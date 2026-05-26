import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import {
  createPluginContext,
  installPlugins,
  mergeSchemas,
  type HonoCMSEnv
} from "@hono-cms/core";
import { memoryJobs } from "@hono-cms/jobs";
import { jobsRuntime } from "@hono-cms/jobs-runtime";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { audit, AUDIT_CLEANUP_JOB_NAME, AUDIT_PLUGIN_ID, type AuditService } from "../plugin";
import { AUDIT_LOG_TABLE } from "../tables";

const articles = defineSchema({
  articles: defineCollection("articles", {
    title: fields.string({ required: true })
  })
});

function bootstrap() {
  const db = createMemoryDatabase({ provider: "memory", collections: articles });
  const app = new Hono<HonoCMSEnv>();
  const ctx = createPluginContext({ collections: articles, db, env: {} });
  return { app, ctx, db };
}

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://test.local/x", { headers });
}

const ADMIN_IDENTITY = { userId: "u1", roles: ["admin"], email: "admin@test.local" };

describe("audit() — plugin shape", () => {
  it("declares the audit_log system table via Plugin.schema", () => {
    const plugin = audit();
    const merged = mergeSchemas([plugin]);
    expect(merged.has(AUDIT_LOG_TABLE)).toBe(true);
    expect(merged.get(AUDIT_LOG_TABLE)?.fields).toHaveProperty("operation");
    expect(merged.get(AUDIT_LOG_TABLE)?.fields).toHaveProperty("createdAt");
  });

  it("plugin id is exposed as AUDIT_PLUGIN_ID = 'audit'", () => {
    expect(AUDIT_PLUGIN_ID).toBe("audit");
    expect(audit().id).toBe("audit");
  });

  it("registers the AuditService on the plugin registry after install", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins([audit()], app, ctx);

    const service = ctx.plugins.get<AuditService>(AUDIT_PLUGIN_ID);
    expect(service.store).toBeDefined();
    expect(service.config.retentionDays).toBe(90);
  });
});

