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

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import {
  ISkill,
  ExecutionContext,
  SkillResult,
  SkillError,
  ExecutionMetrics,
  SkillEvent,
  Environment,
  RateLimitConfig,
} from './types';
import { Logger } from '../monitoring/logger';
import { MetricsCollector } from '../monitoring/metrics';
import { CacheClient } from './cache';
import { EventBus } from './event-bus';
import { getConfig } from '../config';

export interface ExecutorOptions {
  environment: Environment;
  agentId: string;
  cache?: CacheClient;
  eventBus?: EventBus;
  logger?: Logger;
  metrics?: MetricsCollector;
}

class ExecutorAbortError extends Error {
  override name = 'ExecutorAbortError';
}

class ExecutorTimeoutError extends Error {
  override name = 'ExecutorTimeoutError';
}

export class SkillExecutor {
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  private readonly cache?: CacheClient;
  private readonly eventBus?: EventBus;
  private readonly agentId: string;
  private readonly environment: Environment;
  private readonly rateWindows = new Map<string, number[]>();

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

    const identity =
      (context.metadata?.clientId as string | undefined) ??
      (context.metadata?.ip as string | undefined) ??
      context.agentId;
    const rateCheck = this.checkRateLimit(
      skill.definition.id,
      skill.definition.config.rateLimit,
      identity,
    );
    if (!rateCheck.ok) {
      const error: SkillError = {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Rate limit exceeded',
        retryable: false,
        details: { retryAfterMs: rateCheck.retryAfterMs ?? 0, identity },
      };
      this.emit({
        type: 'skill.failed',
        skillId: skill.definition.id,
        executionId,
        taskId,
        timestamp: new Date().toISOString(),
        payload: { error },
      });
      return { status: 'failure', error, metrics: metricsAccumulator, context };
    }

    // Emit started event
    this.emit({
      type: 'skill.started',
      skillId: skill.definition.id,
      executionId,
      taskId,
      timestamp: startedAt,
      payload: { input },
    });

