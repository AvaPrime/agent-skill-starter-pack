# Agent Skill Starter Pack

> Production-ready, plug-and-play framework for building AI agent skills — get a new skill running in **under 30 minutes**.

[![CI](https://img.shields.io/github/actions/workflow/status/your-org/agent-skill-starter-pack/pipeline.yml?label=CI)](ci/pipeline.yml)
[![Coverage](https://img.shields.io/badge/coverage-85%25-brightgreen)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)]()
[![Node](https://img.shields.io/badge/Node.js-20+-green)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)]()

---

## What Is This?

The Agent Skill Starter Pack is a **modular TypeScript framework** for building autonomous AI agent skills. It provides:

- A fully typed **plug-and-play skill architecture** with sync and async support  
- **4 pre-built skills**: Web Scraper, Data Analysis, API Integration, NLP  
- **Production-grade infrastructure**: retry logic, caching, metrics, structured logging, event bus  
- A **30-second scaffolder** to generate new skills with `npm run skill:create`  
- **Comprehensive test suite**: unit tests, integration tests, mock factories  
- **CI/CD pipeline** with automated quality gates (85% coverage, Snyk scan, canary deploy)

---

## Architecture

```
src/
├── core/
│   ├── types.ts          ← All interfaces: ISkill, ExecutionContext, SkillResult
│   ├── base-skill.ts     ← Abstract base class — extend this for every skill
│   ├── executor.ts       ← Retry, timeout, caching, metrics, event emission
│   ├── registry.ts       ← Skill registration and discovery
│   ├── cache.ts          ← Redis + in-memory LRU fallback
│   └── event-bus.ts      ← Typed event bus for lifecycle hooks
├── skills/
│   ├── web_scraper/      ← Playwright + Cheerio (static/dynamic modes)
│   ├── data_analysis/    ← Stats + outliers + trend + LLM insights
│   ├── api_integration/  ← REST/OAuth2/pagination + response transform
│   └── nlp/              ← Sentiment + NER + keywords + summarization
├── monitoring/
│   ├── logger.ts         ← Pino structured logger with redaction
│   └── metrics.ts        ← Prometheus-compatible counters + histograms
└── config/
    └── index.ts          ← Zod-validated config with env var override
```

### Execution Flow

```
Agent.run(skillId, input, taskId)
  └── SkillRegistry.get(skillId)
      └── SkillExecutor.run(skill, input, taskId)
            ├── 1. Input validation (Zod schema)
            ├── 2. Cache lookup (Redis / in-memory)
            ├── 3. pRetry wrapper
            │     └── pTimeout wrapper
            │           └── skill.execute(validatedInput, context)
            ├── 4. Output validation (Zod schema)
            ├── 5. Cache store
            ├── 6. Metrics recording
            └── 7. Event emission → EventBus
```

---

## Quick Start

### 1. Install

```bash
git clone https://github.com/your-org/agent-skill-starter-pack
cd agent-skill-starter-pack
npm install
cp .env.example .env
# Edit .env: add OPENAI_API_KEY if you want LLM features
```

### 2. Run tests

```bash
npm test             # All tests with coverage
npm run test:unit    # Unit tests only
```

### 3. Use the framework

```typescript
import { createAgent } from './src';

const agent = createAgent({ agentId: 'my-agent' });

// Analyse data
const analysis = await agent.run('data-analysis', {
  data: [{ revenue: 12000, month: 'Jan' }, { revenue: 15000, month: 'Feb' }],
  targetColumn: 'revenue',
  analyses: ['descriptive', 'trend', 'outliers'],
}, 'task-001');

console.log(analysis.data?.trend?.direction); // 'increasing'

// Extract keywords from text
const nlp = await agent.run('nlp', {
  text: 'Apple reported record revenue of $89.5B in Q4, driven by iPhone sales.',
  operations: ['keywords', 'sentiment', 'entities'],
  keywordCount: 10,
}, 'task-002');

// Scrape a web page
const page = await agent.run('web-scraper', {
  url: 'https://example.com',
  selectors: { heading: 'h1', price: '.price' },
  mode: 'static',
}, 'task-003');

// Call an API with pagination
const apiData = await agent.run('api-integration', {
  baseUrl: 'https://api.github.com',
  endpoint: '/repos/octocat/hello-world/issues',
  method: 'GET',
  auth: { type: 'bearer', token: process.env.GITHUB_TOKEN! },
  pagination: { strategy: 'link_header', maxPages: 5 },
}, 'task-004');
```

---

## Creating a New Skill

### 30-Second Scaffold

```bash
npm run skill:create
```

This generates:
- `src/skills/my-skill/index.ts` — skill class with typed I/O and TODO markers
- `tests/unit/my_skill.test.ts` — test suite with validation and happy-path tests

### Manual Implementation

```typescript
// src/skills/my-skill/index.ts
import { z } from 'zod';
import { BaseSkill } from '../../core/base-skill';
import { SkillDefinition, ExecutionContext } from '../../core/types';

const MyInputSchema = z.object({ query: z.string().min(1) });
const MyOutputSchema = z.object({ result: z.string() });
type MyInput = z.infer<typeof MyInputSchema>;
type MyOutput = z.infer<typeof MyOutputSchema>;

export class MySkill extends BaseSkill<MyInput, MyOutput> {
  readonly definition: SkillDefinition<MyInput, MyOutput> = {
    id: 'my-skill',
    name: 'My Skill',
    version: '1.0.0',
    description: 'Does something useful',
    inputSchema: MyInputSchema,
    outputSchema: MyOutputSchema,
    category: 'custom',
    tags: ['custom'],
    supportsStreaming: false,
    maxConcurrency: 10,
    config: {
      timeoutMs: 30000,
      maxRetries: 3,
      retryDelayMs: 1000,
      retryBackoffMultiplier: 2,
      cacheTtlSeconds: 300,
    },
  };

  protected async executeImpl(input: MyInput, context: ExecutionContext): Promise<MyOutput> {
    this.trackApiCall(); // tracks API call count in metrics
    const result = await someExternalCall(input.query);
    return { result };
  }
}

export const mySkill = new MySkill();
```

Register it with the agent:

```typescript
agent.registry.register(mySkill);
const result = await agent.run('my-skill', { query: 'hello' }, 'task-001');
```

---

## Pre-Built Skills Reference

### 🕷️ Web Scraper

| Field | Value |
|---|---|
| **ID** | `web-scraper` |
| **Modes** | `static` (Cheerio) · `dynamic` (Playwright) |
| **Key inputs** | `url`, `selectors`, `mode`, `captureScreenshot`, `extractLinks` |
| **Cache TTL** | 5 minutes |
| **Rate limit** | 10 req/min |

```typescript
await agent.run('web-scraper', {
  url: 'https://shop.example.com/product/123',
  selectors: { name: 'h1.product-title', price: '[data-price]' },
  mode: 'static',
  extractLinks: true,
}, 'task');
```

### 📊 Data Analysis

| Field | Value |
|---|---|
| **ID** | `data-analysis` |
| **Operations** | `descriptive` · `correlation` · `outliers` · `trend` · `distribution` · `insights` |
| **Outlier methods** | IQR · Z-score |
| **Insights** | LLM-powered (requires `OPENAI_API_KEY`) |
| **Max rows** | 100,000 |

```typescript
await agent.run('data-analysis', {
  data: salesData,
  targetColumn: 'revenue',
  groupByColumn: 'region',
  analyses: ['descriptive', 'outliers', 'trend', 'insights'],
  insightsFormat: 'bullet_points',
}, 'task');
```

### 🔗 API Integration

| Field | Value |
|---|---|
| **ID** | `api-integration` |
| **Auth** | Bearer · Basic · API Key · OAuth2 (auto-refresh) |
| **Pagination** | Offset · Cursor · Link Header (GitHub-style) |
| **Transform** | none · flatten · normalize_keys |

```typescript
await agent.run('api-integration', {
  baseUrl: 'https://api.stripe.com',
  endpoint: '/v1/charges',
  auth: { type: 'bearer', token: process.env.STRIPE_KEY! },
  pagination: { strategy: 'cursor', pageSize: 100, maxPages: 10 },
}, 'task');
```

### 🧠 NLP

| Field | Value |
|---|---|
| **ID** | `nlp` |
| **Operations** | `sentiment` · `entities` · `keywords` · `summary` · `classify` · `language_detect` · `toxicity` |
| **LLM operations** | entities · summary · classify · sentiment (long text) |
| **Local operations** | keywords · toxicity · language_detect · sentiment (short text) |

```typescript
await agent.run('nlp', {
  text: 'Apple reported record revenue...',
  operations: ['sentiment', 'entities', 'keywords', 'summary'],
  keywordCount: 10,
  summaryLength: 50,
  sentimentGranularity: 'fine_grained',
}, 'task');
```

---

## Configuration

All configuration is loaded from environment variables with Zod validation.

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | Environment: development · staging · production |
| `AGENT_ID` | `agent-default` | Unique agent identifier for tracing |
| `LOG_LEVEL` | `info` | trace · debug · info · warn · error |
| `REDIS_URL` | — | Redis connection URL (optional, uses in-memory if absent) |
| `OPENAI_API_KEY` | — | Required for NLP entities/summary/classify and data insights |
| `CACHE_ENABLED` | `true` | Toggle result caching globally |
| `RATE_LIMIT_REQUESTS` | `1000` | Global rate limit per window |

---

## Testing

```bash
npm test                    # All tests + coverage report
npm run test:unit           # Unit tests only (no external deps)
npm run test:integration    # Integration tests (requires Redis optional)
npm run test:watch          # Watch mode during development
```

Coverage thresholds enforced by CI (CI fails if below):

| Metric | Minimum |
|---|---|
| Lines | 85% |
| Functions | 85% |
| Branches | 80% |
| Statements | 85% |

---

## Monitoring

### Prometheus Metrics

```typescript
const metrics = agent.metricsPrometheus();
// Returns Prometheus text format:
// skill_executions_total{skill_id="nlp",status="success"} 42
// skill_duration_ms_bucket{le="100",skill_id="nlp"} 38
// skill_errors_total{skill_id="web-scraper",error_code="HTTP_404"} 2
```

### Health Check

```typescript
const health = await agent.healthCheck();
// { healthy: true, skills: { 'nlp': true, 'web-scraper': true, ... } }
```

### Event Bus

```typescript
agent.eventBus.on('skill.failed', async (event) => {
  await alertingService.send({
    skillId: event.skillId,
    error: event.payload.error,
  });
});
```

---

## CI/CD

The `ci/pipeline.yml` GitHub Actions workflow runs:

1. **Lint + TypeCheck** — ESLint + `tsc --noEmit`
2. **Unit Tests** — Jest with 85% coverage gate
3. **Integration Tests** — Against real Redis + mocked LLM APIs
4. **Security Scan** — `npm audit --level=high` + Snyk
5. **Build** — TypeScript compilation
6. **Docker** — Build + push to GHCR (main/develop branches)
7. **Staging Deploy** — Kubernetes rolling update (develop branch)
8. **Production Deploy** — 10% canary → monitor 5 min → full rollout (main branch)

---

## License

MIT — see [LICENSE](LICENSE)
