/**
 * @module core/types
 * @description Core type definitions for the Agent Skill Framework.
 * All skills, contexts, and results must conform to these interfaces.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────
// EXECUTION CONTEXT
// ─────────────────────────────────────────────

export interface ExecutionContext {
  /** Unique execution identifier (UUID v4) */
  executionId: string;
  /** Agent identifier executing the skill */
  agentId: string;
  /** Task identifier from upstream orchestrator */
  taskId: string;
  /** ISO-8601 timestamp of execution start */
  startedAt: string;
  /** Arbitrary key-value metadata from the orchestrator */
  metadata: Record<string, unknown>;
  /** Nested execution context for child skill calls */
  parentContext?: ExecutionContext;
  /** Environment: development | staging | production */
  environment: Environment;
}

export type Environment = 'development' | 'staging' | 'production';

// ─────────────────────────────────────────────
// SKILL RESULT
// ─────────────────────────────────────────────

export type SkillStatus = 'success' | 'failure' | 'partial' | 'skipped';

export interface SkillResult<T = unknown> {
  status: SkillStatus;
  data?: T;
  error?: SkillError;
  metrics: ExecutionMetrics;
  context: ExecutionContext;
}

export interface SkillError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  stack?: string;
}

export interface ExecutionMetrics {
  durationMs: number;
  retryCount: number;
  tokenUsage?: TokenUsage;
  apiCallCount: number;
  cacheHits: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ─────────────────────────────────────────────
// SKILL DEFINITION
// ─────────────────────────────────────────────

export interface SkillDefinition<TInput = unknown, TOutput = unknown> {
  /** Unique skill identifier (kebab-case) */
  id: string;
  /** Human-readable skill name */
  name: string;
  /** Semantic version */
  version: string;
  /** Skill description for the agent orchestrator */
  description: string;
  /** Zod schema for input validation */
  inputSchema: z.ZodSchema<TInput>;
  /** Zod schema for output validation */
  outputSchema: z.ZodSchema<TOutput>;
  /** Skill category for routing and discovery */
  category: SkillCategory;
  /** Execution configuration */
  config: SkillConfig;
  /** Tags for discovery and filtering */
  tags: string[];
  /** Whether this skill supports streaming output */
  supportsStreaming: boolean;
  /** Maximum concurrent executions */
  maxConcurrency: number;
}

export type SkillCategory =
  | 'web-scraping'
  | 'data-analysis'
  | 'api-integration'
  | 'nlp'
  | 'code-generation'
  | 'file-processing'
  | 'custom';

export interface SkillConfig {
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  retryBackoffMultiplier: number;
  cacheTtlSeconds?: number;
  rateLimit?: RateLimitConfig;
}

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

// ─────────────────────────────────────────────
// SKILL INTERFACE
// ─────────────────────────────────────────────

/**
 * Base interface that all skills must implement.
 * @template TInput - Validated input type
 * @template TOutput - Output data type
 */
export interface ISkill<TInput = unknown, TOutput = unknown> {
  readonly definition: SkillDefinition<TInput, TOutput>;

  /**
   * Execute the skill with validated input.
   * Implementations should not handle retries — the executor does that.
   */
  execute(input: TInput, context: ExecutionContext): Promise<TOutput>;

  /**
   * Health check for the skill's dependencies.
   * Returns true if the skill is ready to execute.
   */
  healthCheck(): Promise<SkillHealthStatus>;

  /**
   * Optional: tear down any resources held by the skill.
   */
  cleanup?(): Promise<void>;
}

export interface SkillHealthStatus {
  healthy: boolean;
  latencyMs: number;
  details: Record<string, unknown>;
  checkedAt: string;
}

// ─────────────────────────────────────────────
// REGISTRY
// ─────────────────────────────────────────────

export interface ISkillRegistry {
  register<TInput, TOutput>(skill: ISkill<TInput, TOutput>): void;
  get<TInput, TOutput>(skillId: string): ISkill<TInput, TOutput> | undefined;
  list(): SkillDefinition[];
  listByCategory(category: SkillCategory): SkillDefinition[];
  has(skillId: string): boolean;
  remove(skillId: string): boolean;
}

// ─────────────────────────────────────────────
// EVENTS
// ─────────────────────────────────────────────

export type SkillEventType =
  | 'skill.started'
  | 'skill.completed'
  | 'skill.failed'
  | 'skill.retrying'
  | 'skill.cached'
  | 'skill.health_check';

export interface SkillEvent {
  type: SkillEventType;
  skillId: string;
  executionId: string;
  taskId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
