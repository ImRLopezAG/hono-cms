import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import {
  createPluginContext,
  installPlugins,
  type HonoCMSEnv,
  type JobHandler,
  type JobsAdapter
} from "@hono-cms/core";
import { memoryJobs } from "@hono-cms/jobs";
import type { CMSCollections } from "@hono-cms/schema";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { jobsRuntime, JOBS_RUNTIME_ID, type JobsService } from "../plugin";

const articles = defineSchema({
  articles: defineCollection("articles", {
    title: fields.string({ required: true })
  })
});

function bootstrap(adapter: JobsAdapter, options: { withCache?: boolean } = {}) {
  const db = createMemoryDatabase({ provider: "memory", collections: articles });
  const app = new Hono<HonoCMSEnv>();
  const ctx = createPluginContext({ collections: articles, db, env: {} });
  if (options.withCache) {
    ctx.plugins.register("cache", {
      provider: "memory",
      async get() { return null; },
      async set() {},
      async delete() {},
      async sweep() { return { swept: 0 }; }
    });
  }
  return { app, ctx, db };
}

describe("jobsRuntime — plugin shape", () => {
  it("returns a Plugin with id 'jobs'", () => {
    const plugin = jobsRuntime({ adapter: memoryJobs({}) });
    expect(plugin.id).toBe(JOBS_RUNTIME_ID);
    expect(plugin.id).toBe("jobs");
  });

  it("registerJob installs a job and POST /cms/jobs/<name> invokes it", async () => {
    const { app, ctx } = bootstrap(memoryJobs({}));
    await installPlugins([jobsRuntime({ adapter: memoryJobs({}) })], app, ctx);

    const handler = vi.fn<JobHandler>(async () => {});
    const service = ctx.plugins.get<JobsService>(JOBS_RUNTIME_ID);
    service.registerJob("foo", handler);

    const res = await app.request("/cms/jobs/foo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" })
    });

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    const callArgs = handler.mock.calls[0]!;
    expect(callArgs[0]).toEqual({ message: "hello" });
    expect(callArgs[1]).toMatchObject({ cms: null });
  });

  it("dispatch() and enqueue() reach the adapter", async () => {
    const adapter = memoryJobs({});
    const { app, ctx } = bootstrap(adapter);
    await installPlugins([jobsRuntime({ adapter })], app, ctx);
    const service = ctx.plugins.get<JobsService>(JOBS_RUNTIME_ID);

    const handler = vi.fn<JobHandler>(async () => {});
    service.registerJob("dispatched", handler);

    await service.dispatch("dispatched", { from: "dispatch" });
    expect(handler).toHaveBeenCalledTimes(1);

    await service.enqueue("/cms/jobs/dispatched", { from: "enqueue" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("registerJob throws when the same name is registered twice", async () => {
    const { app, ctx } = bootstrap(memoryJobs({}));
    await installPlugins([jobsRuntime({ adapter: memoryJobs({}) })], app, ctx);
    const service = ctx.plugins.get<JobsService>(JOBS_RUNTIME_ID);

    service.registerJob("dupe", async () => {});
    expect(() => service.registerJob("dupe", async () => {})).toThrow(/already registered/);
  });
});

describe("jobsRuntime — verification", () => {
  it("rejects requests without a valid signature when adapter.verify is configured", async () => {
    const verify = vi.fn(async () => false);
    const adapter: JobsAdapter = {
      provider: "test",
      register() {},
      async dispatch() {},
      verify
    };

    const { app, ctx } = bootstrap(adapter);
    await installPlugins([jobsRuntime({ adapter })], app, ctx);
    const service = ctx.plugins.get<JobsService>(JOBS_RUNTIME_ID);
    const handler = vi.fn(async () => {});
    service.registerJob("guarded", handler);

    const res = await app.request("/cms/jobs/guarded", { method: "POST" });
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("accepts requests when adapter.verify returns true", async () => {
    const verify = vi.fn(async () => true);
    const adapter: JobsAdapter = {
      provider: "test",
      register() {},
      async dispatch() {},
      verify
    };

    const { app, ctx } = bootstrap(adapter);
    await installPlugins([jobsRuntime({ adapter })], app, ctx);
    const service = ctx.plugins.get<JobsService>(JOBS_RUNTIME_ID);
    const handler = vi.fn(async () => {});
    service.registerJob("guarded", handler);

    const res = await app.request("/cms/jobs/guarded", { method: "POST" });
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("jobsRuntime — cache-sweep gating", () => {
  it("does not register cache-sweep when cache plugin is absent", async () => {
    const adapter = memoryJobs({});
    const { app, ctx } = bootstrap(adapter, { withCache: false });
    await installPlugins([jobsRuntime({ adapter })], app, ctx);

    const res = await app.request("/cms/jobs/cache-sweep", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("registers cache-sweep when cache plugin is present", async () => {
    const adapter = memoryJobs({});
    const { app, ctx } = bootstrap(adapter, { withCache: true });
    await installPlugins([jobsRuntime({ adapter })], app, ctx);

    const res = await app.request("/cms/jobs/cache-sweep", { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("jobsRuntime — built-in scheduled-publish", () => {
  it("mounts POST /cms/jobs/scheduled-publish by default", async () => {
    const adapter = memoryJobs({});
    const { app, ctx } = bootstrap(adapter);
    await installPlugins([jobsRuntime({ adapter })], app, ctx);

    const res = await app.request("/cms/jobs/scheduled-publish", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("can be disabled via registerScheduledPublish: false", async () => {
    const adapter = memoryJobs({});
    const { app, ctx } = bootstrap(adapter);
    await installPlugins(
      [jobsRuntime({ adapter, registerScheduledPublish: false })],
      app,
      ctx
    );

    const res = await app.request("/cms/jobs/scheduled-publish", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// Ensure the test schema is treated as a valid CMSCollections without
// dragging in test-time identity helpers.
const _typecheckCollections: CMSCollections = articles;
void _typecheckCollections;
