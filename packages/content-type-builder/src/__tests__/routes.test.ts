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

function baseSchema() {
  return defineSchema({
    articles: defineCollection("articles", {
      title: fields.string({ required: true })
    })
  });
}

function bootstrap(writer: SchemaWriter) {
  const schema = baseSchema() as unknown as Record<string, ReturnType<typeof defineCollection>>;
  const db = createMemoryDatabase({ provider: "memory", collections: schema });
  const app = new Hono<HonoCMSEnv>();
  const ctx = createPluginContext({ collections: schema, db, env: {} });
  return { app, ctx, db, schema };
}

async function install(app: Hono<HonoCMSEnv>, ctx: ReturnType<typeof createPluginContext>, writer: SchemaWriter) {
  await installPlugins([contentTypeBuilder({ writer })], app, ctx);
}

describe("POST /cms/content-types", () => {
  it("creates a new collection, writes via the writer, mutates ctx.collections, emits event", async () => {
    let writeCalled: { mode: string; name: string; sourceLen: number } | null = null;
    const writer: SchemaWriter = {
      writeCollection: ({ collection, source, mode }) => {
        writeCalled = { mode, name: collection.name, sourceLen: source.length };
        return { path: `./schema/${collection.name}.ts`, source };
      }
    };
    const { app, ctx, schema } = bootstrap(writer);
    await install(app, ctx, writer);

    let addEvent: { name: string } | null = null;
    ctx.events.on("schema:after-collection-add", async (payload) => {
      addEvent = { name: payload.name };
    });

    const body = {
      name: "posts",
      fields: { title: { kind: "string", required: true } },
      options: {}
    };
    const response = await app.request("/cms/content-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    expect(response.status).toBe(201);
    const json = (await response.json()) as Record<string, unknown>;
    expect((json.collection as { name: string }).name).toBe("posts");
    expect(json.path).toBe("./schema/posts.ts");

    // Writer received the call.
    expect(writeCalled).toEqual({ mode: "create", name: "posts", sourceLen: expect.any(Number) });

    // ctx.collections mutated in place.
    expect(schema.posts).toBeDefined();
    expect(schema.posts?.name).toBe("posts");

    // Event fired.
    expect(addEvent).toEqual({ name: "posts" });
  });

  it("returns 409 when the collection already exists", async () => {
    const writer: SchemaWriter = { writeCollection: () => ({}) };
    const { app, ctx } = bootstrap(writer);
    await install(app, ctx, writer);

    const response = await app.request("/cms/content-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "articles",
        fields: { title: { kind: "string" } },
        options: {}
      })
    });
    expect(response.status).toBe(409);
    const json = (await response.json()) as { error: string };
    expect(json.error).toBe("collection_exists");
  });

  it("returns 422 when the body is invalid", async () => {
    const writer: SchemaWriter = { writeCollection: () => ({}) };
    const { app, ctx } = bootstrap(writer);
    await install(app, ctx, writer);

    const response = await app.request("/cms/content-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bad Name", fields: {}, options: {} })
    });
    expect(response.status).toBe(422);
  });
});

describe("PUT /cms/content-types/:name", () => {
  it("rewrites the file + un-registers the old route + emits update", async () => {
    let lastWrite: { mode: string; name: string } | null = null;
    const writer: SchemaWriter = {
      writeCollection: ({ collection, mode }) => {
        lastWrite = { mode, name: collection.name };
        return {};
      }
    };
    const { app, ctx, schema } = bootstrap(writer);
    await install(app, ctx, writer);

    let updated: { name: string } | null = null;
    let removed: { name: string } | null = null;
    let added: { name: string } | null = null;
    ctx.events.on("schema:after-collection-update", async (payload) => {
      updated = { name: payload.name };
    });
    ctx.events.on("schema:after-collection-remove", async (payload) => {
      removed = { name: payload.name };
    });
    ctx.events.on("schema:after-collection-add", async (payload) => {
      added = { name: payload.name };
    });

    // Rename articles -> stories
    const response = await app.request("/cms/content-types/articles", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "stories",
        fields: { title: { kind: "string", required: true } },
        options: {}
      })
    });
    expect(response.status).toBe(200);

    // The writer rewrote the file under the new name.
    expect(lastWrite).toEqual({ mode: "update", name: "stories" });

    // The live collection map dropped the old name and registered the new.
    expect(schema.articles).toBeUndefined();
    expect(schema.stories).toBeDefined();

    // Events fired (add + remove on rename, plus update).
    expect(updated).toEqual({ name: "stories" });
    expect(removed).toEqual({ name: "articles" });
    expect(added).toEqual({ name: "stories" });
  });

  it("returns 404 when the collection does not exist", async () => {
    const writer: SchemaWriter = { writeCollection: () => ({}) };
    const { app, ctx } = bootstrap(writer);
    await install(app, ctx, writer);

    const response = await app.request("/cms/content-types/missing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "missing",
        fields: { title: { kind: "string" } },
        options: {}
      })
    });
    expect(response.status).toBe(404);
  });
});

describe("DELETE /cms/content-types/:name", () => {
  it("returns 501 when the writer does not implement removeCollection", async () => {
    const writer: SchemaWriter = { writeCollection: () => ({}) };
    const { app, ctx } = bootstrap(writer);
    await install(app, ctx, writer);

    const response = await app.request("/cms/content-types/articles", {
      method: "DELETE"
    });
    expect(response.status).toBe(501);
    const json = (await response.json()) as { error: string };
    expect(json.error).toBe("content_type_remove_unsupported");
  });

  it("removes the file + drops the collection from the live map + emits event", async () => {
    let removedCall: { name: string } | null = null;
    const writer: SchemaWriter = {
      writeCollection: () => ({}),
      removeCollection: ({ collection }) => {
        removedCall = { name: collection.name };
        return { message: "deleted" };
      }
    };
    const { app, ctx, schema } = bootstrap(writer);
    await install(app, ctx, writer);

    let event: { name: string } | null = null;
    ctx.events.on("schema:after-collection-remove", async (payload) => {
      event = { name: payload.name };
    });

    const response = await app.request("/cms/content-types/articles", {
      method: "DELETE"
    });
    expect(response.status).toBe(200);
    expect(removedCall).toEqual({ name: "articles" });
    expect(schema.articles).toBeUndefined();
    expect(event).toEqual({ name: "articles" });
  });

  it("returns 404 when the collection does not exist", async () => {
    const writer: SchemaWriter = {
      writeCollection: () => ({}),
      removeCollection: () => ({})
    };
    const { app, ctx } = bootstrap(writer);
    await install(app, ctx, writer);

    const response = await app.request("/cms/content-types/missing", {
      method: "DELETE"
    });
    expect(response.status).toBe(404);
  });
});

describe("GET /cms/content-types", () => {
  it("returns the current collection list and capabilities", async () => {
    const writer: SchemaWriter = {
      writeCollection: () => ({}),
      removeCollection: () => ({})
    };
    const { app, ctx } = bootstrap(writer);
    await install(app, ctx, writer);

    const response = await app.request("/cms/content-types");
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      collections: Record<string, unknown>;
      capabilities: { writable: boolean; removable: boolean };
    };
    expect(json.collections.articles).toBeDefined();
    expect(json.capabilities.writable).toBe(true);
    expect(json.capabilities.removable).toBe(true);
  });
});
