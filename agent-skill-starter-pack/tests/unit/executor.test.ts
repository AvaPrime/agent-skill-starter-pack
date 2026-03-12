/**
 * @file tests/unit/executor.test.ts
 * @description Unit tests for the SkillExecutor — covers validation,
 * retry, caching, timeout, and error propagation.
 */

import { SkillExecutor, SkillExecutionError } from '../../src/core/executor';
import { BaseSkill } from '../../src/core/base-skill';
import { SkillDefinition } from '../../src/core/types';
import { z } from 'zod';
import { MockCache, MockEventBus } from '../mocks';

// ── Test Skill ────────────────────────────────────────────────────────────────

const testInputSchema = z.object({ value: z.number(), shouldFail: z.boolean().default(false) });
const testOutputSchema = z.object({ doubled: z.number() });
type TestInput = z.infer<typeof testInputSchema>;
type TestOutput = z.infer<typeof testOutputSchema>;

const testDefinition: SkillDefinition<TestInput, TestOutput> = {
  id: 'test-skill',
  name: 'Test Skill',
  version: '1.0.0',
  description: 'A skill for testing',
  inputSchema: testInputSchema,
  outputSchema: testOutputSchema,
  category: 'custom',
  tags: ['test'],
  supportsStreaming: false,
  maxConcurrency: 1,
  config: {
    timeoutMs: 5000,
    maxRetries: 2,
    retryDelayMs: 50,
    retryBackoffMultiplier: 1.5,
    cacheTtlSeconds: 60,
  },
};

class TestSkill extends BaseSkill<TestInput, TestOutput> {
  readonly definition = testDefinition;
  public callCount = 0;
  public shouldThrowRetryable = false;
  public shouldThrowNonRetryable = false;
  public delayMs = 0;

  protected async executeImpl(input: TestInput): Promise<TestOutput> {
    this.callCount++;

    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    if (input.shouldFail || this.shouldThrowRetryable) {
      throw new SkillExecutionError('Intentional failure', 'TEST_ERROR', true);
    }

    if (this.shouldThrowNonRetryable) {
      throw new SkillExecutionError('Non-retryable failure', 'PERMANENT_ERROR', false);
    }

    return { doubled: input.value * 2 };
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SkillExecutor', () => {
  let executor: SkillExecutor;
  let skill: TestSkill;
  let cache: MockCache;
  let eventBus: MockEventBus;

  beforeEach(() => {
    cache = new MockCache();
    eventBus = new MockEventBus();
    executor = new SkillExecutor({
      agentId: 'test-agent',
      environment: 'development',
      cache,
      eventBus,
    });
    skill = new TestSkill();
  });

  // ── Success path ──────────────────────────────────────────────────────────

  describe('successful execution', () => {
    it('returns success status with correct output', async () => {
      const result = await executor.run(skill, { value: 5 }, 'task-001');

      expect(result.status).toBe('success');
      expect(result.data).toEqual({ doubled: 10 });
      expect(result.error).toBeUndefined();
    });

    it('populates execution context correctly', async () => {
      const result = await executor.run(skill, { value: 3 }, 'task-context-test');

      expect(result.context.taskId).toBe('task-context-test');
      expect(result.context.agentId).toBe('test-agent');
      expect(result.context.executionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.context.environment).toBe('development');
    });

    it('records execution metrics', async () => {
      const result = await executor.run(skill, { value: 7 }, 'task-metrics');

      expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.retryCount).toBe(0);
      expect(result.metrics.cacheHits).toBe(0);
    });

    it('emits started and completed events', async () => {
      await executor.run(skill, { value: 1 }, 'task-events');

      const started = eventBus.getEventsByType('skill.started');
      const completed = eventBus.getEventsByType('skill.completed');

      expect(started).toHaveLength(1);
      expect(completed).toHaveLength(1);
      expect(started[0]?.payload).toHaveProperty('input');
    });
  });

  // ── Input validation ──────────────────────────────────────────────────────

