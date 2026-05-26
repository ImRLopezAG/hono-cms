import { describe, expect, test, vi } from "vitest";
import { createUpstashCache, UpstashCacheAdapter, type RateLimiterLike, type UpstashRedisLike } from "../index";

describe("UpstashCacheAdapter", () => {
  test("reads JSON strings, native Redis values, misses, and health", async () => {
    const redis = redisClient({
      json: JSON.stringify({ ok: true }),
      native: { fromRedis: true }
    });
    const cache = new UpstashCacheAdapter({ provider: "upstash", redis });

    await expect(cache.get("json")).resolves.toEqual({ ok: true });
    await expect(cache.get("native")).resolves.toEqual({ fromRedis: true });
    await expect(cache.get("missing")).resolves.toBeNull();
    await expect(cache.health()).resolves.toEqual({ ok: true, details: { provider: "upstash" } });
  });

  test("writes, expires, and deletes Redis cache entries", async () => {
    const redis = redisClient();
    const cache = new UpstashCacheAdapter({ provider: "upstash", redis });

    await cache.set("stable", { value: 1 });
    await cache.set("ttl", ["cached"], { ttl: 30 });
    await cache.delete("stable");

    expect(redis.set).toHaveBeenCalledWith("stable", JSON.stringify({ value: 1 }));
    expect(redis.set).toHaveBeenCalledWith("ttl", JSON.stringify(["cached"]), { ex: 30 });
    expect(redis.del).toHaveBeenCalledWith("stable");
  });

  test("deletes wildcard patterns with Redis SCAN batches", async () => {
    const keys = Array.from({ length: 105 }, (_, index) => `content:article:${index}`);
    const redis = redisClient({}, [
      [7, keys.slice(0, 60)],
      [0, keys.slice(60)]
    ]);
    const cache = new UpstashCacheAdapter({ provider: "upstash", redis });

    await cache.deletePattern("content:article:*");

    expect(redis.scan).toHaveBeenNthCalledWith(1, 0, { match: "content:article:*", count: 100 });
    expect(redis.scan).toHaveBeenNthCalledWith(2, 7, { match: "content:article:*", count: 100 });
    expect(redis.del).toHaveBeenNthCalledWith(1, ...keys.slice(0, 100));
    expect(redis.del).toHaveBeenNthCalledWith(2, ...keys.slice(100));
  });

  test("skips Redis delete when a pattern scan finds no keys", async () => {
    const redis = redisClient({}, [[0, []]]);
    const cache = new UpstashCacheAdapter({ provider: "upstash", redis });

    await cache.deletePattern("content:missing:*");

    expect(redis.scan).toHaveBeenCalledWith(0, { match: "content:missing:*", count: 100 });
    expect(redis.del).not.toHaveBeenCalled();
  });

  test("uses injected Upstash rate limiters and reuses them per policy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00.000Z"));
    try {
      const redis = redisClient();
      const limiter: RateLimiterLike = {
        limit: vi.fn(async () => ({ success: false, remaining: 0, reset: Date.parse("2026-05-22T00:01:00.000Z") }))
      };
      const rateLimiterFactory = vi.fn(() => limiter);
      const cache = new UpstashCacheAdapter({ provider: "upstash", redis, rateLimiterFactory });
      const options = { limit: 2, window: "1 m", prefix: "cms:test" };

      await expect(cache.checkRateLimit("203.0.113.20", options)).resolves.toEqual({
        success: false,
        remaining: 0,
        resetAt: "2026-05-22T00:01:00.000Z"
      });
      await expect(cache.checkRateLimit("203.0.113.21", options)).resolves.toMatchObject({ success: false, remaining: 0 });

      expect(rateLimiterFactory).toHaveBeenCalledTimes(1);
      expect(rateLimiterFactory).toHaveBeenCalledWith({ redis, limit: 2, window: "1 m", prefix: "cms:test" });
      expect(limiter.limit).toHaveBeenNthCalledWith(1, "203.0.113.20");
      expect(limiter.limit).toHaveBeenNthCalledWith(2, "203.0.113.21");
    } finally {
      vi.useRealTimers();
    }
  });

  test("registers the Upstash provider factory", async () => {
    const redis = redisClient();
    const cache = createUpstashCache({ provider: "upstash", redis });

    expect(cache).toBeInstanceOf(UpstashCacheAdapter);
    await expect(cache.sweep()).resolves.toEqual({ swept: 0 });
  });
});

function redisClient(values: Record<string, unknown> = {}, scanBatches: Array<[number | string, string[]]> = [[0, []]]): UpstashRedisLike {
  let scanIndex = 0;
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
    set: vi.fn(async () => "OK"),
    del: vi.fn(async () => 1),
    scan: vi.fn(async () => scanBatches[scanIndex++] ?? [0, []])
  };
}
