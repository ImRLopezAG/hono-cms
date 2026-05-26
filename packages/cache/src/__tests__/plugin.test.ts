import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import {
  CMSPluginError,
  createPluginContext,
  installPlugins,
  type CacheAdapter,
  type HonoCMSEnv
} from "@hono-cms/core";
import type { CMSCollections } from "@hono-cms/schema";
import type { DatabaseAdapter } from "@hono-cms/core";
import { cachePlugin, kvCache, memoryCache, upstashCache } from "../index";

const noopDb: DatabaseAdapter = {
  provider: "memory",
  capabilities: {},
  async migrate() { /* no-op */ },
  async list() { return { items: [], total: 0 }; },
  async get() { return null; },
  async create() { return {} as never; },
  async update() { return null; },
  async delete() { return null; },
  async ensureCollection() { /* no-op */ }
} as unknown as DatabaseAdapter;

function newCtxAndApp() {
  const app = new Hono<HonoCMSEnv>();
  const ctx = createPluginContext({ collections: {} as CMSCollections, db: noopDb, env: {} });
  return { app, ctx };
}

describe("memoryCache() plugin manifest", () => {
  test("returns a Plugin manifest with id 'cache'", () => {
    const plugin = memoryCache({});
    expect(plugin.id).toBe("cache");
    expect(typeof plugin.app).toBe("function");
  });

  test("install registers a CacheAdapter on ctx.plugins under 'cache'", async () => {
    const { app, ctx } = newCtxAndApp();
    await installPlugins([memoryCache({})], app, ctx);

    expect(ctx.plugins.has("cache")).toBe(true);
    const cache = ctx.plugins.get<CacheAdapter>("cache");
    expect(cache.provider).toBe("memory");
  });

  test("registered adapter supports get/set/delete/sweep/health", async () => {
    const { app, ctx } = newCtxAndApp();
    await installPlugins([memoryCache({})], app, ctx);
    const cache = ctx.plugins.get<CacheAdapter>("cache");

    await cache.set("k", { hello: "world" });
    await expect(cache.get("k")).resolves.toEqual({ hello: "world" });

    await cache.delete("k");
    await expect(cache.get("k")).resolves.toBeNull();

    await cache.set("tmp", "v", { ttl: 1 });
    await expect(cache.sweep?.()).resolves.toEqual({ swept: 0 });

    const health = await cache.health?.();
    expect(health?.ok).toBe(true);
  });

  test("two cache plugins in plugins: [...] throw duplicate id", async () => {
    const { app, ctx } = newCtxAndApp();
    await expect(
      installPlugins([memoryCache({}), memoryCache({})], app, ctx)
    ).rejects.toBeInstanceOf(CMSPluginError);
  });
});

describe("memoryCache() workers-safety", () => {
  test("instantiating the plugin does NOT call setInterval", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      const plugin = memoryCache({});
      // Just constructing/declaring the plugin must not touch timers.
      expect(plugin.id).toBe("cache");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("installing the plugin does NOT call setInterval", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      const { app, ctx } = newCtxAndApp();
      await installPlugins([memoryCache({})], app, ctx);
      // The adapter is registered but no .set() has been invoked yet.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("first .set() arms the sweep timer; .destroy() clears it", async () => {
    vi.useFakeTimers();
    try {
      const { app, ctx } = newCtxAndApp();
      const spy = vi.spyOn(globalThis, "setInterval");
      await installPlugins([memoryCache({})], app, ctx);
      expect(spy).not.toHaveBeenCalled();

      const cache = ctx.plugins.get<CacheAdapter & { destroy(): void }>("cache");
      await cache.set("hot", 1);
      expect(spy).toHaveBeenCalledTimes(1);

      cache.destroy();
      expect(vi.getTimerCount()).toBe(0);
      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cachePlugin() bring-your-own-adapter", () => {
  test("wraps an arbitrary CacheAdapter under id 'cache'", async () => {
    const fake: CacheAdapter = {
      provider: "fake",
      async get() { return null; },
      async set() { /* no-op */ },
      async delete() { /* no-op */ }
    };
    const { app, ctx } = newCtxAndApp();
    await installPlugins([cachePlugin(fake)], app, ctx);
    expect(ctx.plugins.get<CacheAdapter>("cache")).toBe(fake);
  });
});

describe("kvCache() and upstashCache() plugin manifests", () => {
  test("kvCache returns Plugin id 'cache' and registers a KV-backed adapter", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const binding = {
        get: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined)
      };
      const plugin = kvCache({ provider: "kv", binding });
      expect(plugin.id).toBe("cache");

      const { app, ctx } = newCtxAndApp();
      await installPlugins([plugin], app, ctx);
      expect(ctx.plugins.get<CacheAdapter>("cache").provider).toBe("kv");
    } finally {
      warn.mockRestore();
    }
  });

  test("upstashCache returns Plugin id 'cache' and registers an Upstash adapter", async () => {
    const redis = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => "OK"),
      del: vi.fn(async () => 1),
      scan: vi.fn(async () => [0, []] as [number, string[]])
    };
    const plugin = upstashCache({ provider: "upstash", redis });
    expect(plugin.id).toBe("cache");

    const { app, ctx } = newCtxAndApp();
    await installPlugins([plugin], app, ctx);
    expect(ctx.plugins.get<CacheAdapter>("cache").provider).toBe("upstash");
  });
});