  describe('input validation', () => {
    it('returns failure for invalid input without calling executeImpl', async () => {
      const result = await executor.run(skill, { value: 'not-a-number' }, 'task-validation');

      expect(result.status).toBe('failure');
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(skill.callCount).toBe(0);
    });

    it('returns failure for missing required fields', async () => {
      const result = await executor.run(skill, {}, 'task-missing-fields');

      expect(result.status).toBe('failure');
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.retryable).toBe(false);
    });

    it('applies default values from schema', async () => {
      const result = await executor.run(skill, { value: 5 }, 'task-defaults');

      expect(result.status).toBe('success');
      expect(skill.callCount).toBe(1);
    });
  });

  // ── Retry behavior ────────────────────────────────────────────────────────

  describe('retry behavior', () => {
    it('retries on retryable errors up to maxRetries times', async () => {
      skill.shouldThrowRetryable = true;

      const result = await executor.run(skill, { value: 1 }, 'task-retry');

      // 1 initial + 2 retries = 3 calls
      expect(skill.callCount).toBe(3);
      expect(result.status).toBe('failure');
      expect(result.metrics.retryCount).toBe(2);
    }, 10000);

    it('does not retry on non-retryable errors', async () => {
      skill.shouldThrowNonRetryable = true;

      const result = await executor.run(skill, { value: 1 }, 'task-no-retry');

      expect(skill.callCount).toBe(1);
      expect(result.status).toBe('failure');
      expect(result.metrics.retryCount).toBe(0);
    });

    it('emits retrying events', async () => {
      skill.shouldThrowRetryable = true;

      await executor.run(skill, { value: 1 }, 'task-retry-events');

      const retryEvents = eventBus.getEventsByType('skill.retrying');
      expect(retryEvents.length).toBeGreaterThan(0);
    }, 10000);
  });

  // ── Caching ───────────────────────────────────────────────────────────────

  describe('caching', () => {
    it('caches successful results', async () => {
      await executor.run(skill, { value: 5 }, 'task-cache-write');

      expect(cache.setCallArgs).toHaveLength(1);
      expect(cache.setCallArgs[0]?.ttl).toBe(60);
    });

    it('returns cached result without calling executeImpl', async () => {
      // First call to populate cache
      await executor.run(skill, { value: 5 }, 'task-cache-miss');
      expect(skill.callCount).toBe(1);

      // Second call should hit cache
      const result = await executor.run(skill, { value: 5 }, 'task-cache-hit');
      expect(skill.callCount).toBe(1); // no additional calls
      expect(result.status).toBe('success');
      expect(result.metrics.cacheHits).toBe(1);
    });

    it('emits cache event on cache hit', async () => {
      await executor.run(skill, { value: 5 }, 'task-cache-event-1');
      await executor.run(skill, { value: 5 }, 'task-cache-event-2');

      const cacheEvents = eventBus.getEventsByType('skill.cached');
      expect(cacheEvents).toHaveLength(1);
    });

    it('different inputs produce different cache keys', async () => {
      await executor.run(skill, { value: 5 }, 'task-1');
      await executor.run(skill, { value: 10 }, 'task-2');

      expect(skill.callCount).toBe(2); // both should execute
      expect(cache.setCallArgs).toHaveLength(2);
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('emits failed event on error', async () => {
      skill.shouldThrowNonRetryable = true;
      await executor.run(skill, { value: 1 }, 'task-error-event');

      const failedEvents = eventBus.getEventsByType('skill.failed');
      expect(failedEvents).toHaveLength(1);
    });

    it('normalizes unknown errors into SkillError format', async () => {
      // Make skill throw a plain Error
      jest
        .spyOn(skill as unknown as { executeImpl: () => void }, 'executeImpl')
        .mockRejectedValueOnce(new Error('Plain error'));

      const result = await executor.run(skill, { value: 1 }, 'task-plain-error');

      expect(result.status).toBe('failure');
      expect(result.error?.code).toBeDefined();
      expect(result.error?.message).toBe('Plain error');
    });
  });

  // ── Parallel execution ────────────────────────────────────────────────────

  describe('parallel execution', () => {
    it('handles multiple concurrent executions with independent contexts', async () => {
      const inputs = [1, 2, 3, 4, 5].map((v) => ({ value: v }));
      const results = await Promise.all(
        inputs.map((input, i) => executor.run(skill, input, `task-parallel-${i}`)),
      );

      expect(results).toHaveLength(5);
      results.forEach((r, i) => {
        expect(r.status).toBe('success');
        expect((r.data as TestOutput).doubled).toBe((i + 1) * 2);
      });

      // Each execution should have a unique ID
      const executionIds = results.map((r) => r.context.executionId);
      expect(new Set(executionIds).size).toBe(5);
    });
  });
});

// ── SkillExecutionError Tests ─────────────────────────────────────────────────

describe('SkillExecutionError', () => {
  it('correctly sets all properties', () => {
    const err = new SkillExecutionError('Test error', 'TEST_CODE', true, { extra: 'info' });

    expect(err.message).toBe('Test error');
    expect(err.code).toBe('TEST_CODE');
    expect(err.retryable).toBe(true);
    expect(err.details).toEqual({ extra: 'info' });
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe('SkillExecutionError');
  });

  it('defaults retryable to false', () => {
    const err = new SkillExecutionError('Test', 'CODE');
    expect(err.retryable).toBe(false);
  });
});
