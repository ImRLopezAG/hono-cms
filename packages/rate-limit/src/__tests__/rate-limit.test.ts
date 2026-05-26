import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { memoryCache } from "@hono-cms/cache";
import type { CMSCollections } from "@hono-cms/schema";
import {
  CMSPluginError,
  createPlugin,
  createPluginContext,
  installPlugins,
  type CacheAdapter,
  type HonoCMSEnv,
  type Plugin
} from "@hono-cms/core";
import {
  clientIdentifier,
  enforceRateLimit,
  isGraphQLMutationRequest,
  rateLimit,
  RATE_LIMIT_PLUGIN_ID,
  retryAfterSeconds
} from "../index";

/* -------------------------------------------------------------------------- */
/* Test scaffolding                                                           */
/* -------------------------------------------------------------------------- */

function newCtxAndApp() {
  const db = createMemoryDatabase({
    provider: "memory",
    collections: {} as CMSCollections
  });
  const app = new Hono<HonoCMSEnv>();
  const ctx = createPluginContext({ collections: {} as CMSCollections, db, env: {} });
  return { app, ctx };
}

/**
 * Mount a tiny set of kernel-shaped echo routes after `installPlugins` so we
 * can hit the rate-limited prefixes end-to-end.
 */
function mountEchoRoutes(app: Hono<HonoCMSEnv>): void {
  app.all("/api/things", (c) => c.json({ ok: true, route: "things" }));
  app.all("/api/things/:id", (c) => c.json({ ok: true, route: "things/:id" }));
  app.all("/api/media", (c) => c.json({ ok: true, route: "media" }));
  app.all("/api/media/upload", (c) => c.json({ ok: true, route: "media/upload" }));
  app.all("/api/api-keys", (c) => c.json({ ok: true, route: "api-keys" }));
  app.all("/api/roles", (c) => c.json({ ok: true, route: "roles" }));
  app.all("/cms/admin/anything", (c) => c.json({ ok: true, route: "admin" }));
  app.all("/cms/jobs/run", (c) => c.json({ ok: true, route: "jobs" }));
  app.all("/graphql", (c) => c.json({ ok: true, route: "graphql" }));
}

/* -------------------------------------------------------------------------- */
/* Pure helper tests (enforce.ts)                                             */
/* -------------------------------------------------------------------------- */

describe("clientIdentifier", () => {
  test("prefers cf-connecting-ip", () => {
    const req = new Request("https://api.test/x", {
      headers: { "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }
    });
    expect(clientIdentifier(req)).toBe("1.1.1.1");
  });

  test("falls back to first x-forwarded-for entry", () => {
    const req = new Request("https://api.test/x", {
      headers: { "x-forwarded-for": "3.3.3.3, 4.4.4.4" }
    });
    expect(clientIdentifier(req)).toBe("3.3.3.3");
  });

  test("falls back to x-real-ip", () => {
    const req = new Request("https://api.test/x", {
      headers: { "x-real-ip": "5.5.5.5" }
    });
    expect(clientIdentifier(req)).toBe("5.5.5.5");
  });

  test("returns 'unknown' when no IP headers are present", () => {
    const req = new Request("https://api.test/x");
    expect(clientIdentifier(req)).toBe("unknown");
  });
});

describe("retryAfterSeconds", () => {
  test("defaults to 60 when resetAt is undefined", () => {
    expect(retryAfterSeconds(undefined)).toBe("60");
  });

  test("computes ceil((resetAt - now) / 1000)", () => {
    const reset = new Date(Date.now() + 12_500).toISOString();
    const seconds = Number(retryAfterSeconds(reset));
    expect(seconds).toBeGreaterThanOrEqual(12);
    expect(seconds).toBeLessThanOrEqual(13);
  });

  test("clamps to at least 1 when resetAt is in the past", () => {
    const reset = new Date(Date.now() - 5_000).toISOString();
    expect(retryAfterSeconds(reset)).toBe("1");
  });
});

describe("isGraphQLMutationRequest", () => {
  test("POST body with mutation → true", async () => {
    const req = new Request("https://api.test/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "mutation { foo }" })
    });
    expect(await isGraphQLMutationRequest(req)).toBe(true);
  });

  test("POST body with query → false", async () => {
    const req = new Request("https://api.test/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { foo }" })
    });
    expect(await isGraphQLMutationRequest(req)).toBe(false);
  });

  test("GET with ?query=mutation → true", async () => {
    const req = new Request("https://api.test/graphql?query=mutation%20%7B%20foo%20%7D");
    expect(await isGraphQLMutationRequest(req)).toBe(true);
  });

  test("GET with no query → false", async () => {
    const req = new Request("https://api.test/graphql");
    expect(await isGraphQLMutationRequest(req)).toBe(false);
  });
});

