import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createVercelExampleCMS } from "./route";
import { createVercelHandler } from "@hono-cms/platform/vercel";

/**
 * Live-boot probe for the Vercel Edge example.
 *
 * We instantiate the exact same `(Request) => Response` handler that the
 * Vercel Edge runtime invokes in production, then plug it into
 * `Bun.serve({ fetch })` on an ephemeral port. This proves the handler
 * answers real HTTP over a TCP socket — the cross-runtime matrix probes
 * (health / schema / create / publish / audit-log) run via `fetch()` against
 * `127.0.0.1`, not via direct in-process invocation.
 *
 * Because the Vercel Edge contract is "Web-standard `(Request) => Response`",
 * Bun.serve is a faithful proxy for the Vercel Edge invocation surface.
 */

const cms = createVercelExampleCMS();
const handler = createVercelHandler(cms);
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: handler });
  baseUrl = `http://${server.hostname}:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
});

describe("Vercel Edge handler under Bun.serve (live HTTP)", () => {
  test("GET /cms/health/live returns 200 over a real TCP socket", async () => {
    const response = await fetch(`${baseUrl}/cms/health/live`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  test("GET /cms/schema returns posts + authors", async () => {
    const response = await fetch(`${baseUrl}/cms/schema`, {
      headers: { authorization: "Bearer admin" }
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { collections: Record<string, { name: string }> };
    const names = Object.keys(body.collections).sort();
    expect(names).toContain("posts");
    expect(names).toContain("authors");
  });

  test("POST /api/posts creates a draft document with admin auth", async () => {
    const created = await fetch(`${baseUrl}/api/posts`, {
      method: "POST",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Vercel Edge CMS",
        slug: "vercel-edge-cms-live",
        body: "Booted via Bun.serve({ fetch: vercelHandler })."
      })
    });
    expect(created.status).toBe(201);
    const post = (await created.json()) as { id: string; title: string; status: string };
    expect(post).toMatchObject({ title: "Vercel Edge CMS", status: "draft" });

    // Persist id for the publish + audit assertions below.
    (globalThis as Record<string, unknown>).__vercelPostId = post.id;
  });

  test("POST /api/posts/:id/publish flips status to published", async () => {
    const id = (globalThis as Record<string, unknown>).__vercelPostId as string;
    const publish = await fetch(`${baseUrl}/api/posts/${id}/publish`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    });
    expect(publish.status).toBe(200);
    const body = (await publish.json()) as { id: string; status: string };
    expect(body).toMatchObject({ id, status: "published" });
  });

  test("audit log records both the create and the publish entries", async () => {
    const id = (globalThis as Record<string, unknown>).__vercelPostId as string;
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
