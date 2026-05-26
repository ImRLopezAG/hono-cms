/**
 * Backend-shared types for the bundled cache adapters.
 *
 * Each named factory in `packages/cache` constructs one of these adapters and
 * wraps it in a `Plugin` that registers under the service id `"cache"`. The
 * factory option shapes live here so the public surface in `index.ts` stays
 * small and so adapter implementations can be lazily imported when wanted.
 */

export type MemoryCacheConfig = {
  provider?: "memory";
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
  provider?: "upstash";
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
  provider?: "kv";
  binding: KVNamespaceLike;
};