describe("enforceRateLimit (direct)", () => {
  test("no config → null (skip)", async () => {
    const result = await enforceRateLimit({
      cache: null,
      config: undefined,
      request: new Request("https://api.test/x"),
      scope: "mutations"
    });
    expect(result).toBeNull();
  });

  test("cache missing + failOpen → null with warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await enforceRateLimit({
        cache: null,
        config: { limit: 1, window: "1 m" },
        request: new Request("https://api.test/x"),
        scope: "auth",
        failOpen: true
      });
      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("cache missing + failOpen: false → 429", async () => {
    const result = await enforceRateLimit({
      cache: null,
      config: { limit: 1, window: "1 m" },
      request: new Request("https://api.test/x"),
      scope: "auth",
      failOpen: false
    });
    expect(result).not.toBeNull();
    expect(result?.status).toBe(429);
    expect(result?.headers.get("retry-after")).toBe("60");
  });

  test("cache throws + failOpen → null with warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const cache: CacheAdapter = {
        provider: "fake",
        async get() { return null; },
        async set() { /* no-op */ },
        async delete() { /* no-op */ },
        async checkRateLimit() { throw new Error("boom"); }
      };
      const result = await enforceRateLimit({
        cache,
        config: { limit: 1, window: "1 m" },
        request: new Request("https://api.test/x"),
        scope: "auth",
        failOpen: true
      });
      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("cache throws + failOpen: false → 429", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const cache: CacheAdapter = {
        provider: "fake",
        async get() { return null; },
        async set() { /* no-op */ },
        async delete() { /* no-op */ },
        async checkRateLimit() { throw new Error("boom"); }
      };
      const result = await enforceRateLimit({
        cache,
        config: { limit: 1, window: "1 m" },
        request: new Request("https://api.test/x"),
        scope: "auth",
        failOpen: false
      });
      expect(result?.status).toBe(429);
    } finally {
      warn.mockRestore();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Plugin manifest shape                                                      */
/* -------------------------------------------------------------------------- */

describe("rateLimit() plugin manifest", () => {
  test("returns a Plugin with id 'rate-limit' and requires ['cache']", () => {
    const plugin = rateLimit({});
    expect(plugin.id).toBe(RATE_LIMIT_PLUGIN_ID);
    expect(plugin.requires).toEqual(["cache"]);
    expect(typeof plugin.app).toBe("function");
  });
});

describe("rateLimit() install ordering", () => {
  test("throws when the cache plugin is missing from plugins: [...]", async () => {
    const { app, ctx } = newCtxAndApp();
    await expect(
      installPlugins([rateLimit({ auth: { limit: 1, window: "1 m" } })], app, ctx)
    ).rejects.toBeInstanceOf(CMSPluginError);
  });

  test("throws when the cache plugin appears AFTER rate-limit in the array", async () => {
    const { app, ctx } = newCtxAndApp();
    await expect(
      installPlugins(
        [rateLimit({ auth: { limit: 1, window: "1 m" } }), memoryCache({})],
        app,
        ctx
      )
    ).rejects.toBeInstanceOf(CMSPluginError);
  });

  test("installs cleanly when cache appears before rate-limit", async () => {
    const { app, ctx } = newCtxAndApp();
    const result = await installPlugins(
      [memoryCache({}), rateLimit({ auth: { limit: 1, window: "1 m" } })],
      app,
      ctx
    );
    expect(result.installedIds).toEqual(["cache", "rate-limit"]);
  });
});

/* -------------------------------------------------------------------------- */
/* End-to-end through a Hono app                                              */
/* -------------------------------------------------------------------------- */

describe("rateLimit() end-to-end — auth bucket", () => {
  test("requests within limit → 200; beyond limit → 429 with Retry-After", async () => {
    const { app, ctx } = newCtxAndApp();
    await installPlugins(
      [memoryCache({}), rateLimit({ auth: { limit: 2, window: "1 m" } })],
      app,
      ctx
    );
    mountEchoRoutes(app);

    const headers = { "x-real-ip": "9.9.9.9" };

    const r1 = await app.request("/api/api-keys", { headers });
    expect(r1.status).toBe(200);

    const r2 = await app.request("/api/api-keys", { headers });
    expect(r2.status).toBe(200);

    const r3 = await app.request("/api/api-keys", { headers });
    expect(r3.status).toBe(429);
    const body = await r3.json() as { error: string };
    expect(body.error).toBe("rate_limited");
    expect(r3.headers.get("retry-after")).not.toBeNull();
    expect(Number(r3.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(r3.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(r3.headers.get("x-ratelimit-reset")).not.toBeNull();
  });
});

describe("rateLimit() end-to-end — window reset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("requests pass again after the window expires", async () => {
    const { app, ctx } = newCtxAndApp();
    await installPlugins(
      [memoryCache({}), rateLimit({ auth: { limit: 1, window: "1 s" } })],
      app,
      ctx
    );
    mountEchoRoutes(app);

    const headers = { "x-real-ip": "8.8.8.8" };

    const r1 = await app.request("/api/api-keys", { headers });
    expect(r1.status).toBe(200);

    const r2 = await app.request("/api/api-keys", { headers });
    expect(r2.status).toBe(429);

    // Advance past the 1s window.
    vi.advanceTimersByTime(1_500);

    const r3 = await app.request("/api/api-keys", { headers });
    expect(r3.status).toBe(200);
  });
});

describe("rateLimit() end-to-end — per-prefix bucket isolation", () => {
  test("auth bucket does not consume media bucket", async () => {
    const { app, ctx } = newCtxAndApp();
    await installPlugins(
      [
        memoryCache({}),
        rateLimit({
          auth:  { limit: 1, window: "1 m" },
          media: { limit: 1, window: "1 m" }
        })
      ],
      app,
      ctx
    );
    mountEchoRoutes(app);

    const headers = { "x-real-ip": "7.7.7.7" };

    // Burn the auth quota.
    expect((await app.request("/api/api-keys", { headers })).status).toBe(200);
    expect((await app.request("/api/api-keys", { headers })).status).toBe(429);

    // Media is independent — first request still passes.
    expect((await app.request("/api/media", { headers })).status).toBe(200);
    expect((await app.request("/api/media", { headers })).status).toBe(429);
  });
});

describe("rateLimit() end-to-end — mutations scope", () => {
  test("only POST/PATCH/PUT/DELETE on /api/* count; GET passes through", async () => {
    const { app, ctx } = newCtxAndApp();
    await installPlugins(
      [memoryCache({}), rateLimit({ mutations: { limit: 1, window: "1 m" } })],
      app,
      ctx
    );
    mountEchoRoutes(app);

    const headers = { "x-real-ip": "6.6.6.6" };

    // Many GETs do not consume the bucket.
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/api/things", { method: "GET", headers });
      expect(res.status).toBe(200);
    }

    // First mutation passes.
    const post1 = await app.request("/api/things", { method: "POST", headers });
    expect(post1.status).toBe(200);

    // Second mutation (any of the gated methods) is blocked.
    const post2 = await app.request("/api/things", { method: "PATCH", headers });
    expect(post2.status).toBe(429);
  });
});

describe("rateLimit() end-to-end — failOpen behaviour", () => {
  /**
   * Stand-in cache plugin that registers an adapter WITHOUT `checkRateLimit`,
   * mimicking what happens when a user installs a minimal cache backend that
   * doesn't implement the rate-limit surface.
   */
  function cacheWithoutCheckRateLimit(): Plugin {
    return createPlugin({
      id: "cache",
      app: (_app, ctx) => {
        const adapter: CacheAdapter = {
          provider: "fake-no-ratelimit",
          async get() { return null; },
          async set() { /* no-op */ },
          async delete() { /* no-op */ }
        };
        ctx.plugins.register("cache", adapter);
      }
    });
  }

  test("default (failOpen: true) lets requests through when cache lacks checkRateLimit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { app, ctx } = newCtxAndApp();
      await installPlugins(
        [cacheWithoutCheckRateLimit(), rateLimit({ auth: { limit: 1, window: "1 m" } })],
        app,
        ctx
      );
      mountEchoRoutes(app);

      // Two back-to-back requests both pass — no enforcement possible.
      const r1 = await app.request("/api/api-keys");
      const r2 = await app.request("/api/api-keys");
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("failOpen: false rejects with 429 when cache lacks checkRateLimit", async () => {
    const { app, ctx } = newCtxAndApp();
    await installPlugins(
      [
        cacheWithoutCheckRateLimit(),
        rateLimit({ auth: { limit: 1, window: "1 m" }, failOpen: false })
      ],
      app,
      ctx
    );
    mountEchoRoutes(app);

    const res = await app.request("/api/api-keys");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});

describe("rateLimit() end-to-end — graphql scope", () => {
  test("queries pass through; mutations are counted", async () => {
    const { app, ctx } = newCtxAndApp();
    await installPlugins(
      [memoryCache({}), rateLimit({ graphql: { limit: 1, window: "1 m" } })],
      app,
      ctx
    );
    mountEchoRoutes(app);

    const headers = { "x-real-ip": "4.4.4.4", "content-type": "application/json" };

    // A query — not counted.
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/graphql", {
        method: "POST",
        headers,
        body: JSON.stringify({ query: "query { foo }" })
      });
      expect(res.status).toBe(200);
    }

    // First mutation passes.
    const m1 = await app.request("/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "mutation { foo }" })
    });
    expect(m1.status).toBe(200);

    // Second mutation is rate limited.
    const m2 = await app.request("/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "mutation { foo }" })
    });
    expect(m2.status).toBe(429);
  });
});
