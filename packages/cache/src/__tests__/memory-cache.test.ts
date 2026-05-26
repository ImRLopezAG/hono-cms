import { afterEach, describe, expect, test, vi } from "vitest";
import { MemoryCacheAdapter, createMemoryCache } from "../index";

describe("MemoryCacheAdapter", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("stores values, expires TTL entries, and reports health", async () => {
    vi.useFakeTimers();
    try {
      const cache = createMemoryCache();
      await cache.set("stable", { ok: true });
      await cache.set("short", "value", { ttl: 10 });

      await expect(cache.get("stable")).resolves.toEqual({ ok: true });
      await expect(cache.get("short")).resolves.toBe("value");

      vi.advanceTimersByTime(10_001);
      await expect(cache.get("short")).resolves.toBeNull();
      await expect(cache.get("stable")).resolves.toEqual({ ok: true });
      await expect(cache.health()).resolves.toMatchObject({ ok: true, details: { entries: 1 } });
    } finally {
      vi.useRealTimers();
    }
  });

  test("deletes exact keys and wildcard prefixes without broad accidental matches", async () => {
    const cache = new MemoryCacheAdapter();
    await cache.set("content:article", 1);
    await cache.set("content:article:draft", 2);
    await cache.set("content:page", 3);

    await cache.deletePattern("content:article");
    await expect(cache.get("content:article")).resolves.toBeNull();
    await expect(cache.get("content:article:draft")).resolves.toBe(2);
    await expect(cache.get("content:page")).resolves.toBe(3);

    await cache.deletePattern("content:*");
    await expect(cache.get("content:article:draft")).resolves.toBeNull();
    await expect(cache.get("content:page")).resolves.toBeNull();
  });

  test("tracks rate limits per prefix and identifier within a sliding window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00.000Z"));
    try {
      const cache = createMemoryCache();
      const options = { limit: 2, window: "1 m", prefix: "cms:test" };

      await expect(cache.checkRateLimit("203.0.113.20", options)).resolves.toMatchObject({ success: true, remaining: 1 });
      await expect(cache.checkRateLimit("203.0.113.20", options)).resolves.toMatchObject({ success: true, remaining: 0 });
      await expect(cache.checkRateLimit("203.0.113.20", options)).resolves.toMatchObject({
        success: false,
        remaining: 0,
        resetAt: "2026-05-22T00:01:00.000Z"
      });

      await expect(cache.checkRateLimit("203.0.113.20", { ...options, prefix: "cms:other" })).resolves.toMatchObject({ success: true, remaining: 1 });
      await expect(cache.checkRateLimit("203.0.113.21", options)).resolves.toMatchObject({ success: true, remaining: 1 });

      vi.advanceTimersByTime(60_001);
      await expect(cache.checkRateLimit("203.0.113.20", options)).resolves.toMatchObject({ success: true, remaining: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("sweeps expired TTL entries and stale rate-limit buckets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00.000Z"));
    try {
      const cache = createMemoryCache();
      cache.destroy();
      await cache.set("stable", "kept");
      await cache.set("short", "expired", { ttl: 10 });
      await cache.checkRateLimit("203.0.113.20", { limit: 2, window: "1 m", prefix: "cms:test" });
      await cache.checkRateLimit("203.0.113.20", { limit: 2, window: "1 m", prefix: "cms:test" });

      vi.advanceTimersByTime(60_001);
      await expect(cache.sweep()).resolves.toEqual({ swept: 3 });
      await expect(cache.get("stable")).resolves.toBe("kept");
      await expect(cache.get("short")).resolves.toBeNull();
      await expect(cache.health()).resolves.toMatchObject({ ok: true, details: { entries: 1 } });
      await expect(cache.sweep()).resolves.toEqual({ swept: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects unsupported rate limit windows", async () => {
    const cache = createMemoryCache();
    await expect(cache.checkRateLimit("client", { limit: 1, window: "1 day" })).rejects.toThrow("Unsupported rate limit window");
  });

  test("periodically sweeps expired entries and can destroy the cleanup timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00.000Z"));
    const cache = createMemoryCache();
    await cache.set("short", "expired", { ttl: 10 });

    vi.advanceTimersByTime(60_000);

    await expect(cache.get("short")).resolves.toBeNull();
    await expect(cache.health()).resolves.toMatchObject({ ok: true, details: { entries: 0 } });
    cache.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("warns when memory cache is selected in production", () => {
    process.env.NODE_ENV = "production";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const cache = createMemoryCache();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Memory cache provider selected in production"));
    cache.destroy();
  });
});
