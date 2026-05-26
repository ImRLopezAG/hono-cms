import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import {
  createPluginContext,
  installPlugins,
  mergeSchemas,
  type HonoCMSEnv,
  type TranslationProvider
} from "@hono-cms/core";
import { memoryJobs } from "@hono-cms/jobs";
import { jobsRuntime } from "@hono-cms/jobs-runtime";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { i18n, I18N_PLUGIN_ID, type I18nService } from "../plugin";
import { TRANSLATIONS_TABLE } from "../tables";
import { enqueueTranslationJobs } from "../jobs";

const schema = defineSchema({
  pages: defineCollection(
    "pages",
    {
      title: fields.string({ required: true }),
      body: fields.text()
    },
    { i18n: { locales: ["en", "es", "es-MX"], defaultLocale: "en" } }
  ),
  articles: defineCollection("articles", { title: fields.string({ required: true }) })
});

function stubProvider(): TranslationProvider {
  return {
    provider: "test-provider",
    async translate({ fields }) {
      return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, `[es] ${value}`]));
    }
  };
}

function adminRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      "content-type": "application/json"
    }
  });
}

const ADMIN_SESSION = { userId: "u1", roles: ["admin"], email: "admin@test.local" };
const EDITOR_SESSION = { userId: "u2", roles: ["editor"], email: "editor@test.local" };

function adminMiddleware() {
  return async (c: any, next: any) => {
    const auth = c.req.header("authorization") ?? "";
    if (auth === "Bearer admin") c.set("session", ADMIN_SESSION);
    else if (auth === "Bearer editor") c.set("session", EDITOR_SESSION);
    else c.set("session", null);
    await next();
  };
}

async function bootstrap(opts: { provider?: TranslationProvider; translateOnPublish?: boolean; autoTranslate?: boolean } = {}) {
  const db = createMemoryDatabase({ provider: "memory", collections: schema });
  const app = new Hono<HonoCMSEnv>();
  app.use("*", adminMiddleware());
  const ctx = createPluginContext({ collections: schema, db, env: {} });
  const adapter = memoryJobs({});
  const enqueueSpy = vi.fn(async (_endpoint: string, _body?: unknown) => {});
  // Swap the adapter's enqueue with a spy so we can observe the queue.
  (adapter as any).enqueue = enqueueSpy;
  await installPlugins(
    [
      jobsRuntime({ adapter, registerScheduledPublish: false }),
      i18n({
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.translateOnPublish ? { translateOnPublish: true } : {}),
        ...(opts.autoTranslate ? { autoTranslate: true } : {})
      })
    ],
    app,
    ctx
  );
  return { app, ctx, db, enqueueSpy };
}

describe("i18n() — plugin shape", () => {
  it("declares the translations system table via Plugin.schema", () => {
    const plugin = i18n();
    const merged = mergeSchemas([plugin]);
    expect(merged.has(TRANSLATIONS_TABLE)).toBe(true);
    expect(merged.get(TRANSLATIONS_TABLE)?.fields).toHaveProperty("locale");
    expect(merged.get(TRANSLATIONS_TABLE)?.fields).toHaveProperty("status");
  });

  it("plugin id is exposed as I18N_PLUGIN_ID = 'i18n'", () => {
    expect(I18N_PLUGIN_ID).toBe("i18n");
    expect(i18n().id).toBe("i18n");
  });

  it("requires the jobs runtime to install", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext({ collections: schema, db, env: {} });
    await expect(installPlugins([i18n()], app, ctx)).rejects.toThrow();
  });

  it("registers the I18nService on the plugin registry after install", async () => {
    const { ctx } = await bootstrap({ provider: stubProvider() });
    const service = ctx.plugins.get<I18nService>(I18N_PLUGIN_ID);
    expect(service.store).toBeDefined();
    expect(service.provider?.provider).toBe("test-provider");
  });
});

