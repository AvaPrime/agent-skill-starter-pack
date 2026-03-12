/**
 * @module core/base-skill
 * @description Abstract base class providing common infrastructure to all skills.
 *
 * Extend this class to create a new skill:
 *
 * @example
 * ```ts
 * export class MySkill extends BaseSkill<MyInput, MyOutput> {
 *   readonly definition = mySkillDefinition;
 *
 *   protected async executeImpl(input: MyInput, context: ExecutionContext): Promise<MyOutput> {
 *     // your skill logic here
 *   }
 * }
 * ```
 */

import { ISkill, SkillDefinition, ExecutionContext, SkillHealthStatus } from './types';
import { Logger } from '../monitoring/logger';
import { MetricsCollector } from '../monitoring/metrics';

export abstract class BaseSkill<TInput, TOutput> implements ISkill<TInput, TOutput> {
  abstract readonly definition: SkillDefinition<TInput, TOutput>;

  protected readonly logger: Logger;
  protected readonly metrics: MetricsCollector;

  constructor(logger?: Logger, metrics?: MetricsCollector) {
    this.logger = logger ?? new Logger({ name: this.constructor.name });
    this.metrics = metrics ?? new MetricsCollector();
  }

  /**
   * Public execute method called by the SkillExecutor.
   * Delegates to the protected executeImpl after logging.
   */
  async execute(input: TInput, context: ExecutionContext): Promise<TOutput> {
    this.logger.info(
      { skillId: this.definition.id, executionId: context.executionId },
      'Executing skill',
    );
    return this.executeImpl(input, context);
  }

  /**
   * Implement your skill logic here.
   * Input is already validated by the executor before this method is called.
   */
  protected abstract executeImpl(input: TInput, context: ExecutionContext): Promise<TOutput>;

  /**
   * Default health check — override to add dependency checks (DB, API, etc.)
   */
  async healthCheck(): Promise<SkillHealthStatus> {
    const start = Date.now();
    return {
      healthy: true,
      latencyMs: Date.now() - start,
      details: { skillId: this.definition.id, version: this.definition.version },
      checkedAt: new Date().toISOString(),
    };
  }

  /** Optional cleanup — override if your skill holds resources (connections, browser, etc.) */
  async cleanup(): Promise<void> {
    // no-op by default
  }

  /** Convenience method for recording API calls within executeImpl */
  protected trackApiCall(): void {
    this.metrics.increment(`skill.${this.definition.id}.api_calls`);
  }
}
