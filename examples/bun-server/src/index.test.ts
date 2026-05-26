import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createBunExampleCMS } from "./cms";

/**
 * Boot the CMS programmatically via Bun.serve on an ephemeral port (port: 0).
 * This proves the production code path — `Bun.serve({ fetch: cms.fetch })` —
 * works end-to-end over a real TCP socket, not just via direct app.fetch()
 * invocation. The same fetch() calls a `curl` user would make are exercised
 * against 127.0.0.1.
 */

const cms = createBunExampleCMS();
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: cms.fetch });
  baseUrl = `http://${server.hostname}:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
});

describe("Hono CMS on Bun.serve (no framework)", () => {
  test("liveness endpoint returns 200 OK over a real HTTP socket", async () => {
    const response = await fetch(`${baseUrl}/cms/health/live`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  test("OpenAPI schema document advertises the posts collection", async () => {
    const response = await fetch(`${baseUrl}/cms/openapi.json`);
    expect(response.status).toBe(200);
    const spec = (await response.json()) as { paths: Record<string, unknown> };
    expect(spec.paths["/api/posts"]).toBeDefined();
    expect(spec.paths["/api/authors"]).toBeDefined();
  });

  test("POST /api/posts creates a draft document with admin auth", async () => {
    const created = await fetch(`${baseUrl}/api/posts`, {
      method: "POST",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Bun-native CMS",
        slug: "bun-native-cms",
        body: "Booted by Bun.serve({ fetch })."
      })
    });
    expect(created.status).toBe(201);
    const post = (await created.json()) as { id: string; title: string; status: string };
    expect(post).toMatchObject({ title: "Bun-native CMS", status: "draft" });

    // Persist id for the publish + audit assertions below.
    (globalThis as Record<string, unknown>).__postId = post.id;
  });

  test("POST /api/posts/:id/publish flips status to published", async () => {
    const id = (globalThis as Record<string, unknown>).__postId as string;
    const publish = await fetch(`${baseUrl}/api/posts/${id}/publish`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    });
    expect(publish.status).toBe(200);

    const list = await fetch(`${baseUrl}/api/posts?status=published&filters[slug][$eq]=bun-native-cms`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: Array<{ id: string; status: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id, status: "published" });
  });

  test("audit log records both the create and the publish entries", async () => {
    const id = (globalThis as Record<string, unknown>).__postId as string;
    const audit = await fetch(`${baseUrl}/cms/audit-log?collection=posts&documentId=${id}`, {
      headers: { authorization: "Bearer admin" }
    });
    expect(audit.status).toBe(200);
    const body = (await audit.json()) as { items: Array<{ operation: string }> };
    const operations = body.items.map((item) => item.operation);
    expect(operations).toContain("create");
    expect(operations).toContain("publish");
  });
});
