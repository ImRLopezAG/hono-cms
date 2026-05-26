import { describe, expect, test, vi } from "vitest";
import worker, { createCloudflareExampleWorker } from "./worker";

describe("Cloudflare Worker example", () => {
  test("exports a Worker module backed by the CMS Web Request API", async () => {
    const health = await worker.fetch(new Request("https://worker.test/cms/health/live"), {}, {});
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok" });
  });

  test("handles content writes, publish workflow, and public reads", async () => {
    const app = createCloudflareExampleWorker();

    const created = await app.fetch(new Request("https://worker.test/api/posts", {
      method: "POST",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json"
      },
      body: JSON.stringify({ title: "Cloudflare Worker CMS", body: "Runs on Web Request handlers.", featured: true })
    }), {}, {});
    expect(created.status).toBe(201);
    const post = await created.json() as { id: string; title: string; status: string };
    expect(post).toMatchObject({ title: "Cloudflare Worker CMS", status: "draft" });

    const publish = await app.fetch(new Request(`https://worker.test/api/posts/${post.id}/publish`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    }), {}, {});
    expect(publish.status).toBe(200);

    const list = await app.fetch(new Request("https://worker.test/api/posts?status=published&filters[featured][$eq]=true"), {}, {});
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      items: [{ id: post.id, title: "Cloudflare Worker CMS", status: "published", featured: true }]
    });
  });

  test("forwards scheduled events to portable CMS jobs", async () => {
    const scheduledHandler = vi.fn(async () => {});
    const app = createCloudflareExampleWorker({ scheduledHandler });
    const event = { cron: "*/15 * * * *" };
    const env = { DB: "d1-binding", R2_BUCKET: "media-binding" };
    const ctx = { waitUntil: vi.fn() };

    await app.scheduled?.(event, env, ctx);

    expect(scheduledHandler).toHaveBeenCalledWith("*/15 * * * *", env, ctx);
  });
});