describe("i18n() — backfill route", () => {
  it("returns 503 when no provider is configured", async () => {
    const { app } = await bootstrap();
    const res = await app.request(
      adminRequest("https://cms.test/cms/admin/i18n/backfill", {
        method: "POST",
        headers: { authorization: "Bearer admin" },
        body: JSON.stringify({ locale: "es", collection: "pages" })
      })
    );
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "translation_provider_not_configured" });
  });

  it("requires an admin session (editor returns 403)", async () => {
    const { app } = await bootstrap({ provider: stubProvider() });
    const res = await app.request(
      adminRequest("https://cms.test/cms/admin/i18n/backfill", {
        method: "POST",
        headers: { authorization: "Bearer editor" },
        body: JSON.stringify({ locale: "es", collection: "pages" })
      })
    );
    expect(res.status).toBe(403);
  });

  it("enqueues translation jobs for all rows in the target collection", async () => {
    const { app, db, enqueueSpy } = await bootstrap({ provider: stubProvider() });
    await db.create("pages", { title: "One", locale: "en" });
    await db.create("pages", { title: "Two", locale: "en" });

    const res = await app.request(
      adminRequest("https://cms.test/cms/admin/i18n/backfill", {
        method: "POST",
        headers: { authorization: "Bearer admin" },
        body: JSON.stringify({ locale: "es", collection: "pages" })
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "enqueued",
      locale: "es",
      collection: "pages",
      jobCount: 2,
      collections: { pages: 2 }
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    const translationCalls = enqueueSpy.mock.calls.filter(([endpoint]) => endpoint === "/cms/jobs/translation");
    expect(translationCalls).toHaveLength(2);
    for (const [, payload] of translationCalls) {
      expect(payload).toMatchObject({ collection: "pages", targetLocale: "es" });
    }
  });

  it("returns 422 when locale equals defaultLocale", async () => {
    const { app } = await bootstrap({ provider: stubProvider() });
    const res = await app.request(
      adminRequest("https://cms.test/cms/admin/i18n/backfill", {
        method: "POST",
        headers: { authorization: "Bearer admin" },
        body: JSON.stringify({ locale: "en", collection: "pages" })
      })
    );
    expect(res.status).toBe(422);
  });

  it("returns 400 i18n_not_enabled when targeting a non-localized collection", async () => {
    const { app } = await bootstrap({ provider: stubProvider() });
    const res = await app.request(
      adminRequest("https://cms.test/cms/admin/i18n/backfill", {
        method: "POST",
        headers: { authorization: "Bearer admin" },
        body: JSON.stringify({ locale: "es", collection: "articles" })
      })
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "i18n_not_enabled" });
  });

  it("status route reports per-collection counts", async () => {
    const { app, db, enqueueSpy } = await bootstrap({ provider: stubProvider() });
    await db.create("pages", { title: "One", locale: "en" });
    await db.create("pages", { title: "Two", locale: "en" });

    // Drive a backfill to populate pending rows.
    await app.request(
      adminRequest("https://cms.test/cms/admin/i18n/backfill", {
        method: "POST",
        headers: { authorization: "Bearer admin" },
        body: JSON.stringify({ locale: "es", collection: "pages" })
      })
    );
    expect(enqueueSpy).toHaveBeenCalledTimes(2);

    const status = await app.request(
      adminRequest("https://cms.test/cms/admin/i18n/backfill/status?locale=es&collection=pages", {
        headers: { authorization: "Bearer admin" }
      })
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      locale: "es",
      collection: "pages",
      totals: { total: 2, pending: 2, missing: 0 },
      collections: [{ collection: "pages", total: 2, pending: 2 }]
    });
  });
});

describe("i18n() — translation job", () => {
  it("translates a document end-to-end through POST /cms/jobs/translation", async () => {
    const { app, ctx, db } = await bootstrap({ provider: stubProvider() });
    const page = await db.create("pages", { title: "Hello", locale: "en" });

    const res = await app.request(
      new Request("https://cms.test/cms/jobs/translation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ collection: "pages", documentId: page.id, targetLocale: "es" })
      })
    );
    expect(res.status).toBe(200);

    const service = ctx.plugins.get<I18nService>(I18N_PLUGIN_ID);
    const stored = await service.store.getVariant("pages", page.id, "es");
    expect(stored?.status).toBe("complete");
    expect(stored?.fields).toMatchObject({ title: "[es] Hello" });
  });
});

describe("i18n() — translate-on-publish", () => {
  it("enqueues translation jobs when content:after-publish fires", async () => {
    const { ctx, db, enqueueSpy } = await bootstrap({
      provider: stubProvider(),
      translateOnPublish: true
    });
    const page = await db.create("pages", { title: "Hello", locale: "en" });

    await ctx.events.emit("content:after-publish", {
      collection: "pages",
      record: { ...page, status: "published" } as any,
      identity: ADMIN_SESSION,
      request: new Request("https://cms.test/api/pages")
    });

    expect(enqueueSpy).toHaveBeenCalled();
    // One job per non-default locale (es, es-MX).
    const nonDefaultCalls = enqueueSpy.mock.calls.filter(
      ([endpoint]) => endpoint === "/cms/jobs/translation"
    );
    expect(nonDefaultCalls).toHaveLength(2);
    const targets = nonDefaultCalls.map(([, payload]) => (payload as any).targetLocale).sort();
    expect(targets).toEqual(["es", "es-MX"]);
  });

  it("does not enqueue when translateOnPublish is disabled", async () => {
    const { ctx, db, enqueueSpy } = await bootstrap({ provider: stubProvider() });
    const page = await db.create("pages", { title: "Hello", locale: "en" });

    await ctx.events.emit("content:after-publish", {
      collection: "pages",
      record: { ...page, status: "published" } as any,
      identity: ADMIN_SESSION,
      request: new Request("https://cms.test/api/pages")
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

describe("enqueueTranslationJobs", () => {
  it("fans out one job per non-default locale when enabled", async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = [];
    const enqueue = async (endpoint: string, payload?: unknown) => {
      calls.push({ endpoint, payload: payload ?? null });
    };
    const collection = schema.pages as any;
    await enqueueTranslationJobs(enqueue, collection, {
      id: "p1",
      status: "draft",
      title: "Hi",
      createdAt: "",
      updatedAt: ""
    } as any, { enabled: true });
    expect(calls.map((c) => (c.payload as any).targetLocale).sort()).toEqual(["es", "es-MX"]);
  });

  it("is a no-op when enabled is not true", async () => {
    const calls: number[] = [];
    const enqueue = async () => {
      calls.push(1);
    };
    await enqueueTranslationJobs(enqueue, schema.pages as any, {
      id: "p1",
      title: "Hi",
      createdAt: "",
      updatedAt: ""
    } as any);
    expect(calls).toHaveLength(0);
  });

  it("respects translateOnPublish by skipping non-published records", async () => {
    const calls: number[] = [];
    const enqueue = async () => {
      calls.push(1);
    };
    await enqueueTranslationJobs(enqueue, schema.pages as any, {
      id: "p1",
      status: "draft",
      title: "Hi",
      createdAt: "",
      updatedAt: ""
    } as any, { enabled: true, translateOnPublish: true });
    expect(calls).toHaveLength(0);
  });
});
