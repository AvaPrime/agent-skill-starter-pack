/**
 * @module core/executor
 * @description The SkillExecutor wraps every skill execution with:
 *   - Input validation (Zod)
 *   - Configurable retry with exponential back-off
 *   - Per-execution timeout
 *   - Optional Redis result caching
 *   - Structured metrics collection
 *   - Event emission for monitoring hooks
 */

import pRetry, { AbortError } from 'p-retry';
import pTimeout, { TimeoutError } from 'p-timeout';
import { v4 as uuidv4 } from 'uuid';
import {
  ISkill,
  ExecutionContext,
  SkillResult,
  SkillError,
  ExecutionMetrics,
  SkillEvent,
  Environment,
} from './types';
import { Logger } from '../monitoring/logger';
import { MetricsCollector } from '../monitoring/metrics';
import { CacheClient } from './cache';
import { EventBus } from './event-bus';

export interface ExecutorOptions {
  environment: Environment;
  agentId: string;
  cache?: CacheClient;
  eventBus?: EventBus;
  logger?: Logger;
  metrics?: MetricsCollector;
}

export class SkillExecutor {
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  private readonly cache?: CacheClient;
  private readonly eventBus?: EventBus;
  private readonly agentId: string;
  private readonly environment: Environment;

  constructor(options: ExecutorOptions) {
    this.agentId = options.agentId;
    this.environment = options.environment;
    this.cache = options.cache;
    this.eventBus = options.eventBus;
    this.logger = options.logger ?? new Logger({ name: 'SkillExecutor' });
    this.metrics = options.metrics ?? new MetricsCollector();
  }

