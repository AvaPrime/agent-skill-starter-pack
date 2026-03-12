/**
 * @module skills/api-integration
 * @description Generic REST/GraphQL API integration skill.
 * Handles OAuth2 token refresh, pagination, retries, request signing,
 * and webhook event forwarding.
 *
 * @example
 * ```ts
 * const result = await executor.run(apiIntegrationSkill, {
 *   baseUrl: 'https://api.github.com',
 *   endpoint: '/repos/octocat/hello-world/issues',
 *   method: 'GET',
 *   auth: { type: 'bearer', token: process.env.GITHUB_TOKEN },
 *   pagination: { strategy: 'cursor', pageSize: 30 },
 * }, taskId);
 * ```
 */

import { z } from 'zod';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseSkill } from '../../core/base-skill';
import { SkillDefinition, ExecutionContext } from '../../core/types';
import { SkillExecutionError } from '../../core/executor';

// ── Auth Schemas ──────────────────────────────────────────────────────────────

const BearerAuthSchema = z.object({ type: z.literal('bearer'), token: z.string() });
const BasicAuthSchema = z.object({
  type: z.literal('basic'),
  username: z.string(),
  password: z.string(),
});
const ApiKeyAuthSchema = z.object({
  type: z.literal('api_key'),
  key: z.string(),
  header: z.string().default('X-API-Key'),
});
const OAuth2Schema = z.object({
  type: z.literal('oauth2'),
  clientId: z.string(),
  clientSecret: z.string(),
  tokenUrl: z.string().url(),
  scope: z.string().optional(),
});

const AuthSchema = z.discriminatedUnion('type', [
  BearerAuthSchema,
  BasicAuthSchema,
  ApiKeyAuthSchema,
  OAuth2Schema,
]);

// ── Pagination Schemas ────────────────────────────────────────────────────────

const OffsetPaginationSchema = z.object({
  strategy: z.literal('offset'),
  pageSize: z.number().default(100),
  offsetParam: z.string().default('offset'),
  limitParam: z.string().default('limit'),
  maxPages: z.number().default(10),
  dataPath: z.string().optional(), // e.g. 'results' to extract from response.results
  totalPath: z.string().optional(), // e.g. 'total' to read total count
});

const CursorPaginationSchema = z.object({
  strategy: z.literal('cursor'),
  pageSize: z.number().default(100),
  cursorParam: z.string().default('cursor'),
  nextCursorPath: z.string().default('next_cursor'),
  maxPages: z.number().default(10),
  dataPath: z.string().optional(),
});

const LinkHeaderPaginationSchema = z.object({
  strategy: z.literal('link_header'), // GitHub-style
  maxPages: z.number().default(10),
  dataPath: z.string().optional(),
});

const PaginationSchema = z.discriminatedUnion('strategy', [
  OffsetPaginationSchema,
  CursorPaginationSchema,
  LinkHeaderPaginationSchema,
]);

// ── Input Schema ──────────────────────────────────────────────────────────────

export const ApiIntegrationInputSchema = z.object({
  baseUrl: z.string().url(),
  endpoint: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  headers: z.record(z.string()).optional(),
  queryParams: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  body: z.unknown().optional(),
  auth: AuthSchema.optional(),
  pagination: PaginationSchema.optional(),
  timeoutMs: z.number().default(30000),
  /** Expected response shape for validation (JSON schema subset) */
  responseMapping: z.record(z.string()).optional(),
  /** Retry on these HTTP status codes */
  retryOnStatus: z.array(z.number()).default([429, 503, 504]),
  /** Transform the response before returning */
  transform: z.enum(['none', 'flatten', 'normalize_keys']).default('none'),
  /** Whether to collect all paginated pages into a single array */
  collectAllPages: z.boolean().default(true),
});

export type ApiIntegrationInput = z.infer<typeof ApiIntegrationInputSchema>;

// ── Output Schema ─────────────────────────────────────────────────────────────

export const ApiIntegrationOutputSchema = z.object({
  statusCode: z.number(),
  data: z.unknown(),
  headers: z.record(z.string()),
  totalRecords: z.number().optional(),
  pagesFetched: z.number(),
  requestId: z.string().optional(),
  rateLimitRemaining: z.number().optional(),
  rateLimitReset: z.string().optional(),
  requestedAt: z.string(),
  durationMs: z.number(),
});

export type ApiIntegrationOutput = z.infer<typeof ApiIntegrationOutputSchema>;

// ── Skill Definition ──────────────────────────────────────────────────────────