describe("audit() — event subscription writes one row per mutation", () => {
  it("content:after-create writes a create row", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins([audit()], app, ctx);
    const service = ctx.plugins.get<AuditService>(AUDIT_PLUGIN_ID);

    await ctx.events.emit("content:after-create", {
      collection: "articles",
      record: { id: "doc-1", title: "Hello" } as any,
      identity: ADMIN_IDENTITY,
      request: makeRequest({ "x-request-id": "req-1" })
    });

    const { items } = await service.store.list({});
    expect(items.length).toBe(1);
    expect(items[0]!.operation).toBe("create");
    expect(items[0]!.collection).toBe("articles");
    expect(items[0]!.documentId).toBe("doc-1");
    expect(items[0]!.actorId).toBe("u1");
    expect(items[0]!.actorEmail).toBe("admin@test.local");
    expect(items[0]!.actorRoles).toEqual(["admin"]);
    expect(items[0]!.requestId).toBe("req-1");
    expect(items[0]!.diff.after).toMatchObject({ id: "doc-1", title: "Hello" });
  });

  it("content:after-update writes an update row with before+after diff", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins([audit()], app, ctx);
    const service = ctx.plugins.get<AuditService>(AUDIT_PLUGIN_ID);

    await ctx.events.emit("content:after-update", {
      collection: "articles",
      record: { id: "doc-1", title: "After" } as any,
      before: { id: "doc-1", title: "Before" } as any,
      identity: ADMIN_IDENTITY,
      request: makeRequest()
    });

    const { items } = await service.store.list({});
    expect(items.length).toBe(1);
    expect(items[0]!.operation).toBe("update");
    expect(items[0]!.diff.before).toEqual({ title: "Before" });
    expect(items[0]!.diff.after).toEqual({ title: "After" });
  });

  it("content:after-delete writes a delete row", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins([audit()], app, ctx);
    const service = ctx.plugins.get<AuditService>(AUDIT_PLUGIN_ID);

    await ctx.events.emit("content:after-delete", {
      collection: "articles",
      id: "doc-1",
      record: { id: "doc-1", title: "Hello" } as any,
      identity: ADMIN_IDENTITY,
      request: makeRequest()
    });

    const { items } = await service.store.list({});
    expect(items[0]!.operation).toBe("delete");
    expect(items[0]!.documentId).toBe("doc-1");
    expect(items[0]!.diff.after).toBeNull();
  });

  it("content:after-publish and content:after-unpublish each write one row", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins([audit()], app, ctx);
    const service = ctx.plugins.get<AuditService>(AUDIT_PLUGIN_ID);

    await ctx.events.emit("content:after-publish", {
      collection: "articles",
      record: { id: "doc-1", title: "Hello" } as any,
      identity: ADMIN_IDENTITY,
      request: makeRequest()
    });
    await ctx.events.emit("content:after-unpublish", {
      collection: "articles",
      record: { id: "doc-1", title: "Hello" } as any,
      identity: ADMIN_IDENTITY,
      request: makeRequest()
    });

    const { items } = await service.store.list({});
    expect(items.length).toBe(2);
    expect(items.map((entry) => entry.operation).sort()).toEqual(["publish", "unpublish"]);
  });

  it("media:after-upload and media:after-delete write media rows", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins([audit()], app, ctx);
    const service = ctx.plugins.get<AuditService>(AUDIT_PLUGIN_ID);

    await ctx.events.emit("media:after-upload", {
      record: { id: "m-1", filename: "a.png" },
      identity: ADMIN_IDENTITY,
      request: makeRequest()
    });
    await ctx.events.emit("media:after-delete", {
      record: { id: "m-1", filename: "a.png" },
      identity: ADMIN_IDENTITY,
      request: makeRequest()
    });

    const { items } = await service.store.list({});
    expect(items.length).toBe(2);
    expect(items.map((entry) => entry.operation).sort()).toEqual(["media_delete", "media_upload"]);
    expect(items.every((entry) => entry.collection === "media")).toBe(true);
  });

  it("schema:after-collection-{add,update,remove} write schema_change rows", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins([audit()], app, ctx);
    const service = ctx.plugins.get<AuditService>(AUDIT_PLUGIN_ID);

    const collectionDef = articles.articles as any;

    await ctx.events.emit("schema:after-collection-add", {
      name: "articles",
      collection: collectionDef
    });
    await ctx.events.emit("schema:after-collection-update", {
      name: "articles",
      before: collectionDef,
      after: collectionDef
    });
    await ctx.events.emit("schema:after-collection-remove", { name: "articles" });

    const { items } = await service.store.list({});
    expect(items.length).toBe(3);
    expect(items.every((entry) => entry.operation === "schema_change")).toBe(true);
  });
});

describe("audit() — config knobs", () => {
  it("excludeFields are stripped from the recorded diff", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins([audit({ excludeFields: ["ssn"] })], app, ctx);
    const service = ctx.plugins.get<AuditService>(AUDIT_PLUGIN_ID);

    await ctx.events.emit("content:after-update", {
      collection: "articles",
      record: { id: "doc-1", ssn: "after" } as any,
      before: { id: "doc-1", ssn: "before" } as any,
      identity: ADMIN_IDENTITY,
      request: makeRequest()
    });

    const { items } = await service.store.list({});
    expect(items[0]!.diff.before).not.toHaveProperty("ssn");
    expect(items[0]!.diff.after).not.toHaveProperty("ssn");
  });

  it("maxFieldBytes truncates oversize values", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins([audit({ maxFieldBytes: 16 })], app, ctx);
    const service = ctx.plugins.get<AuditService>(AUDIT_PLUGIN_ID);

    await ctx.events.emit("content:after-create", {
      collection: "articles",
      record: { id: "doc-1", body: "x".repeat(200) } as any,
      identity: ADMIN_IDENTITY,
      request: makeRequest()
    });

    const { items } = await service.store.list({});
    expect((items[0]!.diff.after as any).body).toMatchObject({ truncated: true });
  });

  it("uses a caller-provided store when supplied", async () => {
    const calls: string[] = [];
    const customStore = {
      async append(entry: any) {
        calls.push(entry.operation);
      },
      async list() {
        return { items: [] };
      }
    } as any;

    const { app, ctx } = bootstrap();
    await installPlugins([audit({ store: customStore })], app, ctx);

    await ctx.events.emit("content:after-create", {
      collection: "articles",
      record: { id: "doc-1" } as any,
      identity: ADMIN_IDENTITY,
      request: makeRequest()
    });

    expect(calls).toEqual(["create"]);
  });
});

