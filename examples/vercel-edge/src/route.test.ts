import { describe, expect, test } from "vitest";
import { GET, POST, cronSecret, runtime, vercelJson } from "./route";

describe("Vercel Edge example", () => {
  test("exports edge route handlers backed by the CMS Web Request API", async () => {
    expect(runtime).toBe("edge");

    const health = await GET(new Request("https://vercel.test/cms/health/live"));
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok" });
  });

  test("handles content writes, publish workflow, and public reads", async () => {
    const created = await POST(new Request("https://vercel.test/api/pages", {
      method: "POST",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json"
      },
      body: JSON.stringify({ title: "Vercel Edge CMS", slug: "vercel-edge-cms", body: "A portable edge route." })
    }));
    expect(created.status).toBe(201);
    const page = await created.json() as { id: string; title: string; status: string };
    expect(page).toMatchObject({ title: "Vercel Edge CMS", status: "draft" });

    const publish = await POST(new Request(`https://vercel.test/api/pages/${page.id}/publish`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    }));
    expect(publish.status).toBe(200);

    const list = await GET(new Request("https://vercel.test/api/pages?status=published&filters[slug][$eq]=vercel-edge-cms"));
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      items: [{ id: page.id, title: "Vercel Edge CMS", slug: "vercel-edge-cms", status: "published" }]
    });
  });

  test("exports Vercel cron configuration and protects cron endpoints", async () => {
    expect(vercelJson).toEqual({
      crons: [
        { path: "/cms/jobs/scheduled-publish", schedule: "*/15 * * * *" },
        { path: "/cms/jobs/audit-log-cleanup", schedule: "0 3 * * *" }
      ]
    });

    const denied = await GET(new Request("https://vercel.test/cms/jobs/scheduled-publish"));
    expect(denied.status).toBe(401);

    const allowed = await GET(new Request("https://vercel.test/cms/jobs/scheduled-publish", {
      headers: { authorization: `Bearer ${cronSecret}` }
    }));
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toEqual({ published: 0 });
  });
});
