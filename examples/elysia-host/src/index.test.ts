import { describe, expect, test } from "vitest";
import { createElysiaApp } from "./index";

const ORIGIN = "http://elysia.test";

function call(path: string, init?: RequestInit) {
  return app.handle(new Request(`${ORIGIN}${path}`, init));
}

const app = createElysiaApp();

describe("Elysia host example", () => {
  test("Elysia root route returns the welcome string", async () => {
    const response = await call("/");
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("Hono CMS via Elysia host");
  });

  test("forwards CMS health checks through the /api/cms prefix", async () => {
    const response = await call("/api/cms/cms/health/live");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  test("exposes the schema with posts and authors collections", async () => {
    const response = await call("/api/cms/cms/schema", {
      headers: { authorization: "Bearer admin" }
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { collections: Record<string, { name: string }> };
    const names = Object.keys(body.collections).sort();
    expect(names).toEqual(["authors", "posts"]);
  });

  test("creates a draft post and publishes it via the mounted CMS", async () => {
    const created = await call("/api/cms/api/posts", {
      method: "POST",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Elysia post",
        slug: "elysia-post",
        body: "Authored from an ElysiaJS host."
      })
    });
    expect(created.status).toBe(201);
    const post = await created.json() as { id: string; title: string; status: string };
    expect(post).toMatchObject({ title: "Elysia post", status: "draft" });

    const publish = await call(`/api/cms/api/posts/${post.id}/publish`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    });
    expect(publish.status).toBe(200);
    const published = await publish.json() as { id: string; status: string };
    expect(published).toMatchObject({ id: post.id, status: "published" });

    const list = await call("/api/cms/api/posts?status=published&filters[slug][$eq]=elysia-post");
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      items: [{ id: post.id, title: "Elysia post", slug: "elysia-post", status: "published" }]
    });
  });

  test("non-prefixed paths fall through Elysia (404)", async () => {
    const response = await call("/cms/health/live");
    expect(response.status).toBe(404);
  });
});
