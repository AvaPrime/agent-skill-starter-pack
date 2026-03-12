/**
 * @file tests/mocks/index.ts
 * @description Reusable mock factories and fixtures for all skill tests.
 */

import { ExecutionContext, SkillHealthStatus, Environment } from '../../src/core/types';
import { CacheClient } from '../../src/core/cache';
import { EventBus } from '../../src/core/event-bus';

// ── Context Factory ───────────────────────────────────────────────────────────

export function createMockContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    executionId: 'test-execution-id-001',
    agentId: 'test-agent',
    taskId: 'test-task-001',
    startedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    metadata: {},
    environment: 'development' as Environment,
    ...overrides,
  };
}

// ── Mock Cache ────────────────────────────────────────────────────────────────

export class MockCache implements CacheClient {
  private store = new Map<string, unknown>();
  public readonly setCallArgs: Array<{ key: string; value: unknown; ttl: number }> = [];
  public readonly getCallArgs: string[] = [];

  get<T>(key: string): Promise<T | null> {
    this.getCallArgs.push(key);
    return Promise.resolve((this.store.get(key) as T) ?? null);
  }

  set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.setCallArgs.push({ key, value, ttl: ttlSeconds });
    this.store.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  flush(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }

  /** Pre-populate cache for testing cache-hit scenarios */
  seed(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  get size(): number {
    return this.store.size;
  }
}

// ── Mock Event Bus ────────────────────────────────────────────────────────────

export class MockEventBus extends EventBus {
  public readonly emittedEvents: Array<{ type: string; payload: unknown }> = [];

  override emit(event: import('../../src/core/types').SkillEvent): void {
    this.emittedEvents.push({ type: event.type, payload: event.payload });
    super.emit(event);
  }

  getEventsByType(type: string): Array<{ type: string; payload: unknown }> {
    return this.emittedEvents.filter((e) => e.type === type);
  }
}

// ── Data Fixtures ─────────────────────────────────────────────────────────────

export const salesData = [
  { month: 'Jan', revenue: 12000, units: 150, region: 'North' },
  { month: 'Feb', revenue: 15000, units: 200, region: 'North' },
  { month: 'Mar', revenue: 13500, units: 170, region: 'South' },
  { month: 'Apr', revenue: 18000, units: 230, region: 'South' },
  { month: 'May', revenue: 21000, units: 280, region: 'North' },
  { month: 'Jun', revenue: 19500, units: 260, region: 'East' },
  { month: 'Jul', revenue: 22000, units: 300, region: 'East' },
  { month: 'Aug', revenue: 25000, units: 340, region: 'West' },
  { month: 'Sep', revenue: 23000, units: 310, region: 'West' },
  { month: 'Oct', revenue: 28000, units: 380, region: 'North' },
  { month: 'Nov', revenue: 35000, units: 450, region: 'North' },
  { month: 'Dec', revenue: 42000, units: 520, region: 'South' },
  // Outlier
  { month: 'Bonus', revenue: 500, units: 5, region: 'Other' },
];

export const textFixtures = {
  positive:
    'This is an excellent product. The quality is outstanding and I love the design. Highly recommended!',
  negative:
    'Terrible experience. The product was broken and customer service was awful. Very disappointed.',
  neutral: 'The product arrived on Tuesday. It has five buttons and comes in blue or green.',
  mixed:
    'The price is excellent but the quality is quite poor. Customer service was helpful though.',
  financial:
    'Apple reported record Q4 revenue of $89.5 billion, a 13% increase year-over-year. CEO Tim Cook credited strong iPhone sales.',
  technical:
    'The API integration supports OAuth 2.0 and returns paginated JSON responses. Rate limits are 1000 requests per hour.',
};

export const htmlFixtures = {
  simple: `
    <html>
      <head><title>Test Page</title></head>
      <body>
        <h1>Main Heading</h1>
        <p class="price">$29.99</p>
        <p class="description">A great product for everyone.</p>
        <a href="/page1">Link 1</a>
        <a href="/page2">Link 2</a>
        <img src="/img/product.jpg" alt="Product" />
      </body>
    </html>
  `,
  pagination: {
    page1: JSON.stringify({
      items: [
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' },
      ],
      next_cursor: 'cursor_page2',
    }),
    page2: JSON.stringify({ items: [{ id: 3, name: 'Item 3' }], next_cursor: null }),
  },
};

// ── Mock HTTP Responses ───────────────────────────────────────────────────────

export const mockHttpResponses = {
  success200: {
    status: 200,
    data: { id: 1, name: 'Test Item' },
    headers: { 'content-type': 'application/json' },
  },
  error404: { status: 404, data: { error: 'Not Found' }, headers: {} },
  error429: { status: 429, data: { error: 'Rate Limited' }, headers: { 'retry-after': '60' } },
  error503: { status: 503, data: { error: 'Service Unavailable' }, headers: {} },
};

// ── Health Check Factory ──────────────────────────────────────────────────────

export function createHealthyStatus(details: Record<string, unknown> = {}): SkillHealthStatus {
  return {
    healthy: true,
    latencyMs: 5,
    details,
    checkedAt: new Date().toISOString(),
  };
}

export function createUnhealthyStatus(details: Record<string, unknown> = {}): SkillHealthStatus {
  return {
    healthy: false,
    latencyMs: 5000,
    details,
    checkedAt: new Date().toISOString(),
  };
}
