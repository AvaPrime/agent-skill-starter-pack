/**
 * @module core/cache
 * @description Cache abstraction with Redis primary and in-memory LRU fallback.
 * Falls back gracefully when Redis is unavailable.
 */

import { Logger } from '../monitoring/logger';

export interface CacheClient {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  flush(): Promise<void>;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * In-memory LRU cache — used as a fallback when Redis is unavailable,
 * and for unit tests that do not require a running Redis instance.
 */
export class InMemoryCache implements CacheClient {
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private readonly maxSize: number;
  private readonly logger: Logger;

  constructor(maxSize = 1000, logger?: Logger) {
    this.maxSize = maxSize;
    this.logger = logger ?? new Logger({ name: 'InMemoryCache' });
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (this.store.size >= this.maxSize) {
      // Evict oldest entry (simple strategy)
      const firstKey = this.store.keys().next().value;
      if (firstKey) this.store.delete(firstKey);
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async flush(): Promise<void> {
    this.store.clear();
    this.logger.info({}, 'Cache flushed');
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * Redis-backed cache with transparent in-memory fallback.
 * Import and instantiate only when ioredis is available.
 */
export class RedisCache implements CacheClient {
  private redis: import('ioredis').Redis | null = null;
  private readonly fallback: InMemoryCache;
  private readonly logger: Logger;
  private connected = false;

  constructor(redisUrl: string, logger?: Logger) {
    this.fallback = new InMemoryCache(500, logger);
    this.logger = logger ?? new Logger({ name: 'RedisCache' });
    this.connect(redisUrl);
  }

  private connect(redisUrl: string): void {
    try {
      // Dynamic import to avoid hard dependency in environments without Redis
      const Redis = require('ioredis');
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 2,
        lazyConnect: true,
        enableReadyCheck: true,
      });

      this.redis!.on('ready', () => {
        this.connected = true;
        this.logger.info({}, 'Redis connected');
      });

      this.redis!.on('error', (err) => {
        this.connected = false;
        this.logger.warn({ err: err.message }, 'Redis error — falling back to in-memory cache');
      });
    } catch {
      this.logger.warn({}, 'ioredis not available — using in-memory cache');
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.connected || !this.redis) return this.fallback.get<T>(key);

    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch {
      return this.fallback.get<T>(key);
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (!this.connected || !this.redis) {
      return this.fallback.set(key, value, ttlSeconds);
    }

    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      await this.fallback.set(key, value, ttlSeconds);
    }
  }

  async delete(key: string): Promise<void> {
    await Promise.allSettled([
      this.redis?.del(key),
      this.fallback.delete(key),
    ]);
  }

  async flush(): Promise<void> {
    await Promise.allSettled([
      this.redis?.flushdb(),
      this.fallback.flush(),
    ]);
  }
}
