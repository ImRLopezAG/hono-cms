/**
 * End-to-end integration test for the plugin-manifest runtime.
 *
 * Exercises a real Hono app composed entirely from the new plugin
 * primitives — `installPlugins(...)` plus the carved first-party
 * plugins — against an in-memory database. This proves the manifest
 * runtime, service registry, event bus, auth gate, and per-plugin
 * lifecycle wiring all hold together without the legacy `createCMS`
 * monolith.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPluginContext,
  installPlugins,
  type PluginContext
} from "@hono-cms/core";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { cors } from "@hono-cms/cors";
import { memoryCache } from "@hono-cms/cache";
import { jobsRuntime } from "@hono-cms/jobs-runtime";
import { memoryJobs } from "@hono-cms/jobs";
import { tokensAuth } from "@hono-cms/auth-tokens";
import { rateLimit } from "@hono-cms/rate-limit";
import { audit } from "@hono-cms/audit";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const collections = defineSchema({
  articles: defineCollection("articles", {
    title: fields.string({ required: true }),
    body: fields.text()
  }, { draftAndPublish: true })
});

let workDir: string;
let originalCwd: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "hono-cms-e2e-"));
  originalCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

async function buildApp() {
  const db = createMemoryDatabase({ provider: "memory", collections });
  const ctx = createPluginContext({
    collections,
    db,
    env: {}
  });

  const app = new Hono();
  const plugins = [
    cors({ origin: "*", credentials: false }),
    memoryCache({}),
    jobsRuntime({ adapter: memoryJobs({}) }),
    tokensAuth({}),
    rateLimit({ mutations: { limit: 100, window: "1m" } }),
    audit({})
  ];

  const result = await installPlugins(plugins, app, ctx);

  // Mount a minimal content REST surface — protected by the AuthPlugin
  // and policed by ctx.var.authorize. This stands in for the kernel's
  // content router until create-cms.ts is fully rewritten.
  if (result.authPlugin) {
    app.use("/api/articles/*", result.authPlugin.protected);
    app.use("/api/articles", result.authPlugin.protected);
  }

  app.get("/api/articles", async (c) => {
    if (!(await result.authorize("read", "articles"))) return c.json({ error: "forbidden" }, 403);
    const list = await db.list("articles");
    return c.json(list);
  });

  app.post("/api/articles", async (c) => {
    if (!(await result.authorize("create", "articles"))) return c.json({ error: "forbidden" }, 403);
    const input = (await c.req.json()) as Record<string, unknown>;
    const record = await db.create("articles", input);
    await ctx.events.emit("content:after-create", {
      collection: "articles",
      record,
      identity: c.var.identity ?? null,
      request: c.req.raw
    });
    return c.json(record, 201);
  });

  app.get("/cms/health", (c) => c.json({ ok: true }));

  return { app, ctx, db, result };
}

describe("Plugin system end-to-end", () => {
  it("boots with the full plugin stack and writes a bootstrap key file", async () => {
    const { result } = await buildApp();
    expect(result.installedIds).toEqual([
      "cors",
      "cache",
      "jobs",
      "auth-tokens",
      "rate-limit",
      "audit"
    ]);
    expect(result.authPlugin?.id).toBe("auth-tokens");
    const bootstrapFile = join(workDir, ".cms-bootstrap-key");
    expect(existsSync(bootstrapFile)).toBe(true);
    const contents = readFileSync(bootstrapFile, "utf8");
    expect(contents).toContain("DO NOT COMMIT");
    const token = contents.split("\n").find((line) => line.startsWith("sk_"));
    expect(token).toMatch(/^sk_[0-9a-f]{48}$/);
  });

  it("rejects unauthenticated GET /api/articles with 401", async () => {
    const { app } = await buildApp();
    const res = await app.request("/api/articles");
    expect(res.status).toBe(401);
  });

  it("CORS preflight returns Access-Control-Allow headers", async () => {
    const { app } = await buildApp();
    const res = await app.request("/api/articles", {
      method: "OPTIONS",
      headers: { Origin: "https://example.com", "Access-Control-Request-Method": "POST" }
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });

  it("authenticated POST creates a record and emits content:after-create", async () => {
    const { app, ctx } = await buildApp();
    const token = readFileSync(join(workDir, ".cms-bootstrap-key"), "utf8")
      .split("\n")
      .find((line) => line.startsWith("sk_"))!;

    const events: string[] = [];
    ctx.events.on("content:after-create", (payload) => {
      events.push(payload.collection);
    });

    const res = await app.request("/api/articles", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ title: "Hello world", body: "First article." })
    });

    expect(res.status).toBe(201);
    const record = (await res.json()) as Record<string, unknown>;
    expect(record.title).toBe("Hello world");
    expect(typeof record.id).toBe("string");
    expect(events).toContain("articles");
  });

  it("an event handler that throws does not block siblings", async () => {
    const { ctx } = await buildApp();
    const seen: string[] = [];
    ctx.events.on("content:after-create", () => {
      throw new Error("boom");
    });
    ctx.events.on("content:after-create", () => {
      seen.push("survivor");
    });
    await expect(
      ctx.events.emit("content:after-create", {
        collection: "articles",
        record: { id: "1" } as never,
        identity: null,
        request: new Request("https://example.com")
      })
    ).rejects.toThrowError(/boom/);
    expect(seen).toContain("survivor");
  });

  it("service registry exposes cache + jobs + openapi-style services across plugins", async () => {
    const { ctx } = await buildApp();
    expect(ctx.plugins.has("cache")).toBe(true);
    expect(ctx.plugins.has("jobs")).toBe(true);
    // Cache adapter is registered as the service
    const cache = ctx.plugins.get<{ set(k: string, v: unknown): Promise<void> }>("cache");
    expect(typeof cache.set).toBe("function");
  });

  it("audit-log table is declared via the plugin schema merge", async () => {
    const { ctx } = await buildApp();
    expect(ctx.systemTables.has("audit_log")).toBe(true);
  });

  it("system tables for auth-tokens (api_keys, roles) are present", async () => {
    const { ctx } = await buildApp();
    expect(ctx.systemTables.has("api_keys")).toBe(true);
    expect(ctx.systemTables.has("roles")).toBe(true);
  });
});