    // ── 1. Input Validation ────────────────────────────────────────────────
    const parseResult = skill.definition.inputSchema.safeParse(input);
    if (!parseResult.success) {
      const error: SkillError = {
        code: 'VALIDATION_ERROR',
        message: `Input validation failed: ${parseResult.error.message}`,
        retryable: false,
        details: { issues: parseResult.error.issues },
      };
      this.logger.error(
        { skillId: skill.definition.id, executionId, error },
        'Input validation failed',
      );
      metricsAccumulator.durationMs = Date.now() - startMs;
      this.emit({
        type: 'skill.failed',
        skillId: skill.definition.id,
        executionId,
        taskId,
        timestamp: new Date().toISOString(),
        payload: { error },
      });
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
        this.emit({
          type: 'skill.cached',
          skillId: skill.definition.id,
          executionId,
          taskId,
          timestamp: new Date().toISOString(),
          payload: { cacheKey },
        });
        return { status: 'success', data: cached, metrics: metricsAccumulator, context };
      }
    }

    // ── 3. Execute with Retry + Timeout ────────────────────────────────────
    try {
      const maxRetries = skill.definition.config.maxRetries;
      const baseDelayMs = skill.definition.config.retryDelayMs;
      const backoff = skill.definition.config.retryBackoffMultiplier;
      const totalAttempts = maxRetries + 1;

      let result!: TOutput;
      for (let attempt = 1; attempt <= totalAttempts; attempt++) {
        if (attempt > 1) {
          metricsAccumulator.retryCount = attempt - 1;
          this.logger.warn(
            { skillId: skill.definition.id, executionId, attempt },
            'Retrying skill execution',
          );
          this.emit({
            type: 'skill.retrying',
            skillId: skill.definition.id,
            executionId,
            taskId,
            timestamp: new Date().toISOString(),
            payload: { attempt },
          });
        }

        try {
          result = await this.withTimeout(
            skill.execute(validatedInput, context),
            skill.definition.config.timeoutMs,
          );
          break;
        } catch (err: unknown) {
          if (err instanceof ExecutorTimeoutError) {
            throw new ExecutorAbortError(
              `Skill timed out after ${skill.definition.config.timeoutMs}ms`,
            );
          }
          if (err instanceof Error && (err as SkillExecutionError).retryable === false) {
            throw new ExecutorAbortError(err.message);
          }

          const retriesLeft = totalAttempts - attempt;
          this.logger.warn(
            { skillId: skill.definition.id, executionId, attempt, retriesLeft },
            `Attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`,
          );

          if (retriesLeft <= 0) throw err;
          const retryIndex = attempt;
          const delayMs = Math.max(0, Math.floor(baseDelayMs * Math.pow(backoff, retryIndex - 1)));
          await this.sleep(delayMs);
        }
      }

      // ── 4. Output Validation ─────────────────────────────────────────────
      const outputParse = skill.definition.outputSchema.safeParse(result);
      if (!outputParse.success) {
        this.logger.warn(
          { skillId: skill.definition.id, executionId },
          'Output validation warning — data returned but did not match schema',
        );
      }

      // ── 5. Cache Store ───────────────────────────────────────────────────
      if (this.cache && skill.definition.config.cacheTtlSeconds) {
        const cacheKey = this.buildCacheKey(skill.definition.id, validatedInput);
        await this.cache.set(cacheKey, result, skill.definition.config.cacheTtlSeconds);
      }

      metricsAccumulator.durationMs = Date.now() - startMs;
      this.metrics.recordExecution(skill.definition.id, metricsAccumulator);

      this.emit({
        type: 'skill.completed',
        skillId: skill.definition.id,
        executionId,
        taskId,
        timestamp: new Date().toISOString(),
        payload: { metrics: metricsAccumulator },
      });
      this.logger.info(
        { skillId: skill.definition.id, executionId, durationMs: metricsAccumulator.durationMs },
        'Skill completed successfully',
      );

      return { status: 'success', data: result, metrics: metricsAccumulator, context };
    } catch (err) {
      metricsAccumulator.durationMs = Date.now() - startMs;
      const skillError: SkillError = this.normalizeError(err);
      this.metrics.recordError(skill.definition.id, skillError.code);
      this.emit({
        type: 'skill.failed',
        skillId: skill.definition.id,
        executionId,
        taskId,
        timestamp: new Date().toISOString(),
        payload: { error: skillError },
      });
      this.logger.error(
        { skillId: skill.definition.id, executionId, error: skillError },
        'Skill execution failed',
      );

      return { status: 'failure', error: skillError, metrics: metricsAccumulator, context };
    }
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  private buildCacheKey(skillId: string, input: unknown): string {
    const sanitized = this.sanitizeInput(input);
    const stable = this.stableStringify(sanitized);
    const versionSalt = skillId;
    const hash = createHash('sha256')
      .update(versionSalt + ':' + stable)
      .digest('hex');
    return `skill:${skillId}:${hash}`;
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
    try {
      this.eventBus?.emit(event);
    } catch (err: unknown) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to emit skill event',
      );
    }
  }

  private checkRateLimit(
    skillId: string,
    limits: RateLimitConfig | undefined,
    identity: string,
  ): { ok: boolean; retryAfterMs?: number } {
    const cfg = getConfig();
    const maxRequests = limits?.maxRequests ?? cfg.globalRateLimitRequests;
    const windowMs = limits?.windowMs ?? cfg.globalRateLimitWindowMs;
    const now = Date.now();
    const key = `${skillId}:${identity}`;
    const arr = this.rateWindows.get(key) ?? [];
    const pruned = arr.filter((t) => now - t <= windowMs);
    if (pruned.length >= maxRequests) {
      const oldest = pruned[0] ?? now;
      const retryAfterMs = windowMs - (now - oldest);
      this.rateWindows.set(key, pruned);
      return { ok: false, retryAfterMs };
    }
    pruned.push(now);
    this.rateWindows.set(key, pruned);
    return { ok: true };
  }

  private sanitizeInput(input: unknown): unknown {
    const banned = new Set([
      'token',
      'apiKey',
      'authorization',
      'password',
      'clientSecret',
      'secret',
      'key',
    ]);
    const walk = (v: unknown): unknown => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(walk);
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) {
        if (banned.has(k)) continue;
        out[k] = walk(o[k]);
      }
      return out;
    };
    return walk(input);
  }

  private stableStringify(obj: unknown): string {
    const seen = new WeakSet<object>();
    const stringify = (v: unknown): string => {
      if (v === null || typeof v !== 'object') return JSON.stringify(v);
      if (Array.isArray(v)) return `[${(v as unknown[]).map(stringify).join(',')}]`;
      const o = v as Record<string, unknown>;
      if (seen.has(o)) return '"[Circular]"';
      seen.add(o);
      const entries = Object.keys(o)
        .sort()
        .map((k) => `"${k}":${stringify(o[k])}`);
      return `{${entries.join(',')}}`;
    };
    return stringify(obj);
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
