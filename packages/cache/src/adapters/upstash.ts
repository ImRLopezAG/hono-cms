import type { CacheAdapter } from "@hono-cms/core";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis/cloudflare";
import type { RateLimiterLike, UpstashCacheConfig, UpstashRedisLike } from "./types";

/**
 * Upstash Redis-backed cache adapter.
 *
 * Distributed, atomic, and rate-limit capable — appropriate for production
 * multi-region deployments. Rate limiters are constructed lazily and cached
 * by `(prefix, limit, window)` so repeated `checkRateLimit` calls don't pay
 * the construction cost.
 */
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

/** Convenience factory; identical to `new UpstashCacheAdapter(config)`. */
export function createUpstashCache(config: UpstashCacheConfig): UpstashCacheAdapter {
  return new UpstashCacheAdapter(config);
}

function createRedis(config: UpstashCacheConfig): UpstashRedisLike {
  if (config.url && config.token) return new Redis({ url: config.url, token: config.token }) as UpstashRedisLike;
  if (config.env) return Redis.fromEnv(config.env as Parameters<typeof Redis.fromEnv>[0]) as UpstashRedisLike;
  return Redis.fromEnv() as UpstashRedisLike;
}