  /**
   * Execute a skill with full lifecycle management.
   *
   * @param skill  - The skill instance to execute
   * @param input  - Raw (unvalidated) input; will be validated against the skill's schema
   * @param taskId - Upstream task identifier for tracing
   */
  async run<TInput, TOutput>(
    skill: ISkill<TInput, TOutput>,
    input: unknown,
    taskId: string,
    parentContext?: ExecutionContext,
  ): Promise<SkillResult<TOutput>> {
    const executionId = uuidv4();
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    const context: ExecutionContext = {
      executionId,
      agentId: this.agentId,
      taskId,
      startedAt,
      metadata: {},
      environment: this.environment,
      parentContext,
    };

    const metricsAccumulator: ExecutionMetrics = {
      durationMs: 0,
      retryCount: 0,
      apiCallCount: 0,
      cacheHits: 0,
    };

    // Emit started event
    this.emit({ type: 'skill.started', skillId: skill.definition.id, executionId, taskId, timestamp: startedAt, payload: { input } });

    // ── 1. Input Validation ────────────────────────────────────────────────
    const parseResult = skill.definition.inputSchema.safeParse(input);
    if (!parseResult.success) {
      const error: SkillError = {
        code: 'VALIDATION_ERROR',
        message: `Input validation failed: ${parseResult.error.message}`,
        retryable: false,
        details: { issues: parseResult.error.issues },
      };
      this.logger.error({ skillId: skill.definition.id, executionId, error }, 'Input validation failed');
      metricsAccumulator.durationMs = Date.now() - startMs;
      this.emit({ type: 'skill.failed', skillId: skill.definition.id, executionId, taskId, timestamp: new Date().toISOString(), payload: { error } });
      return { status: 'failure', error, metrics: metricsAccumulator, context };
    }

    const validatedInput = parseResult.data;

    // ── 2. Cache Lookup ────────────────────────────────────────────────────
    if (this.cache && skill.definition.config.cacheTtlSeconds) {
      const cacheKey = this.buildCacheKey(skill.definition.id, validatedInput);
      const cached = await this.cache.get<TOutput>(cacheKey);
      if (cached !== null) {
        metricsAccumulator.cacheHits = 1;
        metricsAccumulator.durationMs = Date.now() - startMs;
        this.logger.info({ skillId: skill.definition.id, executionId, cacheKey }, 'Cache hit');
        this.emit({ type: 'skill.cached', skillId: skill.definition.id, executionId, taskId, timestamp: new Date().toISOString(), payload: { cacheKey } });
        return { status: 'success', data: cached, metrics: metricsAccumulator, context };
      }
    }

    // ── 3. Execute with Retry + Timeout ────────────────────────────────────
    try {
      const result = await pRetry(
        async (attempt) => {
          if (attempt > 1) {
            metricsAccumulator.retryCount = attempt - 1;
            this.logger.warn({ skillId: skill.definition.id, executionId, attempt }, 'Retrying skill execution');
            this.emit({ type: 'skill.retrying', skillId: skill.definition.id, executionId, taskId, timestamp: new Date().toISOString(), payload: { attempt } });
          }

          try {
            const output = await pTimeout(
              skill.execute(validatedInput, context),
              { milliseconds: skill.definition.config.timeoutMs },
            );
            return output;
          } catch (err) {
            if (err instanceof TimeoutError) {
              throw new AbortError(`Skill timed out after ${skill.definition.config.timeoutMs}ms`);
            }
            // Let pRetry decide whether to retry based on retryable flag
            if (err instanceof Error && (err as SkillExecutionError).retryable === false) {
              throw new AbortError(err.message);
            }
            throw err;
          }
        },
        {
          retries: skill.definition.config.maxRetries,
          minTimeout: skill.definition.config.retryDelayMs,
          factor: skill.definition.config.retryBackoffMultiplier,
          onFailedAttempt: (error) => {
            this.logger.warn(
              { skillId: skill.definition.id, executionId, attempt: error.attemptNumber, retriesLeft: error.retriesLeft },
              `Attempt ${error.attemptNumber} failed: ${error.message}`,
            );
          },
        },
      );

      // ── 4. Output Validation ─────────────────────────────────────────────
      const outputParse = skill.definition.outputSchema.safeParse(result);
      if (!outputParse.success) {
        this.logger.warn({ skillId: skill.definition.id, executionId }, 'Output validation warning — data returned but did not match schema');
      }

      // ── 5. Cache Store ───────────────────────────────────────────────────
      if (this.cache && skill.definition.config.cacheTtlSeconds) {
        const cacheKey = this.buildCacheKey(skill.definition.id, validatedInput);
        await this.cache.set(cacheKey, result, skill.definition.config.cacheTtlSeconds);
      }

      metricsAccumulator.durationMs = Date.now() - startMs;
      this.metrics.recordExecution(skill.definition.id, metricsAccumulator);

      this.emit({ type: 'skill.completed', skillId: skill.definition.id, executionId, taskId, timestamp: new Date().toISOString(), payload: { metrics: metricsAccumulator } });
      this.logger.info({ skillId: skill.definition.id, executionId, durationMs: metricsAccumulator.durationMs }, 'Skill completed successfully');

      return { status: 'success', data: result, metrics: metricsAccumulator, context };

    } catch (err) {
      metricsAccumulator.durationMs = Date.now() - startMs;
      const skillError: SkillError = this.normalizeError(err);
      this.metrics.recordError(skill.definition.id, skillError.code);
      this.emit({ type: 'skill.failed', skillId: skill.definition.id, executionId, taskId, timestamp: new Date().toISOString(), payload: { error: skillError } });
      this.logger.error({ skillId: skill.definition.id, executionId, error: skillError }, 'Skill execution failed');

      return { status: 'failure', error: skillError, metrics: metricsAccumulator, context };
    }
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  private buildCacheKey(skillId: string, input: unknown): string {
    const inputHash = Buffer.from(JSON.stringify(input)).toString('base64');
    return `skill:${skillId}:${inputHash}`;
  }

  private normalizeError(err: unknown): SkillError {
    if (err instanceof Error) {
      return {
        code: (err as SkillExecutionError).code ?? 'EXECUTION_ERROR',
        message: err.message,
        retryable: (err as SkillExecutionError).retryable ?? false,
        stack: err.stack,
      };
    }
    return {
      code: 'UNKNOWN_ERROR',
      message: String(err),
      retryable: false,
    };
  }

  private emit(event: SkillEvent): void {
    this.eventBus?.emit(event).catch((err) => {
      this.logger.warn({ err }, 'Failed to emit skill event');
    });
  }
}

/** Augmented Error for skill-specific metadata */
export class SkillExecutionError extends Error {
  code: string;
  retryable: boolean;
  details?: Record<string, unknown>;

  constructor(message: string, code: string, retryable = false, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SkillExecutionError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}
