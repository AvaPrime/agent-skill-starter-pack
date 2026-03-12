/**
 * @module config
 * @description Configuration management with environment-specific overrides,
 * Zod validation, and secure credential resolution.
 *
 * Environment variables take precedence over defaults.
 * Never log or expose credential values.
 */

import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
import type { Environment } from '../core/types';

// Load .env file — silently skipped if file is absent (production uses real env vars)
loadDotenv({ path: resolve(process.cwd(), '.env') });

// ── Configuration Schema ──────────────────────────────────────────────────────

const ConfigSchema = z.object({
  // Application
  environment: z.enum(['development', 'staging', 'production']).default('development'),
  agentId: z.string().default('agent-default'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  prettyLogs: z.boolean().default(false),

  // Server
  port: z.number().default(3000),
  host: z.string().default('0.0.0.0'),

  // Redis (optional — falls back to in-memory cache)
  redisUrl: z.string().optional(),
  cacheEnabled: z.boolean().default(true),

  // LLM Providers
  openaiApiKey: z.string().optional(),
  anthropicApiKey: z.string().optional(),
  defaultModel: z.string().default('gpt-4o-mini'),

  // Security
  apiSecretKey: z.string().optional(),
  allowedOrigins: z.array(z.string()).default(['*']),

  // Rate Limiting
  globalRateLimitRequests: z.number().default(1000),
  globalRateLimitWindowMs: z.number().default(60000),

  // Skill-specific
  skills: z.object({
    webScraper: z.object({
      maxConcurrency: z.number().default(5),
      defaultTimeoutMs: z.number().default(15000),
      userAgent: z.string().default('AgentSkillBot/1.0'),
    }).default({}),
    dataAnalysis: z.object({
      maxDataRows: z.number().default(100000),
      insightsEnabled: z.boolean().default(true),
    }).default({}),
    apiIntegration: z.object({
      maxConcurrency: z.number().default(20),
      defaultTimeoutMs: z.number().default(30000),
    }).default({}),
    nlp: z.object({
      maxTextLength: z.number().default(50000),
      llmEnabled: z.boolean().default(true),
    }).default({}),
  }).default({}),

  // Monitoring
  metricsEnabled: z.boolean().default(true),
  healthCheckIntervalMs: z.number().default(30000),
  alertWebhookUrl: z.string().url().optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

// ── Config Builder ────────────────────────────────────────────────────────────

function buildConfig(): AppConfig {
  const raw = {
    environment: process.env['NODE_ENV'] as Environment,
    agentId: process.env['AGENT_ID'],
    logLevel: process.env['LOG_LEVEL'],
    prettyLogs: process.env['PRETTY_LOGS'] === 'true',
    port: process.env['PORT'] ? parseInt(process.env['PORT']!, 10) : undefined,
    host: process.env['HOST'],
    redisUrl: process.env['REDIS_URL'],
    cacheEnabled: process.env['CACHE_ENABLED'] !== 'false',
    openaiApiKey: process.env['OPENAI_API_KEY'],
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'],
    defaultModel: process.env['DEFAULT_MODEL'],
    apiSecretKey: process.env['API_SECRET_KEY'],
    allowedOrigins: process.env['ALLOWED_ORIGINS']?.split(','),
    globalRateLimitRequests: process.env['RATE_LIMIT_REQUESTS']
      ? parseInt(process.env['RATE_LIMIT_REQUESTS']!, 10)
      : undefined,
    globalRateLimitWindowMs: process.env['RATE_LIMIT_WINDOW_MS']
      ? parseInt(process.env['RATE_LIMIT_WINDOW_MS']!, 10)
      : undefined,
    metricsEnabled: process.env['METRICS_ENABLED'] !== 'false',
    alertWebhookUrl: process.env['ALERT_WEBHOOK_URL'],
  };

  // Remove undefined keys so Zod defaults kick in
  const filtered = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined),
  );

  const parsed = ConfigSchema.safeParse(filtered);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  return parsed.data;
}

// ── Singleton Config ──────────────────────────────────────────────────────────

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_config) {
    _config = buildConfig();
  }
  return _config;
}

/** Reset config (for tests) */
export function resetConfig(): void {
  _config = null;
}

/** Create a safe copy of config with credentials redacted (for logging) */
export function getSafeConfig(): Partial<AppConfig> {
  const config = getConfig();
  return {
    ...config,
    openaiApiKey: config.openaiApiKey ? '[REDACTED]' : undefined,
    anthropicApiKey: config.anthropicApiKey ? '[REDACTED]' : undefined,
    apiSecretKey: config.apiSecretKey ? '[REDACTED]' : undefined,
    redisUrl: config.redisUrl ? '[REDACTED]' : undefined,
  };
}

export default getConfig;