describe("audit() — jobs-runtime integration", () => {
  it("registers audit-log-cleanup with jobs-runtime when both are installed", async () => {
    const adapter = memoryJobs({});
    const { app, ctx } = bootstrap();
    await installPlugins([jobsRuntime({ adapter }), audit({ retentionDays: 30 })], app, ctx);

    const res = await app.request(`/cms/jobs/${AUDIT_CLEANUP_JOB_NAME}`, { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("works as a no-op when jobs-runtime is not installed (cleanup opt-in)", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins([audit({ retentionDays: 30 })], app, ctx);

    // Cleanup job should NOT be mounted because there's no jobs runtime.
    const res = await app.request(`/cms/jobs/${AUDIT_CLEANUP_JOB_NAME}`, { method: "POST" });
    expect(res.status).toBe(404);

    // But the audit store and event subscriptions still work fine.
    await ctx.events.emit("content:after-create", {
      collection: "articles",
      record: { id: "doc-1" } as any,
      identity: ADMIN_IDENTITY,
      request: makeRequest()
    });
    const service = ctx.plugins.get<AuditService>(AUDIT_PLUGIN_ID);
    const { items } = await service.store.list({});
    expect(items.length).toBe(1);
  });

  it("registered cleanup job actually deletes old rows", async () => {
    const adapter = memoryJobs({});
    const { app, ctx } = bootstrap();
    await installPlugins([jobsRuntime({ adapter }), audit({ retentionDays: 1 })], app, ctx);

    const service = ctx.plugins.get<AuditService>(AUDIT_PLUGIN_ID);
    // Seed an old entry directly.
    await service.store.append({
      id: "old-1",
      operation: "create",
      collection: "articles",
      actorRoles: [],
      requestId: "r",
      diff: { before: null, after: { id: "x" } },
      createdAt: "2020-01-01T00:00:00.000Z"
    });

    const res = await app.request(`/cms/jobs/${AUDIT_CLEANUP_JOB_NAME}`, { method: "POST" });
    expect(res.status).toBe(200);

    const { items } = await service.store.list({});
    expect(items.length).toBe(0);
  });
});

describe("audit() — store fault tolerance", () => {
  it("does not throw if the store.append fails (mutation isn't blocked)", async () => {
    const failing = {
      async append() {
        throw new Error("disk full");
      },
      async list() {
        return { items: [] };
      }
    } as any;

    const { app, ctx } = bootstrap();
    await installPlugins([audit({ store: failing })], app, ctx);

    await expect(
      ctx.events.emit("content:after-create", {
        collection: "articles",
        record: { id: "doc-1" } as any,
        identity: ADMIN_IDENTITY,
        request: makeRequest()
      })
    ).resolves.toBeUndefined();
  });

  it("falls back to anonymous actor when identity is missing or malformed", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins([audit()], app, ctx);
    const service = ctx.plugins.get<AuditService>(AUDIT_PLUGIN_ID);

    await ctx.events.emit("content:after-create", {
      collection: "articles",
      record: { id: "doc-1" } as any,
      identity: null,
      request: makeRequest()
    });

    const { items } = await service.store.list({});
    expect(items[0]!.actorId).toBeUndefined();
    expect(items[0]!.actorRoles).toEqual([]);
  });
});
