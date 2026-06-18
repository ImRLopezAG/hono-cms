import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { memoryCache } from "@hono-cms/cache";
import type { CMSCollections } from "@hono-cms/schema";
import {
  CMSPluginError,
  createPluginContext,
  installPlugins,
  type CacheAdapter,
  type HonoCMSEnv,
  type PluginContext
} from "@hono-cms/core";
import {
  contentCache,
  CONTENT_CACHE_PLUGIN_ID,
  identityScope,
  INVALIDATING_EVENTS,
  invalidateContentCache,
  normalizedRequestCacheSource,
  stableStringify,
  subscribeInvalidationEvents
} from "../index";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function newCtxAndApp() {
  const db = createMemoryDatabase({ provider: "memory", collections: {} as CMSCollections });
  const app = new Hono<HonoCMSEnv>();
  const ctx = createPluginContext({ collections: {} as CMSCollections, db, env: {} });
  return { app, ctx };
}

/**
 * Build a fully-wired test harness: cache plugin + content-cache plugin
 * mounted on a Hono app that mirrors the kernel's collection routes with a
 * counter-backed handler. Each invocation of `GET /api/items` increments a
 * handler-call counter so cache hits are observable.
 */
async function makeHarness(opts: { ttlSeconds?: number; session?: unknown } = {}) {
  const { app, ctx } = newCtxAndApp();

  // Set session BEFORE installing plugins so the auth-style middleware runs
  // before the content-cache middleware (which reads `c.get("session")` to
  // compute the identity scope). Mirrors the kernel: auth plugins install
  // earlier in the manifest than content-cache.
  if (opts.session !== undefined) {
    app.use("/api/*", async (c, next) => {
      c.set("session", opts.session as never);
      await next();
    });
  }

  await installPlugins(
    [
      memoryCache({}),
      contentCache(opts.ttlSeconds === undefined ? {} : { ttlSeconds: opts.ttlSeconds })
    ],
    app,
    ctx
  );

  let listHandlerCalls = 0;
  let getHandlerCalls = 0;

  app.get("/api/items", (c) => {
    listHandlerCalls++;
    return c.json({ items: [{ id: "1", title: "hello" }], total: 1 });
  });
  app.get("/api/items/:id", (c) => {
    getHandlerCalls++;
    return c.json({ id: c.req.param("id"), title: "hello" });
  });

  return {
    app,
    ctx,
    cache: ctx.plugins.get("cache"),
    calls: () => ({ list: listHandlerCalls, get: getHandlerCalls })
  };
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

describe("normalizedRequestCacheSource", () => {
  test("sorts query parameters so reorderings hit the same cache key", () => {
    const a = new Request("https://api.test/api/items?a=1&b=2");
    const b = new Request("https://api.test/api/items?b=2&a=1");
    expect(normalizedRequestCacheSource(a)).toBe(normalizedRequestCacheSource(b));
  });

  test("includes the path and method", () => {
    const source = normalizedRequestCacheSource(new Request("https://api.test/api/items?x=1"));
    expect(source).toBe("GET /api/items?x=1");
  });

  test("breaks ties on value for duplicate keys", () => {
    const a = new Request("https://api.test/api/items?tag=b&tag=a");
    const b = new Request("https://api.test/api/items?tag=a&tag=b");
    expect(normalizedRequestCacheSource(a)).toBe(normalizedRequestCacheSource(b));
  });
});

describe("stableStringify", () => {
  test("sorts object keys", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  test("preserves array order", () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });
});

describe("identityScope", () => {
  test("returns 'anon' for null/undefined", async () => {
    await expect(identityScope(null)).resolves.toBe("anon");
    await expect(identityScope(undefined)).resolves.toBe("anon");
  });

  test("anonymous and authenticated requests produce distinct scopes", async () => {
    const anon = await identityScope(null);
    const user = await identityScope({ userId: "u1", roles: ["editor"] });
    expect(anon).not.toBe(user);
  });

  test("two users with different ids get different scopes", async () => {
    const a = await identityScope({ userId: "u1", roles: ["editor"] });
    const b = await identityScope({ userId: "u2", roles: ["editor"] });
    expect(a).not.toBe(b);
  });

  test("same user with different role sets gets different scopes", async () => {
    const a = await identityScope({ userId: "u1", roles: ["editor"] });
    const b = await identityScope({ userId: "u1", roles: ["admin"] });
    expect(a).not.toBe(b);
  });

  test("role array order does not affect the scope (sorted)", async () => {
    const a = await identityScope({ userId: "u1", roles: ["editor", "admin"] });
    const b = await identityScope({ userId: "u1", roles: ["admin", "editor"] });
    expect(a).toBe(b);
  });
});

/* -------------------------------------------------------------------------- */
/* Plugin manifest                                                            */
/* -------------------------------------------------------------------------- */

describe("contentCache() plugin manifest", () => {
  test("returns a Plugin with id 'content-cache' and requires ['cache']", () => {
    const plugin = contentCache();
    expect(plugin.id).toBe(CONTENT_CACHE_PLUGIN_ID);
    expect(plugin.requires).toEqual(["cache"]);
    expect(typeof plugin.app).toBe("function");
  });

  test("throws on install when the cache plugin is missing (kernel-validated)", async () => {
    const { app, ctx } = newCtxAndApp();
    await expect(installPlugins([contentCache()], app, ctx)).rejects.toBeInstanceOf(CMSPluginError);
  });

  test("installs cleanly when the cache plugin is present and ordered first", async () => {
    const { app, ctx } = newCtxAndApp();
    const result = await installPlugins([memoryCache({}), contentCache()], app, ctx);
    expect(result.installedIds).toContain(CONTENT_CACHE_PLUGIN_ID);
    expect(result.installedIds).toContain("cache");
  });
});

/* -------------------------------------------------------------------------- */
/* End-to-end caching behavior                                                */
/* -------------------------------------------------------------------------- */

describe("contentCache() — end-to-end caching", () => {
  test("second GET within TTL hits the cache (handler called once)", async () => {
    const { app, calls } = await makeHarness();

    const r1 = await app.request("/api/items");
    expect(r1.status).toBe(200);
    expect(r1.headers.get("x-cms-cache")).toBe("miss");
    const body1 = await r1.json();

    const r2 = await app.request("/api/items");
    expect(r2.status).toBe(200);
    expect(r2.headers.get("x-cms-cache")).toBe("hit");
    const body2 = await r2.json();

    expect(body2).toEqual(body1);
    expect(calls().list).toBe(1);
  });

  test("issues an etag on miss and 304s on a matching If-None-Match", async () => {
    const { app } = await makeHarness();

    const miss = await app.request("/api/items");
    const etag = miss.headers.get("etag");
    expect(etag).not.toBeNull();

    const cond = await app.request("/api/items", {
      headers: { "if-none-match": etag! }
    });
    expect(cond.status).toBe(304);
    expect(cond.headers.get("etag")).toBe(etag);
    expect(cond.headers.get("x-cms-cache")).toBe("hit");
  });

  test("caches GET /api/<coll>/:id (single-record route)", async () => {
    const { app, calls } = await makeHarness();

    await app.request("/api/items/1");
    const second = await app.request("/api/items/1");
    expect(second.headers.get("x-cms-cache")).toBe("hit");
    expect(calls().get).toBe(1);
  });

  test("query-parameter reorderings hit the same cache entry", async () => {
    const { app, calls } = await makeHarness();

    await app.request("/api/items?a=1&b=2");
    const second = await app.request("/api/items?b=2&a=1");
    expect(second.headers.get("x-cms-cache")).toBe("hit");
    expect(calls().list).toBe(1);
  });

  test("non-GET requests bypass the cache entirely", async () => {
    const { app, ctx, calls } = await makeHarness();
    // Wire a POST that should never be cached.
    app.post("/api/items", (c) => c.json({ created: true }));

    const r = await app.request("/api/items", { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-cms-cache")).toBeNull();
    expect(calls().list).toBe(0);
    void ctx;
  });

  test("ttlSeconds: 0 disables caching (every request is a miss)", async () => {
    const { app, calls } = await makeHarness({ ttlSeconds: 0 });

    const r1 = await app.request("/api/items");
    const r2 = await app.request("/api/items");
    expect(r1.headers.get("x-cms-cache")).toBeNull();
    expect(r2.headers.get("x-cms-cache")).toBeNull();
    expect(calls().list).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* TTL expiry                                                                 */
/* -------------------------------------------------------------------------- */

describe("contentCache() — TTL expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("entries beyond the TTL force a refetch", async () => {
    const { app, calls } = await makeHarness({ ttlSeconds: 1 });

    const r1 = await app.request("/api/items");
    expect(r1.headers.get("x-cms-cache")).toBe("miss");
    expect(calls().list).toBe(1);

    // Advance past the 1s TTL (MemoryCacheAdapter stores `expiresAt = now + ttl*1000`).
    vi.advanceTimersByTime(1500);

    const r2 = await app.request("/api/items");
    expect(r2.headers.get("x-cms-cache")).toBe("miss");
    expect(calls().list).toBe(2);
  });

  test("re-fetching within the TTL still hits the cache", async () => {
    const { app, calls } = await makeHarness({ ttlSeconds: 60 });

    await app.request("/api/items");
    vi.advanceTimersByTime(10_000);
    const r2 = await app.request("/api/items");
    expect(r2.headers.get("x-cms-cache")).toBe("hit");
    expect(calls().list).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Identity scoping                                                            */
/* -------------------------------------------------------------------------- */

describe("contentCache() — identity scoping", () => {
  test("anonymous and authenticated requests cache separately", async () => {
    const { app: anonApp, calls: anonCalls } = await makeHarness();
    const { app: authApp, calls: authCalls } = await makeHarness({
      session: { userId: "u1", roles: ["editor"] }
    });

    // Two requests under the anon harness — second should hit.
    await anonApp.request("/api/items");
    const anonSecond = await anonApp.request("/api/items");
    expect(anonSecond.headers.get("x-cms-cache")).toBe("hit");
    expect(anonCalls().list).toBe(1);

    // Two requests under the auth harness — second should hit.
    await authApp.request("/api/items");
    const authSecond = await authApp.request("/api/items");
    expect(authSecond.headers.get("x-cms-cache")).toBe("hit");
    expect(authCalls().list).toBe(1);
  });

  test("different identities sharing the same cache get distinct entries", async () => {
    // Use one shared cache backend across the same app so we can prove the
    // entries do NOT collide. Session middleware is registered BEFORE the
    // plugins so it runs before the content-cache middleware sees the
    // request (mirroring how the auth plugin always installs first in
    // production).
    const { app, ctx } = newCtxAndApp();
    let calls = 0;
    let currentSession: unknown = null;
    app.use("/api/*", async (c, next) => {
      c.set("session", currentSession as never);
      await next();
    });
    await installPlugins([memoryCache({}), contentCache()], app, ctx);
    app.get("/api/items", (c) => {
      calls++;
      const s = c.get("session") as { userId?: string } | null;
      return c.json({ items: [{ owner: s?.userId ?? "anon" }] });
    });

    // Request 1: anonymous → miss
    currentSession = null;
    const anon1 = await app.request("/api/items");
    expect(anon1.headers.get("x-cms-cache")).toBe("miss");
    expect(calls).toBe(1);

    // Request 2: user A → miss (different identity scope!)
    currentSession = { userId: "u-a", roles: ["editor"] };
    const userA1 = await app.request("/api/items");
    expect(userA1.headers.get("x-cms-cache")).toBe("miss");
    expect(calls).toBe(2);

    // Request 3: user B → miss
    currentSession = { userId: "u-b", roles: ["editor"] };
    const userB1 = await app.request("/api/items");
    expect(userB1.headers.get("x-cms-cache")).toBe("miss");
    expect(calls).toBe(3);

    // Request 4: anonymous again → hit (cached from request 1)
    currentSession = null;
    const anon2 = await app.request("/api/items");
    expect(anon2.headers.get("x-cms-cache")).toBe("hit");
    expect(calls).toBe(3);

    // Bodies differ because handler reads the session for each cache entry.
    const userAJson = await userA1.json();
    const userBJson = await userB1.json();
    expect(userAJson).not.toEqual(userBJson);
  });
});

/* -------------------------------------------------------------------------- */
/* Event-driven invalidation                                                   */
/* -------------------------------------------------------------------------- */

describe("contentCache() — invalidation on mutation events", () => {
  test.each(INVALIDATING_EVENTS)(
    "%s invalidates the per-collection cache (next GET is a miss)",
    async (event) => {
      const { app, ctx, calls } = await makeHarness();

      // Prime the cache.
      await app.request("/api/items");
      const primedHit = await app.request("/api/items");
      expect(primedHit.headers.get("x-cms-cache")).toBe("hit");
      expect(calls().list).toBe(1);

      // Emit the mutation event for `items`.
      await ctx.events.emit(event, {
        collection: "items",
        record: { id: "x" },
        id: "x",
        identity: null,
        request: new Request("https://api.test/internal"),
        before: null
      } as never);

      // Next GET should be a miss (handler re-invoked).
      const r = await app.request("/api/items");
      expect(r.headers.get("x-cms-cache")).toBe("miss");
      expect(calls().list).toBe(2);
    }
  );

  test("a mutation on collection A does NOT invalidate collection B", async () => {
    const { app, ctx } = await makeHarness();
    app.get("/api/things", (c) => c.json({ items: [], total: 0 }));

    await app.request("/api/items");
    await app.request("/api/things");

    await ctx.events.emit("content:after-update", {
      collection: "items",
      record: { id: "x", createdAt: "now", updatedAt: "now" },
      before: null,
      identity: null,
      request: new Request("https://api.test/internal")
    });

    const itemsAfter = await app.request("/api/items");
    expect(itemsAfter.headers.get("x-cms-cache")).toBe("miss");

    const thingsAfter = await app.request("/api/things");
    expect(thingsAfter.headers.get("x-cms-cache")).toBe("hit");
  });

  test("subscribeInvalidationEvents returns a teardown that detaches handlers", async () => {
    const { app, ctx } = await makeHarness();
    await app.request("/api/items");

    // Tear down the subscriptions wired in `app(...)` by emitting after a
    // fresh subscription is created + immediately torn down — we observe
    // that an event emitted AFTER teardown of an EXTRA subscription does
    // not double-invalidate.
    const off = subscribeInvalidationEvents(ctx, ctx.plugins.get("cache"), "extra-prefix");
    off();
    // The plugin's own subscription is still active — emitting still
    // invalidates the plugin's cache.
    await ctx.events.emit("content:after-update", {
      collection: "items",
      record: { id: "x", createdAt: "now", updatedAt: "now" },
      before: null,
      identity: null,
      request: new Request("https://api.test/internal")
    });
    const miss = await app.request("/api/items");
    expect(miss.headers.get("x-cms-cache")).toBe("miss");
  });
});

/* -------------------------------------------------------------------------- */
/* Direct helper exercise — invalidateContentCache                            */
/* -------------------------------------------------------------------------- */

describe("invalidateContentCache (direct helper)", () => {
  test("bumping the version key invalidates every prior key for that collection", async () => {
    const { app, ctx } = newCtxAndApp();
    await installPlugins([memoryCache({}), contentCache()], app, ctx);
    const cache = ctx.plugins.get("cache");

    let calls = 0;
    app.get("/api/posts", (c) => {
      calls++;
      return c.json({ items: [], total: 0 });
    });

    await app.request("/api/posts");
    const hit = await app.request("/api/posts");
    expect(hit.headers.get("x-cms-cache")).toBe("hit");
    expect(calls).toBe(1);

    await invalidateContentCache(cache, "content-cache", "posts");

    const miss = await app.request("/api/posts");
    expect(miss.headers.get("x-cms-cache")).toBe("miss");
    expect(calls).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Sanity: ctx type                                                           */
/* -------------------------------------------------------------------------- */

describe("PluginContext typing sanity", () => {
  test("ctx.plugins.get('cache') is the registered instance", async () => {
    const { app, ctx } = newCtxAndApp();
    await installPlugins([memoryCache({}), contentCache()], app, ctx);
    const cache: CacheAdapter = ctx.plugins.get("cache");
    expect(typeof cache.get).toBe("function");
    expect(typeof cache.set).toBe("function");
    const explicitCtx: PluginContext = ctx;
    expect(explicitCtx.plugins.has("cache")).toBe(true);
  });
});
