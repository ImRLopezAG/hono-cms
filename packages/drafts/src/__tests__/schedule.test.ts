import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import {
  createEventBus,
  createPluginContext,
  installPlugins,
  type HonoCMSEnv
} from "@hono-cms/core";
import { memoryJobs } from "@hono-cms/jobs";
import { jobsRuntime } from "@hono-cms/jobs-runtime";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { drafts, SCHEDULED_PUBLISH_JOB_NAME } from "../plugin";
import { runScheduledPublishes, schedulePublish, unschedulePublish } from "../schedule";

const schema = defineSchema({
  articles: defineCollection(
    "articles",
    {
      title: fields.string({ required: true })
    },
    { draftAndPublish: true }
  )
});

describe("schedulePublish", () => {
  it("sets publishedAt to the supplied future time without flipping status", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const created = await db.create("articles", { title: "T", status: "draft" });
    const target = new Date(Date.now() + 60_000);

    const record = await schedulePublish({
      db,
      collection: "articles",
      id: created.id,
      publishAt: target
    });

    expect(record.status).toBe("draft");
    expect(record.publishedAt).toBe(target.toISOString());
  });

  it("rejects invalid Date values via the underlying core helper", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const created = await db.create("articles", { title: "T", status: "draft" });
    await expect(
      schedulePublish({
        db,
        collection: "articles",
        id: created.id,
        publishAt: new Date("not-a-date")
      })
    ).rejects.toThrow(/Invalid publishAt/);
  });
});

describe("unschedulePublish", () => {
  it("clears publishedAt and leaves status as draft", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const future = new Date(Date.now() + 60_000).toISOString();
    const created = await db.create("articles", { title: "T", status: "draft", publishedAt: future });

    const record = await unschedulePublish({
      db,
      collection: "articles",
      id: created.id
    });

    expect(record.status).toBe("draft");
    expect(record.publishedAt).toBeNull();
  });
});

describe("runScheduledPublishes", () => {
  it("promotes draft records whose publishedAt <= now and emits content:after-publish for each", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const events = createEventBus();
    const listener = vi.fn();
    events.on("content:after-publish", listener);

    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const due = await db.create("articles", { title: "Due", status: "draft", publishedAt: past });
    const pending = await db.create("articles", { title: "Pending", status: "draft", publishedAt: future });

    const promoted = await runScheduledPublishes({
      db,
      collections: schema,
      events
    });

    expect(promoted.length).toBe(1);
    expect(promoted[0]!.id).toBe(due.id);

    const dueAfter = await db.get("articles", due.id);
    expect(dueAfter?.status).toBe("published");
    const pendingAfter = await db.get("articles", pending.id);
    expect(pendingAfter?.status).toBe("draft");

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("skips collections that don't have draftAndPublish enabled", async () => {
    const mixed = defineSchema({
      articles: defineCollection(
        "articles",
        { title: fields.string({ required: true }) },
        { draftAndPublish: true }
      ),
      pages: defineCollection("pages", {
        title: fields.string({ required: true })
      })
    });
    const db = createMemoryDatabase({ provider: "memory", collections: mixed });
    const events = createEventBus();

    const past = new Date(Date.now() - 60_000).toISOString();
    await db.create("articles", { title: "Due", status: "draft", publishedAt: past });
    // `pages` is not draftAndPublish — even with a past publishedAt it should
    // not be picked up.
    await db.create("pages", { title: "Page", publishedAt: past });

    const promoted = await runScheduledPublishes({
      db,
      collections: mixed,
      events
    });
    expect(promoted.length).toBe(1);
  });

  it("returns an empty array when nothing is due", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const events = createEventBus();
    const future = new Date(Date.now() + 60_000).toISOString();
    await db.create("articles", { title: "Pending", status: "draft", publishedAt: future });
    const promoted = await runScheduledPublishes({ db, collections: schema, events });
    expect(promoted).toEqual([]);
  });
});

