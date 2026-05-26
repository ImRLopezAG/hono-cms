import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudflareExampleWorker } from "./worker";

let workDir = "";
let originalCwd = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "cloudflare-worker-e2e-"));
  originalCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("Cloudflare Worker example (plugin shape)", () => {
  test("Worker module exposes a Web Request fetch handler", async () => {
    const worker = createCloudflareExampleWorker();
    const health = await worker.fetch(new Request("https://worker.test/cms/health/live"), {}, {});
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok" });
  });

  test("openapi plugin exposes the configured title at /cms/openapi.json", async () => {
    const worker = createCloudflareExampleWorker();
    const res = await worker.fetch(new Request("https://worker.test/cms/openapi.json"), {}, {});
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { info: { title: string } };
    expect(spec.info.title).toBe("Hono CMS (Cloudflare Worker, plugin shape)");
  });

  test("anonymous POST /api/posts returns 401", async () => {
    const worker = createCloudflareExampleWorker();
    const res = await worker.fetch(new Request("https://worker.test/api/posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "anon" })
    }), {}, {});
    expect(res.status).toBe(401);
  });

  test("authenticated POST creates a record with the bootstrap key", async () => {
    let bootstrapKey = "";
    const worker = createCloudflareExampleWorker({
      onBootstrapKey: (key) => { bootstrapKey = key; }
    });
    // First call triggers lazy CMS init; bootstrap key is captured during it
    await worker.fetch(new Request("https://worker.test/cms/health/live"), {}, {});
    expect(bootstrapKey).toMatch(/^sk_[0-9a-f]{48}$/);

    const created = await worker.fetch(new Request("https://worker.test/api/posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bootstrapKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Cloudflare Worker plugin shape",
        body: "Plugin runtime over Workers.",
        featured: true
      })
    }), {}, {});
    expect(created.status).toBe(201);
    const post = (await created.json()) as { id: string; title: string };
    expect(post.title).toBe("Cloudflare Worker plugin shape");
  });

  test("forwards scheduled events to the configured handler", async () => {
    const scheduledHandler = vi.fn(async () => {});
    const worker = createCloudflareExampleWorker({ scheduledHandler });
    const event = { cron: "*/15 * * * *" };
    const env = { DB: "d1-binding" };
    const ctx = { waitUntil: vi.fn() };
    await worker.scheduled?.(event, env, ctx);
    expect(scheduledHandler).toHaveBeenCalledWith("*/15 * * * *", env, ctx);
  });
});
