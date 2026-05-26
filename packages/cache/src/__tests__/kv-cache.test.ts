import { describe, expect, test, vi } from "vitest";
import { createKVCache, KVCacheAdapter, type KVNamespaceLike } from "../index";

describe("KVCacheAdapter", () => {
  test("reads, writes, deletes, and reports health through a KV binding", async () => {
    const binding = kvBinding({ hit: JSON.stringify({ ok: true }) });
    const cache = new KVCacheAdapter(binding);

    await expect(cache.get("hit")).resolves.toEqual({ ok: true });
    await expect(cache.get("miss")).resolves.toBeNull();

    await cache.set("stable", { value: 1 });
    expect(binding.put).toHaveBeenCalledWith("stable", JSON.stringify({ value: 1 }));

    await cache.set("ttl", ["cached"], { ttl: 3600 });
    expect(binding.put).toHaveBeenCalledWith("ttl", JSON.stringify(["cached"]), { expirationTtl: 3600 });

    await cache.delete("stable");
    expect(binding.delete).toHaveBeenCalledWith("stable");
    await expect(cache.health()).resolves.toEqual({ ok: true, details: { provider: "kv", rateLimiting: "disabled" } });
  });

  test("clamps KV TTLs below Cloudflare's 60 second minimum", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const binding = kvBinding();
    const cache = new KVCacheAdapter(binding);

    await cache.set("short", "value", { ttl: 30 });

    expect(warn).toHaveBeenCalledWith("[hono-cms/cache] KV provider requires expirationTtl >= 60 seconds. Clamped 30s to 60s for key \"short\".");
    expect(binding.put).toHaveBeenCalledWith("short", JSON.stringify("value"), { expirationTtl: 60 });
  });

  test("warns for unsupported pattern invalidation and atomic rate limiting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = new KVCacheAdapter(kvBinding());

    await expect(cache.deletePattern("content:articles:*")).resolves.toBeUndefined();
    await expect(cache.checkRateLimit("203.0.113.20", { limit: 1, window: "1 m" })).resolves.toEqual({ success: true, remaining: 999 });
    await expect(cache.sweep()).resolves.toEqual({ swept: 0 });

    expect(warn).toHaveBeenCalledWith("[hono-cms/cache] KV provider does not support deletePattern. Pattern: content:articles:*. Keys will expire by TTL.");
    expect(warn).toHaveBeenCalledWith("[hono-cms/cache] KV provider does not support atomic rate limiting. Rate limiting is disabled.");
  });

  test("registers the KV provider and warns about consistency limits", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = createKVCache({ provider: "kv", binding: kvBinding() });

    expect(cache).toBeInstanceOf(KVCacheAdapter);
    expect(warn).toHaveBeenCalledWith("[hono-cms/cache] KV provider selected. Session caching should fall back to in-memory because KV is eventually consistent. Rate limiting is disabled.");
  });
});

function kvBinding(values: Record<string, string> = {}): KVNamespaceLike {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {})
  };
}
