import { Hono } from "hono";
import type { CMSCollections } from "@hono-cms/schema";
import { describe, expect, it, vi } from "vitest";
import type { HonoCMSEnv } from "../../types/instance";
import type { DatabaseAdapter } from "../../types/providers";
import { createAuthPlugin, createPlugin } from "../factories";
import { createPluginContext } from "../context";
import { installPlugins, validateAndOrder } from "../runtime";
import { mergeSchemas } from "../schema-merge";
import { CMSPluginError, type PluginContext } from "../types";

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

const baseInit = () => ({
  collections: {} as CMSCollections,
  db: noopDb,
  env: {}
});

describe("validateAndOrder", () => {
  it("returns empty for empty plugins", () => {
    expect(validateAndOrder([])).toEqual([]);
  });

  it("throws on duplicate ids", () => {
    expect(() =>
      validateAndOrder([
        createPlugin({ id: "a" }),
        createPlugin({ id: "a" })
      ])
    ).toThrow(CMSPluginError);
  });

  it("throws when requires references a plugin appearing later", () => {
    expect(() =>
      validateAndOrder([
        createPlugin({ id: "rate-limit", requires: ["cache"] }),
        createPlugin({ id: "cache" })
      ])
    ).toThrow(/appears later/);
  });

  it("throws when requires references a missing plugin", () => {
    expect(() =>
      validateAndOrder([createPlugin({ id: "rate-limit", requires: ["cache"] })])
    ).toThrow(/not installed/);
  });

  it("throws when two AuthPlugins are present", () => {
    expect(() =>
      validateAndOrder([
        createAuthPlugin({ id: "a", protected: async (_c, next) => { await next(); } }),
        createAuthPlugin({ id: "b", protected: async (_c, next) => { await next(); } })
      ])
    ).toThrow(/Exactly one AuthPlugin/);
  });

  it("throws when two plugins declare mountPhase catchAll", () => {
    expect(() =>
      validateAndOrder([
        createPlugin({ id: "a", mountPhase: "catchAll" }),
        createPlugin({ id: "b", mountPhase: "catchAll" })
      ])
    ).toThrow(/mountPhase: "catchAll"/);
  });

  it("orders early -> normal -> catchAll regardless of array position", () => {
    const ordered = validateAndOrder([
      createPlugin({ id: "catch", mountPhase: "catchAll" }),
      createPlugin({ id: "early", mountPhase: "early" }),
      createPlugin({ id: "normal" })
    ]);
    expect(ordered.map((p) => p.id)).toEqual(["early", "normal", "catch"]);
  });
});

describe("installPlugins", () => {
  it("empty plugins => authorize defaults to true", async () => {
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext(baseInit());
    const result = await installPlugins([], app, ctx);
    expect(result.authPlugin).toBeUndefined();
    expect(await result.authorize("read", null)).toBe(true);
    expect(result.installedIds).toEqual([]);
  });

  it("calls app(app, ctx) on every plugin", async () => {
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext(baseInit());
    const spy = vi.fn();
    await installPlugins(
      [createPlugin({ id: "p", app: (hono, c) => { spy(hono, c); return hono; } })],
      app,
      ctx
    );
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(app, ctx);
  });

  it("exposes the AuthPlugin and identity is opaque to core", async () => {
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext(baseInit());
    const auth = createAuthPlugin({
      id: "auth",
      protected: async (_c, next) => { await next(); }
    });
    const result = await installPlugins([auth], app, ctx);
    expect(result.authPlugin?.id).toBe("auth");
  });

  it("stores the last installAuthorize result", async () => {
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext(baseInit());
    const result = await installPlugins(
      [
        createPlugin({ id: "policy", installAuthorize: () => () => false })
      ],
      app,
      ctx
    );
    expect(await result.authorize("read", null)).toBe(false);
  });

  it("service registry: register/has/get works across plugins", async () => {
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext(baseInit());
    await installPlugins(
      [
        createPlugin({
          id: "cache",
          app: (_h, c) => { c.plugins.register("cache", { it: "works" }); }
        }),
        createPlugin({
          id: "consumer",
          requires: ["cache"],
          app: (_h, c) => {
            expect(c.plugins.has("cache")).toBe(true);
            expect(c.plugins.get<{ it: string }>("cache").it).toBe("works");
          }
        })
      ],
      app,
      ctx
    );
  });

  it("event bus: emits to all subscribers and async handlers complete", async () => {
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext(baseInit());
    const seen: string[] = [];
    await installPlugins(
      [
        createPlugin({
          id: "audit",
          app: (_h, c) => {
            c.events.on("content:after-create", async (payload) => {
              await Promise.resolve();
              seen.push(`audit:${payload.collection}`);
            });
          }
        }),
        createPlugin({
          id: "webhooks",
          app: (_h, c) => {
            c.events.on("content:after-create", (payload) => {
              seen.push(`webhook:${payload.collection}`);
            });
          }
        })
      ],
      app,
      ctx as PluginContext
    );
    await ctx.events.emit("content:after-create", {
      collection: "articles",
      record: { id: "1" } as never,
      identity: null,
      request: new Request("https://example.com")
    });
    expect(seen.sort()).toEqual(["audit:articles", "webhook:articles"]);
  });

  it("event bus: throwing handler does not block siblings; errors aggregate", async () => {
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext(baseInit());
    const seen: string[] = [];
    await installPlugins(
      [
        createPlugin({
          id: "audit",
          app: (_h, c) => {
            c.events.on("content:after-create", () => {
              throw new Error("audit boom");
            });
          }
        }),
        createPlugin({
          id: "webhooks",
          app: (_h, c) => {
            c.events.on("content:after-create", () => {
              seen.push("webhook-ran");
            });
          }
        })
      ],
      app,
      ctx
    );
    await expect(
      ctx.events.emit("content:after-create", {
        collection: "articles",
        record: { id: "1" } as never,
        identity: null,
        request: new Request("https://example.com")
      })
    ).rejects.toThrowError(/audit boom/);
    expect(seen).toEqual(["webhook-ran"]);
  });
});

describe("mergeSchemas", () => {
  it("merges disjoint plugin schemas", () => {
    const merged = mergeSchemas([
      createPlugin({
        id: "tokens",
        schema: { api_keys: { fields: { id: { type: "string", required: true } } } }
      }),
      createPlugin({
        id: "roles",
        schema: { roles: { fields: { id: { type: "string", required: true } } } }
      })
    ]);
    expect(Array.from(merged.keys()).sort()).toEqual(["api_keys", "roles"]);
  });

  it("throws on duplicate table names across plugins", () => {
    expect(() =>
      mergeSchemas([
        createPlugin({
          id: "a",
          schema: { api_keys: { fields: { id: { type: "string" } } } }
        }),
        createPlugin({
          id: "b",
          schema: { api_keys: { fields: { id: { type: "string" } } } }
        })
      ])
    ).toThrow(CMSPluginError);
  });

  it("throws on duplicate modelName across plugins", () => {
    expect(() =>
      mergeSchemas([
        createPlugin({
          id: "a",
          schema: { api_keys: { fields: { id: { type: "string" } }, modelName: "ApiKey" } }
        }),
        createPlugin({
          id: "b",
          schema: { my_keys: { fields: { id: { type: "string" } }, modelName: "ApiKey" } }
        })
      ])
    ).toThrow(CMSPluginError);
  });
});
