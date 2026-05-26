import { describe, expect, test } from "vitest";
import { createNextRouteHandlers } from "@hono-cms/platform/next";
import { GET, POST } from "../app/api/cms/[...route]/route";
import { createNextExampleCMS } from "./cms";

describe("Next.js App Router example", () => {
  test("exports route handlers backed by the CMS Web Request API (with /api/cms basePath strip)", async () => {
    // Live URL shape: Next mounts the catch-all at /api/cms/[...route], so the
    // adapter strips that prefix before forwarding to the CMS.
    const health = await GET(new Request("https://next.test/api/cms/cms/health/live"));
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok" });

    const created = await POST(new Request("https://next.test/api/cms/api/posts", {
      method: "POST",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json"
      },
      body: JSON.stringify({ title: "Next Route Handler", slug: "next-route-handler", body: "Mounted through app/api/cms/[...route]." })
    }));
    expect(created.status).toBe(201);
    const createdPost = await created.json() as { id: string; title: string; status: string };
    expect(createdPost).toMatchObject({ title: "Next Route Handler", status: "draft" });

    const publish = await POST(new Request(`https://next.test/api/cms/api/posts/${createdPost.id}/publish`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    }));
    expect(publish.status).toBe(200);

    const list = await GET(new Request("https://next.test/api/cms/api/posts?status=published"));
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      items: [{ id: createdPost.id, title: "Next Route Handler", status: "published" }]
    });
  });

  test("creates content types through Next route handlers with generated artifacts", async () => {
    const writes: Array<{ source: string; name: string; mode: string }> = [];
    const handlers = createNextRouteHandlers(createNextExampleCMS({
      contentTypeWriter: {
        importPath: "@hono-cms/schema",
        writeCollection(input) {
          writes.push({ source: input.source, name: input.collection.name, mode: input.mode });
          return {
            path: `cms/collections/${input.collection.name}.ts`,
            artifacts: ["node_modules/.cms/sdk/index.ts"],
            migrations: [`.hono-cms/migrations/create_${input.collection.name}.sql`],
            message: "Generated schema artifacts from Next App Router"
          };
        }
      }
    }));

    const response = await handlers.POST(new Request("https://next.test/cms/content-types", {
      method: "POST",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: "products",
        fields: {
          title: { kind: "string", required: true, max: 120 },
          slug: { kind: "uid", targetField: "title" },
          gallery: { kind: "media", multiple: true },
          status: { kind: "enum", values: ["draft", "active"] }
        },
        options: { draftAndPublish: true }
      })
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      collection: {
        name: "products",
        fields: {
          title: { kind: "string", required: true, max: 120 },
          slug: { kind: "uid", targetField: "title" },
          gallery: { kind: "media", multiple: true },
          status: { kind: "enum", values: ["draft", "active"] }
        },
        options: { draftAndPublish: true }
      },
      path: "cms/collections/products.ts",
      artifacts: ["node_modules/.cms/sdk/index.ts"],
      migrations: [".hono-cms/migrations/create_products.sql"],
      message: "Generated schema artifacts from Next App Router"
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ name: "products", mode: "create" });
    expect(writes[0]?.source).toContain("defineCollection(");
    expect(writes[0]?.source).toContain("\"products\"");
    expect(writes[0]?.source).toContain("fields.uid({");
    expect(writes[0]?.source).toContain("\"targetField\": \"title\"");
  });
});
