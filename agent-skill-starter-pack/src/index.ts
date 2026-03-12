/**
 * @module index
 * @description Agent Skill Framework — main entry point.
 *
 * Quick start:
 * ```ts
 * import { createAgent } from 'agent-skill-starter-pack';
 *
 * const agent = createAgent({ agentId: 'my-agent' });
 * const result = await agent.run('web-scraper', { url: 'https://example.com', mode: 'static' }, 'task-001');
 * console.log(result.data);
 * ```
 */

import { SkillRegistry } from './core/registry';
import { SkillExecutor } from './core/executor';
import { InMemoryCache, RedisCache } from './core/cache';
import { EventBus } from './core/event-bus';
import { Logger } from './monitoring/logger';
import { MetricsCollector } from './monitoring/metrics';
import { getConfig } from './config';
import type { SkillResult, Environment } from './core/types';

// Pre-built skills
import { webScraperSkill } from './skills/web_scraper';
import { dataAnalysisSkill } from './skills/data_analysis';
import { apiIntegrationSkill } from './skills/api_integration';
import { nlpSkill } from './skills/nlp';

// ── Agent Options ─────────────────────────────────────────────────────────────

export interface AgentOptions {
  agentId?: string;
  environment?: Environment;
  enableCache?: boolean;
  redisUrl?: string;
  includeDefaultSkills?: boolean;
  logLevel?: string;
}

// ── Agent Class ───────────────────────────────────────────────────────────────

export class Agent {
  readonly registry: SkillRegistry;
  readonly executor: SkillExecutor;
  readonly eventBus: EventBus;
  readonly metrics: MetricsCollector;
  private readonly logger: Logger;

  constructor(options: AgentOptions = {}) {
    const config = getConfig();

    const agentId = options.agentId ?? config.agentId;
    const environment = options.environment ?? config.environment;
    const logLevel = options.logLevel ?? config.logLevel;

    this.logger = new Logger({ name: `Agent:${agentId}`, level: logLevel });
    this.metrics = new MetricsCollector();
    this.eventBus = new EventBus(this.logger);

    const enableCache = options.enableCache ?? config.cacheEnabled;
    const redisUrl = options.redisUrl ?? config.redisUrl;

    const cache = enableCache
      ? redisUrl
        ? new RedisCache(redisUrl, this.logger)
        : new InMemoryCache(1000, this.logger)
      : undefined;

    this.registry = new SkillRegistry(this.logger);

    this.executor = new SkillExecutor({
      agentId,
      environment,
      cache,
      eventBus: this.eventBus,
      logger: this.logger,
      metrics: this.metrics,
    });

    if (options.includeDefaultSkills !== false) {
      this.registerDefaultSkills();
    }

    this.logger.info(
      { agentId, environment, cacheEnabled: enableCache, skillCount: this.registry.list().length },
      'Agent initialized',
    );
  }

  /**
   * Execute a skill by ID.
   */
  async run<TOutput = unknown>(
    skillId: string,
    input: unknown,
    taskId: string,
  ): Promise<SkillResult<TOutput>> {
    const skill = this.registry.get(skillId);
    if (!skill) {
      return {
        status: 'failure',
        error: {
          code: 'SKILL_NOT_FOUND',
          message: `Skill "${skillId}" is not registered. Available: ${this.registry
            .list()
            .map((d) => d.id)
            .join(', ')}`,
          retryable: false,
        },
        metrics: { durationMs: 0, retryCount: 0, apiCallCount: 0, cacheHits: 0 },
        context: {
          executionId: 'unknown',
          agentId: 'unknown',
          taskId,
          startedAt: new Date().toISOString(),
          metadata: {},
          environment: getConfig().environment,
        },
      };
    }

    return this.executor.run(skill, input, taskId) as Promise<SkillResult<TOutput>>;
  }

  /**
   * Register the four pre-built skills.
   */
  private registerDefaultSkills(): void {
    this.registry.register(webScraperSkill);
    this.registry.register(dataAnalysisSkill);
    this.registry.register(apiIntegrationSkill);
    this.registry.register(nlpSkill);
  }

  /**
   * Run health checks across all registered skills.
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    skills: Record<string, boolean>;
    metricsSnapshot: Record<string, unknown>;
  }> {
    const skills = await this.registry.healthCheckAll();
    const healthy = Object.values(skills).every(Boolean);
    return { healthy, skills, metricsSnapshot: this.metrics.toJSON() };
  }

  /**
   * Export Prometheus-format metrics.
   */
  metricsPrometheus(): string {
    return this.metrics.toPrometheusFormat();
  }

  /**
   * Clean up all skill resources.
   */
  async shutdown(): Promise<void> {
    this.logger.info({}, 'Agent shutting down');
    for (const def of this.registry.list()) {
      const skill = this.registry.get(def.id);
      await skill?.cleanup?.();
    }
    this.eventBus.removeAllListeners();
  }
}

// ── Factory Function ──────────────────────────────────────────────────────────

/**
 * Create a new Agent instance with sensible defaults.
 *
 * @example
 * ```ts
 * const agent = createAgent({ agentId: 'my-pipeline-agent' });
 * const result = await agent.run('nlp', { text: 'Hello world', operations: ['sentiment'] }, 'task-1');
 * ```
 */
export function createAgent(options: AgentOptions = {}): Agent {
  return new Agent(options);
}

// ── Exports ───────────────────────────────────────────────────────────────────

// Core
export { SkillRegistry } from './core/registry';
export { SkillExecutor, SkillExecutionError } from './core/executor';
export { BaseSkill } from './core/base-skill';
export { InMemoryCache, RedisCache } from './core/cache';
export { EventBus } from './core/event-bus';
export type {
  ISkill,
  SkillDefinition,
  SkillResult,
  SkillError,
  ExecutionContext,
  ExecutionMetrics,
  SkillCategory,
  SkillConfig,
  SkillHealthStatus,
  SkillEventType,
  SkillEvent,
  Environment,
} from './core/types';

// Monitoring
export { Logger } from './monitoring/logger';
export { MetricsCollector } from './monitoring/metrics';

// Config
export { getConfig, getSafeConfig } from './config';

// Skills
export {
  webScraperSkill,
  WebScraperSkill,
  WebScraperInputSchema,
  WebScraperOutputSchema,
} from './skills/web_scraper';
export type { WebScraperInput, WebScraperOutput } from './skills/web_scraper';

export {
  dataAnalysisSkill,
  DataAnalysisSkill,
  DataAnalysisInputSchema,
  DataAnalysisOutputSchema,
} from './skills/data_analysis';
export type { DataAnalysisInput, DataAnalysisOutput } from './skills/data_analysis';

export {
  apiIntegrationSkill,
  ApiIntegrationSkill,
  ApiIntegrationInputSchema,
  ApiIntegrationOutputSchema,
} from './skills/api_integration';
export type { ApiIntegrationInput, ApiIntegrationOutput } from './skills/api_integration';

export { nlpSkill, NlpSkill, NlpInputSchema, NlpOutputSchema } from './skills/nlp';
export type { NlpInput, NlpOutput } from './skills/nlp';