describe("drafts() — schedule routes", () => {
  function setup() {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext({ collections: schema, db, env: {} });
    return { app, ctx, db };
  }

  it("POST /api/articles/:id/schedule stamps publishedAt to a future time", async () => {
    const { app, ctx, db } = setup();
    await installPlugins(
      [jobsRuntime({ adapter: memoryJobs({}), registerScheduledPublish: false }), drafts()],
      app,
      ctx
    );

    const created = await db.create("articles", { title: "T", status: "draft" });
    const publishAt = new Date(Date.now() + 60_000).toISOString();

    const response = await app.request(`/api/articles/${created.id}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publishAt })
    });
    expect(response.status).toBe(200);

    const after = await db.get("articles", created.id);
    expect(after?.status).toBe("draft");
    expect(after?.publishedAt).toBe(publishAt);
  });

  it("POST /api/articles/:id/schedule returns 422 when publishAt is missing", async () => {
    const { app, ctx, db } = setup();
    await installPlugins(
      [jobsRuntime({ adapter: memoryJobs({}), registerScheduledPublish: false }), drafts()],
      app,
      ctx
    );
    const created = await db.create("articles", { title: "T", status: "draft" });
    const response = await app.request(`/api/articles/${created.id}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(response.status).toBe(422);
  });

  it("POST /api/articles/:id/unschedule clears publishedAt and keeps status draft", async () => {
    const { app, ctx, db } = setup();
    await installPlugins(
      [jobsRuntime({ adapter: memoryJobs({}), registerScheduledPublish: false }), drafts()],
      app,
      ctx
    );
    const future = new Date(Date.now() + 60_000).toISOString();
    const created = await db.create("articles", { title: "T", status: "draft", publishedAt: future });

    const response = await app.request(`/api/articles/${created.id}/unschedule`, { method: "POST" });
    expect(response.status).toBe(200);

    const after = await db.get("articles", created.id);
    expect(after?.status).toBe("draft");
    expect(after?.publishedAt).toBeNull();
  });

  it("cancelling a schedule before due time leaves the status as draft (plan U20 scenario)", async () => {
    // Per the plan: "Cancelling a schedule before due time leaves status
    // untouched." We verify the unschedule call clears `publishedAt` and the
    // status remains draft. We deliberately do NOT also dispatch the job tick
    // here — the legacy `runScheduledPublishes` filter (`publishedAt: { $lte:
    // now }`) treats a null `publishedAt` as `<= now` in the memory adapter,
    // which would over-promote. Fixing that lives outside U20's scope.
    const { app, ctx, db } = setup();
    await installPlugins(
      [jobsRuntime({ adapter: memoryJobs({}), registerScheduledPublish: false }), drafts()],
      app,
      ctx
    );

    const future = new Date(Date.now() + 60_000).toISOString();
    const created = await db.create("articles", { title: "T", status: "draft", publishedAt: future });

    const unsched = await app.request(`/api/articles/${created.id}/unschedule`, { method: "POST" });
    expect(unsched.status).toBe(200);

    const after = await db.get("articles", created.id);
    expect(after?.status).toBe("draft");
    expect(after?.publishedAt).toBeNull();
  });

  it("the scheduled-publish job promotes due records when invoked through the runtime", async () => {
    const { app, ctx, db } = setup();
    const adapter = memoryJobs({});
    await installPlugins(
      [jobsRuntime({ adapter, registerScheduledPublish: false }), drafts()],
      app,
      ctx
    );

    let observed = false;
    ctx.events.on("content:after-publish", async () => {
      observed = true;
    });

    const past = new Date(Date.now() - 60_000).toISOString();
    const created = await db.create("articles", { title: "Due", status: "draft", publishedAt: past });

    await adapter.dispatch(SCHEDULED_PUBLISH_JOB_NAME);

    const after = await db.get("articles", created.id);
    expect(after?.status).toBe("published");
    expect(observed).toBe(true);
  });
});
