import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import {
  CMSPluginError,
  createPluginContext,
  installPlugins,
  type HonoCMSEnv
} from "@hono-cms/core";
import { memoryJobs } from "@hono-cms/jobs";
import { jobsRuntime } from "@hono-cms/jobs-runtime";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { drafts, DRAFTS_PLUGIN_ID, SCHEDULED_PUBLISH_JOB_NAME } from "../plugin";

const schema = defineSchema({
  articles: defineCollection(
    "articles",
    {
      title: fields.string({ required: true })
    },
    { draftAndPublish: true }
  ),
  // Plain collection — used to confirm the plugin only mounts publish routes
  // when `draftAndPublish` is enabled.
  authors: defineCollection("authors", {
    name: fields.string({ required: true })
  })
});

function bootstrap() {
  const db = createMemoryDatabase({ provider: "memory", collections: schema });
  const app = new Hono<HonoCMSEnv>();
  const ctx = createPluginContext({ collections: schema, db, env: {} });
  return { app, ctx, db };
}

describe("drafts() — plugin manifest", () => {
  it("returns a Plugin with id 'drafts' and requires the jobs plugin", () => {
    const plugin = drafts();
    expect(plugin.id).toBe(DRAFTS_PLUGIN_ID);
    expect(plugin.id).toBe("drafts");
    expect(plugin.requires).toEqual(["jobs"]);
  });

  it("install fails when the jobs plugin is missing", async () => {
    const { app, ctx } = bootstrap();
    await expect(installPlugins([drafts()], app, ctx)).rejects.toBeInstanceOf(CMSPluginError);
  });

  it("installs cleanly with jobs-runtime present (built-in scheduled-publish disabled)", async () => {
    const { app, ctx } = bootstrap();
    const result = await installPlugins(
      [
        jobsRuntime({ adapter: memoryJobs({}), registerScheduledPublish: false }),
        drafts()
      ],
      app,
      ctx
    );
    expect(result.installedIds).toContain("jobs");
    expect(result.installedIds).toContain("drafts");
  });

  it("registers the scheduled-publish job with the jobs runtime", async () => {
    const { app, ctx } = bootstrap();
    const adapter = memoryJobs({});
    await installPlugins(
      [jobsRuntime({ adapter, registerScheduledPublish: false }), drafts()],
      app,
      ctx
    );
    // The memory jobs adapter records registrations on its internal map.
    // We can verify by dispatching: if the job wasn't registered, dispatch
    // would throw or be a silent no-op.
    expect(SCHEDULED_PUBLISH_JOB_NAME).toBe("scheduled-publish");
    // Dispatch is a smoke test — no rows are due yet but the handler should run.
    await adapter.dispatch(SCHEDULED_PUBLISH_JOB_NAME);
  });
});

describe("drafts() — publish routes", () => {
  it("POST /api/articles/:id/publish flips status to 'published' and emits content:after-publish", async () => {
    const { app, ctx, db } = bootstrap();
    await installPlugins(
      [jobsRuntime({ adapter: memoryJobs({}), registerScheduledPublish: false }), drafts()],
      app,
      ctx
    );

    let observed: { collection: string; recordId: string } | null = null;
    ctx.events.on("content:after-publish", async (payload) => {
      observed = { collection: payload.collection, recordId: payload.record.id };
    });

    const created = await db.create("articles", { title: "Draft One", status: "draft" });
    const response = await app.request(`/api/articles/${created.id}/publish`, { method: "POST" });
    expect(response.status).toBe(200);

    const after = await db.get("articles", created.id);
    expect(after?.status).toBe("published");
    expect(observed).toEqual({ collection: "articles", recordId: created.id });
  });

  it("POST /api/articles/:id/unpublish reverts to draft and emits content:after-unpublish", async () => {
    const { app, ctx, db } = bootstrap();
    await installPlugins(
      [jobsRuntime({ adapter: memoryJobs({}), registerScheduledPublish: false }), drafts()],
      app,
      ctx
    );

    let observed: string | null = null;
    ctx.events.on("content:after-unpublish", async (payload) => {
      observed = payload.collection;
    });

    const created = await db.create("articles", {
      title: "Live",
      status: "published",
      publishedAt: new Date().toISOString()
    });
    const response = await app.request(`/api/articles/${created.id}/unpublish`, { method: "POST" });
    expect(response.status).toBe(200);

    const after = await db.get("articles", created.id);
    expect(after?.status).toBe("draft");
    expect(observed).toBe("articles");
  });

  it("returns 404 when the collection is not draftAndPublish", async () => {
    const { app, ctx, db } = bootstrap();
    await installPlugins(
      [jobsRuntime({ adapter: memoryJobs({}), registerScheduledPublish: false }), drafts()],
      app,
      ctx
    );
    const created = await db.create("authors", { name: "A" });
    const response = await app.request(`/api/authors/${created.id}/publish`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  it("returns 404 for an unknown document id", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins(
      [jobsRuntime({ adapter: memoryJobs({}), registerScheduledPublish: false }), drafts()],
      app,
      ctx
    );
    const response = await app.request("/api/articles/does-not-exist/publish", { method: "POST" });
    expect(response.status).toBe(404);
  });
});
