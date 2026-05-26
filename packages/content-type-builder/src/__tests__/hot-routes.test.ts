import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import {
  createPluginContext,
  installPlugins,
  type HonoCMSEnv
} from "@hono-cms/core";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { contentTypeBuilder } from "../plugin";
import type { SchemaWriter } from "../writer";

function freshSchema() {
  return defineSchema({
    articles: defineCollection("articles", {
      title: fields.string({ required: true })
    })
  }) as unknown as Record<string, ReturnType<typeof defineCollection>>;
}

function bootstrap() {
  const schema = freshSchema();
  const db = createMemoryDatabase({ provider: "memory", collections: schema });
  const app = new Hono<HonoCMSEnv>();
  const ctx = createPluginContext({ collections: schema, db, env: {} });
  return { app, ctx, db, schema };
}

const writer: SchemaWriter = {
  writeCollection: () => ({}),
  removeCollection: () => ({})
};

describe("hot-routes — TrieRouter dispatch", () => {
  it("GET /api/<existing> at boot dispatches to the content sub-app", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins([contentTypeBuilder({ writer })], app, ctx);

    const response = await app.request("/api/articles");
    expect(response.status).toBe(200);
    const json = (await response.json()) as { items: unknown[] };
    expect(Array.isArray(json.items)).toBe(true);
  });

  it("POST /api/<new-type> reaches the dispatcher after a hot collection add", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins([contentTypeBuilder({ writer })], app, ctx);

    // Add a new collection via the admin route.
    const create = await app.request("/cms/content-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "comments",
        fields: { body: { kind: "string", required: true } },
        options: {}
      })
    });
    expect(create.status).toBe(201);

    // The freshly-added collection should now be reachable via /api/*.
    const post = await app.request("/api/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Hello world" })
    });
    expect(post.status).toBe(201);
    const record = (await post.json()) as { id: string; body: string };
    expect(record.id).toBeDefined();
    expect(record.body).toBe("Hello world");

    // And listing the new collection returns the record we just created.
    const list = await app.request("/api/comments");
    expect(list.status).toBe(200);
    const items = (await list.json()) as { items: Array<{ id: string }> };
    expect(items.items).toHaveLength(1);
    expect(items.items[0]?.id).toBe(record.id);
  });

  it("explicit /api/<literal> routes registered before the dispatcher take precedence", async () => {
    const { app, ctx } = bootstrap();

    // Simulate another plugin registering an explicit /api/media route
    // before the catch-all dispatcher.
    app.get("/api/media", () => Response.json({ source: "media-plugin" }));

    await installPlugins([contentTypeBuilder({ writer })], app, ctx);

    const response = await app.request("/api/media");
    expect(response.status).toBe(200);
    const json = (await response.json()) as { source: string };
    expect(json.source).toBe("media-plugin");
  });

  it("dropped collections return 404 from the dispatcher after delete", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins([contentTypeBuilder({ writer })], app, ctx);

    // Sanity: collection exists initially.
    let response = await app.request("/api/articles");
    expect(response.status).toBe(200);

    // Delete it.
    const del = await app.request("/cms/content-types/articles", {
      method: "DELETE"
    });
    expect(del.status).toBe(200);

    // Routes stay registered on the trie (Hono can't un-register), but the
    // handler short-circuits via the liveCollection() guard.
    response = await app.request("/api/articles");
    expect(response.status).toBe(404);
  });
});

describe("hot-routes — event observability", () => {
  it("a custom subscriber observes schema:after-collection-add", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins([contentTypeBuilder({ writer })], app, ctx);

    const observed: Array<{ name: string }> = [];
    ctx.events.on("schema:after-collection-add", async (payload) => {
      observed.push({ name: payload.name });
    });

    await app.request("/cms/content-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "tags",
        fields: { label: { kind: "string", required: true } },
        options: {}
      })
    });

    expect(observed).toEqual([{ name: "tags" }]);
  });
});
