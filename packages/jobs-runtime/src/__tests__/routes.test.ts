import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { HonoCMSEnv, JobsAdapter } from "@hono-cms/core";
import { memoryJobs } from "@hono-cms/jobs";
import { runVerifiedJob } from "../dispatcher";
import { mountJobRoute } from "../routes";

describe("runVerifiedJob", () => {
  it("returns 401 when adapter.verify rejects the request", async () => {
    const adapter: JobsAdapter = {
      provider: "test",
      register() {},
      async dispatch() {},
      verify: async () => false
    };
    const res = await runVerifiedJob(adapter, new Request("https://cms.test/cms/jobs/foo"), () => "should not run");
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("skips verification when adapter.verify is absent", async () => {
    const adapter: JobsAdapter = {
      provider: "test",
      register() {},
      async dispatch() {}
    };
    const run = vi.fn(async () => ({ ran: true }));
    const res = await runVerifiedJob(adapter, new Request("https://cms.test/cms/jobs/foo"), run);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ran: true });
    expect(run).toHaveBeenCalled();
  });

  it("forwards a Response result without wrapping", async () => {
    const adapter: JobsAdapter = { provider: "test", register() {}, async dispatch() {} };
    const customResponse = Response.json({ custom: true }, { status: 202 });
    const res = await runVerifiedJob(adapter, new Request("https://cms.test/cms/jobs/foo"), async () => customResponse);
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ custom: true });
  });

  it("returns 500 with the error message when the job throws", async () => {
    const adapter: JobsAdapter = { provider: "test", register() {}, async dispatch() {} };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await runVerifiedJob(adapter, new Request("https://cms.test/cms/jobs/foo"), async () => {
        throw new Error("boom");
      });
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toMatchObject({ error: "job_failed", message: "boom" });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("mountJobRoute", () => {
  it("mounts both GET and POST handlers by default", async () => {
    const app = new Hono<HonoCMSEnv>();
    const adapter = memoryJobs({});
    const run = vi.fn(async () => ({ result: true }));
    mountJobRoute(app, adapter, "noop", run);

    const post = await app.request("/cms/jobs/noop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 1 })
    });
    expect(post.status).toBe(200);
    expect(run).toHaveBeenLastCalledWith({ x: 1 });

    const get = await app.request("/cms/jobs/noop");
    expect(get.status).toBe(200);
    expect(run).toHaveBeenLastCalledWith(undefined);
  });

  it("skips the GET mount when allowGet is false", async () => {
    const app = new Hono<HonoCMSEnv>();
    const adapter = memoryJobs({});
    mountJobRoute(app, adapter, "post-only", async () => ({ ok: true }), { allowGet: false });

    const get = await app.request("/cms/jobs/post-only");
    expect(get.status).toBe(404);

    const post = await app.request("/cms/jobs/post-only", { method: "POST" });
    expect(post.status).toBe(200);
  });

  it("returns the raw text body as undefined payload when JSON parsing fails", async () => {
    const app = new Hono<HonoCMSEnv>();
    const adapter = memoryJobs({});
    const run = vi.fn(async (payload: unknown) => ({ payload }));
    mountJobRoute(app, adapter, "lenient", run);

    const res = await app.request("/cms/jobs/lenient", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not-json"
    });
    expect(res.status).toBe(200);
    expect(run).toHaveBeenLastCalledWith(undefined);
  });
});