export const apiIntegrationDefinition: SkillDefinition<ApiIntegrationInput, ApiIntegrationOutput> =
  {
    id: 'api-integration',
    name: 'API Integration',
    version: '1.0.0',
    description: 'Generic REST API client with OAuth2, pagination, retry, and response mapping.',
    inputSchema: ApiIntegrationInputSchema,
    outputSchema: ApiIntegrationOutputSchema,
    category: 'api-integration',
    tags: ['rest', 'http', 'oauth2', 'pagination', 'integration'],
    supportsStreaming: false,
    maxConcurrency: 20,
    config: {
      timeoutMs: 30000,
      maxRetries: 3,
      retryDelayMs: 1000,
      retryBackoffMultiplier: 2,
      cacheTtlSeconds: 60,
      rateLimit: { maxRequests: 50, windowMs: 60000 },
    },
  };

// ── Token Cache (in-process) ──────────────────────────────────────────────────

interface TokenEntry {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, TokenEntry>();

// ── Skill Implementation ──────────────────────────────────────────────────────

export class ApiIntegrationSkill extends BaseSkill<ApiIntegrationInput, ApiIntegrationOutput> {
  readonly definition = apiIntegrationDefinition;

  protected async executeImpl(
    input: ApiIntegrationInput,
    context: ExecutionContext,
  ): Promise<ApiIntegrationOutput> {
    const start = Date.now();

    // Resolve auth headers
    const authHeaders = await this.resolveAuth(input.auth);

    // Build base request config
    const baseConfig: AxiosRequestConfig = {
      baseURL: input.baseUrl,
      method: input.method,
      timeout: input.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'AgentSkillBot/1.0',
        ...authHeaders,
        ...input.headers,
      },
      params: input.queryParams,
      data: input.body,
      validateStatus: null, // handle all status codes manually
    };

    // Execute (with or without pagination)
    if (input.pagination && input.collectAllPages) {
      return this.executePaginated(input, baseConfig, start, context);
    }

    return this.executeSingle(input, baseConfig, start);
  }

  // ── Single Request ────────────────────────────────────────────────────────

  private async executeSingle(
    input: ApiIntegrationInput,
    config: AxiosRequestConfig,
    start: number,
  ): Promise<ApiIntegrationOutput> {
    this.trackApiCall();

    const response = await axios.request<unknown>({ ...config, url: input.endpoint });

    if (!this.isSuccess(response.status) && !input.retryOnStatus.includes(response.status)) {
      throw new SkillExecutionError(
        `API returned ${response.status}: ${JSON.stringify(response.data).substring(0, 200)}`,
        `HTTP_${response.status}`,
        input.retryOnStatus.includes(response.status),
      );
    }

    const data = this.transformResponse(response.data, input.transform);

    return {
      statusCode: response.status,
      data,
      headers: response.headers as Record<string, string>,
      pagesFetched: 1,
      requestId: response.headers['x-request-id'] as string | undefined,
      rateLimitRemaining: response.headers['x-ratelimit-remaining']
        ? parseInt(response.headers['x-ratelimit-remaining'] as string)
        : undefined,
      rateLimitReset: response.headers['x-ratelimit-reset'] as string | undefined,
      requestedAt: new Date(start).toISOString(),
      durationMs: Date.now() - start,
    };
  }

  // ── Paginated Requests ────────────────────────────────────────────────────

