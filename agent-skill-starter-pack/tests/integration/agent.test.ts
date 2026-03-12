/**
 * @file tests/integration/agent.test.ts
 * @description Integration tests for the Agent class end-to-end —
 * registry, executor, cache, and event bus all wired together.
 */

import { createAgent, Agent } from '../../src/index';
import { MockEventBus } from '../mocks';

describe('Agent Integration', () => {
  let agent: Agent;

  beforeEach(() => {
    agent = createAgent({
      agentId: 'integration-test-agent',
      environment: 'development',
      enableCache: true,
      logLevel: 'error', // suppress logs in tests
    });
  });

  afterEach(async () => {
    await agent.shutdown();
  });

  // ── Registry ──────────────────────────────────────────────────────────────

  describe('skill registry', () => {
    it('registers all four default skills', () => {
      const skills = agent.registry.list();
      const ids = skills.map((s) => s.id);

      expect(ids).toContain('web-scraper');
      expect(ids).toContain('data-analysis');
      expect(ids).toContain('api-integration');
      expect(ids).toContain('nlp');
    });

    it('can retrieve skill definitions by category', () => {
      const nlpSkills = agent.registry.listByCategory('nlp');
      expect(nlpSkills).toHaveLength(1);
      expect(nlpSkills[0]!.id).toBe('nlp');
    });
  });

  // ── Skill Not Found ───────────────────────────────────────────────────────

  describe('unknown skill handling', () => {
    it('returns failure result for unknown skill', async () => {
      const result = await agent.run('non-existent-skill', { foo: 'bar' }, 'task-001');

      expect(result.status).toBe('failure');
      expect(result.error?.code).toBe('SKILL_NOT_FOUND');
      expect(result.error?.message).toContain('non-existent-skill');
    });

    it('lists available skills in error message', async () => {
      const result = await agent.run('missing', {}, 'task-002');

      expect(result.error?.message).toContain('web-scraper');
    });
  });

  // ── Data Analysis Integration ─────────────────────────────────────────────

  describe('data-analysis skill end-to-end', () => {
    it('successfully analyses a simple dataset', async () => {
      const data = Array.from({ length: 20 }, (_, i) => ({ value: (i + 1) * 10, category: i % 2 === 0 ? 'A' : 'B' }));

      const result = await agent.run(
        'data-analysis',
        {
          data,
          targetColumn: 'value',
          analyses: ['descriptive', 'trend', 'outliers'],
        },
        'integration-task-001',
      );

      expect(result.status).toBe('success');
      const output = result.data as Record<string, unknown>;
      expect(output.descriptive).toBeDefined();
      expect(output.trend).toBeDefined();
      expect(output.outliers).toBeDefined();
      expect(output.rowCount).toBe(20);
    });

    it('detects increasing trend in ordered data', async () => {
      const data = Array.from({ length: 12 }, (_, i) => ({ revenue: 1000 + i * 500 }));

      const result = await agent.run(
        'data-analysis',
        { data, targetColumn: 'revenue', analyses: ['trend'] },
        'integration-task-002',
      );

      expect(result.status).toBe('success');
      const output = result.data as { trend: { direction: string; rSquared: number } };
      expect(output.trend.direction).toBe('increasing');
      expect(output.trend.rSquared).toBeGreaterThan(0.95);
    });

    it('validation rejects invalid input', async () => {
      const result = await agent.run(
        'data-analysis',
        {
          data: [], // empty array is invalid (min: 1)
          targetColumn: 'value',
          analyses: ['descriptive'],
        },
        'integration-task-validation',
      );

      expect(result.status).toBe('failure');
      expect(result.error?.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── NLP Integration ───────────────────────────────────────────────────────

  describe('nlp skill end-to-end', () => {
    it('extracts keywords from a business text', async () => {
      const text = 'Revenue growth accelerated in Q4 due to strong product sales and market expansion strategies.';

      const result = await agent.run(
        'nlp',
        { text, operations: ['keywords', 'language_detect', 'toxicity'], keywordCount: 8 },
        'integration-nlp-001',
      );

      expect(result.status).toBe('success');
      const output = result.data as { keywords: unknown[]; language: string; toxicity: { isToxic: boolean } };
      expect(output.keywords.length).toBeGreaterThan(0);
      expect(output.language).toBe('en');
      expect(output.toxicity.isToxic).toBe(false);
    });

    it('handles very short text gracefully', async () => {
      const result = await agent.run(
        'nlp',
        { text: 'OK', operations: ['keywords', 'toxicity'], keywordCount: 5 },
        'integration-nlp-short',
      );

      expect(result.status).toBe('success');
    });
  });

  // ── Caching Integration ───────────────────────────────────────────────────

  describe('caching integration', () => {
    it('caches data-analysis results and returns cache hit on second call', async () => {
      const data = Array.from({ length: 5 }, (_, i) => ({ v: i + 1 }));
      const input = { data, targetColumn: 'v', analyses: ['descriptive'] };

      const firstResult = await agent.run('data-analysis', input, 'cache-task-1');
      const secondResult = await agent.run('data-analysis', input, 'cache-task-2');

      expect(firstResult.status).toBe('success');
      expect(secondResult.status).toBe('success');
      expect(secondResult.metrics.cacheHits).toBe(1);
      expect(firstResult.metrics.cacheHits).toBe(0);

      // Results should be identical
      expect(secondResult.data).toEqual(firstResult.data);
    });
  });

  // ── Health Check ──────────────────────────────────────────────────────────

  describe('health check', () => {
    it('returns health status for all registered skills', async () => {
      const health = await agent.healthCheck();

      expect(typeof health.healthy).toBe('boolean');
      expect(health.skills).toHaveProperty('web-scraper');
      expect(health.skills).toHaveProperty('data-analysis');
      expect(health.skills).toHaveProperty('api-integration');
      expect(health.skills).toHaveProperty('nlp');
    });

    it('returns metrics snapshot', async () => {
      // Run some operations first
      await agent.run('data-analysis', {
        data: [{ v: 1 }, { v: 2 }],
        targetColumn: 'v',
        analyses: ['descriptive'],
      }, 'health-task');

      const health = await agent.healthCheck();
      expect(typeof health.metricsSnapshot).toBe('object');
    });
  });

  // ── Metrics ───────────────────────────────────────────────────────────────

  describe('prometheus metrics export', () => {
    it('exports valid Prometheus format', async () => {
      await agent.run('data-analysis', {
        data: [{ v: 1 }, { v: 2 }, { v: 3 }],
        targetColumn: 'v',
        analyses: ['descriptive'],
      }, 'metrics-task');

      const metrics = agent.metricsPrometheus();
      expect(metrics).toContain('skill_executions_total');
      expect(metrics).toContain('# TYPE');
    });
  });

  // ── Event Bus Integration ─────────────────────────────────────────────────

  describe('event bus integration', () => {
    it('emits lifecycle events for successful execution', async () => {
      const events: string[] = [];
      agent.eventBus.on('skill.started', () => events.push('started'));
      agent.eventBus.on('skill.completed', () => events.push('completed'));

      await agent.run('nlp', {
        text: 'Hello world good day',
        operations: ['keywords'],
        keywordCount: 3,
      }, 'event-task');

      expect(events).toContain('started');
      expect(events).toContain('completed');
    });

    it('emits failed event on validation error', async () => {
      const events: string[] = [];
      agent.eventBus.on('skill.failed', () => events.push('failed'));

      await agent.run('nlp', { text: '', operations: ['keywords'] }, 'event-fail-task');

      expect(events).toContain('failed');
    });
  });

  // ── Concurrent Execution ──────────────────────────────────────────────────

  describe('concurrent execution', () => {
    it('handles 10 concurrent skill executions', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        agent.run('nlp', {
          text: `Test sentence number ${i + 1} about various topics and keywords for testing purposes.`,
          operations: ['keywords', 'toxicity'],
          keywordCount: 5,
        }, `concurrent-task-${i}`),
      );

      const results = await Promise.all(promises);

      results.forEach((result, i) => {
        expect(result.status).toBe('success');
        expect(result.context.taskId).toBe(`concurrent-task-${i}`);
      });
    });
  });
});
