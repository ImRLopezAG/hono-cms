import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import {
  defineCollection,
  defineSchema,
  fields,
  type CMSCollections
} from "@hono-cms/schema";
import {
  createPluginContext,
  installPlugins,
  type HonoCMSEnv
} from "@hono-cms/core";
import { openapi, OPENAPI_PLUGIN_ID } from "../plugin";
import type { OpenAPIConfig, OpenAPIService, OpenAPISpec } from "../types";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const articleCollection = defineCollection(
  "articles",
  { title: fields.string({ required: true }) },
  {}
);

function makeCollections() {
  return defineSchema({ articles: articleCollection });
}

async function buildApp(opts: OpenAPIConfig = {}) {
  const collections = makeCollections();
  const db = createMemoryDatabase({ provider: "memory", collections });
  const app = new Hono<HonoCMSEnv>();
  const ctx = createPluginContext({ collections, db, env: {} });
  const plugin = openapi(opts);
  await installPlugins([plugin], app, ctx);
  return { app, ctx, plugin, collections };
}

/* -------------------------------------------------------------------------- */
/* `GET /openapi.json` shape + ETag                                            */
/* -------------------------------------------------------------------------- */

describe("openapi plugin — GET /openapi.json", () => {
  it("returns OpenAPI 3 JSON with the configured title and version", async () => {
    const { app } = await buildApp({ title: "My CMS", version: "9.9.9" });
    const res = await app.request("/cms/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]+"$/);
    const spec = (await res.json()) as OpenAPISpec;
    expect(spec.openapi).toBe("3.1.0");
    expect((spec.info as { title: string }).title).toBe("My CMS");
    expect((spec.info as { version: string }).version).toBe("9.9.9");
    // The kernel content paths for the configured collection should appear.
    expect(Object.keys(spec.paths)).toContain("/api/articles");
  });

  it("falls back to the kernel default title/version when none are configured", async () => {
    const { app } = await buildApp({});
    const res = await app.request("/cms/openapi.json");
    expect(res.status).toBe(200);
    const spec = (await res.json()) as OpenAPISpec;
    expect((spec.info as { title: string }).title).toBe("Hono CMS API");
    expect((spec.info as { version: string }).version).toBe("0.1.0");
  });

  it("honours `path` and the legacy `specPath` alias", async () => {
    const { app: appPath } = await buildApp({ path: "/custom/openapi.json" });
    const a = await appPath.request("/custom/openapi.json");
    expect(a.status).toBe(200);
    const aMiss = await appPath.request("/cms/openapi.json");
    expect(aMiss.status).toBe(404);

    const { app: appLegacy } = await buildApp({ specPath: "/legacy/openapi.json" });
    const b = await appLegacy.request("/legacy/openapi.json");
    expect(b.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* `GET /docs`                                                                 */
/* -------------------------------------------------------------------------- */

describe("openapi plugin — GET /docs", () => {
  it("returns HTML containing the spec URL", async () => {
    const { app } = await buildApp({ path: "/openapi.json" });
    const res = await app.request("/cms/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<script id=\"api-reference\"");
    expect(body).toContain("data-url=\"/openapi.json\"");
  });

  it("is omitted in production when no explicit docs path is set", async () => {
    const { app } = await buildApp({ production: true });
    const res = await app.request("/cms/docs");
    expect(res.status).toBe(404);
  });

  it("is mounted in production when an explicit docs path is set", async () => {
    const { app } = await buildApp({ production: true, docs: "/my-docs" });
    const res = await app.request("/my-docs");
    expect(res.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* ETag / 304                                                                  */
/* -------------------------------------------------------------------------- */

describe("openapi plugin — ETag handling", () => {
  it("returns 304 when If-None-Match matches the current etag", async () => {
    const { app } = await buildApp();
    const initial = await app.request("/cms/openapi.json");
    const etag = initial.headers.get("etag");
    expect(etag).toBeTruthy();

    const cached = await app.request("/cms/openapi.json", {
      headers: { "if-none-match": etag as string }
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    expect(await cached.text()).toBe("");
  });

  it("changes etag once the cache is invalidated", async () => {
    const { app, ctx } = await buildApp();
    const before = await app.request("/cms/openapi.json");
    const etagBefore = before.headers.get("etag") as string;

    // Add a new collection via the live `collections` map (the kernel mutates
    // it the same way) and emit the event the plugin listens for.
    const collections = ctx.collections as unknown as Record<string, unknown>;
    collections.posts = defineCollection(
      "posts",
      { headline: fields.string({ required: true }) },
      {}
    );
    await ctx.events.emit("schema:after-collection-add", {
      name: "posts",
      collection: collections.posts as never
    });

    const after = await app.request("/cms/openapi.json");
    const etagAfter = after.headers.get("etag") as string;
    expect(etagAfter).not.toBe(etagBefore);

    const spec = (await after.json()) as OpenAPISpec;
    expect(Object.keys(spec.paths)).toContain("/api/posts");
  });
});

/* -------------------------------------------------------------------------- */
/* Service registry — addPath / refresh / getSpec                              */
/* -------------------------------------------------------------------------- */

describe("openapi plugin — service registry", () => {
  it("registers a service on ctx.plugins under the OPENAPI_PLUGIN_ID id", async () => {
    const { ctx } = await buildApp();
    expect(ctx.plugins.has(OPENAPI_PLUGIN_ID)).toBe(true);
    const service = ctx.plugins.get<OpenAPIService>(OPENAPI_PLUGIN_ID);
    expect(typeof service.getSpec).toBe("function");
    expect(typeof service.addPath).toBe("function");
    expect(typeof service.refresh).toBe("function");
  });

  it("addPath injects routes into the served spec", async () => {
    const { app, ctx } = await buildApp();
    const service = ctx.plugins.get<OpenAPIService>(OPENAPI_PLUGIN_ID);
    service.addPath("/api/api-keys", {
      get: {
        tags: ["api-keys"],
        summary: "List API keys",
        responses: { "200": { description: "API key list" } }
      }
    });

    const res = await app.request("/cms/openapi.json");
    const spec = (await res.json()) as OpenAPISpec;
    expect(spec.paths["/api/api-keys"]).toBeDefined();
    expect(((spec.paths["/api/api-keys"] as { get: { summary: string } }).get).summary).toBe("List API keys");
  });

  it("getSpec reflects extra paths and refresh forces a rebuild", async () => {
    const { ctx } = await buildApp();
    const service = ctx.plugins.get<OpenAPIService>(OPENAPI_PLUGIN_ID);
    const firstSpec = service.getSpec();
    expect(firstSpec.paths["/api/extra"]).toBeUndefined();

    service.addPath("/api/extra", { get: { tags: ["extra"], summary: "Extra", responses: { "200": { description: "ok" } } } });
    const secondSpec = service.getSpec();
    expect(secondSpec.paths["/api/extra"]).toBeDefined();
    // refresh() drops the cache; the returned object should still describe
    // the extra path (since `extraPaths` survives across refreshes).
    service.refresh();
    const thirdSpec = service.getSpec();
    expect(thirdSpec.paths["/api/extra"]).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* CORS on the spec routes                                                    */
/* -------------------------------------------------------------------------- */

describe("openapi plugin — CORS on the spec routes", () => {
  it("sends a wildcard allow-origin by default", async () => {
    const { app } = await buildApp();
    const res = await app.request("/cms/openapi.json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("resolves a configured origin on the GET response", async () => {
    const { app } = await buildApp({
      cors: { origin: ["https://allowed.example"], credentials: true }
    });
    const res = await app.request("/cms/openapi.json", {
      headers: { origin: "https://allowed.example" }
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("returns preflight headers on OPTIONS when CORS is configured", async () => {
    const { app } = await buildApp({
      cors: { origin: "https://allowed.example", maxAge: 600 }
    });
    const res = await app.request("/cms/openapi.json", {
      method: "OPTIONS",
      headers: {
        origin: "https://allowed.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "if-none-match"
      }
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-max-age")).toBe("600");
  });

  it("returns the spec-specific preflight headers on plain OPTIONS without an origin", async () => {
    const { app } = await buildApp();
    const res = await app.request("/cms/openapi.json", { method: "OPTIONS" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toContain("if-none-match");
  });
});

/* -------------------------------------------------------------------------- */
/* Smoke: plugin can be installed alongside other plugins                     */
/* -------------------------------------------------------------------------- */

describe("openapi plugin — integration", () => {
  it("installs cleanly via installPlugins on an empty plugin set", async () => {
    const collections = makeCollections();
    const db = createMemoryDatabase({ provider: "memory", collections });
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext({ collections, db, env: {} });
    const result = await installPlugins([openapi()], app, ctx);
    expect(result.installedIds).toEqual([OPENAPI_PLUGIN_ID]);

    const res = await app.request("/cms/openapi.json");
    expect(res.status).toBe(200);
  });

  it("emits a 304 -> 200 round-trip after a schema:after-collection-remove event", async () => {
    const { app, ctx, collections } = await buildApp();
    const initial = await app.request("/cms/openapi.json");
    const etagInitial = initial.headers.get("etag") as string;
    expect(etagInitial).toBeTruthy();

    // Remove the only collection and emit the corresponding event.
    delete (collections as unknown as Record<string, unknown>).articles;
    await ctx.events.emit("schema:after-collection-remove", { name: "articles" });

    const second = await app.request("/cms/openapi.json", {
      headers: { "if-none-match": etagInitial }
    });
    expect(second.status).toBe(200);
    const spec = (await second.json()) as OpenAPISpec;
    expect(Object.keys(spec.paths)).not.toContain("/api/articles");
  });
});

// Side effect for tsc — exercise CMSCollections so the import isn't unused.
type _CollectionsCheck = CMSCollections;
const _unused: _CollectionsCheck = {} as never;
void _unused;
