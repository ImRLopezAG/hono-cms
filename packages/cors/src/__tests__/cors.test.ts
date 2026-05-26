import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import type { CMSCollections } from "@hono-cms/schema";
import {
  createPluginContext,
  installPlugins,
  type HonoCMSEnv
} from "@hono-cms/core";
import { cors, CORS_PLUGIN_ID } from "../plugin";
import {
  applyCorsHeaders,
  corsPreflightResponse,
  normalizeCors,
  resolveCorsOrigin
} from "../middleware";

/* -------------------------------------------------------------------------- */
/* Helper: a tiny Hono app with the cors plugin manually wired up via the     */
/* same middleware/route shape the kernel will use after U9 lands.            */
/* -------------------------------------------------------------------------- */

function makeApp(opts: Parameters<typeof cors>[0] = {}): Hono<HonoCMSEnv> {
  const plugin = cors(opts);
  const app = new Hono<HonoCMSEnv>();
  for (const decl of plugin.middlewares ?? []) {
    app.use(decl.path as string, decl.middleware);
  }
  plugin.app?.(app, {} as never);
  app.get("/hello", (c) => c.json({ ok: true }));
  return app;
}

/* -------------------------------------------------------------------------- */
/* Helper unit tests — exercise the ported helpers directly                   */
/* -------------------------------------------------------------------------- */

describe("normalizeCors", () => {
  it("fills in kernel defaults when given an empty config", () => {
    const result = normalizeCors({});
    expect(result.origin).toBe("*");
    expect(result.credentials).toBe(false);
    expect(result.methods).toEqual(["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"]);
    expect(result.allowedHeaders).toEqual([
      "authorization",
      "content-type",
      "x-request-id",
      "x-filename"
    ]);
    expect(result.exposedHeaders).toEqual([]);
    expect(result.maxAge).toBeUndefined();
  });

  it("preserves user-supplied overrides", () => {
    const result = normalizeCors({
      origin: "https://example.com",
      credentials: true,
      methods: ["GET"],
      allowedHeaders: ["x-foo"],
      exposedHeaders: ["x-bar"],
      maxAge: 600
    });
    expect(result.origin).toBe("https://example.com");
    expect(result.credentials).toBe(true);
    expect(result.methods).toEqual(["GET"]);
    expect(result.allowedHeaders).toEqual(["x-foo"]);
    expect(result.exposedHeaders).toEqual(["x-bar"]);
    expect(result.maxAge).toBe(600);
  });
});

describe("resolveCorsOrigin", () => {
  function req(origin: string | null): Request {
    const headers = origin ? { origin } : undefined;
    return new Request("https://api.test/anything", headers ? { headers } : undefined);
  }

  it("returns '*' for the wildcard origin without credentials", () => {
    const out = resolveCorsOrigin(normalizeCors({ origin: "*" }), req("https://app.test"));
    expect(out).toBe("*");
  });

  it("echoes the request origin when '*' is paired with credentials", () => {
    const out = resolveCorsOrigin(
      normalizeCors({ origin: "*", credentials: true }),
      req("https://app.test")
    );
    expect(out).toBe("https://app.test");
  });

  it("matches a string origin only when the request origin matches", () => {
    const config = normalizeCors({ origin: "https://app.test" });
    expect(resolveCorsOrigin(config, req("https://app.test"))).toBe("https://app.test");
    expect(resolveCorsOrigin(config, req("https://evil.test"))).toBeNull();
  });

  it("matches the request origin against an allowlist array", () => {
    const config = normalizeCors({
      origin: ["https://a.test", "https://b.test"]
    });
    expect(resolveCorsOrigin(config, req("https://a.test"))).toBe("https://a.test");
    expect(resolveCorsOrigin(config, req("https://b.test"))).toBe("https://b.test");
    expect(resolveCorsOrigin(config, req("https://c.test"))).toBeNull();
  });

  it("delegates to a function origin and honors its return value", () => {
    let invoked = false;
    const config = normalizeCors({
      origin: (origin) => {
        invoked = true;
        return origin === "https://allowed.test" ? origin : false;
      }
    });
    expect(resolveCorsOrigin(config, req("https://allowed.test"))).toBe("https://allowed.test");
    expect(invoked).toBe(true);
    expect(resolveCorsOrigin(config, req("https://denied.test"))).toBeNull();
  });

  it("returns null when origin: false", () => {
    expect(resolveCorsOrigin(normalizeCors({ origin: false }), req("https://app.test"))).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Preflight + actual-request behavior                                        */
/* -------------------------------------------------------------------------- */

describe("corsPreflightResponse", () => {
  it("builds a 204 preflight with allow-methods + allow-headers", () => {
    const request = new Request("https://api.test/anything", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-custom"
      }
    });
    const response = corsPreflightResponse({ origin: "*", maxAge: 600 }, request);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(204);
    expect(response?.headers.get("access-control-allow-origin")).toBe("*");
    expect(response?.headers.get("access-control-allow-methods")).toBe(
      "GET, HEAD, POST, PATCH, DELETE, OPTIONS"
    );
    expect(response?.headers.get("access-control-allow-headers")).toBe("x-custom");
    expect(response?.headers.get("access-control-max-age")).toBe("600");
  });

  it("returns null for non-preflight OPTIONS requests", () => {
    const request = new Request("https://api.test/anything", {
      method: "OPTIONS",
      headers: { origin: "https://app.test" }
    });
    expect(corsPreflightResponse({}, request)).toBeNull();
  });

  it("returns null when the config is disabled (false/undefined)", () => {
    const request = new Request("https://api.test/anything", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.test",
        "access-control-request-method": "POST"
      }
    });
    expect(corsPreflightResponse(undefined, request)).toBeNull();
    expect(corsPreflightResponse(false, request)).toBeNull();
  });
});