  private async executePaginated(
    input: ApiIntegrationInput,
    baseConfig: AxiosRequestConfig,
    start: number,
    _context: ExecutionContext,
  ): Promise<ApiIntegrationOutput> {
    const pagination = input.pagination!;
    const allData: unknown[] = [];
    let pagesFetched = 0;
    let lastResponse: AxiosResponse | null = null;
    const baseParams = (baseConfig.params ?? {}) as Record<string, unknown>;

    if (pagination.strategy === 'offset') {
      for (let page = 0; page < pagination.maxPages; page++) {
        this.trackApiCall();
        const response = await axios.request<unknown>({
          ...baseConfig,
          url: input.endpoint,
          params: {
            ...baseParams,
            [pagination.limitParam]: pagination.pageSize,
            [pagination.offsetParam]: page * pagination.pageSize,
          },
        });

        const pageData = pagination.dataPath
          ? this.getNestedValue(response.data, pagination.dataPath)
          : response.data;

        const items = Array.isArray(pageData) ? (pageData as unknown[]) : [pageData];
        allData.push(...items);
        lastResponse = response;
        pagesFetched++;

        if (items.length < pagination.pageSize) break; // last page
      }
    } else if (pagination.strategy === 'cursor') {
      let cursor: string | undefined;
      for (let page = 0; page < pagination.maxPages; page++) {
        this.trackApiCall();
        const response = await axios.request<unknown>({
          ...baseConfig,
          url: input.endpoint,
          params: {
            ...baseParams,
            [pagination.cursorParam]: cursor,
            limit: pagination.pageSize,
          },
        });

        const pageData = pagination.dataPath
          ? this.getNestedValue(response.data, pagination.dataPath)
          : response.data;

        const items = Array.isArray(pageData) ? (pageData as unknown[]) : [pageData];
        allData.push(...items);
        lastResponse = response;
        pagesFetched++;

        const next = this.getNestedValue(response.data, pagination.nextCursorPath);
        cursor = typeof next === 'string' ? next : undefined;
        if (!cursor) break;
      }
    } else if (pagination.strategy === 'link_header') {
      let nextUrl: string | null = `${input.baseUrl}${input.endpoint}`;
      for (let page = 0; page < pagination.maxPages && nextUrl; page++) {
        this.trackApiCall();
        const response = await axios.request<unknown>({
          ...baseConfig,
          url: nextUrl,
          baseURL: undefined,
        });

        const pageData = pagination.dataPath
          ? this.getNestedValue(response.data, pagination.dataPath)
          : response.data;

        allData.push(...(Array.isArray(pageData) ? (pageData as unknown[]) : [pageData]));
        lastResponse = response;
        pagesFetched++;

        nextUrl = this.parseLinkHeader(response.headers['link'] as string | undefined);
      }
    }

    return {
      statusCode: lastResponse?.status ?? 200,
      data: allData,
      headers: (lastResponse?.headers ?? {}) as Record<string, string>,
      totalRecords: allData.length,
      pagesFetched,
      requestedAt: new Date(start).toISOString(),
      durationMs: Date.now() - start,
    };
  }

  // ── Auth Resolution ───────────────────────────────────────────────────────

  private async resolveAuth(auth: ApiIntegrationInput['auth']): Promise<Record<string, string>> {
    if (!auth) return {};

    if (auth.type === 'bearer') return { Authorization: `Bearer ${auth.token}` };
    if (auth.type === 'basic') {
      const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      return { Authorization: `Basic ${encoded}` };
    }
    if (auth.type === 'api_key') return { [auth.header]: auth.key };
    if (auth.type === 'oauth2') {
      const token = await this.getOAuth2Token(auth);
      return { Authorization: `Bearer ${token}` };
    }

    return {};
  }

  private async getOAuth2Token(auth: z.infer<typeof OAuth2Schema>): Promise<string> {
    const cacheKey = `${auth.clientId}:${auth.tokenUrl}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.token;

    this.trackApiCall();
    const response = await axios.post(
      auth.tokenUrl,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
        ...(auth.scope ? { scope: auth.scope } : {}),
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    const { access_token, expires_in } = response.data as {
      access_token: string;
      expires_in: number;
    };
    tokenCache.set(cacheKey, {
      token: access_token,
      expiresAt: Date.now() + (expires_in - 60) * 1000, // 60s buffer
    });

    return access_token;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private isSuccess(status: number): boolean {
    return status >= 200 && status < 300;
  }

  private transformResponse(data: unknown, transform: ApiIntegrationInput['transform']): unknown {
    if (transform === 'flatten' && typeof data === 'object' && data !== null) {
      return this.flatten(data as Record<string, unknown>);
    }
    if (transform === 'normalize_keys' && typeof data === 'object' && data !== null) {
      return this.normalizeKeys(data as Record<string, unknown>);
    }
    return data;
  }

  private flatten(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
    return Object.entries(obj).reduce<Record<string, unknown>>((acc, [key, val]) => {
      const newKey = prefix ? `${prefix}.${key}` : key;
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        Object.assign(acc, this.flatten(val as Record<string, unknown>, newKey));
      } else {
        acc[newKey] = val;
      }
      return acc;
    }, {});
  }

  private normalizeKeys(obj: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [
        k.replace(/([A-Z])/g, '_$1').toLowerCase(),
        typeof v === 'object' && v !== null && !Array.isArray(v)
          ? this.normalizeKeys(v as Record<string, unknown>)
          : v,
      ]),
    );
  }

  private getNestedValue(obj: unknown, path: string): unknown {
    return path.split('.').reduce((cur, key) => (cur as Record<string, unknown>)?.[key], obj);
  }

  private parseLinkHeader(header: string | undefined): string | null {
    if (!header) return null;
    const match = header.match(/<([^>]+)>;\s*rel="next"/);
    return match?.[1] ?? null;
  }
}

export const apiIntegrationSkill = new ApiIntegrationSkill();
