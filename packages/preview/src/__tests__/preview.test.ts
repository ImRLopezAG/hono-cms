import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { memoryCache } from "@hono-cms/cache";
import {
  CMSPluginError,
  createPluginContext,
  installPlugins,
  type HonoCMSEnv
} from "@hono-cms/core";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { PREVIEW_PLUGIN_ID, preview } from "../plugin";
import { PREVIEW_TOKEN_PATTERN } from "../tokens";

const schema = defineSchema({
  articles: defineCollection("articles", {
    title: fields.string({ required: true })
  })
});

type SessionLike = { userId: string; roles: string[] } | null;

/**
 * Build a Hono app + plugin context wired with the preview plugin.
 *
 * The middleware at `*` stamps `c.var.session` from the closed-over
 * `currentSession` ref so individual tests can flip between authenticated
 * and anonymous identities without rebuilding the whole stack.
 */
function bootstrap(opts: {
  previewUrl?: string;
  ttlSeconds?: number;
  withCache?: boolean;
} = {}) {
  const { previewUrl, ttlSeconds, withCache = true } = opts;
  const db = createMemoryDatabase({ provider: "memory", collections: schema });
  const app = new Hono<HonoCMSEnv>();
  const ctx = createPluginContext({ collections: schema, db, env: {} });

  let currentSession: SessionLike = { userId: "user-1", roles: ["editor"] };
  app.use("*", async (c, next) => {
    c.set("session", currentSession);
    await next();
  });

  const previewOpts: Parameters<typeof preview>[0] = {};
  if (previewUrl !== undefined) previewOpts.url = previewUrl;
  if (ttlSeconds !== undefined) previewOpts.tokenTtlSeconds = ttlSeconds;

  const plugins = withCache
    ? [memoryCache({}), preview(previewOpts)]
    : [preview(previewOpts)];

  return {
    app,
    ctx,
    install: () => installPlugins(plugins, app, ctx),
    setSession(next: SessionLike) {
      currentSession = next;
    }
  };
}

describe("preview() plugin manifest", () => {
  it("returns a Plugin with id 'preview' and requires the cache plugin", () => {
    const plugin = preview();
    expect(plugin.id).toBe(PREVIEW_PLUGIN_ID);
    expect(plugin.id).toBe("preview");
    expect(plugin.requires).toEqual(["cache"]);
  });

  it("install fails when the cache plugin is missing", async () => {
    const harness = bootstrap({ withCache: false });
    await expect(harness.install()).rejects.toBeInstanceOf(CMSPluginError);
  });
});

describe("POST /api/preview-tokens — token issuance", () => {
  let harness: ReturnType<typeof bootstrap>;
  beforeEach(async () => {
    harness = bootstrap({ previewUrl: "https://site.example/preview" });
    await harness.install();
  });

  it("issues a token in the documented prev_<32-hex> format", async () => {
    const res = await harness.app.request("/api/preview-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection: "articles", documentId: "doc-1" })
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; previewUrl: string; expiresAt: string };
    expect(body.token).toMatch(PREVIEW_TOKEN_PATTERN);
    expect(body.token).toMatch(/^prev_[0-9a-f]{32}$/);
    expect(typeof body.expiresAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false);
  });

  it("appends the token as a query parameter to the configured preview URL", async () => {
    const res = await harness.app.request("/api/preview-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection: "articles", documentId: "doc-1" })
    });

    const body = (await res.json()) as { token: string; previewUrl: string };
    const url = new URL(body.previewUrl);
    expect(url.origin + url.pathname).toBe("https://site.example/preview");
    expect(url.searchParams.get("token")).toBe(body.token);
  });

  it("substitutes the {{token}} placeholder when present in the configured URL", async () => {
    const placeholderHarness = bootstrap({
      previewUrl: "https://site.example/p/{{token}}/show"
    });
    await placeholderHarness.install();

    const res = await placeholderHarness.app.request("/api/preview-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection: "articles", documentId: "doc-1" })
    });
    const body = (await res.json()) as { token: string; previewUrl: string };
    expect(body.previewUrl).toBe(`https://site.example/p/${body.token}/show`);
  });

  it("rejects anonymous callers with 403", async () => {
    harness.setSession(null);
    const res = await harness.app.request("/api/preview-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection: "articles", documentId: "doc-1" })
    });
    expect(res.status).toBe(403);
  });

  it("returns 422 when collection/documentId are missing", async () => {
    const res = await harness.app.request("/api/preview-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(422);
  });
});

describe("GET /api/preview-tokens/:token/verify", () => {
  let harness: ReturnType<typeof bootstrap>;
  beforeEach(async () => {
    harness = bootstrap({ previewUrl: "https://site.example/preview" });
    await harness.install();
  });

  it("verifies a freshly issued token within its TTL", async () => {
    const createRes = await harness.app.request("/api/preview-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection: "articles", documentId: "doc-42" })
    });
    const { token } = (await createRes.json()) as { token: string };

    const verifyRes = await harness.app.request(`/api/preview-tokens/${token}/verify`);
    expect(verifyRes.status).toBe(200);
    expect(await verifyRes.json()).toEqual({
      ok: true,
      collection: "articles",
      documentId: "doc-42"
    });
  });

  it("returns 404 for unknown tokens", async () => {
    const fake = "prev_" + "0".repeat(32);
    const res = await harness.app.request(`/api/preview-tokens/${fake}/verify`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for malformed token formats", async () => {
    const res = await harness.app.request("/api/preview-tokens/not-a-token/verify");
    expect(res.status).toBe(404);
  });
});

describe("TTL expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("verify returns 404 once the token TTL has elapsed", async () => {
    const harness = bootstrap({
      previewUrl: "https://site.example/preview",
      ttlSeconds: 2
    });
    await harness.install();

    const createRes = await harness.app.request("/api/preview-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection: "articles", documentId: "doc-1" })
    });
    const { token } = (await createRes.json()) as { token: string };

    // Token is live immediately.
    const liveRes = await harness.app.request(`/api/preview-tokens/${token}/verify`);
    expect(liveRes.status).toBe(200);

    // Advance past the TTL — the memory cache's lazy expiry triggers on `.get`.
    vi.advanceTimersByTime(5_000);

    const expiredRes = await harness.app.request(`/api/preview-tokens/${token}/verify`);
    expect(expiredRes.status).toBe(404);
  });
});

describe("DELETE /api/preview-tokens/:token", () => {
  it("revokes a token and subsequent verify returns 404", async () => {
    const harness = bootstrap({ previewUrl: "https://site.example/preview" });
    await harness.install();

    const createRes = await harness.app.request("/api/preview-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection: "articles", documentId: "doc-1" })
    });
    const { token } = (await createRes.json()) as { token: string };

    const deleteRes = await harness.app.request(`/api/preview-tokens/${token}`, {
      method: "DELETE"
    });
    expect(deleteRes.status).toBe(204);

    const verifyRes = await harness.app.request(`/api/preview-tokens/${token}/verify`);
    expect(verifyRes.status).toBe(404);
  });

  it("rejects anonymous callers with 403 on revoke", async () => {
    const harness = bootstrap({ previewUrl: "https://site.example/preview" });
    await harness.install();
    harness.setSession(null);

    const res = await harness.app.request("/api/preview-tokens/prev_" + "a".repeat(32), {
      method: "DELETE"
    });
    expect(res.status).toBe(403);
  });
});