describe("applyCorsHeaders", () => {
  it("sets allow-credentials and expose-headers when configured", () => {
    const request = new Request("https://api.test/x", {
      headers: { origin: "https://app.test" }
    });
    const response = new Response(null);
    applyCorsHeaders(
      {
        origin: "https://app.test",
        credentials: true,
        exposedHeaders: ["x-total-count"]
      },
      request,
      response
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-expose-headers")).toBe("x-total-count");
    expect(response.headers.get("vary")).toMatch(/Origin/);
  });

  it("is a no-op when the origin is not allowed", () => {
    const request = new Request("https://api.test/x", {
      headers: { origin: "https://evil.test" }
    });
    const response = new Response(null);
    applyCorsHeaders({ origin: "https://app.test" }, request, response);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Plugin manifest shape                                                      */
/* -------------------------------------------------------------------------- */

describe("cors() plugin manifest", () => {
  it("returns a Plugin with id 'cors' and one middleware on '*'", () => {
    const plugin = cors();
    expect(plugin.id).toBe(CORS_PLUGIN_ID);
    expect(plugin.middlewares).toHaveLength(1);
    expect(plugin.middlewares?.[0]?.path).toBe("*");
    expect(typeof plugin.app).toBe("function");
  });
});

/* -------------------------------------------------------------------------- */
/* End-to-end through a real Hono app                                         */
/* -------------------------------------------------------------------------- */

describe("cors() plugin — end-to-end through a Hono app", () => {
  it("OPTIONS preflight returns 204 with Access-Control-Allow-* headers", async () => {
    const app = makeApp({ origin: "*" });
    const response = await app.request("/hello", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.test",
        "access-control-request-method": "POST"
      }
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("Actual GET request gets CORS headers applied to the response", async () => {
    const app = makeApp({ origin: "*" });
    const response = await app.request("/hello", {
      method: "GET",
      headers: { origin: "https://app.test" }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("vary")).toMatch(/Origin/);
  });

  it("origin: ['a', 'b'] only allows listed origins", async () => {
    const app = makeApp({ origin: ["https://a.test", "https://b.test"] });

    const allowed = await app.request("/hello", {
      headers: { origin: "https://a.test" }
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://a.test");

    const denied = await app.request("/hello", {
      headers: { origin: "https://c.test" }
    });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("origin: (origin) => ... callback fires and controls the header", async () => {
    let invoked = 0;
    const app = makeApp({
      origin: (origin) => {
        invoked++;
        return origin === "https://allow.test" ? origin : false;
      }
    });

    const allowed = await app.request("/hello", {
      headers: { origin: "https://allow.test" }
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://allow.test");

    const denied = await app.request("/hello", {
      headers: { origin: "https://deny.test" }
    });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(invoked).toBeGreaterThanOrEqual(2);
  });

  it("credentials: true adds Access-Control-Allow-Credentials: true", async () => {
    const app = makeApp({ origin: "https://app.test", credentials: true });
    const response = await app.request("/hello", {
      headers: { origin: "https://app.test" }
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("methods controls Access-Control-Allow-Methods on preflight", async () => {
    const app = makeApp({ origin: "*", methods: ["GET", "POST"] });
    const response = await app.request("/hello", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.test",
        "access-control-request-method": "POST"
      }
    });
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST");
  });
});

/* -------------------------------------------------------------------------- */
/* Integration: installed via the plugin runtime                              */
/* -------------------------------------------------------------------------- */

describe("cors() plugin — installPlugins integration", () => {
  it("installing cors({ origin: '*' }) decorates kernel routes with CORS headers", async () => {
    const db = createMemoryDatabase({
      provider: "memory",
      collections: {} as CMSCollections
    });
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext({
      collections: {} as CMSCollections,
      db,
      env: {}
    });

    const result = await installPlugins([cors({ origin: "*" })], app, ctx);
    expect(result.installedIds).toContain(CORS_PLUGIN_ID);

    // Register a "kernel-style" GET after install — the middleware mounted by
    // the plugin must still wrap it because Hono middleware applies in
    // declaration order.
    app.get("/api/things", (c) => c.json({ items: [] }));

    const response = await app.request("/api/things", {
      headers: { origin: "https://client.test" }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("vary")).toMatch(/Origin/);
  });

  it("installing cors() handles a preflight via the mounted OPTIONS catch-all", async () => {
    const db = createMemoryDatabase({
      provider: "memory",
      collections: {} as CMSCollections
    });
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext({
      collections: {} as CMSCollections,
      db,
      env: {}
    });

    await installPlugins([cors({ origin: "*", maxAge: 600 })], app, ctx);

    const response = await app.request("/api/anything", {
      method: "OPTIONS",
      headers: {
        origin: "https://client.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, authorization"
      }
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type, authorization");
    expect(response.headers.get("access-control-max-age")).toBe("600");
  });
});
