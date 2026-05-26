import { registerProvider, type CacheAdapter } from "@hono-cms/core";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis/cloudflare";

export type MemoryCacheConfig = {
  provider: "memory";
};

export type UpstashRedisLike = {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: string, options?: { ex?: number }): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  scan(cursor: number | string, options?: { match?: string; count?: number }): Promise<[number | string, string[]]>;
};

export type RateLimiterLike = {
  limit(identifier: string): Promise<{ success: boolean; remaining: number; reset?: number }>;
};

export type UpstashCacheConfig = {
  provider: "upstash";
  url?: string;
  token?: string;
  env?: Record<string, unknown>;
  redis?: UpstashRedisLike;
  rateLimiterFactory?: (options: { redis: UpstashRedisLike; limit: number; window: string; prefix?: string }) => RateLimiterLike;
};

export type KVNamespaceLike = {
  get(key: string, type?: "text"): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

export type KVCacheConfig = {
  provider: "kv";
  binding: KVNamespaceLike;
};

type Entry = {
  value: unknown;
  expiresAt?: number;
};

export class UpstashCacheAdapter implements CacheAdapter {
  readonly provider = "upstash";
  private readonly redis: UpstashRedisLike;
  private readonly rateLimiters = new Map<string, RateLimiterLike>();
  private readonly rateLimiterFactory: NonNullable<UpstashCacheConfig["rateLimiterFactory"]>;

  constructor(config: UpstashCacheConfig) {
    this.redis = config.redis ?? createRedis(config);
    this.rateLimiterFactory = config.rateLimiterFactory ?? ((options) => new Ratelimit({
      redis: options.redis as never,
      limiter: Ratelimit.slidingWindow(options.limit, options.window as Parameters<typeof Ratelimit.slidingWindow>[1]),
      analytics: true,
      ...(options.prefix ? { prefix: options.prefix } : {})
    }) as RateLimiterLike);
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = await this.redis.get<unknown>(key);
    if (value === null) return null;
    if (typeof value === "string") return JSON.parse(value) as T;
    return value as T;
  }

  async set<T = unknown>(key: string, value: T, options: { ttl?: number } = {}): Promise<void> {
    const serialized = JSON.stringify(value);
    if (options.ttl === undefined) {
      await this.redis.set(key, serialized);
      return;
    }
    await this.redis.set(key, serialized, { ex: options.ttl });
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async deletePattern(pattern: string): Promise<void> {
    let cursor: number | string = 0;
    const keys: string[] = [];
    do {
      const [nextCursor, batch] = await this.redis.scan(cursor, { match: pattern, count: 100 });
      cursor = nextCursor;
      keys.push(...batch);
    } while (String(cursor) !== "0");

    if (keys.length === 0) return;
    for (let index = 0; index < keys.length; index += 100) {
      await this.redis.del(...keys.slice(index, index + 100));
    }
  }

  async sweep(): Promise<{ swept: number }> {
    return { swept: 0 };
  }

  async checkRateLimit(identifier: string, options: { limit: number; window: string; prefix?: string }): Promise<{ success: boolean; remaining: number; resetAt?: string }> {
    const key = `${options.prefix ?? "@hono-cms/ratelimit"}:${options.limit}:${options.window}`;
    const limiterOptions: { redis: UpstashRedisLike; limit: number; window: string; prefix?: string } = {
      redis: this.redis,
      limit: options.limit,
      window: options.window,
      ...(options.prefix ? { prefix: options.prefix } : {})
    };
    const limiter = this.rateLimiters.get(key) ?? this.rateLimiterFactory(limiterOptions);
    this.rateLimiters.set(key, limiter);
    const result = await limiter.limit(identifier);
    return {
      success: result.success,
      remaining: result.remaining,
      ...(result.reset ? { resetAt: new Date(result.reset).toISOString() } : {})
    };
  }

  async health(): Promise<{ ok: boolean; details: { provider: string } }> {
    return { ok: true, details: { provider: this.provider } };
  }
}

/**
 * Cloudflare KV-backed cache.
 *
 * KV is eventually consistent, so this provider is suitable for content response
 * caching, not security-sensitive session caching or atomic distributed rate
 * limiting. Pattern deletion is intentionally a warned no-op and entries expire
 * by TTL.
 */
export class KVCacheAdapter implements CacheAdapter {
  readonly provider = "kv";

  constructor(private readonly binding: KVNamespaceLike) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = await this.binding.get(key, "text");
    return value === null ? null : JSON.parse(value) as T;
  }

  async set<T = unknown>(key: string, value: T, options: { ttl?: number } = {}): Promise<void> {
    const serialized = JSON.stringify(value);
    if (options.ttl === undefined) {
      await this.binding.put(key, serialized);
      return;
    }
    const expirationTtl = Math.max(60, options.ttl);
    if (expirationTtl !== options.ttl) {
      console.warn(`[hono-cms/cache] KV provider requires expirationTtl >= 60 seconds. Clamped ${options.ttl}s to 60s for key "${key}".`);
    }
    await this.binding.put(key, serialized, { expirationTtl });
  }

  async delete(key: string): Promise<void> {
    await this.binding.delete(key);
  }

  async deletePattern(pattern: string): Promise<void> {
    console.warn(`[hono-cms/cache] KV provider does not support deletePattern. Pattern: ${pattern}. Keys will expire by TTL.`);
  }

  async sweep(): Promise<{ swept: number }> {
    return { swept: 0 };
  }

  async checkRateLimit(): Promise<{ success: boolean; remaining: number }> {
    console.warn("[hono-cms/cache] KV provider does not support atomic rate limiting. Rate limiting is disabled.");
    return { success: true, remaining: 999 };
  }

  async health(): Promise<{ ok: boolean; details: { provider: string; rateLimiting: "disabled" } }> {
    return { ok: true, details: { provider: this.provider, rateLimiting: "disabled" } };
  }
}

export class MemoryCacheAdapter implements CacheAdapter {
  readonly provider = "memory";
  private readonly entries = new Map<string, Entry>();
  private readonly rateLimits = new Map<string, number[]>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor() {
    const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
    if (proc?.env?.NODE_ENV === "production") {
      console.warn("[hono-cms/cache] Memory cache provider selected in production. This provider is not distributed; use Upstash Redis for multi-process or edge deployments.");
    }
    // Defer setInterval until first request — Cloudflare Workers / edge runtimes
    // disallow async I/O (incl. setTimeout/setInterval) in global scope.
  }

  private ensureCleanupTimer(): void {
    if (this.destroyed) return;
    if (this.cleanupTimer !== null) return;
    if (typeof setInterval !== "function") return;
    const handle = setInterval(() => {
      void this.sweep();
    }, 60_000);
    if (typeof handle === "object" && handle !== null && "unref" in handle && typeof (handle as { unref: () => void }).unref === "function") {
      (handle as { unref: () => void }).unref();
    }
    this.cleanupTimer = handle;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T = unknown>(key: string, value: T, options: { ttl?: number } = {}): Promise<void> {
    this.ensureCleanupTimer();
    const entry: Entry = { value };
    if (options.ttl) entry.expiresAt = Date.now() + options.ttl * 1000;
    this.entries.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async deletePattern(pattern: string): Promise<void> {
    const wildcard = pattern.endsWith("*");
    const prefix = wildcard ? pattern.slice(0, -1) : pattern;
    for (const key of this.entries.keys()) {
      if (wildcard ? key.startsWith(prefix) : key === pattern) this.entries.delete(key);
    }
  }

  async sweep(): Promise<{ swept: number }> {
    const now = Date.now();
    let swept = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt && entry.expiresAt <= now) {
        this.entries.delete(key);
        swept += 1;
      }
    }
    for (const [key, timestamps] of this.rateLimits) {
      const recent = timestamps.filter((timestamp) => timestamp > now);
      if (recent.length === 0) {
        this.rateLimits.delete(key);
        swept += timestamps.length;
      } else if (recent.length !== timestamps.length) {
        this.rateLimits.set(key, recent);
        swept += timestamps.length - recent.length;
      }
    }
    return { swept };
  }

  async checkRateLimit(identifier: string, options: { limit: number; window: string; prefix?: string }): Promise<{ success: boolean; remaining: number; resetAt?: string }> {
    this.ensureCleanupTimer();
    const windowMs = parseWindowMs(options.window);
    const now = Date.now();
    const key = `${options.prefix ?? "rate-limit"}:${identifier}`;
    const recent = (this.rateLimits.get(key) ?? []).filter((timestamp) => timestamp > now);
    const resetAt = new Date(recent[0] ?? now + windowMs).toISOString();
    if (recent.length >= options.limit) {
      this.rateLimits.set(key, recent);
      return { success: false, remaining: 0, resetAt };
    }
    recent.push(now + windowMs);
    this.rateLimits.set(key, recent);
    return { success: true, remaining: Math.max(0, options.limit - recent.length), resetAt };
  }

  async health(): Promise<{ ok: boolean; details: { entries: number } }> {
    return { ok: true, details: { entries: this.entries.size } };
  }
}

function parseWindowMs(window: string): number {
  const match = window.trim().match(/^(\d+)\s*(ms|s|m|h)$/);
  if (!match?.[1] || !match[2]) throw new Error(`Unsupported rate limit window "${window}". Use values like "30 s", "1 m", or "1 h".`);
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60_000;
  return amount * 3_600_000;
}

export function createMemoryCache(): MemoryCacheAdapter {
  return new MemoryCacheAdapter();
}

export function createUpstashCache(config: UpstashCacheConfig): UpstashCacheAdapter {
  return new UpstashCacheAdapter(config);
}

export function createKVCache(config: KVCacheConfig): KVCacheAdapter {
  console.warn("[hono-cms/cache] KV provider selected. Session caching should fall back to in-memory because KV is eventually consistent. Rate limiting is disabled.");
  return new KVCacheAdapter(config.binding);
}

function createRedis(config: UpstashCacheConfig): UpstashRedisLike {
  if (config.url && config.token) return new Redis({ url: config.url, token: config.token }) as UpstashRedisLike;
  if (config.env) return Redis.fromEnv(config.env as Parameters<typeof Redis.fromEnv>[0]) as UpstashRedisLike;
  return Redis.fromEnv() as UpstashRedisLike;
}

registerProvider<UpstashCacheConfig, CacheAdapter>("cache", "upstash", createUpstashCache);
registerProvider<MemoryCacheConfig, CacheAdapter>("cache", "memory", createMemoryCache);
registerProvider<KVCacheConfig, CacheAdapter>("cache", "kv", createKVCache);
