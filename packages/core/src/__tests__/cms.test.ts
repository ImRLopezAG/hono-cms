import { describe, expect, test, vi } from "vitest";
import { defineCollection, defineSchema, fields, generateDrizzleSchema, generateTypeScriptSDK } from "@hono-cms/schema";
import { auditLogCleanupJob, createCMS, decodeCursor, definePlugin, encodeCursor, hashApiKey, matchesEventPattern, MemoryAuditStore, MemoryMediaStore, MemoryOrganizationStore, MemoryWebhookStore, parsePopulateParams, parseQueryParams, runWebhookRetrySweep, webhookDeliveryCleanupJob } from "../index";
import { createMemoryDatabase } from "../../../adapter-memory/src/index";
import { createMemoryStorage } from "../../../storage-memory/src/index";
import "../../../cache/src/index";
import "../../../jobs/src/index";
import "../../../storage-memory/src/index";

const collections = defineSchema({
  articles: defineCollection("articles", {
    title: fields.string({ required: true }),
    body: fields.text(),
    internalNotes: fields.text({ private: true }),
    author: fields.relation("authors", "one")
  }, { draftAndPublish: true }),
  authors: defineCollection("authors", {
    name: fields.string({ required: true }),
    apiKey: fields.string({ private: true })
  }),
  pages: defineCollection("pages", {
    title: fields.string({ required: true })
  }, {
    i18n: { locales: ["en", "es", "es-MX"], defaultLocale: "en" }
  })
});

function cms() {
  return createCMS({
    collections,
    db: createMemoryDatabase({ provider: "memory", collections }),
    storage: { provider: "memory" },
    cache: { provider: "memory" },
    jobs: { provider: "memory" },
    auth: {
      tokens: {
        admin: { userId: "1", roles: ["admin"] },
        editor: { userId: "2", roles: ["editor"] }
      }
    },
    rbac: {
      publicRead: true,
      rules: [
        { action: "create", collection: "articles", roles: ["editor"] },
        { action: "update", collection: "articles", roles: ["editor"] },
        { action: "publish", collection: "articles", roles: ["editor"] }
      ]
    },
    preview: { url: "https://site.test/preview" }
  });
}

function findDanglingOpenAPIRefs(spec: { components?: { schemas?: Record<string, unknown> } }): string[] {
  const schemas = new Set(Object.keys(spec.components?.schemas ?? {}));
  const dangling: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    const reference = record.$ref;
    if (typeof reference === "string" && reference.startsWith("#/components/schemas/")) {
      const name = reference.slice("#/components/schemas/".length);
      if (!schemas.has(name)) dangling.push(reference);
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(spec);
  return [...new Set(dangling)].sort();
}

describe("createCMS", () => {
  test("matches webhook event patterns across exact, wildcard, and multi-segment events", () => {
    expect(matchesEventPattern("articles.publish", "articles.publish")).toBe(true);
    expect(matchesEventPattern("articles.publish", "*.publish")).toBe(true);
    expect(matchesEventPattern("content.articles.publish", "content.*.publish")).toBe(true);
    expect(matchesEventPattern("content.sections.news.publish", "content.**.publish")).toBe(true);
    expect(matchesEventPattern("cms.test", "cms.*")).toBe(true);
    expect(matchesEventPattern("cms.jobs.webhook-retry.failed", "cms.**.failed")).toBe(true);
    expect(matchesEventPattern("articles.create", "*.publish")).toBe(false);
    expect(matchesEventPattern("content.articles.publish", "*.publish")).toBe(false);
    expect(matchesEventPattern("cms.test", "cms.test.extra")).toBe(false);
    expect(matchesEventPattern("", "*")).toBe(false);
  });

  test("returns a Web Request compatible Hono app", async () => {
    const app = cms();
    const response = await app.fetch(new Request("https://cms.test/cms/health"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok", checks: { db: { status: "ok" } } });

    const live = await app.fetch(new Request("https://cms.test/cms/health/live"));
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toMatchObject({ status: "ok" });

    const ready = await app.fetch(new Request("https://cms.test/cms/health/ready"));
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ status: "ok" });
  });

  test("serves admin-only schema metadata for generated clients", async () => {
    const app = cms();

    const forbidden = await app.fetch(new Request("https://cms.test/cms/schema"));
    expect(forbidden.status).toBe(403);

    const response = await app.fetch(new Request("https://cms.test/cms/schema", {
      headers: { authorization: "Bearer admin" }
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      collections: {
        articles: {
          name: "articles",
          options: { draftAndPublish: true },
          fields: {
            title: { kind: "string", required: true, private: false },
            internalNotes: { kind: "text", private: true },
            author: { kind: "relation", target: "authors", cardinality: "one" }
          }
        },
        pages: {
          fields: {
            title: { kind: "string", required: true }
          },
          options: { i18n: { locales: ["en", "es", "es-MX"], defaultLocale: "en" } }
        }
      }
    });
  });

  test("exposes content-type capabilities and keeps schema writes read-only without a writer", async () => {
    const app = cms();

    const forbidden = await app.fetch(new Request("https://cms.test/cms/content-types/capabilities"));
    expect(forbidden.status).toBe(403);

    const capabilities = await app.fetch(new Request("https://cms.test/cms/content-types/capabilities", {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(capabilities.json()).resolves.toMatchObject({ writable: false, mode: "read-only" });

    const create = await app.fetch(new Request("https://cms.test/cms/content-types", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "sections", fields: { title: { kind: "string", required: true } } })
    }));
    expect(create.status).toBe(403);
    await expect(create.json()).resolves.toMatchObject({ error: "content_type_builder_read_only" });
  });

  test("writes generated collection source through a configured content-type writer", async () => {
    const writes: Array<{ mode: string; source: string; collection: string }> = [];
    const afterWrites: Array<{ mode: string; resultPath?: string; source: string; collection: string }> = [];
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      cache: { provider: "memory" },
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      contentTypeBuilder: {
        writer: {
          importPath: "@cms/schema",
          writeCollection(input) {
            writes.push({ mode: input.mode, source: input.source, collection: input.collection.name });
            return { path: `cms/collections/${input.collection.name}.ts` };
          },
          afterWrite(input) {
            afterWrites.push({
              mode: input.mode,
              source: input.source,
              collection: input.collection.name,
              ...(input.result.path ? { resultPath: input.result.path } : {})
            });
            return {
              artifacts: ["node_modules/.cms/sdk/index.ts", "node_modules/.cms/drizzle-schema.ts"],
              migrations: [".hono-cms/migrations/202605220001_create_sections.sql"],
              message: "Schema artifacts refreshed"
            };
          }
        }
      }
    });

    const create = await app.fetch(new Request("https://cms.test/cms/content-types", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({
        name: "sections",
        fields: {
          title: { kind: "string", required: true, max: 120 },
          layout: { kind: "enum", values: ["hero", "grid"] }
        },
        options: { draftAndPublish: true }
      })
    }));
    expect(create.status).toBe(201);
    await expect(create.json()).resolves.toMatchObject({
      path: "cms/collections/sections.ts",
      artifacts: ["node_modules/.cms/sdk/index.ts", "node_modules/.cms/drizzle-schema.ts"],
      migrations: [".hono-cms/migrations/202605220001_create_sections.sql"],
      message: "Schema artifacts refreshed",
      collection: {
        name: "sections",
        fields: {
          title: { kind: "string", required: true, max: 120 },
          layout: { kind: "enum", values: ["hero", "grid"] }
        },
        options: { draftAndPublish: true }
      }
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ mode: "create", collection: "sections" });
    expect(writes[0]?.source).toContain("defineCollection");
    expect(writes[0]?.source).toContain("fields.enum([\"hero\", \"grid\"]");
    expect(afterWrites).toHaveLength(1);
    expect(afterWrites[0]).toMatchObject({ mode: "create", collection: "sections", resultPath: "cms/collections/sections.ts" });
    expect(afterWrites[0]?.source).toBe(writes[0]?.source);

    const duplicate = await app.fetch(new Request("https://cms.test/cms/content-types", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "articles", fields: { title: { kind: "string" } } })
    }));
    expect(duplicate.status).toBe(409);
  });

  test("accepts admin builder payloads and refreshes generated SDK artifacts", async () => {
    const generated: Array<{ path: string; source: string }> = [];
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      cache: { provider: "memory" },
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      contentTypeBuilder: {
        writer: {
          importPath: "@hono-cms/schema",
          writeCollection(input) {
            generated.push({ path: `cms/collections/${input.collection.name}.ts`, source: input.source });
            return { path: `cms/collections/${input.collection.name}.ts` };
          },
          afterWrite(input) {
            const nextSchema = defineSchema({ ...collections, [input.collection.name]: input.collection });
            generated.push({ path: "node_modules/.cms/sdk/index.ts", source: generateTypeScriptSDK(nextSchema) });
            generated.push({ path: "node_modules/.cms/drizzle-schema.ts", source: generateDrizzleSchema(nextSchema) });
            return {
              artifacts: generated.slice(1).map((artifact) => artifact.path),
              message: "Generated typed SDK and database schema from admin builder payload"
            };
          }
        }
      }
    });

    const payload = {
      name: "products",
      fields: {
        name: { kind: "string", required: true, unique: true, min: 3, max: 120 },
        slug: { kind: "uid", targetField: "name" },
        price: { kind: "number", required: true, min: 0 },
        status: { kind: "enum", values: ["draft", "active", "archived"] },
        heroImage: { kind: "media", multiple: false },
        author: { kind: "relation", target: "authors", cardinality: "many-to-one", onDelete: "restrict" }
      },
      options: { draftAndPublish: true, timestamps: true }
    };

    const response = await app.fetch(new Request("https://cms.test/cms/content-types", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify(payload)
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      path: "cms/collections/products.ts",
      artifacts: ["node_modules/.cms/sdk/index.ts", "node_modules/.cms/drizzle-schema.ts"],
      message: "Generated typed SDK and database schema from admin builder payload",
      collection: {
        name: "products",
        fields: {
          name: { kind: "string", required: true, unique: true, min: 3, max: 120 },
          slug: { kind: "uid", targetField: "name" },
          price: { kind: "number", required: true, min: 0 },
          status: { kind: "enum", values: ["draft", "active", "archived"] },
          heroImage: { kind: "media", multiple: false },
          author: { kind: "relation", target: "authors", cardinality: "many-to-one", onDelete: "restrict" }
        },
        options: { draftAndPublish: true, timestamps: true }
      }
    });

    expect(generated.find((artifact) => artifact.path === "cms/collections/products.ts")?.source).toContain("defineCollection(\n  \"products\"");
    expect(generated.find((artifact) => artifact.path === "node_modules/.cms/sdk/index.ts")?.source).toContain("export type Products");
    expect(generated.find((artifact) => artifact.path === "node_modules/.cms/sdk/index.ts")?.source).toContain("export type ProductsCreateInput");
    expect(generated.find((artifact) => artifact.path === "node_modules/.cms/drizzle-schema.ts")?.source).toContain("export const products");
  });

  test("validates content-type writes before handing source to the writer", async () => {
    const writer = vi.fn();
    const afterWrite = vi.fn();
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      cache: { provider: "memory" },
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      contentTypeBuilder: { writer: { writeCollection: writer, afterWrite } }
    });

    const invalidKind = await app.fetch(new Request("https://cms.test/cms/content-types", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "bad-types", fields: { title: { kind: "made-up" } } })
    }));
    expect(invalidKind.status).toBe(422);
    await expect(invalidKind.json()).resolves.toMatchObject({ issues: [{ path: ["fields", "title", "kind"] }] });

    const emptyFields = await app.fetch(new Request("https://cms.test/cms/content-types", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "empty", fields: {} })
    }));
    expect(emptyFields.status).toBe(422);
    await expect(emptyFields.json()).resolves.toMatchObject({ issues: [{ path: ["fields"], message: "At least one field is required." }] });

    const invalidUidTarget = await app.fetch(new Request("https://cms.test/cms/content-types", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "bad-slug", fields: { slug: { kind: "uid", targetField: "title" } } })
    }));
    expect(invalidUidTarget.status).toBe(422);
    await expect(invalidUidTarget.json()).resolves.toMatchObject({
      issues: [{ path: ["fields", "slug", "targetField"], message: "UID targetField \"title\" must reference another field in this collection." }]
    });

    const invalidUidTargetType = await app.fetch(new Request("https://cms.test/cms/content-types", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "bad-slug-type", fields: { title: { kind: "string" }, slug: { kind: "uid", targetField: 123 } } })
    }));
    expect(invalidUidTargetType.status).toBe(422);
    await expect(invalidUidTargetType.json()).resolves.toMatchObject({
      issues: [{ path: ["fields", "slug", "targetField"], message: "targetField must be a string." }]
    });

    const invalidRange = await app.fetch(new Request("https://cms.test/cms/content-types", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "bad-range", fields: { title: { kind: "string", min: 120, max: 20 } } })
    }));
    expect(invalidRange.status).toBe(422);
    await expect(invalidRange.json()).resolves.toMatchObject({
      issues: [{ path: ["fields", "title", "min"], message: "min cannot be greater than max." }]
    });

    const duplicateEnum = await app.fetch(new Request("https://cms.test/cms/content-types", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "bad-enum", fields: { status: { kind: "enum", values: ["draft", "draft"] } } })
    }));
    expect(duplicateEnum.status).toBe(422);
    await expect(duplicateEnum.json()).resolves.toMatchObject({
      issues: [{ path: ["fields", "status", "values"], message: "Enum values must be unique." }]
    });

    const invalidInverseIdentifier = await app.fetch(new Request("https://cms.test/cms/content-types", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "bad-relation", fields: { article: { kind: "relation", target: "articles", cardinality: "many-to-one", inverse: "bad-slug" } } })
    }));
    expect(invalidInverseIdentifier.status).toBe(422);
    await expect(invalidInverseIdentifier.json()).resolves.toMatchObject({
      issues: [{ path: ["fields", "article", "inverse"], message: "inverse must be a valid TypeScript identifier." }]
    });

    const invalidRelation = await app.fetch(new Request("https://cms.test/cms/content-types", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "sections", fields: { article: { kind: "relation", target: "missing", cardinality: "many-to-one" } } })
    }));
    expect(invalidRelation.status).toBe(422);
    await expect(invalidRelation.json()).resolves.toMatchObject({ error: "validation_error" });
    expect(writer).not.toHaveBeenCalled();
    expect(afterWrite).not.toHaveBeenCalled();
  });

  test("removes content types via the configured writer and surfaces 404/501 for unsupported cases", async () => {
    const removals: Array<{ collection: string }> = [];
    const afterRemovals: Array<{ collection: string; resultPath?: string }> = [];
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      cache: { provider: "memory" },
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      contentTypeBuilder: {
        writer: {
          writeCollection(input) {
            return { path: `cms/collections/${input.collection.name}.ts` };
          },
          removeCollection(input) {
            removals.push({ collection: input.collection.name });
            return { path: `cms/collections/${input.collection.name}.ts`, artifacts: [`cms/collections/${input.collection.name}.ts`] };
          },
          afterRemove(input) {
            afterRemovals.push({
              collection: input.collection.name,
              ...(input.result.path ? { resultPath: input.result.path } : {})
            });
            return { message: "Schema artifact removed" };
          }
        }
      }
    });

    // First create a throwaway collection so we have something the writer
    // tracks. Mirrors how the admin UI ships through POST → DELETE.
    const create = await app.fetch(new Request("https://cms.test/cms/content-types", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "drafts", fields: { title: { kind: "string", required: true } } })
    }));
    expect(create.status).toBe(201);

    const remove = await app.fetch(new Request("https://cms.test/cms/content-types/drafts", {
      method: "DELETE",
      headers: { authorization: "Bearer admin" }
    }));
    expect(remove.status).toBe(200);
    const removeBody = (await remove.json()) as { collection: { name: string; deletedAt: string }; path?: string; artifacts?: string[]; message?: string };
    expect(removeBody.collection.name).toBe("drafts");
    expect(typeof removeBody.collection.deletedAt).toBe("string");
    expect(new Date(removeBody.collection.deletedAt).toString()).not.toBe("Invalid Date");
    expect(removeBody.path).toBe("cms/collections/drafts.ts");
    expect(removeBody.message).toBe("Schema artifact removed");
    expect(removals).toEqual([{ collection: "drafts" }]);
    expect(afterRemovals).toEqual([{ collection: "drafts", resultPath: "cms/collections/drafts.ts" }]);

    // Deleting again returns 404 — the in-memory schema dropped the entry.
    const missing = await app.fetch(new Request("https://cms.test/cms/content-types/drafts", {
      method: "DELETE",
      headers: { authorization: "Bearer admin" }
    }));
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: "not_found" });

    // A writer without removeCollection should respond 501 with a helpful error.
    const readOnly = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      cache: { provider: "memory" },
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      contentTypeBuilder: {
        writer: {
          writeCollection(input) {
            return { path: `cms/collections/${input.collection.name}.ts` };
          }
        }
      }
    });

    const unsupported = await readOnly.fetch(new Request("https://cms.test/cms/content-types/articles", {
      method: "DELETE",
      headers: { authorization: "Bearer admin" }
    }));
    expect(unsupported.status).toBe(501);
    await expect(unsupported.json()).resolves.toMatchObject({ error: "content_type_remove_unsupported" });

    // And with no writer at all the route is blocked entirely.
    const noWriter = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      cache: { provider: "memory" },
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } }
    });
    const forbidden = await noWriter.fetch(new Request("https://cms.test/cms/content-types/articles", {
      method: "DELETE",
      headers: { authorization: "Bearer admin" }
    }));
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({ error: "content_type_builder_read_only" });
  });

  test("hot-registers a newly-created collection so /api/<new> works without restart (Gap-A)", async () => {
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      cache: { provider: "memory" },
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true },
      contentTypeBuilder: {
        writer: {
          writeCollection: ({ collection }) => ({ path: `cms/collections/${collection.name}.ts` }),
          removeCollection: ({ collection }) => ({ path: `cms/collections/${collection.name}.ts` })
        }
      }
    });

    // 1. Before the CT exists, /api/<new> 404s.
    const before = await app.fetch(new Request("https://cms.test/api/hot"));
    expect(before.status).toBe(404);

    // 2. Create the collection via the admin endpoint.
    const create = await app.fetch(new Request("https://cms.test/cms/content-types", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "hot", fields: { title: { kind: "string", required: true } } })
    }));
    expect(create.status).toBe(201);

    // 3. Immediately — no `createCMS()` rebuild — the REST routes are live.
    const list = await app.fetch(new Request("https://cms.test/api/hot"));
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ items: [] });

    // 4. Records can be created right away.
    const created = await app.fetch(new Request("https://cms.test/api/hot", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Hello" })
    }));
    expect(created.status).toBe(201);
    const record = await created.json() as { id: string; title: string };
    expect(record.title).toBe("Hello");

    // 5. Listing reflects the new record.
    const list2 = await app.fetch(new Request("https://cms.test/api/hot"));
    const list2Body = await list2.json() as { items: Array<{ id: string }> };
    expect(list2Body.items.length).toBe(1);
    expect(list2Body.items[0]?.id).toBe(record.id);

    // 6. Deleting the CT removes the live surface.
    const remove = await app.fetch(new Request("https://cms.test/cms/content-types/hot", {
      method: "DELETE",
      headers: { authorization: "Bearer admin" }
    }));
    expect(remove.status).toBe(200);

    const after = await app.fetch(new Request("https://cms.test/api/hot"));
    expect(after.status).toBe(404);
  });

  test("exposes cms.registerCollection and unregisterCollection for programmatic use", async () => {
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      cache: { provider: "memory" },
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true }
    });

    const before = await app.fetch(new Request("https://cms.test/api/widgets"));
    expect(before.status).toBe(404);

    app.registerCollection(defineCollection("widgets", {
      name: fields.string({ required: true })
    }));

    const list = await app.fetch(new Request("https://cms.test/api/widgets"));
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ items: [] });

    app.unregisterCollection("widgets");
    const after = await app.fetch(new Request("https://cms.test/api/widgets"));
    expect(after.status).toBe(404);
  });

  test("handles CORS preflight and response headers for independently hosted admin apps", async () => {
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      cors: {
        origin: ["https://admin.test"],
        credentials: true,
        exposedHeaders: ["x-cms-request-id"],
        maxAge: 600
      },
      rbac: { publicRead: true }
    });

    const preflight = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "OPTIONS",
      headers: {
        origin: "https://admin.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type"
      }
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://admin.test");
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("authorization,content-type");
    expect(preflight.headers.get("access-control-max-age")).toBe("600");

    const list = await app.fetch(new Request("https://cms.test/api/articles", {
      headers: { origin: "https://admin.test" }
    }));
    expect(list.status).toBe(200);
    expect(list.headers.get("access-control-allow-origin")).toBe("https://admin.test");
    expect(list.headers.get("access-control-expose-headers")).toBe("x-cms-request-id");

    const deniedOrigin = await app.fetch(new Request("https://cms.test/api/articles", {
      headers: { origin: "https://evil.test" }
    }));
    expect(deniedOrigin.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("composes typed Hono plugins and validates declared capabilities at bootstrap", async () => {
    const plugin = definePlugin<typeof collections>((app) => {
      app.get("/plugin/seo/health", () => Response.json({ ok: true, plugin: "seo" }));
    }, {
      reads: ["articles"],
      writes: ["media"],
      requiresEnv: ["SEO_TOKEN"],
      requiresAdapter: ["populate"]
    });

    const app = createCMS({
      collections,
      env: { SEO_TOKEN: "present" },
      db: createMemoryDatabase({ provider: "memory", collections }),
      plugins: [plugin],
      rbac: { publicRead: true }
    });

    const response = await app.fetch(new Request("https://cms.test/plugin/seo/health"));
    await expect(response.json()).resolves.toEqual({ ok: true, plugin: "seo" });
  });

  test("fails fast when plugin capabilities reference missing resources", () => {
    const unknownCollection = definePlugin<typeof collections>(() => undefined, { reads: ["missing" as keyof typeof collections & string] });
    expect(() => createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      plugins: [unknownCollection]
    })).toThrow("unknown collection");

    const missingEnv = definePlugin<typeof collections>(() => undefined, { requiresEnv: ["CMS_PLUGIN_SECRET"] });
    expect(() => createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      plugins: [missingEnv]
    })).toThrow("requires environment value");
  });

  test("creates, lists, filters, and publishes content through REST routes", async () => {
    const app = cms();
    const authorResponse = await app.fetch(new Request("https://cms.test/api/authors", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" })
    }));
    const author = await authorResponse.json() as { id: string };
    const create = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ title: "Edge CMS", body: "Runs anywhere", author: author.id })
    }));
    expect(create.status).toBe(201);
    const record = await create.json() as { id: string; status: string };
    expect(record.status).toBe("draft");

    const publish = await app.fetch(new Request(`https://cms.test/api/articles/${record.id}/publish`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    }));
    expect(publish.status).toBe(200);

    const list = await app.fetch(new Request("https://cms.test/api/articles?filter[title][$contains]=CMS&status=published&populate=author"));
    await expect(list.json()).resolves.toMatchObject({ items: [{ id: record.id, title: "Edge CMS", status: "published", author: { id: author.id, name: "Ada" } }] });
  });

  test("parses Strapi-style filters, pagination aliases, $in arrays, and multi-sort", async () => {
    const app = cms();
    const createArticle = async (title: string, body: string) => {
      const response = await app.fetch(new Request("https://cms.test/api/articles", {
        method: "POST",
        headers: { authorization: "Bearer admin", "content-type": "application/json" },
        body: JSON.stringify({ title, body })
      }));
      expect(response.status).toBe(201);
      const record = await response.json() as { id: string };
      await app.fetch(new Request(`https://cms.test/api/articles/${record.id}/publish`, {
        method: "POST",
        headers: { authorization: "Bearer admin" }
      }));
      return record;
    };
    const first = await createArticle("Alpha CMS", "a");
    const second = await createArticle("Beta CMS", "b");
    await createArticle("Gamma API", "c");

    const response = await app.fetch(new Request(`https://cms.test/api/articles?filters[title][$in]=${first.id === second.id ? "none" : "Alpha CMS,Beta CMS"}&pagination[limit]=1&sort=-title,createdAt`));
    expect(response.status).toBe(200);
    const responseBody = await response.json() as { items: Array<{ id: string; title: string }>; nextCursor: string };
    expect(responseBody).toMatchObject({
      items: [{ id: second.id, title: "Beta CMS" }],
    });
    expect(decodeCursor(responseBody.nextCursor)).toMatchObject({ id: second.id });

    const directionalSort = await app.fetch(new Request("https://cms.test/api/articles?sort=title:asc&pagination[limit]=2"));
    await expect(directionalSort.json()).resolves.toMatchObject({
      items: [{ id: first.id, title: "Alpha CMS" }, { id: second.id, title: "Beta CMS" }]
    });

    const offsetPage = await app.fetch(new Request("https://cms.test/api/articles?sort=title:asc&pagination[page]=2&pagination[pageSize]=1"));
    const offsetPageBody = await offsetPage.json() as { items: Array<{ id: string; title: string }>; nextCursor: string; total: number };
    expect(offsetPageBody).toMatchObject({
      items: [{ id: second.id, title: "Beta CMS" }],
      total: 3
    });
    expect(decodeCursor(offsetPageBody.nextCursor)).toMatchObject({ id: second.id });
    expect(offsetPageBody.nextCursor).not.toContain(second.id);
    expect(offsetPageBody.nextCursor).not.toMatch(/[+/=]/);

    const invalidCursor = await app.fetch(new Request("https://cms.test/api/articles?pagination[cursor]=not-base64&pagination[limit]=1"));
    expect(invalidCursor.status).toBe(422);
    await expect(invalidCursor.json()).resolves.toMatchObject({
      issues: [{ path: ["pagination", "cursor"], message: "Invalid cursor" }]
    });

    const cursorCreatedAt = "2026-05-22T10:00:00.000Z";
    expect(parseQueryParams(new URL(`https://cms.test/api/articles?pagination[cursor]=${encodeCursor({ id: "article_1", createdAt: cursorCreatedAt })}`))).toMatchObject({
      cursor: "article_1",
      cursorCreatedAt
    });

    const mixedDirectionalSort = await app.fetch(new Request("https://cms.test/api/articles?sort=title:desc,createdAt:asc&pagination[limit]=1"));
    await expect(mixedDirectionalSort.json()).resolves.toMatchObject({
      items: [{ title: "Gamma API" }]
    });

    const bracketArrayQuery = await app.fetch(new Request("https://cms.test/api/articles?filters[title][$in][]=Alpha%20CMS&filters[title][$in][]=Beta%20CMS&pagination[limit]=2&sort[]=title%3Aasc&sort[]=createdAt%3Adesc&populate[]=author"));
    await expect(bracketArrayQuery.json()).resolves.toMatchObject({
      items: [{ id: first.id, title: "Alpha CMS" }, { id: second.id, title: "Beta CMS" }]
    });

    const indexedArrayQuery = await app.fetch(new Request("https://cms.test/api/articles?filters[title][$in][0]=Alpha%20CMS&filters[title][$in][1]=Beta%20CMS&pagination[limit]=2&sort[0]=title%3Aasc&sort[1]=createdAt%3Adesc"));
    await expect(indexedArrayQuery.json()).resolves.toMatchObject({
      items: [{ id: first.id, title: "Alpha CMS" }, { id: second.id, title: "Beta CMS" }]
    });
  });

  test("filters REST lists by related collection fields with Strapi-style nested qs", async () => {
    const app = cms();
    const createAuthor = async (name: string) => {
      const response = await app.fetch(new Request("https://cms.test/api/authors", {
        method: "POST",
        headers: { authorization: "Bearer admin", "content-type": "application/json" },
        body: JSON.stringify({ name })
      }));
      expect(response.status).toBe(201);
      return await response.json() as { id: string; name: string };
    };
    const createPublishedArticle = async (title: string, author: string) => {
      const response = await app.fetch(new Request("https://cms.test/api/articles", {
        method: "POST",
        headers: { authorization: "Bearer admin", "content-type": "application/json" },
        body: JSON.stringify({ title, author })
      }));
      expect(response.status).toBe(201);
      const record = await response.json() as { id: string };
      await app.fetch(new Request(`https://cms.test/api/articles/${record.id}/publish`, {
        method: "POST",
        headers: { authorization: "Bearer admin" }
      }));
      return record;
    };

    const ada = await createAuthor("Ada Lovelace");
    const grace = await createAuthor("Grace Hopper");
    const adaArticle = await createPublishedArticle("Analytical Engine CMS", ada.id);
    await createPublishedArticle("Compiler CMS", grace.id);

    const filtered = await app.fetch(new Request("https://cms.test/api/articles?filters[author][name][$startsWith]=Ada&populate[author][fields][0]=name&sort=title"));
    expect(filtered.status).toBe(200);
    await expect(filtered.json()).resolves.toMatchObject({
      items: [{ id: adaArticle.id, title: "Analytical Engine CMS", author: { id: ada.id, name: "Ada Lovelace" } }]
    });

    const invalid = await app.fetch(new Request("https://cms.test/api/articles?filters[author][apiKey][$contains]=secret"));
    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toMatchObject({
      issues: [{ path: ["filter", "author", "apiKey"], message: "Field \"apiKey\" is private" }]
    });
  });

  test("uses stable createdAt/id ordering for default cursor pagination", async () => {
    const now = "2026-05-22T10:00:00.000Z";
    const app = createCMS({
      collections,
      db: createMemoryDatabase({
        provider: "memory",
        collections,
        seed: {
          articles: [
            { id: "article_c", title: "Third", status: "published", createdAt: "2026-05-22T10:00:02.000Z", updatedAt: now },
            { id: "article_a", title: "First", status: "published", createdAt: "2026-05-22T10:00:00.000Z", updatedAt: now },
            { id: "article_b", title: "Second", status: "published", createdAt: "2026-05-22T10:00:01.000Z", updatedAt: now },
            { id: "article_d", title: "Fourth", status: "published", createdAt: "2026-05-22T10:00:03.000Z", updatedAt: now }
          ]
        }
      }),
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true }
    });

    const firstPage = await app.fetch(new Request("https://cms.test/api/articles?pagination[limit]=2"));
    expect(firstPage.status).toBe(200);
    const firstBody = await firstPage.json() as { items: Array<{ id: string; title: string }>; nextCursor?: string };
    expect(firstBody.items).toEqual([
      expect.objectContaining({ id: "article_a", title: "First" }),
      expect.objectContaining({ id: "article_b", title: "Second" })
    ]);
    expect(decodeCursor(firstBody.nextCursor ?? "")).toMatchObject({
      id: "article_b",
      createdAt: "2026-05-22T10:00:01.000Z"
    });

    const secondPage = await app.fetch(new Request(`https://cms.test/api/articles?pagination[limit]=2&pagination[cursor]=${encodeURIComponent(firstBody.nextCursor ?? "")}`));
    expect(secondPage.status).toBe(200);
    const secondBody = await secondPage.json() as { items: Array<{ id: string; title: string }>; nextCursor?: string };
    expect(secondBody.items).toEqual([
      expect.objectContaining({ id: "article_c", title: "Third" }),
      expect.objectContaining({ id: "article_d", title: "Fourth" })
    ]);
    expect(secondBody.nextCursor).toBeUndefined();
    expect(new Set([...firstBody.items, ...secondBody.items].map((item) => item.id)).size).toBe(4);
  });

  test("supports the planned Strapi-compatible REST filter operators", async () => {
    const app = cms();
    const createArticle = async (title: string, body?: string) => {
      const response = await app.fetch(new Request("https://cms.test/api/articles", {
        method: "POST",
        headers: { authorization: "Bearer admin", "content-type": "application/json" },
        body: JSON.stringify(body === undefined ? { title } : { title, body })
      }));
      expect(response.status).toBe(201);
      const record = await response.json() as { id: string };
      await app.fetch(new Request(`https://cms.test/api/articles/${record.id}/publish`, {
        method: "POST",
        headers: { authorization: "Bearer admin" }
      }));
      return record;
    };
    const alpha = await createArticle("Alpha CMS", "intro");
    const beta = await createArticle("Beta API", "reference");
    await createArticle("Gamma CMS");

    const notContains = await app.fetch(new Request("https://cms.test/api/articles?filters[title][$notContains]=CMS&sort=title"));
    await expect(notContains.json()).resolves.toMatchObject({ items: [{ id: beta.id, title: "Beta API" }] });

    const nin = await app.fetch(new Request("https://cms.test/api/articles?filters[title][$nin]=Beta API,Gamma CMS&sort=title"));
    await expect(nin.json()).resolves.toMatchObject({ items: [{ id: alpha.id, title: "Alpha CMS" }] });

    const isNull = await app.fetch(new Request("https://cms.test/api/articles?filters[body][$null]=true&sort=title"));
    await expect(isNull.json()).resolves.toMatchObject({ items: [{ title: "Gamma CMS" }] });

    const notNull = await app.fetch(new Request("https://cms.test/api/articles?filters[body][$notNull]=true&sort=title"));
    await expect(notNull.json()).resolves.toMatchObject({ items: [{ title: "Alpha CMS" }, { title: "Beta API" }] });

    const between = await app.fetch(new Request("https://cms.test/api/articles?filters[title][$between]=Alpha CMS,Beta API&sort=title"));
    await expect(between.json()).resolves.toMatchObject({ items: [{ title: "Alpha CMS" }, { title: "Beta API" }] });
  });

  test("rejects unbounded REST query complexity before adapter reads", async () => {
    const app = cms();
    const unknownOperator = await app.fetch(new Request("https://cms.test/api/articles?filters[title][$near]=CMS"));
    expect(unknownOperator.status).toBe(422);
    await expect(unknownOperator.json()).resolves.toMatchObject({
      issues: [{ path: ["filter", "title", "$near"], message: "Unknown filter operator \"$near\"" }]
    });

    const manyFilters = Array.from({ length: 26 }, (_, index) => `filters[title${index}]=value`).join("&");
    const tooManyFilters = await app.fetch(new Request(`https://cms.test/api/articles?${manyFilters}`));
    expect(tooManyFilters.status).toBe(422);
    await expect(tooManyFilters.json()).resolves.toMatchObject({
      issues: [{ path: ["filter"], message: "Filters are limited to 25 fields" }]
    });

    const operatorHeavyFilters = Array.from({ length: 9 }, (_, index) => (
      `filters[title${index}][$gte]=A&filters[title${index}][$lte]=Z`
    )).join("&");
    const tooManyFilterNodes = await app.fetch(new Request(`https://cms.test/api/articles?${operatorHeavyFilters}`));
    expect(tooManyFilterNodes.status).toBe(422);
    await expect(tooManyFilterNodes.json()).resolves.toMatchObject({
      issues: [{ path: ["filter"], message: "Filter complexity is limited to 25 nodes" }]
    });

    const tooManyInValues = await app.fetch(new Request(`https://cms.test/api/articles?filters[title][$in]=${Array.from({ length: 101 }, (_, index) => `Title ${index}`).join(",")}`));
    expect(tooManyInValues.status).toBe(422);
    await expect(tooManyInValues.json()).resolves.toMatchObject({
      issues: [{ path: ["filter", "title", "$in"], message: "$in filters are limited to 100 values" }]
    });

    const invalidBetween = await app.fetch(new Request("https://cms.test/api/articles?filters[title][$between]=OnlyOne"));
    expect(invalidBetween.status).toBe(422);
    await expect(invalidBetween.json()).resolves.toMatchObject({
      issues: [{ path: ["filter", "title", "$between"], message: "$between filters require exactly 2 values" }]
    });

    const tooManySorts = await app.fetch(new Request("https://cms.test/api/articles?sort=title,body,status,createdAt"));
    expect(tooManySorts.status).toBe(422);
    await expect(tooManySorts.json()).resolves.toMatchObject({
      issues: [{ path: ["sort"], message: "Sort is limited to 3 fields" }]
    });
  });

  test("populates standard many-to-one and many-to-many relation cardinalities", async () => {
    const relationalCollections = defineSchema({
      authors: defineCollection("authors", {
        name: fields.string({ required: true })
      }),
      tags: defineCollection("tags", {
        name: fields.string({ required: true })
      }),
      articles: defineCollection("articles", {
        title: fields.string({ required: true }),
        author: fields.relation("authors", "many-to-one"),
        tags: fields.relation("tags", "many-to-many")
      })
    });
    const app = createCMS({
      collections: relationalCollections,
      db: createMemoryDatabase({ provider: "memory", collections: relationalCollections }),
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true }
    });
    const authorResponse = await app.fetch(new Request("https://cms.test/api/authors", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" })
    }));
    const author = await authorResponse.json() as { id: string };
    const tagResponse = await app.fetch(new Request("https://cms.test/api/tags", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "API" })
    }));
    const tag = await tagResponse.json() as { id: string };
    const articleResponse = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Relations", author: author.id, tags: [tag.id] })
    }));
    const article = await articleResponse.json() as { id: string };

    const populated = await app.fetch(new Request(`https://cms.test/api/articles/${article.id}?populate=author,tags`));
    await expect(populated.json()).resolves.toMatchObject({
      id: article.id,
      author: { id: author.id, name: "Ada" },
      tags: [{ id: tag.id, name: "API" }]
    });
  });

  test("populates self-referential many-to-many relations with bounded recursion", async () => {
    const categoryCollections = defineSchema({
      categories: defineCollection("categories", {
        name: fields.string({ required: true }),
        related: fields.relation("categories", "many-to-many")
      })
    });
    const app = createCMS({
      collections: categoryCollections,
      db: createMemoryDatabase({ provider: "memory", collections: categoryCollections }),
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true }
    });
    const parentResponse = await app.fetch(new Request("https://cms.test/api/categories", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Parent" })
    }));
    const parent = await parentResponse.json() as { id: string };
    const childResponse = await app.fetch(new Request("https://cms.test/api/categories", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Child", related: [parent.id] })
    }));
    const child = await childResponse.json() as { id: string };
    await app.fetch(new Request(`https://cms.test/api/categories/${parent.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ related: [child.id] })
    }));

    const populated = await app.fetch(new Request(`https://cms.test/api/categories/${parent.id}?populate=related.related`));

    expect(populated.status).toBe(200);
    await expect(populated.json()).resolves.toMatchObject({
      id: parent.id,
      name: "Parent",
      related: [{
        id: child.id,
        name: "Child",
        related: [{ id: parent.id, name: "Parent" }]
      }]
    });
  });

  test("enforces relation onDelete behavior during REST deletes", async () => {
    const createApp = (articleRelation: ReturnType<typeof fields.relation>, extraFields: Record<string, ReturnType<typeof fields.relation>> = {}) => {
      const relationCollections = defineSchema({
        authors: defineCollection("authors", { name: fields.string({ required: true }) }),
        tags: defineCollection("tags", { name: fields.string({ required: true }) }),
        articles: defineCollection("articles", {
          title: fields.string({ required: true }),
          author: articleRelation,
          ...extraFields
        })
      });
      return createCMS({
        collections: relationCollections,
        db: createMemoryDatabase({ provider: "memory", collections: relationCollections }),
        auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
        rbac: { publicRead: true }
      });
    };
    const headers = { authorization: "Bearer admin", "content-type": "application/json" };
    const createRecord = async <T extends Record<string, unknown>>(app: ReturnType<typeof createApp>, collection: string, body: Record<string, unknown>): Promise<T> => {
      const response = await app.fetch(new Request(`https://cms.test/api/${collection}`, { method: "POST", headers, body: JSON.stringify(body) }));
      expect(response.status).toBe(201);
      return await response.json() as T;
    };

    const restrictedApp = createApp(fields.relation("authors", "many-to-one"));
    const restrictedAuthor = await createRecord<{ id: string }>(restrictedApp, "authors", { name: "Ada" });
    await createRecord(restrictedApp, "articles", { title: "Restricted", author: restrictedAuthor.id });
    const restrictedDelete = await restrictedApp.fetch(new Request(`https://cms.test/api/authors/${restrictedAuthor.id}`, { method: "DELETE", headers }));
    expect(restrictedDelete.status).toBe(409);
    await expect(restrictedDelete.json()).resolves.toMatchObject({ error: "RELATION_CONSTRAINT", relatedCollection: "articles", field: "author" });

    const nullableApp = createApp(fields.relation("authors", "many-to-one", { onDelete: "set_null" }));
    const nullableAuthor = await createRecord<{ id: string }>(nullableApp, "authors", { name: "Grace" });
    const nullableArticle = await createRecord<{ id: string }>(nullableApp, "articles", { title: "Nullable", author: nullableAuthor.id });
    const nullableDelete = await nullableApp.fetch(new Request(`https://cms.test/api/authors/${nullableAuthor.id}`, { method: "DELETE", headers }));
    expect(nullableDelete.status).toBe(204);
    const nullableGet = await nullableApp.fetch(new Request(`https://cms.test/api/articles/${nullableArticle.id}`));
    await expect(nullableGet.json()).resolves.toMatchObject({ id: nullableArticle.id, author: null });

    const cascadeApp = createApp(fields.relation("authors", "many-to-one", { onDelete: "cascade" }));
    const cascadeAuthor = await createRecord<{ id: string }>(cascadeApp, "authors", { name: "Katherine" });
    const cascadeArticle = await createRecord<{ id: string }>(cascadeApp, "articles", { title: "Cascade", author: cascadeAuthor.id });
    const cascadeDelete = await cascadeApp.fetch(new Request(`https://cms.test/api/authors/${cascadeAuthor.id}`, { method: "DELETE", headers }));
    expect(cascadeDelete.status).toBe(204);
    const cascadeGet = await cascadeApp.fetch(new Request(`https://cms.test/api/articles/${cascadeArticle.id}`));
    expect(cascadeGet.status).toBe(404);

    const manyApp = createApp(fields.relation("authors", "many-to-one", { onDelete: "set_null" }), {
      tags: fields.relation("tags", "many-to-many")
    });
    const manyAuthor = await createRecord<{ id: string }>(manyApp, "authors", { name: "Mary" });
    const tag = await createRecord<{ id: string }>(manyApp, "tags", { name: "CMS" });
    const manyArticle = await createRecord<{ id: string }>(manyApp, "articles", { title: "Many", author: manyAuthor.id, tags: [tag.id] });
    const manyDelete = await manyApp.fetch(new Request(`https://cms.test/api/tags/${tag.id}`, { method: "DELETE", headers }));
    expect(manyDelete.status).toBe(204);
    const manyGet = await manyApp.fetch(new Request(`https://cms.test/api/articles/${manyArticle.id}`));
    await expect(manyGet.json()).resolves.toMatchObject({ id: manyArticle.id, tags: [] });
  });

  test("caps populated relation nodes before reading related records", async () => {
    const relationalCollections = defineSchema({
      tags: defineCollection("tags", {
        name: fields.string({ required: true })
      }),
      articles: defineCollection("articles", {
        title: fields.string({ required: true }),
        tags: fields.relation("tags", "many-to-many")
      })
    });
    const app = createCMS({
      collections: relationalCollections,
      db: createMemoryDatabase({ provider: "memory", collections: relationalCollections }),
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true }
    });
    const tags: string[] = [];
    for (let index = 0; index < 105; index += 1) {
      const tagResponse = await app.fetch(new Request("https://cms.test/api/tags", {
        method: "POST",
        headers: { authorization: "Bearer admin", "content-type": "application/json" },
        body: JSON.stringify({ name: `Tag ${index}` })
      }));
      const tag = await tagResponse.json() as { id: string };
      tags.push(tag.id);
    }
    const articleResponse = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Budgeted", tags })
    }));
    const article = await articleResponse.json() as { id: string };

    const populated = await app.fetch(new Request(`https://cms.test/api/articles/${article.id}?populate=tags`));
    const body = await populated.json() as { tags: Array<{ id: string; name: string }> };

    expect(body.tags).toHaveLength(100);
    expect(body.tags.at(0)).toMatchObject({ id: tags[0], name: "Tag 0" });
    expect(body.tags.at(-1)).toMatchObject({ id: tags[99], name: "Tag 99" });
  });

  test("projects requested fields and never exposes private fields", async () => {
    const app = cms();
    const authorResponse = await app.fetch(new Request("https://cms.test/api/authors", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", apiKey: "private-author-key" })
    }));
    const author = await authorResponse.json() as { id: string };
    const create = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Projection", body: "Visible", internalNotes: "do not leak", author: author.id })
    }));
    const record = await create.json() as { id: string };
    await app.fetch(new Request(`https://cms.test/api/articles/${record.id}/publish`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    }));

    const list = await app.fetch(new Request("https://cms.test/api/articles?fields=title,author&populate=author&populate[author][fields]=name"));
    await expect(list.json()).resolves.toMatchObject({
      items: [{ id: record.id, title: "Projection", author: { id: author.id, name: "Ada" } }]
    });

    const item = await app.fetch(new Request(`https://cms.test/api/articles/${record.id}?fields=title,author&populate=author`));
    const body = await item.json() as Record<string, unknown>;
    expect(body).toMatchObject({ id: record.id, title: "Projection" });
    expect(body).not.toHaveProperty("body");
    expect(body).not.toHaveProperty("internalNotes");
    expect(body.author).not.toHaveProperty("apiKey");
  });

  test("parses qs-style populate arrays, field arrays, and nested populate objects", async () => {
    const relationalCollections = defineSchema({
      companies: defineCollection("companies", {
        name: fields.string({ required: true }),
        secret: fields.string({ private: true })
      }),
      authors: defineCollection("authors", {
        name: fields.string({ required: true }),
        company: fields.relation("companies", "many-to-one")
      }),
      articles: defineCollection("articles", {
        title: fields.string({ required: true }),
        author: fields.relation("authors", "many-to-one")
      })
    });
    const app = createCMS({
      collections: relationalCollections,
      db: createMemoryDatabase({ provider: "memory", collections: relationalCollections }),
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true }
    });
    const headers = { authorization: "Bearer admin", "content-type": "application/json" };
    const companyResponse = await app.fetch(new Request("https://cms.test/api/companies", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Analytical Engines", secret: "never" })
    }));
    const company = await companyResponse.json() as { id: string };
    const authorResponse = await app.fetch(new Request("https://cms.test/api/authors", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada", company: company.id })
    }));
    const author = await authorResponse.json() as { id: string };
    const articleResponse = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Nested", author: author.id })
    }));
    const article = await articleResponse.json() as { id: string };

    const response = await app.fetch(new Request(`https://cms.test/api/articles/${article.id}?populate[0]=author&populate[author][fields][0]=name&populate[author][fields][1]=company&populate[author][populate][company][fields][0]=name`));
    const nested = await response.json() as { author: { name: string; company: { name: string; secret?: string } } };
    expect(nested).toMatchObject({
      author: {
        name: "Ada",
        company: { name: "Analytical Engines" }
      }
    });
    expect(nested.author.company).not.toHaveProperty("secret");
  });

  test("warns and drops populate paths beyond the depth limit", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const dotted = parsePopulateParams(new URL("https://cms.test/api/articles?populate=author.company.country.region"));
      expect(dotted).toEqual({ author: { populate: { company: { populate: { country: { populate: {} } } } } } });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped "author.company.country.region"'));

      warn.mockClear();
      const bracket = parsePopulateParams(new URL("https://cms.test/api/articles?populate[author][populate][company][populate][country][populate][region][fields][0]=name"));
      expect(bracket).toEqual({ author: { populate: { company: { populate: { country: true } } } } });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped "region"'));
    } finally {
      warn.mockRestore();
    }
  });

  test("rejects unknown and private REST query fields before reading content", async () => {
    const app = cms();

    const unknownField = await app.fetch(new Request("https://cms.test/api/articles?fields=title,missing"));
    expect(unknownField.status).toBe(422);
    await expect(unknownField.json()).resolves.toMatchObject({
      error: "validation_error",
      issues: [{ path: ["fields", "missing"], message: "Unknown field \"missing\"" }]
    });

    const privateField = await app.fetch(new Request("https://cms.test/api/articles?fields=internalNotes"));
    expect(privateField.status).toBe(422);
    await expect(privateField.json()).resolves.toMatchObject({
      issues: [{ path: ["fields", "internalNotes"], message: "Field \"internalNotes\" is private" }]
    });

    const privateFilter = await app.fetch(new Request("https://cms.test/api/articles?filter[internalNotes]=secret"));
    expect(privateFilter.status).toBe(422);
    await expect(privateFilter.json()).resolves.toMatchObject({
      issues: [{ path: ["filter", "internalNotes"], message: "Field \"internalNotes\" is private" }]
    });

    const unknownSort = await app.fetch(new Request("https://cms.test/api/articles?sort=-missing"));
    expect(unknownSort.status).toBe(422);
    await expect(unknownSort.json()).resolves.toMatchObject({
      issues: [{ path: ["sort"], message: "Unknown field \"missing\"" }]
    });

    const unknownDirectionalSort = await app.fetch(new Request("https://cms.test/api/articles?sort=missing:asc"));
    expect(unknownDirectionalSort.status).toBe(422);
    await expect(unknownDirectionalSort.json()).resolves.toMatchObject({
      issues: [{ path: ["sort"], message: "Unknown field \"missing\"" }]
    });
  });

  test("validates REST and GraphQL populate paths against relation fields", async () => {
    const app = cms();

    const restNonRelation = await app.fetch(new Request("https://cms.test/api/articles?populate=title"));
    expect(restNonRelation.status).toBe(422);
    await expect(restNonRelation.json()).resolves.toMatchObject({
      error: "validation_error",
      issues: [{ path: ["populate", "title"], message: "Field \"title\" is not a relation" }]
    });

    const restPrivateNestedField = await app.fetch(new Request("https://cms.test/api/articles?populate=author&populate[author][fields]=name,apiKey"));
    expect(restPrivateNestedField.status).toBe(422);
    await expect(restPrivateNestedField.json()).resolves.toMatchObject({
      issues: [{ path: ["populate", "author", "fields", "apiKey"], message: "Field \"apiKey\" is private" }]
    });

    const graphQLNonRelation = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles(populate: [\"title\"]) { items { id title } } }" })
    }));
    await expect(graphQLNonRelation.json()).resolves.toMatchObject({
      data: { articles: null },
      errors: [{ extensions: { code: "VALIDATION_ERROR" } }]
    });
  });

  test("sorts and validates GraphQL collection queries with the shared query contract", async () => {
    const app = cms();
    const first = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Alpha GraphQL" })
    }));
    const firstBody = await first.json() as { id: string };
    const second = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Beta GraphQL" })
    }));
    const secondBody = await second.json() as { id: string };
    for (const id of [firstBody.id, secondBody.id]) {
      await app.fetch(new Request(`https://cms.test/api/articles/${id}/publish`, {
        method: "POST",
        headers: { authorization: "Bearer admin" }
      }));
    }

    const sorted = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles(pagination: { limit: 1 }, sort: [\"title:desc\"]) { items { id title } nextCursor meta { pagination { cursor hasMore total } } } }" })
    }));
    const sortedBody = await sorted.json() as { data: { articles: { items: Array<{ title: string }>; nextCursor?: string; meta: { pagination: { cursor?: string; hasMore: boolean; total?: number } } } } };
    expect(sortedBody.data.articles.items.map((item) => item.title)).toEqual(["Beta GraphQL"]);
    expect(decodeCursor(sortedBody.data.articles.nextCursor ?? "")).toMatchObject({ id: secondBody.id });
    expect(decodeCursor(sortedBody.data.articles.meta.pagination.cursor ?? "")).toMatchObject({ id: secondBody.id });
    expect(sortedBody.data.articles.meta.pagination).toMatchObject({ hasMore: true });
    // Under the Apollo executor an explicitly selected nullable field is
    // serialized as null when the resolver did not provide it (the legacy
    // hand-rolled handler omitted it from the JSON payload). Both signal
    // "no total available"; we assert the null shape to keep the contract
    // explicit.
    expect(sortedBody.data.articles.meta.pagination.total ?? null).toBeNull();

    const nextPage = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: `query Page($pagination: PaginationInput!) { articles(pagination: $pagination, limit: 100, sort: ["title:desc"]) { items { id title } meta { pagination { hasMore } } } }`, variables: { pagination: { limit: 1, cursor: sortedBody.data.articles.nextCursor } } })
    }));
    await expect(nextPage.json()).resolves.toMatchObject({
      data: { articles: { items: [{ id: firstBody.id, title: "Alpha GraphQL" }], meta: { pagination: { hasMore: false } } } }
    });

    const offsetPage = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: `query Page($pagination: PaginationInput!) { articles(pagination: $pagination, sort: ["title:asc"]) { items { id title } meta { pagination { cursor hasMore total } } } }`, variables: { pagination: { page: 2, pageSize: 1 } } })
    }));
    await expect(offsetPage.json()).resolves.toMatchObject({
      data: { articles: { items: [{ id: secondBody.id, title: "Beta GraphQL" }], meta: { pagination: { hasMore: false, total: 2 } } } }
    });

    const invalidCursor = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: `query Page($pagination: PaginationInput!) { articles(pagination: $pagination) { items { id title } } }`, variables: { pagination: { limit: 1, cursor: "not-base64" } } })
    }));
    await expect(invalidCursor.json()).resolves.toMatchObject({
      data: { articles: null },
      errors: [{ message: "Invalid cursor", path: ["articles"], extensions: { code: "VALIDATION_ERROR" } }]
    });

    const invalidSort = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles(sort: [\"missing:asc\"]) { items { id title } } }" })
    }));
    await expect(invalidSort.json()).resolves.toMatchObject({
      data: { articles: null },
      errors: [{ extensions: { code: "VALIDATION_ERROR", issues: [{ path: ["sort"], message: "Unknown field \"missing\"" }] } }]
    });

    const schema = await app.fetch(new Request("https://cms.test/cms/graphql/schema"));
    const sdl = await schema.text();
    expect(sdl).toContain("articles(filters: ArticlesFilterInput, pagination: PaginationInput, limit: Int, cursor: String, page: Int, pageSize: Int, sort: [String!]");
    expect(sdl).toContain("input PaginationInput { limit: Int cursor: String page: Int pageSize: Int }");
    expect(sdl).toContain("type PaginationInfo { cursor: String hasMore: Boolean! total: Int }");
    expect(sdl).toContain("type PaginationMeta { pagination: PaginationInfo! }");
    expect(sdl).toContain("meta: PaginationMeta!");
  });

  test("mounts planned GraphQL public routes, compatibility aliases, and config gates", async () => {
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      rbac: { publicRead: true }
    });

    const post = await app.fetch(new Request("https://cms.test/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles { items { id title } meta { pagination { hasMore } } } }" })
    }));
    expect(post.status).toBe(200);
    await expect(post.json()).resolves.toMatchObject({ data: { articles: { items: [], meta: { pagination: { hasMore: false } } } } });

    const get = await app.fetch(new Request(`https://cms.test/graphql?query=${encodeURIComponent("{ articles { items { id title } } }")}`));
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({ data: { articles: { items: [] } } });

    const publicSchema = await app.fetch(new Request("https://cms.test/graphql/schema"));
    expect(publicSchema.status).toBe(200);
    expect(await publicSchema.text()).toContain("type Query");

    const legacySchema = await app.fetch(new Request("https://cms.test/cms/graphql/schema"));
    expect(legacySchema.status).toBe(200);
    expect(await legacySchema.text()).toContain("type Query");

    const disabled = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      graphql: false,
      rbac: { publicRead: true }
    });
    expect((await disabled.fetch(new Request("https://cms.test/graphql"))).status).toBe(404);
    expect((await disabled.fetch(new Request("https://cms.test/cms/graphql"))).status).toBe(404);
    const disabledSpec = await disabled.fetch(new Request("https://cms.test/cms/openapi.json"));
    expect(disabledSpec.status).toBe(200);
    const disabledSpecBody = await disabledSpec.json() as { tags: Array<{ name: string }>; paths: Record<string, unknown> };
    expect(disabledSpecBody.tags.map((tag) => tag.name)).not.toContain("graphql");
    expect(disabledSpecBody.paths).not.toHaveProperty("/graphql");
    expect(disabledSpecBody.paths).not.toHaveProperty("/cms/graphql");

    const custom = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      graphql: { path: "/contracts/graphql", schemaPath: "/contracts/graphql.sdl" },
      rbac: { publicRead: true }
    });
    expect((await custom.fetch(new Request(`https://cms.test/contracts/graphql?query=${encodeURIComponent("{ articles { items { id } } }")}`))).status).toBe(200);
    expect((await custom.fetch(new Request("https://cms.test/contracts/graphql.sdl"))).status).toBe(200);
    const customSpec = await custom.fetch(new Request("https://cms.test/cms/openapi.json"));
    expect(customSpec.status).toBe(200);
    const customSpecBody = await customSpec.json() as { paths: Record<string, unknown> };
    expect(customSpecBody.paths).toHaveProperty("/contracts/graphql");
    expect(customSpecBody.paths).toHaveProperty("/contracts/graphql.sdl");
    expect(customSpecBody.paths).toHaveProperty("/cms/graphql");
    expect(customSpecBody.paths).not.toHaveProperty("/graphql");
  });

  test("disables GraphQL introspection in production unless explicitly enabled", async () => {
    const production = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      env: { NODE_ENV: "production" },
      rbac: { publicRead: true }
    });
    const blocked = await production.fetch(new Request("https://cms.test/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __schema { types { name } } }" })
    }));
    expect(blocked.status).toBe(200);
    await expect(blocked.json()).resolves.toMatchObject({
      errors: [{ message: "GraphQL introspection is disabled", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }]
    });

    const enabled = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      env: { NODE_ENV: "production" },
      graphql: { introspection: true },
      rbac: { publicRead: true }
    });
    const explicit = await enabled.fetch(new Request("https://cms.test/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __schema { types { name } } }" })
    }));
    expect(explicit.status).toBe(200);
    // With Plan-6 U5 the GraphQL endpoint is backed by Apollo Server and a
    // real `GraphQLSchema`; introspection now returns the actual schema
    // metadata rather than the legacy `NOT_FOUND` stub.
    const explicitBody = await explicit.json() as { data: { __schema: { types: Array<{ name: string }> } } };
    expect(explicitBody.data.__schema.types.map((type) => type.name)).toEqual(expect.arrayContaining(["Articles", "Query", "Mutation"]));
  });

  test("filters GraphQL collection queries through generated filter inputs", async () => {
    const app = cms();
    const first = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "GraphQL Filters", body: "Typed filtering" })
    }));
    const firstBody = await first.json() as { id: string };
    const second = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "REST Filters", body: "Other path" })
    }));
    const secondBody = await second.json() as { id: string };
    const ada = await app.fetch(new Request("https://cms.test/api/authors", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada Lovelace" })
    }));
    const adaBody = await ada.json() as { id: string };
    const grace = await app.fetch(new Request("https://cms.test/api/authors", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Grace Hopper" })
    }));
    const graceBody = await grace.json() as { id: string };
    const adaArticle = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Ada Notes", body: "Relation filter", author: adaBody.id })
    }));
    const adaArticleBody = await adaArticle.json() as { id: string };
    const graceArticle = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Grace Notes", body: "Relation filter", author: graceBody.id })
    }));
    const graceArticleBody = await graceArticle.json() as { id: string };
    for (const id of [firstBody.id, secondBody.id, adaArticleBody.id, graceArticleBody.id]) {
      await app.fetch(new Request(`https://cms.test/api/articles/${id}/publish`, {
        method: "POST",
        headers: { authorization: "Bearer admin" }
      }));
    }

    const filtered = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "{ articles(filters: { title: { contains: \"GraphQL\" } }, sort: [\"title:asc\"]) { items { id title } } }"
      })
    }));
    const filteredBody = await filtered.json() as { data: { articles: { items: Array<{ title: string }> } } };
    expect(filteredBody.data.articles.items.map((item) => item.title)).toEqual(["GraphQL Filters"]);

    const relationFiltered = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "{ articles(filters: { author: { name: { startsWith: \"Ada\" } } }, sort: [\"title:asc\"]) { items { id title author { id name } } } }"
      })
    }));
    const relationFilteredBody = await relationFiltered.json() as { data: { articles: { items: Array<{ title: string; author: { name: string } }> } } };
    expect(relationFilteredBody.data.articles.items).toMatchObject([{ title: "Ada Notes", author: { name: "Ada Lovelace" } }]);

    const invalidPrivateField = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "{ articles(filters: { internalNotes: { contains: \"secret\" } }) { items { id title } } }"
      })
    }));
    await expect(invalidPrivateField.json()).resolves.toMatchObject({
      data: { articles: null },
      errors: [{ extensions: { code: "VALIDATION_ERROR", issues: [{ path: ["filter", "internalNotes"], message: "Field \"internalNotes\" is private" }] } }]
    });

    const invalidPrivateRelationField = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "{ articles(filters: { author: { apiKey: { contains: \"secret\" } } }) { items { id title } } }"
      })
    }));
    await expect(invalidPrivateRelationField.json()).resolves.toMatchObject({
      data: { articles: null },
      errors: [{ extensions: { code: "VALIDATION_ERROR", issues: [{ path: ["filter", "author", "apiKey"], message: "Field \"apiKey\" is private" }] } }]
    });

    const schema = await app.fetch(new Request("https://cms.test/cms/graphql/schema"));
    const sdl = await schema.text();
    expect(sdl).toContain("input ArticlesFilterInput");
    expect(sdl).toContain("title: StringFilter");
    expect(sdl).toContain("author: AuthorsFilterInput");
    expect(sdl).toContain("input AuthorsFilterInput");
    expect(sdl).toContain("name: StringFilter");
    expect(sdl).not.toContain("internalNotes: StringFilter");
    expect(sdl).not.toContain("apiKey: StringFilter");
    expect(sdl).toContain("input StringFilter { eq: String ne: String contains: String notContains: String startsWith: String endsWith: String in: [String!] nin: [String!] null: Boolean notNull: Boolean between: [String!] }");
  });

  test("rejects GraphQL queries that exceed demand limits", async () => {
    const app = cms();

    const tooDeep = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles { items { author { nested { deeper { tooDeep { id } } } } } } }" })
    }));
    await expect(tooDeep.json()).resolves.toMatchObject({
      data: { articles: null },
      errors: [{ extensions: { code: "QUERY_COMPLEXITY", issues: [{ message: "GraphQL selection depth is limited to 3" }] } }]
    });

    const tooManyFields = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: `{ articles { items { ${Array.from({ length: 81 }, () => "title").join(" ")} } } }` })
    }));
    await expect(tooManyFields.json()).resolves.toMatchObject({
      data: { articles: null },
      errors: [{ extensions: { code: "QUERY_COMPLEXITY", issues: [{ message: "GraphQL selection is limited to 80 fields" }] } }]
    });

    const tooManyPopulate = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: `{ articles(populate: [${Array.from({ length: 11 }, (_, index) => `"relation${index}"`).join(", ")}]) { items { id title } } }` })
    }));
    await expect(tooManyPopulate.json()).resolves.toMatchObject({
      data: { articles: null },
      errors: [{ extensions: { code: "QUERY_COMPLEXITY", issues: [{ path: ["articles", "populate"], message: "GraphQL populate is limited to 10 relations" }] } }]
    });
  });

  test("executes GraphQL collection queries through the same RBAC and projection path", async () => {
    const app = cms();
    const authorResponse = await app.fetch(new Request("https://cms.test/api/authors", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", apiKey: "hidden" })
    }));
    const author = await authorResponse.json() as { id: string };
    const create = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "GraphQL Edge", body: "Typed", internalNotes: "private", author: author.id })
    }));
    const draft = await create.json() as { id: string };

    const publicDraftList = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles(limit: 10, populate: [\"author\"]) { items { id title internalNotes author { id name apiKey } } nextCursor } }" })
    }));
    await expect(publicDraftList.json()).resolves.toMatchObject({ data: { articles: { items: [] } } });

    await app.fetch(new Request(`https://cms.test/api/articles/${draft.id}/publish`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    }));

    const publicPublishedList = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles(limit: 10, populate: [\"author\"]) { items { id title internalNotes author { id name apiKey } } } }" })
    }));
    const listBody = await publicPublishedList.json() as { data: { articles: { items: Array<Record<string, unknown>> } } };
    expect(listBody.data.articles.items).toMatchObject([{ id: draft.id, title: "GraphQL Edge", author: { id: author.id, name: "Ada" } }]);
    expect(listBody.data.articles.items[0]).not.toHaveProperty("internalNotes");
    expect(listBody.data.articles.items[0]?.author).not.toHaveProperty("apiKey");

    const item = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({
        query: "query Article($id: ID!) { article(id: $id, populate: [\"author\"]) { id title author { id name } } }",
        variables: { id: draft.id }
      })
    }));
    await expect(item.json()).resolves.toMatchObject({ data: { article: { id: draft.id, title: "GraphQL Edge", author: { id: author.id, name: "Ada" } } } });

    const schema = await app.fetch(new Request("https://cms.test/cms/graphql/schema"));
    const sdl = await schema.text();
    expect(sdl).toContain("type Articles");
    expect(sdl).toContain("author: Authors");
    expect(sdl).toContain("author: ID");
  });

  test("projects populated GraphQL relations to their nested selection fields", async () => {
    const relationCollections = defineSchema({
      authors: defineCollection("authors", {
        name: fields.string({ required: true }),
        bio: fields.text(),
        apiKey: fields.string({ private: true })
      }),
      articles: defineCollection("articles", {
        title: fields.string({ required: true }),
        author: fields.relation("authors", "one")
      })
    });
    const app = createCMS({
      collections: relationCollections,
      db: createMemoryDatabase({ provider: "memory", collections: relationCollections }),
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true }
    });
    const authorResponse = await app.fetch(new Request("https://cms.test/api/authors", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", bio: "Mathematician", apiKey: "secret" })
    }));
    const author = await authorResponse.json() as { id: string };
    await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Nested Selection", author: author.id })
    }));

    const response = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles { items { id title author { id name } } } }" })
    }));
    const body = await response.json() as { data: { articles: { items: Array<{ author: Record<string, unknown> }> } } };

    expect(body.data.articles.items[0]?.author).toMatchObject({ id: author.id, name: "Ada" });
    expect(body.data.articles.items[0]?.author).not.toHaveProperty("bio");
    expect(body.data.articles.items[0]?.author).not.toHaveProperty("apiKey");
  });

  test("caches anonymous content reads with ETags and invalidates on REST mutations", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections });
    const app = createCMS({
      collections,
      db,
      cache: { provider: "memory" },
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true }
    });

    const created = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Cached", body: "first" })
    }));
    const article = await created.json() as { id: string };
    await app.fetch(new Request(`https://cms.test/api/articles/${article.id}/publish`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    }));

    const listSpy = vi.spyOn(db, "list");
    const first = await app.fetch(new Request("https://cms.test/api/articles?limit=10"));
    expect(first.headers.get("x-cms-cache")).toBe("miss");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^".+"$/);
    await expect(first.json()).resolves.toMatchObject({ items: [{ title: "Cached" }] });
    expect(listSpy).toHaveBeenCalledTimes(1);

    const second = await app.fetch(new Request("https://cms.test/api/articles?limit=10"));
    expect(second.headers.get("x-cms-cache")).toBe("hit");
    expect(second.headers.get("etag")).toBe(etag);
    expect(listSpy).toHaveBeenCalledTimes(1);

    const notModified = await app.fetch(new Request("https://cms.test/api/articles?limit=10", {
      headers: { "if-none-match": etag ?? "" }
    }));
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("x-cms-cache")).toBe("hit");
    expect(listSpy).toHaveBeenCalledTimes(1);

    await app.fetch(new Request(`https://cms.test/api/articles/${article.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Fresh" })
    }));

    const afterMutation = await app.fetch(new Request("https://cms.test/api/articles?limit=10"));
    expect(afterMutation.headers.get("x-cms-cache")).toBe("miss");
    await expect(afterMutation.json()).resolves.toMatchObject({ items: [{ title: "Fresh" }] });
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  test("rate limits configured content mutations through the cache adapter", async () => {
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      cache: { provider: "memory" },
      rateLimit: { mutations: { limit: 1, window: "1 m", prefix: "test:mutations" } },
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true }
    });

    const first = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
      body: JSON.stringify({ title: "First" })
    }));
    expect(first.status).toBe(201);

    const second = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
      body: JSON.stringify({ title: "Second" })
    }));
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(second.headers.get("x-ratelimit-remaining")).toBe("0");
    await expect(second.json()).resolves.toEqual({ error: "rate_limited" });
  });

  test("resolves the Cloudflare KV cache provider through createCMS", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const binding = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {})
    };
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      cache: { provider: "kv", binding },
      rbac: { publicRead: true }
    });

    expect(app.cache?.provider).toBe("kv");
    const response = await app.fetch(new Request("https://cms.test/cms/health"));
    expect(response.status).toBe(200);
    expect(warn).toHaveBeenCalledWith("[hono-cms/cache] KV provider selected. Session caching should fall back to in-memory because KV is eventually consistent. Rate limiting is disabled.");
  });

  test("rate limits configured GraphQL mutations without throttling GraphQL reads", async () => {
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      cache: { provider: "memory" },
      rateLimit: { graphql: { limit: 1, window: "1 m", prefix: "test:graphql" } },
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true }
    });

    const first = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json", "cf-connecting-ip": "203.0.113.11" },
      body: JSON.stringify({ query: "mutation { createArticle(data: { title: \"First Graph\" }) { id title } }" })
    }));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ data: { createArticle: { title: "First Graph" } } });

    const read = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.11" },
      body: JSON.stringify({ query: "{ articles { items { id title } } }" })
    }));
    expect(read.status).toBe(200);

    const second = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json", "cf-connecting-ip": "203.0.113.11" },
      body: JSON.stringify({ query: "mutation { createArticle(data: { title: \"Second Graph\" }) { id title } }" })
    }));
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toEqual({ error: "rate_limited" });
  });

  test("rate limits configured media mutations independently from content writes", async () => {
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      storage: { provider: "memory" },
      cache: { provider: "memory" },
      rateLimit: {
        mutations: { limit: 100, window: "1 m", prefix: "test:content" },
        media: { limit: 1, window: "1 m", prefix: "test:media" }
      },
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] }, editor: { userId: "2", roles: ["editor"] } } },
      rbac: { publicRead: true }
    });

    const content = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json", "cf-connecting-ip": "203.0.113.12" },
      body: JSON.stringify({ title: "Content Still Works" })
    }));
    expect(content.status).toBe(201);

    const first = await app.fetch(new Request("https://cms.test/api/media", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "text/plain", "x-filename": "first.txt", "cf-connecting-ip": "203.0.113.12" },
      body: "first"
    }));
    expect(first.status).toBe(201);

    const second = await app.fetch(new Request("https://cms.test/api/media", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "text/plain", "x-filename": "second.txt", "cf-connecting-ip": "203.0.113.12" },
      body: "second"
    }));
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toEqual({ error: "rate_limited" });
  });

  test("caches anonymous GraphQL queries and invalidates on GraphQL mutations", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections });
    const app = createCMS({
      collections,
      db,
      cache: { provider: "memory" },
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true }
    });

    const create = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ query: "mutation { createArticle(data: { title: \"Graph Cache\" }) { id title } }" })
    }));
    const createBody = await create.json() as { data: { createArticle: { id: string } } };
    await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ query: `mutation { publishArticle(id: "${createBody.data.createArticle.id}") { id } }` })
    }));

    const listSpy = vi.spyOn(db, "list");
    const query = { query: "{ articles { items { id title } } }" };
    const first = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(query)
    }));
    const etag = first.headers.get("etag");
    expect(first.headers.get("x-cms-cache")).toBe("miss");
    await expect(first.json()).resolves.toMatchObject({ data: { articles: { items: [{ title: "Graph Cache" }] } } });
    expect(listSpy).toHaveBeenCalledTimes(1);

    const second = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", "if-none-match": etag ?? "" },
      body: JSON.stringify(query)
    }));
    expect(second.status).toBe(304);
    expect(listSpy).toHaveBeenCalledTimes(1);

    await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ query: `mutation { updateArticle(id: "${createBody.data.createArticle.id}", data: { title: "Graph Fresh" }) { id } }` })
    }));

    const afterMutation = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(query)
    }));
    expect(afterMutation.headers.get("x-cms-cache")).toBe("miss");
    await expect(afterMutation.json()).resolves.toMatchObject({ data: { articles: { items: [{ title: "Graph Fresh" }] } } });
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  test("executes GraphQL content mutations through validation, RBAC, and projection", async () => {
    const app = cms();
    const authorResponse = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({
        query: "mutation CreateAuthor($data: AuthorsCreateInput!) { createAuthor(data: $data) { id name apiKey } }",
        variables: { data: { name: "Grace" } }
      })
    }));
    const authorBody = await authorResponse.json() as { data: { createAuthor: { id: string; name: string; apiKey?: string } } };
    expect(authorBody.data.createAuthor).toMatchObject({ name: "Grace" });
    expect(authorBody.data.createAuthor).not.toHaveProperty("apiKey");

    const create = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({
        query: "mutation CreateArticle($data: ArticlesCreateInput!) { createArticle(data: $data) { id title status author } }",
        variables: { data: { title: "GraphQL Mutation", body: "Typed", author: authorBody.data.createAuthor.id } }
      })
    }));
    const createBody = await create.json() as { data: { createArticle: { id: string; title: string; status: string } } };
    expect(createBody.data.createArticle).toMatchObject({ title: "GraphQL Mutation", status: "draft" });

    const update = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation { updateArticle(id: "${createBody.data.createArticle.id}", data: { title: "Updated Mutation" }) { id title status } }`
      })
    }));
    await expect(update.json()).resolves.toMatchObject({ data: { updateArticle: { title: "Updated Mutation", status: "draft" } } });

    const publish = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation { publishArticle(id: "${createBody.data.createArticle.id}") { id status publishedAt } }`
      })
    }));
    await expect(publish.json()).resolves.toMatchObject({ data: { publishArticle: { status: "published" } } });

    const deleted = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ query: `mutation { deleteArticle(id: "${createBody.data.createArticle.id}") { ok } }` })
    }));
    await expect(deleted.json()).resolves.toMatchObject({ data: { deleteArticle: true } });
  });

  test("returns GraphQL mutation errors for forbidden operations and field writes", async () => {
    const app = cms();

    const unauthenticatedCreate = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "mutation { createArticle(data: { title: \"Nope\" }) { id title } }" })
    }));
    await expect(unauthenticatedCreate.json()).resolves.toMatchObject({
      data: { createArticle: null },
      errors: [{ extensions: { code: "FORBIDDEN" } }]
    });

    const forbiddenField = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ query: "mutation { createArticle(data: { title: \"Nope\", internalNotes: \"secret\" }) { id title } }" })
    }));
    await expect(forbiddenField.json()).resolves.toMatchObject({
      data: { createArticle: null },
      errors: [{ extensions: { code: "VALIDATION_ERROR" } }]
    });

    const editorDelete = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ query: "mutation { deleteArticle(id: \"missing\") { ok } }" })
    }));
    await expect(editorDelete.json()).resolves.toMatchObject({
      data: { deleteArticle: null },
      errors: [{ extensions: { code: "FORBIDDEN" } }]
    });
  });

  test("serves a real GraphQL schema through the Apollo handler", async () => {
    // Plan-6 U4/U5 acceptance: the `/cms/graphql` endpoint is now backed by
    // a real `GraphQLSchema` executed through Apollo Server, so a standard
    // introspection query returns the schema definition (types, queries,
    // mutations) instead of the legacy `NOT_FOUND` stub.
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      rbac: { publicRead: true }
    });

    const introspection = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `{
          __schema {
            queryType { name }
            mutationType { name }
            types { name kind }
          }
        }`
      })
    }));
    expect(introspection.status).toBe(200);
    const introspectionBody = await introspection.json() as { data: { __schema: { queryType: { name: string }; mutationType: { name: string }; types: Array<{ name: string; kind: string }> } } };
    expect(introspectionBody.data.__schema.queryType.name).toBe("Query");
    expect(introspectionBody.data.__schema.mutationType.name).toBe("Mutation");
    const typeNames = new Set(introspectionBody.data.__schema.types.map((type) => type.name));
    expect(typeNames.has("Articles")).toBe(true);
    expect(typeNames.has("Authors")).toBe(true);
    expect(typeNames.has("ArticlesConnection")).toBe(true);
    expect(typeNames.has("ArticlesCreateInput")).toBe(true);
  });

  test("runs GraphQL mutation hooks, audit entries, and webhook dispatch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const beforeCreate = vi.fn((input: Record<string, unknown>) => ({ ...input, body: "from hook" }));
    const afterCreate = vi.fn();
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true },
      webhooks: [{ url: "https://hooks.test/graphql", events: ["content.created"] }],
      hooks: { beforeCreate: [beforeCreate], afterCreate: [afterCreate] }
    });

    const created = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json", "x-request-id": "gql_create_1" },
      body: JSON.stringify({ query: "mutation { createArticle(data: { title: \"Hooked GraphQL\" }) { id title body } }" })
    }));
    const body = await created.json() as { data: { createArticle: { id: string; body: string } } };
    expect(body.data.createArticle.body).toBe("from hook");
    expect(beforeCreate).toHaveBeenCalledWith(expect.objectContaining({ title: "Hooked GraphQL" }), expect.objectContaining({ collection: "articles" }));
    expect(afterCreate).toHaveBeenCalledWith(expect.objectContaining({ id: body.data.createArticle.id }), expect.objectContaining({ id: body.data.createArticle.id }));

    const audit = await app.fetch(new Request(`https://cms.test/cms/audit-log?collection=articles&documentId=${body.data.createArticle.id}`, {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(audit.json()).resolves.toMatchObject({
      items: [{ operation: "create", requestId: "gql_create_1", diff: { after: { title: "Hooked GraphQL", body: "from hook" } } }]
    });
    expect(fetchMock).toHaveBeenCalledWith("https://hooks.test/graphql", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining("gql_create_1")
    }));
    fetchMock.mockRestore();
  });

  test("enqueues webhook retries for failed GraphQL mutation deliveries", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));
    const webhookStore = new MemoryWebhookStore();
    await webhookStore.createWebhook({
      name: "graphql retry",
      url: "https://hooks.test/graphql-retry",
      events: ["content.created"],
      enabled: true
    });
    const enqueue = vi.fn(async () => {});
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      jobs: {
        provider: "test",
        register: vi.fn(),
        dispatch: vi.fn(),
        enqueue
      },
      webhookStore,
      rbac: { publicRead: true }
    });

    const created = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json", "x-request-id": "gql_retry_1" },
      body: JSON.stringify({ query: "mutation { createArticle(data: { title: \"Retry GraphQL\" }) { id title } }" })
    }));
    expect(created.status).toBe(200);

    expect(enqueue).toHaveBeenCalledWith("/cms/jobs/webhook-retry", expect.objectContaining({ deliveryId: expect.any(String) }), { delay: 30 });
    await expect(webhookStore.listDeliveries()).resolves.toMatchObject({
      items: [{ status: "retrying", attempt: 1, responseStatus: 503 }]
    });
    fetchMock.mockRestore();
  });

  test("returns GraphQL errors for forbidden collection access and invalid operations", async () => {
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      auth: { tokens: { editor: { userId: "2", roles: ["editor"] } } },
      rbac: { publicRead: false }
    });

    const forbidden = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles { items { id title } } }" })
    }));
    await expect(forbidden.json()).resolves.toMatchObject({
      data: { articles: null },
      errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }]
    });

    const bad = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ query: "not graphql" })
    }));
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toMatchObject({ errors: [{ extensions: { code: "BAD_REQUEST" } }] });
  });

  test("defaults, validates, filters, and falls back localized collection reads", async () => {
    const app = cms();
    const createDefault = await app.fetch(new Request("https://cms.test/api/pages", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Home" })
    }));
    await expect(createDefault.json()).resolves.toMatchObject({ title: "Home", locale: "en" });

    const unsupported = await app.fetch(new Request("https://cms.test/api/pages?locale=pt-BR", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Casa" })
    }));
    expect(unsupported.status).toBe(422);

    const createSpanish = await app.fetch(new Request("https://cms.test/api/pages?locale=es", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Inicio" })
    }));
    await expect(createSpanish.json()).resolves.toMatchObject({ title: "Inicio", locale: "es" });

    const spanish = await app.fetch(new Request("https://cms.test/api/pages?locale=es"));
    await expect(spanish.json()).resolves.toMatchObject({ items: [{ title: "Inicio", locale: "es" }] });

    const mexicanSpanish = await app.fetch(new Request("https://cms.test/api/pages?locale=es-MX"));
    await expect(mexicanSpanish.json()).resolves.toMatchObject({ items: [{ title: "Inicio", locale: "es" }] });

    const strictMexicanSpanish = await app.fetch(new Request("https://cms.test/api/pages?locale=es-MX&fallback=false"));
    await expect(strictMexicanSpanish.json()).resolves.toMatchObject({ items: [] });
  });

  test("creates and serves AI locale variants through translation routes and jobs", async () => {
    const provider = {
      provider: "test-translator",
      translate: vi.fn(async ({ fields, targetLocale }: { fields: Record<string, string>; targetLocale: string }) =>
        Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, `${value} (${targetLocale})`]))
      )
    };
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      i18n: { provider },
      jobs: { provider: "memory" },
      rbac: { publicRead: true }
    });

    const create = await app.fetch(new Request("https://cms.test/api/pages", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Home" })
    }));
    const page = await create.json() as { id: string };

    const translated = await app.fetch(new Request(`https://cms.test/api/pages/${page.id}/translate`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ targetLocale: "es" })
    }));
    expect(translated.status).toBe(200);
    await expect(translated.json()).resolves.toMatchObject({
      collection: "pages",
      documentId: page.id,
      locale: "es",
      status: "complete",
      translatedBy: "ai",
      fields: { title: "Home (es)" }
    });

    const spanish = await app.fetch(new Request(`https://cms.test/api/pages/${page.id}?locale=es`));
    await expect(spanish.json()).resolves.toMatchObject({ id: page.id, title: "Home (es)", locale: "es" });

    const mexicanFallback = await app.fetch(new Request(`https://cms.test/api/pages/${page.id}?locale=es-MX`));
    await expect(mexicanFallback.json()).resolves.toMatchObject({ id: page.id, title: "Home (es)", locale: "es" });

    const strictMexicanFallback = await app.fetch(new Request(`https://cms.test/api/pages/${page.id}?locale=es-MX&fallback=false`));
    expect(strictMexicanFallback.status).toBe(404);
    await expect(strictMexicanFallback.json()).resolves.toMatchObject({ error: "not_found" });

    const locales = await app.fetch(new Request(`https://cms.test/api/pages/${page.id}/locales`));
    await expect(locales.json()).resolves.toMatchObject({
      defaultLocale: "en",
      locales: [
        { locale: "en", status: "complete", translatedBy: "human" },
        { locale: "es", status: "complete", translatedBy: "ai" },
        { locale: "es-MX", status: "missing", translatedBy: "pending" }
      ]
    });

    const job = await app.fetch(new Request("https://cms.test/cms/jobs/translation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection: "pages", documentId: page.id, targetLocale: "es-MX" })
    }));
    expect(job.status).toBe(200);
    await expect(job.json()).resolves.toMatchObject({ locale: "es-MX", fields: { title: "Home (es-MX)" } });
    expect(provider.translate).toHaveBeenCalledTimes(2);
  });

  test("marks locale variants reviewed and supports direct human locale edits", async () => {
    const provider = {
      provider: "test-translator",
      translate: vi.fn(async ({ fields, targetLocale }: { fields: Record<string, string>; targetLocale: string }) =>
        Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, `${value} (${targetLocale})`]))
      )
    };
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] }, editor: { userId: "2", roles: ["editor"] } } },
      i18n: { provider },
      jobs: { provider: "memory" },
      rbac: { publicRead: true, rules: [{ action: "update", collection: "pages", roles: ["editor"] }] }
    });

    const create = await app.fetch(new Request("https://cms.test/api/pages", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Home" })
    }));
    const page = await create.json() as { id: string };

    await app.fetch(new Request(`https://cms.test/api/pages/${page.id}/translate`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ targetLocale: "es" })
    }));

    const reviewed = await app.fetch(new Request(`https://cms.test/api/pages/${page.id}/locales/es`, {
      method: "PATCH",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ translatedBy: "human" })
    }));
    expect(reviewed.status).toBe(200);
    await expect(reviewed.json()).resolves.toMatchObject({ locale: "es", translatedBy: "human", fields: { title: "Home (es)" } });

    const edited = await app.fetch(new Request(`https://cms.test/api/pages/${page.id}/locales/es-MX`, {
      method: "PUT",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ fields: { title: "Inicio", ignoredSharedField: "shared" } })
    }));
    expect(edited.status).toBe(200);
    await expect(edited.json()).resolves.toMatchObject({ locale: "es-MX", status: "complete", translatedBy: "human", fields: { title: "Inicio" } });

    const localized = await app.fetch(new Request(`https://cms.test/api/pages/${page.id}?locale=es-MX`));
    await expect(localized.json()).resolves.toMatchObject({ id: page.id, title: "Inicio", locale: "es-MX", translatedBy: "human" });

    const defaultLocaleEdit = await app.fetch(new Request(`https://cms.test/api/pages/${page.id}/locales/en`, {
      method: "PUT",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ fields: { title: "Default" } })
    }));
    expect(defaultLocaleEdit.status).toBe(422);
    await expect(defaultLocaleEdit.json()).resolves.toMatchObject({ error: "validation_error" });

    const unsupported = await app.fetch(new Request(`https://cms.test/api/pages/${page.id}/locales/fr`, {
      method: "PATCH",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ translatedBy: "human" })
    }));
    expect(unsupported.status).toBe(422);
    await expect(unsupported.json()).resolves.toMatchObject({ error: "unsupported_locale" });
  });

  test("auto-translation enqueues one job per non-default locale on localized saves", async () => {
    const enqueue = vi.fn(async () => {});
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      i18n: {
        autoTranslate: true,
        provider: {
          provider: "test-translator",
          translate: vi.fn(async ({ fields }: { fields: Record<string, string> }) => fields)
        }
      },
      jobs: {
        provider: "test",
        register: vi.fn(),
        dispatch: vi.fn(),
        enqueue
      },
      rbac: { publicRead: true }
    });

    const create = await app.fetch(new Request("https://cms.test/api/pages", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Auto Home" })
    }));
    const page = await create.json() as { id: string };

    expect(enqueue).toHaveBeenCalledWith("/cms/jobs/translation", { collection: "pages", documentId: page.id, targetLocale: "es" });
    expect(enqueue).toHaveBeenCalledWith("/cms/jobs/translation", { collection: "pages", documentId: page.id, targetLocale: "es-MX" });
  });

  test("backfills translated locale variants through admin jobs", async () => {
    const enqueue = vi.fn(async () => {});
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] }, editor: { userId: "2", roles: ["editor"] } } },
      i18n: {
        provider: {
          provider: "test-translator",
          translate: vi.fn(async ({ fields }: { fields: Record<string, string> }) => fields)
        }
      },
      jobs: {
        provider: "test",
        register: vi.fn(),
        dispatch: vi.fn(),
        enqueue
      },
      rbac: { publicRead: true }
    });

    const first = await app.fetch(new Request("https://cms.test/api/pages", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Home" })
    }));
    const firstPage = await first.json() as { id: string };
    const second = await app.fetch(new Request("https://cms.test/api/pages", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "About" })
    }));
    const secondPage = await second.json() as { id: string };

    const forbidden = await app.fetch(new Request("https://cms.test/cms/admin/i18n/backfill", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ locale: "es", collection: "pages" })
    }));
    expect(forbidden.status).toBe(403);

    const backfill = await app.fetch(new Request("https://cms.test/cms/admin/i18n/backfill", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ locale: "es", collection: "pages" })
    }));
    expect(backfill.status).toBe(200);
    await expect(backfill.json()).resolves.toMatchObject({
      status: "enqueued",
      locale: "es",
      collection: "pages",
      jobCount: 2,
      collections: { pages: 2 }
    });
    expect(enqueue).toHaveBeenCalledWith("/cms/jobs/translation", { collection: "pages", documentId: firstPage.id, targetLocale: "es" });
    expect(enqueue).toHaveBeenCalledWith("/cms/jobs/translation", { collection: "pages", documentId: secondPage.id, targetLocale: "es" });

    const status = await app.fetch(new Request("https://cms.test/cms/admin/i18n/backfill/status?locale=es&collection=pages", {
      headers: { authorization: "Bearer admin" }
    }));
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      locale: "es",
      collection: "pages",
      totals: { total: 2, missing: 0, pending: 2, complete: 0, error: 0 },
      collections: [{ collection: "pages", total: 2, missing: 0, pending: 2 }]
    });

    const defaultLocale = await app.fetch(new Request("https://cms.test/cms/admin/i18n/backfill", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ locale: "en", collection: "pages" })
    }));
    expect(defaultLocale.status).toBe(422);

    const nonLocalized = await app.fetch(new Request("https://cms.test/cms/admin/i18n/backfill/status?locale=es&collection=articles", {
      headers: { authorization: "Bearer admin" }
    }));
    expect(nonLocalized.status).toBe(400);
    await expect(nonLocalized.json()).resolves.toMatchObject({ error: "i18n_not_enabled" });
  });

  test("keeps draft system fields managed and hidden from public reads", async () => {
    const app = cms();
    const create = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Private Draft", status: "published", publishedAt: "2020-01-01T00:00:00.000Z" })
    }));
    const draft = await create.json() as { id: string; status: string; publishedAt?: string };
    expect(draft.status).toBe("draft");
    expect(draft.publishedAt).toBeUndefined();

    const publicList = await app.fetch(new Request("https://cms.test/api/articles"));
    await expect(publicList.json()).resolves.toMatchObject({ items: [] });

    const publicGet = await app.fetch(new Request(`https://cms.test/api/articles/${draft.id}`));
    expect(publicGet.status).toBe(404);

    const adminList = await app.fetch(new Request("https://cms.test/api/articles", {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(adminList.json()).resolves.toMatchObject({ items: [{ id: draft.id, status: "draft" }] });
  });

  test("supports unpublish and registers publish routes only for draft collections", async () => {
    const app = cms();
    const articleResponse = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Lifecycle" })
    }));
    const article = await articleResponse.json() as { id: string };

    const publish = await app.fetch(new Request(`https://cms.test/api/articles/${article.id}/publish`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    }));
    await expect(publish.json()).resolves.toMatchObject({ status: "published" });

    const unpublish = await app.fetch(new Request(`https://cms.test/api/articles/${article.id}/unpublish`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    }));
    await expect(unpublish.json()).resolves.toMatchObject({ status: "draft", publishedAt: null });

    const pageResponse = await app.fetch(new Request("https://cms.test/api/pages", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Static Page" })
    }));
    const page = await pageResponse.json() as { id: string };
    const missingPublishRoute = await app.fetch(new Request(`https://cms.test/api/pages/${page.id}/publish`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    }));
    expect(missingPublishRoute.status).toBe(404);
  });

  test("publishes scheduled drafts from the Web Request scheduled hook", async () => {
    const app = cms();
    const create = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Scheduled" })
    }));
    const draft = await create.json() as { id: string };
    const schedule = await app.fetch(new Request(`https://cms.test/api/articles/${draft.id}/schedule`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ publishAt: "2000-01-01T00:00:00.000Z" })
    }));
    await expect(schedule.json()).resolves.toMatchObject({ status: "draft", publishedAt: "2000-01-01T00:00:00.000Z" });

    await app.scheduled({}, {}, {});

    const publicGet = await app.fetch(new Request(`https://cms.test/api/articles/${draft.id}`));
    await expect(publicGet.json()).resolves.toMatchObject({ id: draft.id, status: "published" });
  });

  test("runs portable jobs endpoints with verification and disabled-route behavior", async () => {
    const app = cms();
    const create = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Job Scheduled" })
    }));
    const draft = await create.json() as { id: string };
    await app.fetch(new Request(`https://cms.test/api/articles/${draft.id}/schedule`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ publishAt: new Date(Date.now() - 1000).toISOString() })
    }));

    const scheduled = await app.fetch(new Request("https://cms.test/cms/jobs/scheduled-publish", { method: "GET" }));
    expect(scheduled.status).toBe(200);
    await expect(scheduled.json()).resolves.toEqual({ published: 1 });
    const publicList = await app.fetch(new Request("https://cms.test/api/articles"));
    await expect(publicList.json()).resolves.toMatchObject({ items: [{ title: "Job Scheduled", status: "published" }] });

    const auditStore = new MemoryAuditStore();
    await auditStore.append({
      id: "old",
      operation: "create",
      collection: "articles",
      actorRoles: [],
      requestId: "old",
      diff: { before: null, after: { title: "old" } },
      createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    });
    await auditStore.append({
      id: "fresh",
      operation: "create",
      collection: "articles",
      actorRoles: [],
      requestId: "fresh",
      diff: { before: null, after: { title: "fresh" } },
      createdAt: new Date().toISOString()
    });
    const cleanupApp = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      jobs: { provider: "memory" },
      auditLog: { store: auditStore, retentionDays: 1 },
      rbac: { publicRead: true }
    });
    const cleanup = await cleanupApp.fetch(new Request("https://cms.test/cms/jobs/audit-log-cleanup", { method: "POST" }));
    await expect(cleanup.json()).resolves.toEqual({ deleted: 1 });
    await expect(auditStore.list()).resolves.toMatchObject({ items: [{ id: "fresh" }] });
    await auditStore.append({
      id: "old-dispatch",
      operation: "create",
      collection: "articles",
      actorRoles: [],
      requestId: "old-dispatch",
      diff: { before: null, after: { title: "old dispatch" } },
      createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    });
    await cleanupApp.jobs?.dispatch("audit-log-cleanup");
    await expect(auditStore.list()).resolves.toMatchObject({ items: [{ id: "fresh" }] });

    const sweep = vi.fn(async () => ({ swept: 3 }));
    const cacheSweepApp = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      jobs: { provider: "memory" },
      cache: {
        provider: "sweepable",
        get: vi.fn(async () => null),
        set: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
        sweep
      },
      rbac: { publicRead: true }
    });
    const cacheSweep = await cacheSweepApp.fetch(new Request("https://cms.test/cms/jobs/cache-sweep", { method: "POST" }));
    expect(sweep).toHaveBeenCalledTimes(1);
    await expect(cacheSweep.json()).resolves.toEqual({ swept: 3 });
    await cacheSweepApp.jobs?.dispatch("cache-sweep");
    expect(sweep).toHaveBeenCalledTimes(2);

    const protectedApp = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      jobs: {
        provider: "locked",
        register: vi.fn(),
        dispatch: vi.fn(),
        verify: async () => false
      },
      rbac: { publicRead: true }
    });
    const unauthorized = await protectedApp.fetch(new Request("https://cms.test/cms/jobs/scheduled-publish", { method: "POST" }));
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({ error: "unauthorized" });

    const disabledApp = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      rbac: { publicRead: true }
    });
    const disabled = await disabledApp.fetch(new Request("https://cms.test/cms/jobs/scheduled-publish", { method: "POST" }));
    expect(disabled.status).toBe(404);

    const explicitNoneApp = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      jobs: { provider: "none" },
      rbac: { publicRead: true }
    });
    expect(explicitNoneApp.jobs).toBeNull();
    const explicitNone = await explicitNoneApp.fetch(new Request("https://cms.test/cms/jobs/scheduled-publish", { method: "POST" }));
    expect(explicitNone.status).toBe(404);
  });

  test("issues and revokes preview tokens for single-document draft access", async () => {
    const app = cms();
    const create = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Preview Me" })
    }));
    const draft = await create.json() as { id: string };

    const forbidden = await app.fetch(new Request("https://cms.test/api/preview-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection: "articles", documentId: draft.id })
    }));
    expect(forbidden.status).toBe(403);

    const issued = await app.fetch(new Request("https://cms.test/api/preview-tokens", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ collection: "articles", documentId: draft.id })
    }));
    expect(issued.status).toBe(200);
    const token = await issued.json() as { token: string; expiresAt: string; previewUrl: string };
    expect(token.token).toMatch(/^[a-f0-9]{64}$/);
    expect(token.previewUrl).toBe(`https://site.test/preview?preview=${token.token}`);
    expect(Date.parse(token.expiresAt)).toBeGreaterThan(Date.now());

    const publicGet = await app.fetch(new Request(`https://cms.test/api/articles/${draft.id}?preview=${token.token}`));
    await expect(publicGet.json()).resolves.toMatchObject({ id: draft.id, status: "draft", title: "Preview Me" });

    const publicList = await app.fetch(new Request(`https://cms.test/api/articles?preview=${token.token}`));
    await expect(publicList.json()).resolves.toMatchObject({ items: [] });

    const graphQLPreview = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "query Preview($id: ID!, $preview: String!) { article(id: $id, preview: $preview) { id title status } }",
        variables: { id: draft.id, preview: token.token }
      })
    }));
    await expect(graphQLPreview.json()).resolves.toMatchObject({
      data: { article: { id: draft.id, title: "Preview Me", status: "draft" } }
    });

    const graphQLListPreview = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "query PreviewList($preview: String!) { articles(preview: $preview) { items { id title status } } }",
        variables: { preview: token.token }
      })
    }));
    await expect(graphQLListPreview.json()).resolves.toMatchObject({ data: { articles: { items: [] } } });

    const graphQLWrongId = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "query Preview($id: ID!, $preview: String!) { article(id: $id, preview: $preview) { id title status } }",
        variables: { id: "not_the_previewed_document", preview: token.token }
      })
    }));
    await expect(graphQLWrongId.json()).resolves.toMatchObject({ data: { article: null } });

    const graphQLSchema = await app.fetch(new Request("https://cms.test/cms/graphql/schema"));
    const sdl = await graphQLSchema.text();
    expect(sdl).toContain("article(id: ID!, locale: String, preview: String");
    expect(sdl).toContain("articles(filters: ArticlesFilterInput, pagination: PaginationInput, limit: Int, cursor: String, page: Int, pageSize: Int, sort: [String!], status: ContentStatus, locale: String, preview: String");

    const revoked = await app.fetch(new Request(`https://cms.test/api/preview-tokens/${token.token}`, {
      method: "DELETE",
      headers: { authorization: "Bearer admin" }
    }));
    expect(revoked.status).toBe(204);

    const afterRevoke = await app.fetch(new Request(`https://cms.test/api/articles/${draft.id}?preview=${token.token}`));
    expect(afterRevoke.status).toBe(404);
  });

  test("enforces RBAC and validates input", async () => {
    const app = cms();
    const forbidden = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Nope" })
    }));
    expect(forbidden.status).toBe(403);

    const invalid = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ body: "Missing title" })
    }));
    expect(invalid.status).toBe(422);
  });

  test("enforces schema-declared collection RBAC for REST and GraphQL", async () => {
    const scopedCollections = defineSchema({
      articles: defineCollection("articles", {
        title: fields.string({ required: true })
      }, {
        draftAndPublish: true,
        rbac: { authenticated: ["read", "create"] }
      }),
      pages: defineCollection("pages", {
        title: fields.string({ required: true })
      }, {
        rbac: { public: ["read"] }
      })
    });
    const app = createCMS({
      collections: scopedCollections,
      db: createMemoryDatabase({ provider: "memory", collections: scopedCollections }),
      auth: {
        tokens: {
          member: { userId: "member_1", roles: ["member"] },
          admin: { userId: "admin_1", roles: ["admin"] }
        }
      }
    });

    const pageResponse = await app.fetch(new Request("https://cms.test/api/pages", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Public Page" })
    }));
    const page = await pageResponse.json() as { id: string };

    const publicPage = await app.fetch(new Request(`https://cms.test/api/pages/${page.id}`));
    expect(publicPage.status).toBe(200);
    await expect(publicPage.json()).resolves.toMatchObject({ id: page.id, title: "Public Page" });

    const publicArticles = await app.fetch(new Request("https://cms.test/api/articles"));
    expect(publicArticles.status).toBe(403);

    const memberCreate = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer member", "content-type": "application/json" },
      body: JSON.stringify({ title: "Member Draft" })
    }));
    expect(memberCreate.status).toBe(201);

    const memberGraphQL = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer member", "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles(limit: 10) { items { id title status } } }" })
    }));
    await expect(memberGraphQL.json()).resolves.toMatchObject({ data: { articles: { items: [{ title: "Member Draft", status: "draft" }] } } });

    const publicGraphQL = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles(limit: 10) { items { id title } } }" })
    }));
    await expect(publicGraphQL.json()).resolves.toMatchObject({ errors: [{ extensions: { code: "FORBIDDEN" } }] });
  });

  test("enforces schema-declared field permissions across REST and GraphQL", async () => {
    const scopedCollections = defineSchema({
      articles: defineCollection("articles", {
        title: fields.string({ required: true }),
        publicSummary: fields.string(),
        memberNotes: fields.string({ permissions: { read: ["authenticated"], write: ["editor"] } }),
        editorNotes: fields.string({ permissions: { read: ["editor"], write: ["editor"] } }),
        adminNotes: fields.string({ permissions: { read: ["admin"], write: ["admin"] } }),
        privateNotes: fields.string({ private: true, permissions: { write: ["admin"] } })
      }, {
        rbac: {
          public: ["read"],
          authenticated: ["create", "read", "update"]
        }
      })
    });
    const app = createCMS({
      collections: scopedCollections,
      db: createMemoryDatabase({ provider: "memory", collections: scopedCollections }),
      auth: {
        tokens: {
          member: { userId: "member_1", roles: ["member"] },
          editor: { userId: "editor_1", roles: ["editor"] },
          admin: { userId: "admin_1", roles: ["admin"] }
        }
      }
    });

    const deniedCreate = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer member", "content-type": "application/json" },
      body: JSON.stringify({ title: "Field Gates", memberNotes: "nope" })
    }));
    expect(deniedCreate.status).toBe(403);
    await expect(deniedCreate.json()).resolves.toMatchObject({ error: "forbidden_field", issues: [{ path: ["memberNotes"] }] });

    const created = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({
        title: "Field Gates",
        publicSummary: "Everyone",
        memberNotes: "Members",
        editorNotes: "Editors",
        adminNotes: "Admins",
        privateNotes: "Private"
      })
    }));
    expect(created.status).toBe(403);
    await expect(created.json()).resolves.toMatchObject({ issues: [{ path: ["adminNotes"] }, { path: ["privateNotes"] }] });

    const adminCreate = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({
        title: "Field Gates",
        publicSummary: "Everyone",
        memberNotes: "Members",
        editorNotes: "Editors",
        adminNotes: "Admins",
        privateNotes: "Private"
      })
    }));
    expect(adminCreate.status).toBe(201);
    const createBody = await adminCreate.json() as Record<string, unknown> & { id: string };
    expect(createBody).toMatchObject({ title: "Field Gates", publicSummary: "Everyone", memberNotes: "Members", editorNotes: "Editors", adminNotes: "Admins" });
    expect(createBody.privateNotes).toBeUndefined();
    const record = createBody;

    const adminUpdate = await app.fetch(new Request(`https://cms.test/api/articles/${record.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ publicSummary: "Updated", privateNotes: "Still Private" })
    }));
    expect(adminUpdate.status).toBe(200);
    const updateBody = await adminUpdate.json() as Record<string, unknown>;
    expect(updateBody).toMatchObject({ publicSummary: "Updated", adminNotes: "Admins" });
    expect(updateBody.privateNotes).toBeUndefined();

    const publicRead = await app.fetch(new Request(`https://cms.test/api/articles/${record.id}`));
    const publicBody = await publicRead.json() as Record<string, unknown>;
    expect(publicBody).toMatchObject({ title: "Field Gates", publicSummary: "Updated" });
    expect(publicBody.memberNotes).toBeUndefined();
    expect(publicBody.editorNotes).toBeUndefined();
    expect(publicBody.adminNotes).toBeUndefined();
    expect(publicBody.privateNotes).toBeUndefined();

    const memberRead = await app.fetch(new Request(`https://cms.test/api/articles/${record.id}`, {
      headers: { authorization: "Bearer member" }
    }));
    const memberBody = await memberRead.json() as Record<string, unknown>;
    expect(memberBody.memberNotes).toBe("Members");
    expect(memberBody.editorNotes).toBeUndefined();
    expect(memberBody.adminNotes).toBeUndefined();

    const graphQL = await app.fetch(new Request("https://cms.test/cms/graphql", {
      method: "POST",
      headers: { authorization: "Bearer member", "content-type": "application/json" },
      body: JSON.stringify({ query: `{ article(id: "${record.id}") { id title memberNotes editorNotes adminNotes privateNotes } }` })
    }));
    await expect(graphQL.json()).resolves.toMatchObject({ data: { article: { title: "Field Gates", memberNotes: "Members" } } });
  });

  test("authenticates hashed API keys from headers and bearer fallback", async () => {
    const apiKey = "cms_live_secret_123";
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      auth: {
        provider: "api-key",
        keys: [
          { id: "key_editor", name: "Editor key", hash: await hashApiKey(apiKey), userId: "api_editor", roles: ["editor"] },
          { id: "key_disabled", hash: await hashApiKey("disabled"), userId: "disabled", roles: ["admin"], enabled: false }
        ]
      },
      rbac: {
        rules: [
          { action: "create", collection: "articles", roles: ["editor"] },
          { action: "publish", collection: "articles", roles: ["editor"] }
        ]
      }
    });

    expect(await hashApiKey(apiKey)).not.toBe(apiKey);

    const invalid = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { "x-cms-api-key": "wrong", "content-type": "application/json" },
      body: JSON.stringify({ title: "Nope" })
    }));
    expect(invalid.status).toBe(403);

    const disabled = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { "x-cms-api-key": "disabled", "content-type": "application/json" },
      body: JSON.stringify({ title: "Nope" })
    }));
    expect(disabled.status).toBe(403);

    const created = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { "x-cms-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ title: "API Key Draft" })
    }));
    expect(created.status).toBe(201);
    const draft = await created.json() as { id: string; status: string };
    expect(draft.status).toBe("draft");

    const published = await app.fetch(new Request(`https://cms.test/api/articles/${draft.id}/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` }
    }));
    expect(published.status).toBe(200);
    await expect(published.json()).resolves.toMatchObject({ id: draft.id, status: "published" });

    const authInfo = await app.fetch(new Request("https://cms.test/api/auth/info"));
    await expect(authInfo.json()).resolves.toMatchObject({ provider: "api-key", headerName: "x-cms-api-key" });

    const login = await app.fetch(new Request("https://cms.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: apiKey })
    }));
    expect(login.status).toBe(200);
    await expect(login.json()).resolves.toMatchObject({
      ok: true,
      provider: "api-key",
      token: apiKey,
      user: { id: "api_editor", roles: ["editor"] }
    });

    const session = await app.fetch(new Request("https://cms.test/api/auth/session", {
      headers: { authorization: `Bearer ${apiKey}` }
    }));
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      ok: true,
      authenticated: true,
      user: { id: "api_editor", roles: ["editor"] }
    });
  });

  test("logs in with built-in static tokens for admin sessions", async () => {
    const app = cms();

    const invalid = await app.fetch(new Request("https://cms.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong" })
    }));
    expect(invalid.status).toBe(401);

    const login = await app.fetch(new Request("https://cms.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "admin" })
    }));
    expect(login.status).toBe(200);
    await expect(login.json()).resolves.toMatchObject({
      ok: true,
      provider: "static-token",
      token: "admin",
      user: { id: "1", roles: ["admin"] }
    });

    const session = await app.fetch(new Request("https://cms.test/api/auth/session", {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(session.json()).resolves.toMatchObject({
      ok: true,
      authenticated: true,
      user: { id: "1", roles: ["admin"] }
    });
  });

  test("mounts auth routes before the global session middleware", async () => {
    const sessionFromRequest = vi.fn(async () => ({ userId: "admin", roles: ["admin"] }));
    const handleAuth = vi.fn(async () => Response.json({ ok: true, provider: "instrumented" }));
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      auth: {
        provider: "instrumented",
        sessionFromRequest,
        handleAuth
      }
    });

    const authInfo = await app.fetch(new Request("https://cms.test/api/auth/info"));
    expect(authInfo.status).toBe(200);
    expect(handleAuth).toHaveBeenCalledTimes(1);
    expect(sessionFromRequest).not.toHaveBeenCalled();

    const schema = await app.fetch(new Request("https://cms.test/cms/schema"));
    expect(schema.status).toBe(200);
    expect(sessionFromRequest).toHaveBeenCalledTimes(1);
  });

  test("manages API keys and authenticates newly created secrets immediately", async () => {
    const adminSecret = "cms_live_admin_secret";
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      auth: {
        provider: "api-key",
        keys: [
          { id: "key_admin", name: "Admin key", hash: await hashApiKey(adminSecret), userId: "api_admin", roles: ["admin"] }
        ]
      },
      rbac: {
        rules: [
          { action: "create", collection: "articles", roles: ["editor"] },
          { action: "publish", collection: "articles", roles: ["editor"] }
        ]
      }
    });

    const createdKey = await app.fetch(new Request("https://cms.test/cms/settings/api-keys", {
      method: "POST",
      headers: { "x-cms-api-key": adminSecret, "content-type": "application/json" },
      body: JSON.stringify({ name: "Editorial automation", userId: "api_editor", roles: ["editor"] })
    }));
    expect(createdKey.status).toBe(201);
    const keyBody = await createdKey.json() as { id: string; secret: string; hash?: string; roles: string[]; enabled: boolean };
    expect(keyBody.secret).toMatch(/^cms_live_/);
    expect(keyBody.hash).toBeUndefined();
    expect(keyBody).toMatchObject({ roles: ["editor"], enabled: true });

    const createdArticle = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { "x-cms-api-key": keyBody.secret, "content-type": "application/json" },
      body: JSON.stringify({ title: "Managed API Key Draft" })
    }));
    expect(createdArticle.status).toBe(201);

    const listed = await app.fetch(new Request("https://cms.test/cms/settings/api-keys", {
      headers: { "x-cms-api-key": adminSecret }
    }));
    await expect(listed.json()).resolves.toMatchObject({ items: [expect.objectContaining({ id: "key_admin" }), expect.objectContaining({ id: keyBody.id, userId: "api_editor" })], meta: { total: 2 } });

    const disabled = await app.fetch(new Request(`https://cms.test/cms/settings/api-keys/${keyBody.id}`, {
      method: "PATCH",
      headers: { "x-cms-api-key": adminSecret, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    }));
    expect(disabled.status).toBe(200);

    const denied = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { "x-cms-api-key": keyBody.secret, "content-type": "application/json" },
      body: JSON.stringify({ title: "Disabled" })
    }));
    expect(denied.status).toBe(403);

    const deleted = await app.fetch(new Request(`https://cms.test/cms/settings/api-keys/${keyBody.id}`, {
      method: "DELETE",
      headers: { "x-cms-api-key": adminSecret }
    }));
    expect(deleted.status).toBe(204);
  });

  test("manages organization settings, members, and invitations", async () => {
    const organizationStore = new MemoryOrganizationStore({
      organization: { id: "org_1", name: "Editorial Studio", slug: "editorial", plan: "team" },
      members: [
        { id: "member_1", email: "owner@example.com", name: "Owner", role: "owner", status: "active" },
        { id: "member_2", email: "editor@example.com", role: "editor", status: "pending" }
      ],
      invitations: [
        { id: "invite_1", email: "reviewer@example.com", role: "reviewer", status: "pending" }
      ]
    });
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] }, editor: { userId: "2", roles: ["editor"] } } },
      organizationStore
    });

    const forbidden = await app.fetch(new Request("https://cms.test/cms/settings/organization", {
      headers: { authorization: "Bearer editor" }
    }));
    expect(forbidden.status).toBe(403);

    const organization = await app.fetch(new Request("https://cms.test/cms/settings/organization", {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(organization.json()).resolves.toMatchObject({ id: "org_1", name: "Editorial Studio", slug: "editorial" });

    const updatedOrganization = await app.fetch(new Request("https://cms.test/cms/settings/organization", {
      method: "PUT",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "News Desk", slug: "news-desk", plan: "enterprise" })
    }));
    expect(updatedOrganization.status).toBe(200);
    await expect(updatedOrganization.json()).resolves.toMatchObject({ name: "News Desk", slug: "news-desk", plan: "enterprise" });

    const members = await app.fetch(new Request("https://cms.test/cms/settings/organization/members", {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(members.json()).resolves.toMatchObject({ items: [expect.objectContaining({ id: "member_1" }), expect.objectContaining({ id: "member_2" })], meta: { total: 2 } });

    const updatedMember = await app.fetch(new Request("https://cms.test/cms/settings/organization/members/member_2", {
      method: "PATCH",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ role: "publisher", status: "active" })
    }));
    expect(updatedMember.status).toBe(200);
    await expect(updatedMember.json()).resolves.toMatchObject({ id: "member_2", role: "publisher", status: "active" });

    const invited = await app.fetch(new Request("https://cms.test/cms/settings/organization/invitations", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ email: "copy@example.com", role: "editor" })
    }));
    expect(invited.status).toBe(201);
    const invitation = await invited.json() as { id: string; email: string; status: string };
    expect(invitation).toMatchObject({ email: "copy@example.com", status: "pending" });

    const revoked = await app.fetch(new Request(`https://cms.test/cms/settings/organization/invitations/${invitation.id}/revoke`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    }));
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({ id: invitation.id, status: "revoked" });

    const removed = await app.fetch(new Request("https://cms.test/cms/settings/organization/members/member_2", {
      method: "DELETE",
      headers: { authorization: "Bearer admin" }
    }));
    expect(removed.status).toBe(204);

    const invalidInvite = await app.fetch(new Request("https://cms.test/cms/settings/organization/invitations", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ email: "not-email", role: "" })
    }));
    expect(invalidInvite.status).toBe(400);
  });

  test("uploads, lists, downloads, audits, and deletes media objects", async () => {
    const app = cms();
    const forbidden = await app.fetch(new Request("https://cms.test/api/media", {
      method: "POST",
      headers: { "content-type": "text/plain", "x-filename": "nope.txt" },
      body: "nope"
    }));
    expect(forbidden.status).toBe(403);

    const upload = await app.fetch(new Request("https://cms.test/api/media", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "text/plain", "x-filename": "hello world.txt", "x-request-id": "media_1" },
      body: "hello media"
    }));
    expect(upload.status).toBe(201);
    const media = await upload.json() as { id: string; key: string; filename: string; size: number; contentType: string };
    expect(media).toMatchObject({ filename: "hello world.txt", size: 11, contentType: "text/plain" });
    expect(media.key).toContain("hello-world.txt");

    const list = await app.fetch(new Request("https://cms.test/api/media", {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(list.json()).resolves.toMatchObject({ items: [{ id: media.id, filename: "hello world.txt" }] });

    const imageUpload = await app.fetch(new Request("https://cms.test/api/media", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "image/png", "x-filename": "Launch Diagram.png" },
      body: new Uint8Array([1, 2, 3, 4])
    }));
    expect(imageUpload.status).toBe(201);
    const image = await imageUpload.json() as { id: string; filename: string; contentType: string; createdAt: string };

    const filteredBySearch = await app.fetch(new Request("https://cms.test/api/media?q=launch", {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(filteredBySearch.json()).resolves.toMatchObject({ items: [{ id: image.id, filename: "Launch Diagram.png" }] });

    const filteredByType = await app.fetch(new Request("https://cms.test/api/media?type=image", {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(filteredByType.json()).resolves.toMatchObject({ items: [{ id: image.id, contentType: "image/png" }] });

    const createdAt = encodeURIComponent(image.createdAt);
    const filteredByDate = await app.fetch(new Request(`https://cms.test/api/media?from=${createdAt}&to=${createdAt}`, {
      headers: { authorization: "Bearer admin" }
    }));
    const filteredByDateBody = await filteredByDate.json() as { items: Array<{ id: string }> };
    expect(filteredByDateBody.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: image.id })]));

    const invalidMediaQuery = await app.fetch(new Request("https://cms.test/api/media?limit=0&from=nope", {
      headers: { authorization: "Bearer admin" }
    }));
    expect(invalidMediaQuery.status).toBe(422);

    const file = await app.fetch(new Request(`https://cms.test/api/media/${media.id}/file`, {
      headers: { authorization: "Bearer admin" }
    }));
    expect(file.headers.get("content-type")).toContain("text/plain");
    expect(await file.text()).toBe("hello media");

    const audit = await app.fetch(new Request("https://cms.test/cms/audit-log?collection=media", {
      headers: { authorization: "Bearer admin" }
    }));
    const auditBody = await audit.json() as { items: Array<{ operation: string; requestId: string }> };
    expect(auditBody.items).toEqual(expect.arrayContaining([expect.objectContaining({ operation: "media_upload", requestId: "media_1" })]));

    const deleted = await app.fetch(new Request(`https://cms.test/api/media/${media.id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer admin" }
    }));
    expect(deleted.status).toBe(204);

    const afterDelete = await app.fetch(new Request(`https://cms.test/api/media/${media.id}/file`, {
      headers: { authorization: "Bearer admin" }
    }));
    expect(afterDelete.status).toBe(404);
  });

  test("creates, lists, navigates, renames, moves, and deletes media folders", async () => {
    const app = cms();

    // List is empty initially.
    const initialList = await app.fetch(new Request("https://cms.test/api/media/folders", {
      headers: { authorization: "Bearer admin" }
    }));
    expect(initialList.status).toBe(200);
    await expect(initialList.json()).resolves.toEqual({ items: [] });

    // Create root folder.
    const createRoot = await app.fetch(new Request("https://cms.test/api/media/folders", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ name: "Brand" })
    }));
    expect(createRoot.status).toBe(201);
    const root = await createRoot.json() as { id: string; name: string; parentId: string | null; path: string };
    expect(root).toMatchObject({ name: "Brand", parentId: null, path: "/Brand" });

    // Create a nested folder.
    const createChild = await app.fetch(new Request("https://cms.test/api/media/folders", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ name: "Logos", parentId: root.id })
    }));
    expect(createChild.status).toBe(201);
    const child = await createChild.json() as { id: string; path: string };
    expect(child.path).toBe("/Brand/Logos");

    // Duplicate sibling name should be rejected.
    const conflict = await app.fetch(new Request("https://cms.test/api/media/folders", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ name: "Logos", parentId: root.id })
    }));
    expect(conflict.status).toBe(400);

    // Validation: missing name.
    const invalid = await app.fetch(new Request("https://cms.test/api/media/folders", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({})
    }));
    expect(invalid.status).toBe(422);

    // List should contain both folders.
    const list = await app.fetch(new Request("https://cms.test/api/media/folders", {
      headers: { authorization: "Bearer admin" }
    }));
    const listBody = await list.json() as { items: Array<{ id: string }> };
    expect(listBody.items.map((item) => item.id).sort()).toEqual([root.id, child.id].sort());

    // Upload asset into root folder.
    const uploadInRoot = await app.fetch(new Request(`https://cms.test/api/media?folderId=${root.id}`, {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "text/plain", "x-filename": "brand.txt" },
      body: "brand"
    }));
    expect(uploadInRoot.status).toBe(201);
    const asset = await uploadInRoot.json() as { id: string; folderId?: string | null };
    expect(asset.folderId).toBe(root.id);

    // Filter by folderId returns the asset.
    const inFolder = await app.fetch(new Request(`https://cms.test/api/media?folderId=${root.id}`, {
      headers: { authorization: "Bearer admin" }
    }));
    const inFolderBody = await inFolder.json() as { items: Array<{ id: string }> };
    expect(inFolderBody.items.map((item) => item.id)).toEqual([asset.id]);

    // Filtering for root-only (folderId=null) excludes the foldered asset.
    const rootOnly = await app.fetch(new Request("https://cms.test/api/media?folderId=null", {
      headers: { authorization: "Bearer admin" }
    }));
    const rootOnlyBody = await rootOnly.json() as { items: Array<{ id: string }> };
    expect(rootOnlyBody.items.find((item) => item.id === asset.id)).toBeUndefined();

    // Rename child folder via PATCH.
    const renamed = await app.fetch(new Request(`https://cms.test/api/media/folders/${child.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ name: "Wordmarks" })
    }));
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({ id: child.id, name: "Wordmarks", path: "/Brand/Wordmarks" });

    // Move child to root.
    const moved = await app.fetch(new Request(`https://cms.test/api/media/folders/${child.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ parentId: null })
    }));
    expect(moved.status).toBe(200);
    await expect(moved.json()).resolves.toMatchObject({ id: child.id, parentId: null, path: "/Wordmarks" });

    // Delete non-empty root without force → 409.
    const blocked = await app.fetch(new Request(`https://cms.test/api/media/folders/${root.id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer admin" }
    }));
    expect(blocked.status).toBe(409);

    // Force delete cascades and detaches the asset.
    const forced = await app.fetch(new Request(`https://cms.test/api/media/folders/${root.id}?force=true`, {
      method: "DELETE",
      headers: { authorization: "Bearer admin" }
    }));
    expect(forced.status).toBe(204);

    // Asset should now be root-level (folderId null).
    const detached = await app.fetch(new Request(`https://cms.test/api/media/${asset.id}`, {
      headers: { authorization: "Bearer admin" }
    }));
    const detachedBody = await detached.json() as { folderId: string | null };
    expect(detachedBody.folderId).toBeNull();

    // Deleting an empty folder (the moved Wordmarks) succeeds without force.
    const cleaned = await app.fetch(new Request(`https://cms.test/api/media/folders/${child.id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer admin" }
    }));
    expect(cleaned.status).toBe(204);

    // Unknown id → 404.
    const missing = await app.fetch(new Request("https://cms.test/api/media/folders/does-not-exist", {
      method: "DELETE",
      headers: { authorization: "Bearer admin" }
    }));
    expect(missing.status).toBe(404);
  });

  test("prevents deleting media objects that are still referenced by content", async () => {
    const mediaCollections = defineSchema({
      articles: defineCollection("articles", {
        title: fields.string({ required: true }),
        heroImage: fields.media(),
        gallery: fields.media({ multiple: true })
      })
    });
    const app = createCMS({
      collections: mediaCollections,
      db: createMemoryDatabase({ provider: "memory", collections: mediaCollections }),
      storage: { provider: "memory" },
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } }
    });

    const upload = await app.fetch(new Request("https://cms.test/api/media", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "image/png", "x-filename": "hero.png" },
      body: new Uint8Array([1, 2, 3])
    }));
    expect(upload.status).toBe(201);
    const media = await upload.json() as { id: string };

    const article = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Referenced media", heroImage: media.id, gallery: [media.id] })
    }));
    expect(article.status).toBe(201);
    const articleBody = await article.json() as { id: string };

    const deleted = await app.fetch(new Request(`https://cms.test/api/media/${media.id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer admin" }
    }));
    expect(deleted.status).toBe(409);
    await expect(deleted.json()).resolves.toMatchObject({
      error: "media_in_use",
      references: expect.arrayContaining([
        { collection: "articles", field: "heroImage", id: articleBody.id },
        { collection: "articles", field: "gallery", id: articleBody.id }
      ])
    });

    const metadata = await app.fetch(new Request(`https://cms.test/api/media/${media.id}`, {
      headers: { authorization: "Bearer admin" }
    }));
    expect(metadata.status).toBe(200);
    const file = await app.fetch(new Request(`https://cms.test/api/media/${media.id}/file`, {
      headers: { authorization: "Bearer admin" }
    }));
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("can reuse a media store across CMS instances for persistent metadata", async () => {
    const mediaStore = new MemoryMediaStore();
    const first = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      storage: { provider: "memory" },
      mediaStore,
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } }
    });
    const upload = await first.fetch(new Request("https://cms.test/api/media", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "text/plain", "x-filename": "shared.txt" },
      body: "shared media"
    }));
    expect(upload.status).toBe(201);
    const media = await upload.json() as { id: string; filename: string };

    const second = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      storage: { provider: "memory" },
      mediaStore,
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } }
    });
    const listed = await second.fetch(new Request("https://cms.test/api/media?limit=1", {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(listed.json()).resolves.toMatchObject({ items: [{ id: media.id, filename: "shared.txt" }] });

    const fetched = await second.fetch(new Request(`https://cms.test/api/media/${media.id}`, {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(fetched.json()).resolves.toMatchObject({ id: media.id, filename: "shared.txt" });
  });

  test("rejects active content media by default and allows explicit opt-in", async () => {
    const app = cms();
    const directSvg = await app.fetch(new Request("https://cms.test/api/media", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "image/svg+xml; charset=utf-8", "x-filename": "icon.svg" },
      body: `<svg xmlns="http://www.w3.org/2000/svg"><script>alert("x")</script></svg>`
    }));
    expect(directSvg.status).toBe(400);
    await expect(directSvg.json()).resolves.toMatchObject({ error: "upload_failed", message: "active_content_not_allowed" });

    const presignedHtml = await app.fetch(new Request("https://cms.test/api/media/presign", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ filename: "preview.html", contentType: "text/html", size: 42 })
    }));
    expect(presignedHtml.status).toBe(400);
    await expect(presignedHtml.json()).resolves.toMatchObject({ error: "presign_failed", message: "active_content_not_allowed" });

    const optedIn = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      storage: { provider: "memory" },
      auth: { tokens: { editor: { userId: "2", roles: ["editor"] } } },
      media: { allowActiveContent: true }
    });
    const allowedSvg = await optedIn.fetch(new Request("https://cms.test/api/media", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "image/svg+xml", "x-filename": "trusted.svg" },
      body: "<svg />"
    }));
    expect(allowedSvg.status).toBe(201);
    await expect(allowedSvg.json()).resolves.toMatchObject({ filename: "trusted.svg", contentType: "image/svg+xml" });
  });

  test("presigns and confirms direct media uploads with replay protection", async () => {
    const storage = createMemoryStorage({ provider: "memory" });
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      storage,
      cache: { provider: "memory" },
      auth: {
        tokens: {
          admin: { userId: "1", roles: ["admin"] },
          editor: { userId: "2", roles: ["editor"] }
        }
      }
    });
    const forbidden = await app.fetch(new Request("https://cms.test/api/media/presign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "large.txt", contentType: "text/plain", size: 512 })
    }));
    expect(forbidden.status).toBe(403);

    const presignResponse = await app.fetch(new Request("https://cms.test/api/media/presign", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ filename: "large file.txt", contentType: "text/plain", size: 512 })
    }));
    expect(presignResponse.status).toBe(200);
    const presign = await presignResponse.json() as { uploadId: string; uploadUrl: string; key: string; method: string; headers: Record<string, string>; expiresAt: string };
    expect(presign).toMatchObject({ method: "PUT", headers: { "content-type": "text/plain" } });
    expect(presign.key).toContain("large-file.txt");
    expect(presign.uploadUrl).toContain(encodeURIComponent(presign.key));
    expect(Date.parse(presign.expiresAt)).toBeGreaterThan(Date.now());

    const mismatch = await app.fetch(new Request("https://cms.test/api/media/confirm", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ ...presign, key: "media/other.txt", filename: "large file.txt", contentType: "text/plain", size: 512 })
    }));
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toMatchObject({ error: "presign_session_mismatch" });

    const missingObject = await app.fetch(new Request("https://cms.test/api/media/confirm", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ uploadId: presign.uploadId, key: presign.key, filename: "large file.txt", contentType: "text/plain", size: 512 })
    }));
    expect(missingObject.status).toBe(400);
    await expect(missingObject.json()).resolves.toMatchObject({ error: "media_object_not_found" });

    await storage.put(presign.key, new Uint8Array(511), { contentType: "text/plain" });
    const wrongSize = await app.fetch(new Request("https://cms.test/api/media/confirm", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ uploadId: presign.uploadId, key: presign.key, filename: "large file.txt", contentType: "text/plain", size: 512 })
    }));
    expect(wrongSize.status).toBe(400);
    await expect(wrongSize.json()).resolves.toMatchObject({ error: "media_object_size_mismatch" });

    await storage.put(presign.key, new Uint8Array(512), { contentType: "application/json" });
    const wrongContentType = await app.fetch(new Request("https://cms.test/api/media/confirm", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ uploadId: presign.uploadId, key: presign.key, filename: "large file.txt", contentType: "text/plain", size: 512 })
    }));
    expect(wrongContentType.status).toBe(400);
    await expect(wrongContentType.json()).resolves.toMatchObject({ error: "media_object_content_type_mismatch" });

    await storage.put(presign.key, new Uint8Array(512), { contentType: "text/plain", metadata: { filename: "large file.txt" } });

    const confirmResponse = await app.fetch(new Request("https://cms.test/api/media/confirm", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json", "x-request-id": "media_direct_1" },
      body: JSON.stringify({ uploadId: presign.uploadId, key: presign.key, filename: "large file.txt", contentType: "text/plain", size: 512, metadata: { alt: "Large file" } })
    }));
    expect(confirmResponse.status).toBe(201);
    const media = await confirmResponse.json() as { id: string; key: string; filename: string; size: number; contentType: string; metadata: Record<string, string> };
    expect(media).toMatchObject({ key: presign.key, filename: "large file.txt", size: 512, contentType: "text/plain", metadata: { alt: "Large file" } });

    const replay = await app.fetch(new Request("https://cms.test/api/media/confirm", {
      method: "POST",
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      body: JSON.stringify({ uploadId: presign.uploadId, key: presign.key, filename: "large file.txt", contentType: "text/plain", size: 512 })
    }));
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: "presign_session_not_found" });

    const list = await app.fetch(new Request("https://cms.test/api/media", {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(list.json()).resolves.toMatchObject({ items: [{ id: media.id, key: presign.key }] });
  });

  test("serves OpenAPI and dispatches webhooks", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true },
      webhooks: [{ url: "https://hooks.test/cms", secret: "secret", events: ["content.created"] }]
    });

    const spec = await app.fetch(new Request("https://cms.test/cms/openapi.json"));
    expect(spec.headers.get("etag")).toMatch(/^".+"$/);
    expect(spec.headers.get("cache-control")).toBe("no-store");
    expect(spec.headers.get("access-control-allow-origin")).toBe("*");
    expect(spec.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    const preflight = await app.fetch(new Request("https://cms.test/cms/openapi.json", {
      method: "OPTIONS",
      headers: {
        origin: "https://tools.test",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,if-none-match"
      }
    }));
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("authorization, content-type, if-none-match");
    const cachedSpec = await app.fetch(new Request("https://cms.test/cms/openapi.json", {
      headers: { "if-none-match": spec.headers.get("etag") ?? "" }
    }));
    expect(cachedSpec.status).toBe(304);
    const specBody = await spec.json() as {
      info: { title: string; version: string; description?: string; "x-cms-filter-syntax"?: unknown };
      servers?: Array<{ url: string; description?: string }>;
      components: { schemas: Record<string, unknown> };
      paths: Record<string, Record<string, { operationId?: string; requestBody?: unknown; responses?: Record<string, unknown> }>>;
    };
    expect(findDanglingOpenAPIRefs(specBody)).toEqual([]);
    expect(specBody.info).toMatchObject({
      title: "Hono CMS API",
      version: "0.1.0",
      description: expect.stringContaining("Headless CMS API"),
      "x-cms-filter-syntax": {
        style: "qs",
        examples: {
          simple: "filters[title][$contains]=cms",
          nested: "filters[author][name][$startsWith]=Ada",
          multiValue: "filters[status][$in][]=draft&filters[status][$in][]=published"
        }
      }
    });
    expect(specBody.servers).toEqual([{ url: "/" }]);
    const authLoginPath = specBody.paths["/api/auth/login"] as { post?: { operationId?: string; requestBody?: unknown; responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> } };
    const authSessionPath = specBody.paths["/api/auth/session"] as { get?: { operationId?: string; security?: unknown; responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> } };
    const authActionPath = specBody.paths["/api/auth/{action}"] as { get?: { parameters?: unknown[]; responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }; post?: { requestBody?: unknown; parameters?: unknown[] } };
    const translatePath = specBody.paths["/api/pages/{id}/translate"] as { post?: { requestBody?: unknown; operationId?: string } };
    const localesPath = specBody.paths["/api/pages/{id}/locales"] as { get?: { operationId?: string } };
    const localeVariantPath = specBody.paths["/api/pages/{id}/locales/{locale}"] as { patch?: { requestBody?: unknown; operationId?: string }; put?: { requestBody?: unknown; operationId?: string } };
    const articlesListPath = specBody.paths["/api/articles"] as { get?: { parameters?: Array<Record<string, unknown>> } };
    const pagesListPath = specBody.paths["/api/pages"] as { get?: { parameters?: Array<Record<string, unknown>> } };
    const pageDetailPath = specBody.paths["/api/pages/{id}"] as { get?: { parameters?: Array<Record<string, unknown>> } };
    const auditPath = specBody.paths["/cms/audit-log"] as { get?: { parameters?: unknown[]; responses?: Record<string, { content?: Record<string, unknown> }> } };
    const livenessPath = specBody.paths["/cms/health/live"] as { get?: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> } };
    const webhooksPath = specBody.paths["/cms/settings/webhooks"] as { get?: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }; post?: { requestBody?: unknown } };
    const webhookPath = specBody.paths["/cms/settings/webhooks/{id}"] as { patch?: { requestBody?: unknown }; put?: { requestBody?: unknown } };
    const deliveriesPath = specBody.paths["/cms/settings/webhooks/{id}/deliveries"] as { get?: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> } };
    const publicGraphQLPath = specBody.paths["/graphql"] as { get?: { operationId?: string; parameters?: unknown[] }; post?: { operationId?: string; requestBody?: unknown; responses?: unknown } };
    const publicGraphQLSchemaPath = specBody.paths["/graphql/schema"] as { get?: { responses?: Record<string, { content?: Record<string, unknown> }> } };
    const legacyGraphQLPath = specBody.paths["/cms/graphql"] as { get?: { operationId?: string; parameters?: unknown[] }; post?: { operationId?: string; requestBody?: unknown; responses?: unknown } };
    const contentTypesCapabilitiesPath = specBody.paths["/cms/content-types/capabilities"] as { get?: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> } };
    const contentTypesPath = specBody.paths["/cms/content-types"] as { get?: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }; post?: { requestBody?: unknown; responses?: Record<string, unknown> } };
    const contentTypePath = specBody.paths["/cms/content-types/{name}"] as { put?: { requestBody?: unknown; parameters?: unknown[]; responses?: Record<string, unknown> } };
    const apiKeysPath = specBody.paths["/cms/settings/api-keys"] as { get?: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }; post?: { requestBody?: unknown } };
    const apiKeyPath = specBody.paths["/cms/settings/api-keys/{id}"] as { patch?: { requestBody?: unknown }; delete?: { responses?: Record<string, unknown> } };
    const organizationPath = specBody.paths["/cms/settings/organization"] as { get?: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }; put?: { requestBody?: unknown } };
    const organizationMembersPath = specBody.paths["/cms/settings/organization/members"] as { get?: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> } };
    const organizationMemberPath = specBody.paths["/cms/settings/organization/members/{id}"] as { patch?: { requestBody?: unknown }; delete?: { responses?: Record<string, unknown> } };
    const organizationInvitationsPath = specBody.paths["/cms/settings/organization/invitations"] as { get?: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }; post?: { requestBody?: unknown } };
    const organizationInvitationRevokePath = specBody.paths["/cms/settings/organization/invitations/{id}/revoke"] as { post?: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> } };
    const operationIds = Object.values(specBody.paths).flatMap((path) => Object.values(path).map((operation) => operation.operationId).filter(Boolean));
    const articleSchema = specBody.components.schemas.Articles as { properties: Record<string, unknown> };
    const schemaMetadataSchema = specBody.components.schemas.SchemaMetadata as { properties: Record<string, { additionalProperties?: unknown }> };
    const schemaCollectionSchema = specBody.components.schemas.SchemaCollectionMetadata as { required: string[]; properties: Record<string, { additionalProperties?: unknown }> };
    const schemaFieldSchema = specBody.components.schemas.SchemaFieldMetadata as { required: string[]; properties: Record<string, unknown> };
    const healthReportSchema = specBody.components.schemas.HealthReport as { required: string[]; properties: Record<string, unknown> };
    const healthCheckSchema = specBody.components.schemas.HealthCheck as { required: string[]; properties: Record<string, unknown> };
    const auditEntrySchema = specBody.components.schemas.AuditEntry as { required: string[]; properties: Record<string, unknown> };
    const webhookInputSchema = specBody.components.schemas.WebhookInput as { required: string[] };
    const webhookListItemSchema = specBody.components.schemas.WebhookListItem as { required: string[]; properties: Record<string, unknown> };
    const webhookDeliverySchema = specBody.components.schemas.WebhookDelivery as { required: string[]; properties: Record<string, unknown> };
    const authUserSchema = specBody.components.schemas.AuthUser as { required: string[]; properties: Record<string, unknown> };
    const authLoginRequestSchema = specBody.components.schemas.AuthLoginRequest as { properties: Record<string, unknown> };
    const authLoginResponseSchema = specBody.components.schemas.AuthLoginResponse as { required: string[]; properties: Record<string, unknown> };
    const authSessionResponseSchema = specBody.components.schemas.AuthSessionResponse as { required: string[]; properties: Record<string, unknown> };
    const apiKeyInputSchema = specBody.components.schemas.ApiKeyInput as { required: string[] };
    const apiKeyCreateResponseSchema = specBody.components.schemas.ApiKeyCreateResponse as { required: string[]; properties: Record<string, unknown> };
    const organizationInputSchema = specBody.components.schemas.OrganizationInput as { required: string[] };
    const organizationMemberSchema = specBody.components.schemas.OrganizationMember as { required: string[]; properties: Record<string, unknown> };
    const organizationInvitationSchema = specBody.components.schemas.OrganizationInvitation as { required: string[]; properties: Record<string, unknown> };
    const mediaPresignRequestSchema = specBody.components.schemas.MediaPresignRequest as { required: string[]; properties: Record<string, unknown>; oneOf: Array<{ required: string[] }> };
    const mediaConfirmRequestSchema = specBody.components.schemas.MediaConfirmRequest as { required: string[]; properties: Record<string, unknown>; oneOf: Array<{ required: string[] }> };
    const schemaCollectionOptionsSchema = specBody.components.schemas.SchemaCollectionOptions as { properties: Record<string, unknown> };
    const contentTypeCapabilitiesSchema = specBody.components.schemas.ContentTypeCapabilities as { required: string[]; properties: Record<string, unknown> };
    const contentTypeInputSchema = specBody.components.schemas.ContentTypeInput as { required: string[]; properties: Record<string, unknown> };
    const contentTypeWriteResponseSchema = specBody.components.schemas.ContentTypeWriteResponse as { required: string[]; properties: Record<string, unknown> };
    const populateParameter = articlesListPath.get?.parameters?.find((parameter) => parameter.name === "populate");
    const filtersParameter = articlesListPath.get?.parameters?.find((parameter) => parameter.name === "filters");
    const paginationParameter = articlesListPath.get?.parameters?.find((parameter) => parameter.name === "pagination");
    const cursorParameter = articlesListPath.get?.parameters?.find((parameter) => parameter.name === "cursor");
    const sortParameter = articlesListPath.get?.parameters?.find((parameter) => parameter.name === "sort");
    const pageListLocaleParameter = pagesListPath.get?.parameters?.find((parameter) => parameter.name === "locale");
    const pageListFallbackParameter = pagesListPath.get?.parameters?.find((parameter) => parameter.name === "fallback");
    const pageDetailLocaleParameter = pageDetailPath.get?.parameters?.find((parameter) => parameter.name === "locale");
    const pageDetailFallbackParameter = pageDetailPath.get?.parameters?.find((parameter) => parameter.name === "fallback");
    expect(articleSchema.properties.author).toMatchObject({ oneOf: [{ type: "string" }, { $ref: "#/components/schemas/Authors" }] });
    expect(schemaMetadataSchema.properties.collections).toMatchObject({ additionalProperties: { $ref: "#/components/schemas/SchemaCollectionMetadata" } });
    expect(schemaCollectionSchema).toMatchObject({
      required: ["name", "fields", "options"],
      properties: {
        fields: { additionalProperties: { $ref: "#/components/schemas/SchemaFieldMetadata" } },
        options: { $ref: "#/components/schemas/SchemaCollectionOptions" }
      }
    });
    expect(schemaFieldSchema).toMatchObject({
      required: ["kind", "required", "unique", "localized", "private"],
      properties: {
        kind: { enum: ["string", "text", "richtext", "number", "boolean", "datetime", "date", "time", "json", "email", "url", "password", "uid", "enum", "media", "relation"] },
        cardinality: { enum: ["one", "many", "one-to-one", "many-to-one", "one-to-many", "many-to-many"] },
        onDelete: { enum: ["cascade", "restrict", "set_null"] },
        values: { type: "array", items: { type: "string" } },
        multiple: { type: "boolean" },
        permissions: {
          properties: {
            read: { type: "array", items: { type: "string" } },
            write: { type: "array", items: { type: "string" } }
          }
        }
      }
    });
    expect(schemaCollectionOptionsSchema).toMatchObject({
      properties: {
        draftAndPublish: { type: "boolean" },
        timestamps: { type: "boolean" },
        i18n: { $ref: "#/components/schemas/SchemaI18nOptions" },
        rbac: { additionalProperties: { type: "array", items: { type: "string" } } }
      }
    });
    expect(livenessPath.get?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/LivenessReport" });
    expect(healthReportSchema).toMatchObject({
      required: ["status", "version", "uptime_seconds", "checks"],
      properties: {
        checks: { additionalProperties: { $ref: "#/components/schemas/HealthCheck" } }
      }
    });
    expect(healthCheckSchema).toMatchObject({
      required: ["status"],
      properties: {
        status: { enum: ["ok", "error"] },
        details: { type: "object", additionalProperties: true }
      }
    });
    expect(filtersParameter).toMatchObject({
      style: "deepObject",
      explode: true,
      "x-cms-filter-fields": ["author", "body", "title"],
      "x-cms-filter-operators": ["$eq", "$ne", "$contains", "$notContains", "$startsWith", "$endsWith", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$null", "$notNull", "$between"]
    });
    expect(paginationParameter).toMatchObject({
      style: "deepObject",
      explode: true,
      description: expect.stringContaining("opaque base64url"),
      schema: {
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: { type: "string" },
          page: { type: "integer", minimum: 1 },
          pageSize: { type: "integer", minimum: 1, maximum: 100 }
        }
      },
      "x-cms-query-syntax": [
        expect.stringContaining("pagination[cursor]=eyJpZCI6"),
        "pagination[page]=2&pagination[pageSize]=25"
      ]
    });
    expect(cursorParameter).toMatchObject({
      description: expect.stringContaining("Opaque base64url cursor"),
      schema: {
        type: "string",
        examples: [expect.stringContaining("eyJpZCI6")]
      }
    });
    expect(sortParameter).toMatchObject({
      style: "form",
      explode: false,
      description: expect.stringContaining("field:asc"),
      schema: {
        type: "string",
        examples: ["createdAt:desc", "title:asc", "-updatedAt"]
      },
      "x-cms-sort-fields": ["author", "body", "createdAt", "id", "publishedAt", "status", "title", "updatedAt"],
      "x-cms-sort-directions": ["asc", "desc"],
      "x-cms-sort-examples": ["author:asc", "author:desc", "-author"]
    });
    expect(pageListLocaleParameter).toMatchObject({
      description: expect.stringContaining("Defaults to en"),
      schema: { type: "string", enum: ["en", "es", "es-MX"], default: "en" }
    });
    expect(pageDetailLocaleParameter).toEqual(pageListLocaleParameter);
    expect(pageListFallbackParameter).toMatchObject({
      description: expect.stringContaining("fallback=false"),
      schema: { type: "boolean", default: true },
      "x-cms-query-syntax": ["fallback=false", "locale=es-MX&fallback=false"]
    });
    expect(pageDetailFallbackParameter).toEqual(pageListFallbackParameter);
    expect(populateParameter).toMatchObject({
      style: "deepObject",
      explode: true,
      description: expect.stringContaining("populate[author][fields][0]=name"),
      schema: {
        oneOf: [
          { type: "string", enum: ["*", "author"] },
          { type: "array", items: { type: "string", enum: ["*", "author"] }, uniqueItems: true },
          {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                fields: { type: "array", items: { type: "string" } },
                populate: { type: "object", additionalProperties: true }
              },
              additionalProperties: true
            }
          }
        ]
      },
      "x-cms-relations": ["author"],
      "x-cms-query-syntax": ["populate=author", "populate[0]=author", "populate[author][fields][0]=name"]
    });
    expect(auditPath.get?.responses?.["200"]?.content).toMatchObject({
      "application/json": expect.any(Object),
      "text/csv": { schema: { type: "string" } }
    });
    expect(auditPath.get?.responses?.["422"]).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });
    expect(auditPath.get?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "from", schema: { type: "string", format: "date-time" } }),
      expect.objectContaining({ name: "to", schema: { type: "string", format: "date-time" } })
    ]));
    expect(auditEntrySchema.required).toEqual(expect.arrayContaining(["actorRoles", "diff"]));
    expect(auditEntrySchema.properties.operation).toMatchObject({ enum: ["create", "update", "delete", "publish", "unpublish", "media_upload", "media_delete", "schema_change"] });
    expect(webhooksPath.get?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/WebhookListResponse" });
    expect(webhooksPath.post?.requestBody).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookInput" } } } });
    expect(webhookPath.patch?.requestBody).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookUpdateInput" } } } });
    expect(webhookPath.put?.requestBody).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookInput" } } } });
    expect(deliveriesPath.get?.responses?.["200"]?.content?.["application/json"]?.schema).toMatchObject({
      allOf: expect.arrayContaining([expect.objectContaining({ $ref: "#/components/schemas/PaginatedResponse" })])
    });
    expect(webhookInputSchema.required).toEqual(expect.arrayContaining(["name", "url", "events"]));
    expect(webhookListItemSchema.required).toEqual(expect.arrayContaining(["hasSecret", "lastDeliveryAt", "lastDeliveryStatus"]));
    expect(webhookListItemSchema.properties.lastDeliveryStatus).toMatchObject({ enum: ["pending", "success", "retrying", "failed", null] });
    expect(webhookDeliverySchema.required).toEqual(expect.arrayContaining(["eventType", "url", "attempt", "requestBody"]));
    expect(webhookDeliverySchema.properties.webhookId).toMatchObject({ type: ["string", "null"] });
    expect(webhookDeliverySchema.properties.status).toMatchObject({ enum: ["pending", "success", "retrying", "failed"] });
    expect(authLoginPath.post?.requestBody).toMatchObject({
      content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/AuthLoginRequest" }] } } }
    });
    expect(authLoginPath.post?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/AuthLoginResponse" });
    expect(authSessionPath.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(authSessionPath.get?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/AuthSessionResponse" });
    expect(authActionPath.get?.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: "action", in: "path" })]));
    expect(authActionPath.post?.requestBody).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/AuthLoginRequest" } } } });
    expect(authUserSchema).toMatchObject({ required: ["id", "roles"], properties: { roles: { type: "array", items: { type: "string" } } } });
    expect(authLoginRequestSchema.properties).toMatchObject({ token: { type: "string" }, apiKey: { type: "string" }, key: { type: "string" } });
    expect(authLoginResponseSchema.required).toEqual(["ok", "provider", "token", "user"]);
    expect(authLoginResponseSchema.properties.provider).toMatchObject({ enum: ["static-token", "api-key"] });
    expect(authSessionResponseSchema.required).toEqual(["ok", "authenticated", "user"]);
    expect(publicGraphQLPath.get?.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: "query", in: "query" })]));
    expect(publicGraphQLPath.post?.requestBody).toMatchObject({ content: { "application/json": { schema: expect.objectContaining({ required: ["query"] }) } } });
    expect(publicGraphQLSchemaPath.get?.responses?.["200"]?.content).toMatchObject({ "text/plain": { schema: { type: "string" } } });
    expect(legacyGraphQLPath.post?.requestBody).toEqual(publicGraphQLPath.post?.requestBody);
    expect(legacyGraphQLPath.post?.responses).toEqual(publicGraphQLPath.post?.responses);
    expect(legacyGraphQLPath.post?.operationId).not.toBe(publicGraphQLPath.post?.operationId);
    expect(apiKeysPath.get?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/ApiKeyListResponse" });
    expect(apiKeysPath.post?.requestBody).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/ApiKeyInput" } } } });
    expect(apiKeyPath.patch?.requestBody).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/ApiKeyUpdateInput" } } } });
    expect(apiKeyPath.delete?.responses?.["204"]).toMatchObject({ description: "API key deleted" });
    expect(apiKeyInputSchema.required).toEqual(expect.arrayContaining(["userId", "roles"]));
    expect(apiKeyCreateResponseSchema.required).toEqual(expect.arrayContaining(["secret"]));
    expect(apiKeyCreateResponseSchema.properties).not.toHaveProperty("hash");
    expect(organizationPath.get?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/Organization" });
    expect(organizationPath.put?.requestBody).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/OrganizationInput" } } } });
    expect(organizationMembersPath.get?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/OrganizationMemberListResponse" });
    expect(organizationMemberPath.patch?.requestBody).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/OrganizationMemberInput" } } } });
    expect(organizationMemberPath.delete?.responses?.["204"]).toMatchObject({ description: "Organization member removed" });
    expect(organizationInvitationsPath.get?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/OrganizationInvitationListResponse" });
    expect(organizationInvitationsPath.post?.requestBody).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/OrganizationInvitationInput" } } } });
    expect(organizationInvitationRevokePath.post?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/OrganizationInvitation" });
    expect(organizationInputSchema.required).toEqual(expect.arrayContaining(["name", "slug"]));
    expect(organizationMemberSchema.properties.status).toMatchObject({ enum: ["active", "pending", "disabled"] });
    expect(organizationInvitationSchema.properties.status).toMatchObject({ enum: ["pending", "accepted", "revoked", "expired"] });
    expect(mediaPresignRequestSchema.required).toEqual(expect.arrayContaining(["filename", "size"]));
    expect(mediaPresignRequestSchema.required).not.toContain("contentType");
    expect(mediaPresignRequestSchema.properties.contentType).toMatchObject({ type: "string" });
    expect(mediaPresignRequestSchema.properties.mimeType).toMatchObject({ type: "string" });
    expect(mediaPresignRequestSchema.oneOf).toEqual(expect.arrayContaining([
      { required: ["contentType"] },
      { required: ["mimeType"] }
    ]));
    expect(mediaConfirmRequestSchema.required).toEqual(expect.arrayContaining(["uploadId", "key", "filename", "size"]));
    expect(mediaConfirmRequestSchema.required).not.toContain("contentType");
    expect(mediaConfirmRequestSchema.properties.contentType).toMatchObject({ type: "string" });
    expect(mediaConfirmRequestSchema.properties.mimeType).toMatchObject({ type: "string" });
    expect(mediaConfirmRequestSchema.oneOf).toEqual(expect.arrayContaining([
      { required: ["contentType"] },
      { required: ["mimeType"] }
    ]));
    expect(contentTypesCapabilitiesPath.get?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/ContentTypeCapabilities" });
    expect(contentTypesPath.get?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/ContentTypeListResponse" });
    expect(contentTypesPath.post?.requestBody).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/ContentTypeInput" } } } });
    expect(contentTypesPath.post?.responses?.["201"]).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/ContentTypeWriteResponse" } } } });
    expect(contentTypePath.put?.requestBody).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/ContentTypeInput" } } } });
    expect(contentTypePath.put?.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: "name", in: "path" })]));
    expect(contentTypeCapabilitiesSchema).toMatchObject({
      required: ["writable", "mode"],
      properties: { mode: { enum: ["development", "read-only"] } }
    });
    expect(contentTypeInputSchema).toMatchObject({
      required: ["name", "fields"],
      properties: {
        fields: { additionalProperties: { $ref: "#/components/schemas/SchemaFieldMetadata" } },
        options: { $ref: "#/components/schemas/SchemaCollectionOptions" }
      }
    });
    expect(contentTypeWriteResponseSchema).toMatchObject({
      required: ["collection"],
      properties: {
        artifacts: { type: "array", items: { type: "string" } },
        migrations: { type: "array", items: { type: "string" } },
        message: { type: "string" }
      }
    });
    expect(specBody).toMatchObject({
      openapi: "3.1.0",
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
        schemas: {
          Articles: expect.any(Object),
          ArticlesCreateInput: expect.any(Object),
          ArticlesUpdateInput: expect.any(Object),
          AuthUser: expect.any(Object),
          AuthLoginRequest: expect.any(Object),
          AuthLoginResponse: expect.any(Object),
          AuthSessionResponse: expect.any(Object),
          AuthProviderResponse: expect.any(Object),
          PreviewTokenRequest: expect.any(Object),
          ScheduleRequest: expect.any(Object),
          LivenessReport: expect.any(Object),
          HealthCheck: expect.any(Object),
          HealthReport: expect.any(Object),
          SchemaFieldMetadata: expect.any(Object),
          SchemaI18nOptions: expect.any(Object),
          SchemaCollectionOptions: expect.any(Object),
          SchemaCollectionMetadata: expect.any(Object),
          SchemaMetadata: expect.any(Object),
          ContentTypeCapabilities: expect.any(Object),
          ContentTypeListResponse: expect.any(Object),
          ContentTypeInput: expect.any(Object),
          ContentTypeWriteResponse: expect.any(Object),
          AuditEntry: expect.any(Object),
          Webhook: expect.any(Object),
          WebhookInput: expect.any(Object),
          WebhookUpdateInput: expect.any(Object),
          WebhookListItem: expect.any(Object),
          WebhookListResponse: expect.any(Object),
          WebhookDelivery: expect.any(Object),
          ApiKey: expect.any(Object),
          ApiKeyInput: expect.any(Object),
          ApiKeyUpdateInput: expect.any(Object),
          ApiKeyCreateResponse: expect.any(Object),
          ApiKeyListResponse: expect.any(Object),
          Organization: expect.any(Object),
          OrganizationInput: expect.any(Object),
          OrganizationMember: expect.any(Object),
          OrganizationMemberInput: expect.any(Object),
          OrganizationMemberListResponse: expect.any(Object),
          OrganizationInvitation: expect.any(Object),
          OrganizationInvitationInput: expect.any(Object),
          OrganizationInvitationListResponse: expect.any(Object),
          Media: expect.any(Object),
          MediaPresignRequest: expect.any(Object),
          MediaPresign: expect.any(Object),
          MediaConfirmRequest: expect.any(Object),
          TranslateRequest: expect.any(Object),
          LocaleReviewRequest: expect.any(Object),
          LocaleVariantUpdateRequest: expect.any(Object),
          I18nBackfillRequest: expect.any(Object),
          I18nBackfillCollectionResult: expect.any(Object),
          I18nBackfillResponse: expect.any(Object),
          I18nBackfillStatus: expect.any(Object),
          LocaleState: expect.any(Object),
          LocaleStatus: expect.any(Object),
          TranslationVariant: expect.any(Object)
        }
      },
      paths: {
        "/api/auth/login": expect.any(Object),
        "/api/auth/session": expect.any(Object),
        "/api/auth/{action}": expect.any(Object),
        "/cms/health/live": expect.any(Object),
        "/cms/health": expect.any(Object),
        "/cms/health/ready": expect.any(Object),
        "/cms/schema": expect.any(Object),
        "/cms/content-types/capabilities": expect.any(Object),
        "/cms/content-types": expect.any(Object),
        "/cms/content-types/{name}": expect.any(Object),
        "/graphql": expect.any(Object),
        "/graphql/schema": expect.any(Object),
        "/cms/graphql": expect.any(Object),
        "/cms/graphql/schema": expect.any(Object),
        "/api/media": expect.any(Object),
        "/api/media/presign": expect.any(Object),
        "/api/media/confirm": expect.any(Object),
        "/api/media/{id}": expect.any(Object),
        "/api/media/{id}/file": expect.any(Object),
        "/api/articles/{id}/publish": expect.any(Object),
        "/api/articles/{id}/unpublish": expect.any(Object),
        "/api/articles/{id}/schedule": {
          post: expect.objectContaining({
            requestBody: expect.objectContaining({ content: expect.any(Object) }),
            security: [{ bearerAuth: [] }]
          })
        },
        "/api/pages/{id}/locales": expect.any(Object),
        "/api/pages/{id}/locales/{locale}": expect.any(Object),
        "/api/pages/{id}/translate": expect.any(Object),
        "/api/preview-tokens": expect.any(Object),
        "/api/preview-tokens/{token}": expect.any(Object),
        "/cms/admin/i18n/backfill": expect.any(Object),
        "/cms/admin/i18n/backfill/status": expect.any(Object),
        "/cms/audit-log": expect.any(Object),
        "/cms/settings/webhooks": expect.any(Object),
        "/cms/settings/webhooks/{id}": expect.any(Object),
        "/cms/settings/webhooks/{id}/deliveries": expect.any(Object),
        "/cms/settings/webhooks/{id}/deliveries/{deliveryId}/retry": expect.any(Object),
        "/cms/settings/webhooks/{id}/test": expect.any(Object),
        "/cms/settings/api-keys": expect.any(Object),
        "/cms/settings/api-keys/{id}": expect.any(Object),
        "/cms/settings/organization": expect.any(Object),
        "/cms/settings/organization/members": expect.any(Object),
        "/cms/settings/organization/members/{id}": expect.any(Object),
        "/cms/settings/organization/invitations": expect.any(Object),
        "/cms/settings/organization/invitations/{id}/revoke": expect.any(Object)
      }
    });
    expect(specBody.paths["/api/articles"]?.post?.requestBody).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/ArticlesCreateInput" } } }
    });
    expect(specBody.paths["/api/articles/{id}"]?.patch?.requestBody).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/ArticlesUpdateInput" } } }
    });
    expect(translatePath.post?.requestBody).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/TranslateRequest" } } }
    });
    expect(localesPath.get?.operationId).toBe("listPagesLocaleStatus");
    expect(localeVariantPath.patch?.requestBody).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/LocaleReviewRequest" } } }
    });
    expect(localeVariantPath.put?.requestBody).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/LocaleVariantUpdateRequest" } } }
    });
    expect(specBody.paths["/cms/admin/i18n/backfill"]?.post?.requestBody).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/I18nBackfillRequest" } } }
    });
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(operationIds).toContain("authenticateCMSSession");
    expect(operationIds).toContain("getCMSAuthSession");
    expect(operationIds).toContain("runCMSAuthProviderAction");
    expect(operationIds).toContain("translatePagesRecord");
    expect(operationIds).toContain("reviewPagesLocaleVariant");
    expect(operationIds).toContain("updatePagesLocaleVariant");
    expect(operationIds).toContain("backfillTranslatedLocaleVariants");
    expect(operationIds).toContain("getI18nBackfillStatus");
    expect(operationIds).toContain("getContentTypeBuilderCapabilities");
    expect(operationIds).toContain("listContentTypes");
    expect(operationIds).toContain("createContentType");
    expect(operationIds).toContain("updateContentType");

    await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Hooked" })
    }));
    expect(fetchMock).toHaveBeenCalledWith("https://hooks.test/cms", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "x-cms-signature": expect.stringMatching(/^sha256=/) })
    }));
    fetchMock.mockRestore();
  });

  test("merges the registry-derived spec with hand-rolled extensions for migrated paths", async () => {
    // Plan-12 U6 regression: the served `/cms/openapi.json` is the merge of
    // the hand-rolled spec and `app.getOpenAPI31Document()`. For every
    // content collection migrated to `createRoute(...)`, the merged path
    // entry must carry BOTH the registry-derived response/operationId AND
    // the hand-rolled `x-cms-filter-fields` / `x-cms-sort-fields` /
    // `x-cms-relations` parameter extensions.
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      rbac: { publicRead: true }
    });
    const response = await app.fetch(new Request("https://cms.test/cms/openapi.json"));
    expect(response.status).toBe(200);
    const spec = await response.json() as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, Record<string, {
        operationId?: string;
        responses?: Record<string, unknown>;
        parameters?: Array<Record<string, unknown>>;
      }>>;
      components: { schemas: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
    };

    // Structural OpenAPI 3.1 validity: the served document must keep the
    // required top-level fields after the merge.
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info).toMatchObject({ title: expect.any(String), version: expect.any(String) });
    expect(spec.paths).toEqual(expect.any(Object));
    expect(spec.components.schemas).toEqual(expect.any(Object));
    expect(findDanglingOpenAPIRefs(spec)).toEqual([]);

    const articlesList = spec.paths["/api/articles"]?.get;
    expect(articlesList).toBeDefined();
    // Registry-derived signal: the migrated `createRoute` declared an
    // operationId of `listArticles` and a JSON response.
    expect(articlesList?.operationId).toBe("listArticles");
    expect(articlesList?.responses?.["200"]).toMatchObject({
      content: { "application/json": expect.any(Object) }
    });
    // Hand-rolled signal: filter/sort/populate parameters merged in with
    // their `x-cms-*` extension metadata preserved.
    const filtersParameter = articlesList?.parameters?.find((parameter) => parameter.name === "filters");
    const sortParameter = articlesList?.parameters?.find((parameter) => parameter.name === "sort");
    const populateParameter = articlesList?.parameters?.find((parameter) => parameter.name === "populate");
    expect(filtersParameter).toBeDefined();
    expect(filtersParameter?.["x-cms-filter-fields"]).toEqual(["author", "body", "title"]);
    expect(sortParameter?.["x-cms-sort-fields"]).toEqual(expect.arrayContaining(["createdAt", "title"]));
    expect(populateParameter?.["x-cms-relations"]).toEqual(["author"]);

    // Non-migrated path passes through from the hand-rolled spec intact.
    const auditPath = spec.paths["/cms/audit-log"]?.get;
    expect(auditPath?.operationId).toBe("listAuditLogEntries");

    // Components retain the hand-rolled richer schema definitions when both
    // sides register a component with the same name (the registry stubs them
    // as `{type: "object"}` placeholders).
    const articlesSchema = spec.components.schemas.Articles as { properties?: Record<string, unknown> };
    expect(articlesSchema.properties).toBeDefined();
    expect(articlesSchema.properties?.title).toBeDefined();
  });

  test("gates OpenAPI routes in production unless explicitly configured", async () => {
    const developmentEnabledApp = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      openapi: true,
      rbac: { publicRead: true }
    });
    expect((await developmentEnabledApp.fetch(new Request("https://cms.test/cms/openapi.json"))).status).toBe(200);
    expect((await developmentEnabledApp.fetch(new Request("https://cms.test/cms/docs"))).status).toBe(200);

    const disabledApp = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      openapi: false,
      rbac: { publicRead: true }
    });
    expect((await disabledApp.fetch(new Request("https://cms.test/cms/openapi.json"))).status).toBe(404);
    expect((await disabledApp.fetch(new Request("https://cms.test/cms/docs"))).status).toBe(404);

    const productionApp = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      env: { NODE_ENV: "production" },
      openapi: true,
      rbac: { publicRead: true }
    });
    expect((await productionApp.fetch(new Request("https://cms.test/cms/openapi.json"))).status).toBe(404);
    expect((await productionApp.fetch(new Request("https://cms.test/cms/docs"))).status).toBe(404);

    const planAliasApp = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      env: { NODE_ENV: "production" },
      openapi: { path: "/contracts/plan-openapi.json", docs: "/contracts/plan-docs" },
      rbac: { publicRead: true }
    });
    expect((await planAliasApp.fetch(new Request("https://cms.test/contracts/plan-openapi.json"))).status).toBe(200);
    const aliasDocs = await planAliasApp.fetch(new Request("https://cms.test/contracts/plan-docs"));
    expect(aliasDocs.status).toBe(200);
    expect(await aliasDocs.text()).toContain("/contracts/plan-openapi.json");

    const configuredApp = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      env: { NODE_ENV: "production" },
      openapi: {
        specPath: "/contracts/openapi.json",
        docsPath: "/contracts/docs",
        title: "Hosted CMS",
        version: "2026.5",
        description: "Hosted API contract for generated clients.",
        servers: [{ url: "https://api.example.com", description: "Production API" }]
      },
      rbac: { publicRead: true }
    });
    const spec = await configuredApp.fetch(new Request("https://cms.test/contracts/openapi.json"));
    expect(spec.status).toBe(200);
    expect(spec.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(spec.headers.get("access-control-allow-origin")).toBe("*");
    expect(spec.headers.get("etag")).toMatch(/^".+"$/);
    const configuredSpecBody = await spec.clone().json() as { info: Record<string, unknown>; servers?: unknown[] };
    expect(configuredSpecBody.info).toMatchObject({
      title: "Hosted CMS",
      version: "2026.5",
      description: "Hosted API contract for generated clients."
    });
    expect(configuredSpecBody.servers).toEqual([{ url: "https://api.example.com", description: "Production API" }]);
    const notModified = await configuredApp.fetch(new Request("https://cms.test/contracts/openapi.json", {
      headers: { "if-none-match": spec.headers.get("etag") ?? "" }
    }));
    expect(notModified.status).toBe(304);
    const docs = await configuredApp.fetch(new Request("https://cms.test/contracts/docs"));
    expect(docs.status).toBe(200);
    const docsHtml = await docs.text();
    expect(docsHtml).toContain("/contracts/openapi.json");
    expect(docsHtml).toContain("preferredSecurityScheme: 'bearerAuth'");
  });

  test("restricts OpenAPI spec and docs CORS when configured", async () => {
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      openapi: {
        path: "/contracts/openapi.json",
        docs: "/contracts/docs",
        cors: {
          origin: ["https://docs.test"],
          credentials: true,
          allowedHeaders: ["authorization", "if-none-match"],
          maxAge: 900
        }
      },
      rbac: { publicRead: true }
    });

    const spec = await app.fetch(new Request("https://cms.test/contracts/openapi.json", {
      headers: { origin: "https://docs.test" }
    }));
    expect(spec.status).toBe(200);
    expect(spec.headers.get("access-control-allow-origin")).toBe("https://docs.test");
    expect(spec.headers.get("access-control-allow-credentials")).toBe("true");
    expect(spec.headers.get("vary")).toContain("Origin");

    const deniedSpec = await app.fetch(new Request("https://cms.test/contracts/openapi.json", {
      headers: { origin: "https://evil.test" }
    }));
    expect(deniedSpec.status).toBe(200);
    expect(deniedSpec.headers.get("access-control-allow-origin")).toBeNull();

    const preflight = await app.fetch(new Request("https://cms.test/contracts/openapi.json", {
      method: "OPTIONS",
      headers: {
        origin: "https://docs.test",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,if-none-match"
      }
    }));
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://docs.test");
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("authorization, content-type, if-none-match");
    expect(preflight.headers.get("access-control-max-age")).toBe("900");

    const docs = await app.fetch(new Request("https://cms.test/contracts/docs", {
      headers: { origin: "https://docs.test" }
    }));
    expect(docs.status).toBe(200);
    expect(docs.headers.get("access-control-allow-origin")).toBe("https://docs.test");

    const docsPreflight = await app.fetch(new Request("https://cms.test/contracts/docs", {
      method: "OPTIONS",
      headers: {
        origin: "https://docs.test",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,if-none-match"
      }
    }));
    expect(docsPreflight.status).toBe(200);
    expect(docsPreflight.headers.get("access-control-allow-origin")).toBe("https://docs.test");
    expect(docsPreflight.headers.get("access-control-allow-credentials")).toBe("true");
    expect(docsPreflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(docsPreflight.headers.get("access-control-allow-headers")).toBe("authorization, content-type, if-none-match");
  });

  test("records audit entries and exports csv", async () => {
    const app = cms();
    const create = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json", "x-request-id": "req_1" },
      body: JSON.stringify({ title: "Audited", body: "Before" })
    }));
    const record = await create.json() as { id: string };

    await app.fetch(new Request(`https://cms.test/api/articles/${record.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer admin", "content-type": "application/json", "x-request-id": "req_2" },
      body: JSON.stringify({ body: "After" })
    }));

    const audit = await app.fetch(new Request(`https://cms.test/cms/audit-log?collection=articles&documentId=${record.id}`, {
      headers: { authorization: "Bearer admin" }
    }));
    const auditBody = await audit.json() as { items: Array<{ createdAt: string; requestId: string }> };
    expect(auditBody).toMatchObject({
      items: [
        { operation: "update", requestId: "req_2", diff: { before: { body: "Before" }, after: { body: "After" } } },
        { operation: "create", requestId: "req_1" }
      ]
    });
    const from = encodeURIComponent(new Date(new Date(auditBody.items[0]?.createdAt ?? Date.now()).getTime() - 1000).toISOString());
    const to = encodeURIComponent(new Date(new Date(auditBody.items[0]?.createdAt ?? Date.now()).getTime() + 1000).toISOString());
    const rangedAudit = await app.fetch(new Request(`https://cms.test/cms/audit-log?collection=articles&from=${from}&to=${to}`, {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(rangedAudit.json()).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ requestId: "req_2" }),
        expect.objectContaining({ requestId: "req_1" })
      ])
    });
    const invalidAuditQuery = await app.fetch(new Request("https://cms.test/cms/audit-log?from=nope&to=2026-01-01T00:00:00.000Z&limit=0&operation=unknown&format=xml", {
      headers: { authorization: "Bearer admin" }
    }));
    expect(invalidAuditQuery.status).toBe(422);
    await expect(invalidAuditQuery.json()).resolves.toMatchObject({
      error: "validation_error",
      issues: expect.arrayContaining([
        { path: ["operation"], message: "operation is not supported" },
        { path: ["from"], message: "from must be a valid date-time" },
        { path: ["format"], message: "format must be json or csv" },
        { path: ["limit"], message: "limit must be an integer between 1 and 100" }
      ])
    });

    const csv = await app.fetch(new Request("https://cms.test/cms/audit-log?format=csv", {
      headers: { authorization: "Bearer admin" }
    }));
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain("operation");
  });

  test("cleans audit logs through the exported retention job", async () => {
    const auditStore = new MemoryAuditStore();
    const now = new Date("2026-05-22T12:00:00.000Z");
    await auditStore.append({
      id: "old",
      operation: "create",
      collection: "articles",
      actorRoles: [],
      requestId: "old",
      diff: { before: null, after: { title: "old" } },
      createdAt: new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000).toISOString()
    });
    await auditStore.append({
      id: "fresh",
      operation: "create",
      collection: "articles",
      actorRoles: [],
      requestId: "fresh",
      diff: { before: null, after: { title: "fresh" } },
      createdAt: new Date(now.getTime() - 89 * 24 * 60 * 60 * 1000).toISOString()
    });

    await expect(auditLogCleanupJob({ store: auditStore, retentionDays: 90, now })).resolves.toMatchObject({
      deletedCount: 1,
      olderThan: "2026-02-21T12:00:00.000Z"
    });
    await expect(auditStore.list()).resolves.toMatchObject({ items: [{ id: "fresh" }] });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(auditLogCleanupJob({ store: auditStore, retentionDays: 0, now })).resolves.toEqual({ deletedCount: 0 });
    expect(warn).toHaveBeenCalledWith("[hono-cms/audit] audit log cleanup skipped because retentionDays is 0.");
    warn.mockRestore();
  });

  test("manages UI webhooks and records delivery history", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const app = cms();
    const created = await app.fetch(new Request("https://cms.test/cms/settings/webhooks", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Search", url: "https://hooks.test/search", secret: "top", events: ["content.created"] })
    }));
    expect(created.status).toBe(201);
    const webhook = await created.json() as { id: string; secret: string };
    expect(webhook.secret).toBe("top");

    const list = await app.fetch(new Request("https://cms.test/cms/settings/webhooks", {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(list.json()).resolves.toMatchObject({ items: [{ id: webhook.id, hasSecret: true, lastDeliveryStatus: null }], meta: { total: 1 } });

    const partialUpdate = await app.fetch(new Request(`https://cms.test/cms/settings/webhooks/${webhook.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    }));
    await expect(partialUpdate.json()).resolves.toMatchObject({ id: webhook.id, secret: "****", enabled: false });

    const incompleteReplace = await app.fetch(new Request(`https://cms.test/cms/settings/webhooks/${webhook.id}`, {
      method: "PUT",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    }));
    expect(incompleteReplace.status).toBe(400);
    await expect(incompleteReplace.json()).resolves.toMatchObject({
      error: "validation_error",
      issues: expect.arrayContaining([
        { path: ["name"], message: "name is required" },
        { path: ["url"], message: "url must be a valid HTTP URL" },
        { path: ["events"], message: "events must be a non-empty string array" }
      ])
    });

    const rotatedSecret = await app.fetch(new Request(`https://cms.test/cms/settings/webhooks/${webhook.id}`, {
      method: "PUT",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Search", url: "https://hooks.test/search", events: ["content.created"], enabled: true, secret: "new-top" })
    }));
    await expect(rotatedSecret.json()).resolves.toMatchObject({ id: webhook.id, secret: "new-top", enabled: true });

    await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Webhooked" })
    }));

    const deliveries = await app.fetch(new Request(`https://cms.test/cms/settings/webhooks/${webhook.id}/deliveries`, {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(deliveries.json()).resolves.toMatchObject({ items: [{ webhookId: webhook.id, status: "success", responseStatus: 200 }] });

    const listWithDelivery = await app.fetch(new Request("https://cms.test/cms/settings/webhooks", {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(listWithDelivery.json()).resolves.toMatchObject({ items: [{ id: webhook.id, hasSecret: true, lastDeliveryStatus: "success" }] });
    fetchMock.mockRestore();
  });

  test("records static config webhook deliveries without exposing them as managed webhooks", async () => {
    const webhookStore = new MemoryWebhookStore();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("indexed", { status: 200 }));
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true },
      webhookStore,
      webhooks: [{ name: "Search Index", url: "https://hooks.test/static-search", events: ["content.created"] }]
    });

    const create = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Static Hook" })
    }));
    expect(create.status).toBe(201);

    await expect(webhookStore.listWebhooks()).resolves.toEqual([]);
    await expect(webhookStore.listDeliveries()).resolves.toMatchObject({
      items: [{ webhookId: null, eventType: "content.created", url: "https://hooks.test/static-search", status: "success", responseStatus: 200 }]
    });
    const managedList = await app.fetch(new Request("https://cms.test/cms/settings/webhooks", {
      headers: { authorization: "Bearer admin" }
    }));
    await expect(managedList.json()).resolves.toMatchObject({ items: [], meta: { total: 0 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  test("paginates webhook delivery logs newest first with cursor limits", async () => {
    const webhookStore = new MemoryWebhookStore();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true },
      webhookStore
    });
    const webhook = await webhookStore.createWebhook({
      name: "Search",
      url: "https://hooks.test/search",
      events: ["content.created"],
      enabled: true
    });

    for (let index = 0; index < 75; index += 1) {
      const created = await app.fetch(new Request("https://cms.test/api/articles", {
        method: "POST",
        headers: { authorization: "Bearer admin", "content-type": "application/json" },
        body: JSON.stringify({ title: `Delivery ${String(index).padStart(2, "0")}` })
      }));
      expect(created.status).toBe(201);
    }
    expect(fetchMock).toHaveBeenCalledTimes(75);

    const firstPage = await app.fetch(new Request(`https://cms.test/cms/settings/webhooks/${webhook.id}/deliveries?limit=50`, {
      headers: { authorization: "Bearer admin" }
    }));
    expect(firstPage.status).toBe(200);
    const firstBody = await firstPage.json() as { items: Array<{ id: string; requestBody: string }>; nextCursor?: string };
    expect(firstBody.items).toHaveLength(50);
    expect(firstBody.nextCursor).toBe(firstBody.items.at(-1)?.id);
    expect(JSON.parse(firstBody.items[0]?.requestBody ?? "{}").data.record.title).toBe("Delivery 74");
    expect(JSON.parse(firstBody.items[49]?.requestBody ?? "{}").data.record.title).toBe("Delivery 25");

    const secondPage = await app.fetch(new Request(`https://cms.test/cms/settings/webhooks/${webhook.id}/deliveries?limit=50&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`, {
      headers: { authorization: "Bearer admin" }
    }));
    expect(secondPage.status).toBe(200);
    const secondBody = await secondPage.json() as { items: Array<{ requestBody: string }>; nextCursor?: string };
    expect(secondBody.items).toHaveLength(25);
    expect(secondBody.nextCursor).toBeUndefined();
    expect(JSON.parse(secondBody.items[0]?.requestBody ?? "{}").data.record.title).toBe("Delivery 24");
    expect(JSON.parse(secondBody.items[24]?.requestBody ?? "{}").data.record.title).toBe("Delivery 00");

    const invalidLimit = await app.fetch(new Request(`https://cms.test/cms/settings/webhooks/${webhook.id}/deliveries?limit=101`, {
      headers: { authorization: "Bearer admin" }
    }));
    expect(invalidLimit.status).toBe(422);
    await expect(invalidLimit.json()).resolves.toMatchObject({
      error: "validation_error",
      issues: [{ path: ["limit"], message: "limit must be an integer between 1 and 100" }]
    });
    fetchMock.mockRestore();
  });

  test("sends synchronous cms.test webhook deliveries without enqueueing retries", async () => {
    const webhookStore = new MemoryWebhookStore();
    const enqueue = vi.fn(async () => undefined);
    const jobs = {
      provider: "test-jobs",
      register: vi.fn(),
      dispatch: vi.fn(async () => undefined),
      verify: vi.fn(async () => true),
      enqueue
    };
    const receivedRequests: Array<{ body: string; headers: Headers }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      receivedRequests.push({
        body: typeof init?.body === "string" ? init.body : "",
        headers: new Headers(init?.headers)
      });
      return new Response("receiver down", { status: 503 });
    });
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      jobs,
      webhookStore,
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true }
    });
    const webhook = await webhookStore.createWebhook({
      name: "Deploy",
      url: "https://hooks.test/deploy",
      secret: "test-secret",
      events: ["content.published"],
      enabled: true
    });

    const response = await app.fetch(new Request(`https://cms.test/cms/settings/webhooks/${webhook.id}/test`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "x-request-id": "req_test_1" }
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      webhookId: webhook.id,
      eventType: "cms.test",
      status: "failed",
      responseStatus: 503,
      responseBody: "receiver down",
      attempt: 1
    });
    expect(enqueue).not.toHaveBeenCalled();
    const receivedRequest = receivedRequests[0];
    expect(receivedRequest?.headers.get("x-cms-event")).toBe("cms.test");
    expect(receivedRequest?.headers.get("x-cms-signature")).toMatch(/^sha256=/);
    expect(JSON.parse(receivedRequest?.body ?? "{}")).toMatchObject({
      event: "cms.test",
      data: { type: "cms.test", requestId: "req_test_1" }
    });
    await expect(webhookStore.listDeliveries({ webhookId: webhook.id })).resolves.toMatchObject({
      items: [{ eventType: "cms.test", status: "failed", responseStatus: 503, attempt: 1 }]
    });

    fetchMock.mockRestore();
  });

  test("retries failed webhook deliveries through the jobs endpoint", async () => {
    const webhookStore = new MemoryWebhookStore();
    const enqueue = vi.fn(async () => undefined);
    const jobs = {
      provider: "test-jobs",
      register: vi.fn(),
      dispatch: vi.fn(async () => undefined),
      verify: vi.fn(async () => true),
      enqueue
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("temporary", { status: 503 }));
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      jobs,
      webhookStore,
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true }
    });
    const webhook = await webhookStore.createWebhook({
      name: "Search",
      url: "https://hooks.test/search",
      events: ["content.created"],
      enabled: true
    });

    await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Retry Me" })
    }));
    expect(enqueue).toHaveBeenCalledWith("/cms/jobs/webhook-retry", expect.objectContaining({ deliveryId: expect.any(String) }), { delay: 30 });
    const [delivery] = (await webhookStore.listDeliveries({ webhookId: webhook.id })).items;
    expect(delivery).toMatchObject({ status: "retrying", attempt: 1, responseStatus: 503 });

    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    const retry = await app.fetch(new Request("https://cms.test/cms/jobs/webhook-retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId: delivery?.id })
    }));
    await expect(retry.json()).resolves.toMatchObject({ success: true, attempt: 2 });
    await expect(webhookStore.getDelivery(delivery?.id ?? "")).resolves.toMatchObject({ status: "success", attempt: 2, responseStatus: 200 });

    await webhookStore.appendDelivery({
      id: "almost_failed",
      webhookId: webhook.id,
      eventType: "content.created",
      url: "https://hooks.test/search",
      attempt: 2,
      status: "retrying",
      requestBody: "{}",
      createdAt: new Date().toISOString()
    });
    fetchMock.mockResolvedValue(new Response("still down", { status: 500 }));
    const failed = await app.fetch(new Request("https://cms.test/cms/jobs/webhook-retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId: "almost_failed" })
    }));
    await expect(failed.json()).resolves.toMatchObject({ failed: true, attempt: 3 });
    await expect(webhookStore.getDelivery("almost_failed")).resolves.toMatchObject({ status: "failed", attempt: 3, responseStatus: 500 });

    fetchMock.mockResolvedValue(new Response("manual ok", { status: 200 }));
    const manualRetry = await app.fetch(new Request(`https://cms.test/cms/settings/webhooks/${webhook.id}/deliveries/almost_failed/retry`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    }));
    expect(manualRetry.status).toBe(200);
    await expect(manualRetry.json()).resolves.toMatchObject({ id: "almost_failed", status: "success", attempt: 4, responseStatus: 200 });

    const retrySuccess = await app.fetch(new Request(`https://cms.test/cms/settings/webhooks/${webhook.id}/deliveries/almost_failed/retry`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    }));
    expect(retrySuccess.status).toBe(409);
    await expect(retrySuccess.json()).resolves.toMatchObject({ error: "delivery_not_failed" });
    fetchMock.mockRestore();
  });

  test("persists webhook retries when jobs.enqueue throws (Vercel cron-only/CF no-queue) and sweeper picks them up", async () => {
    const webhookStore = new MemoryWebhookStore();
    // Simulate Gap-B/J behavior: jobs.enqueue throws JobsConfigError because no
    // qstashFallback or queue binding is configured. dispatch should swallow
    // the throw and persist the delivery row for the sweeper.
    const cronOnlyEnqueue = vi.fn(async () => {
      throw new Error("VercelJobsAdapter requires qstashFallback for on-demand jobs");
    });
    const jobs = {
      provider: "vercel-cron-only",
      register: vi.fn(),
      dispatch: vi.fn(),
      verify: vi.fn(async () => true),
      enqueue: cronOnlyEnqueue
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("temporary", { status: 503 }));
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      jobs,
      webhookStore,
      auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
      rbac: { publicRead: true }
    });
    const webhook = await webhookStore.createWebhook({
      name: "Cron-Only",
      url: "https://hooks.test/cron-only",
      secret: "cron-only-secret",
      events: ["content.created"],
      enabled: true
    });

    // Trigger a delivery; enqueue throws but the mutation must still succeed.
    const created = await app.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Cron-Only Retry" })
    }));
    expect(created.status).toBe(201);
    expect(cronOnlyEnqueue).toHaveBeenCalled();

    // Persisted with status retrying + nextAttemptAt.
    const after = await webhookStore.listDeliveries({ webhookId: webhook.id });
    expect(after.items).toHaveLength(1);
    const delivery = after.items[0];
    expect(delivery?.status).toBe("retrying");
    expect(delivery?.attempt).toBe(1);
    expect(delivery?.nextAttemptAt).toEqual(expect.any(String));

    // Backdate nextAttemptAt so the sweeper considers it overdue, then succeed
    // on the next fetch.
    await webhookStore.updateDelivery?.(delivery!.id, { nextAttemptAt: new Date(Date.now() - 1_000).toISOString() });
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const sweep = await app.fetch(new Request("https://cms.test/cms/jobs/webhook-retry-sweep", {
      method: "POST",
      headers: { authorization: "Bearer cron-secret" }
    }));
    expect(sweep.status).toBe(200);
    await expect(sweep.json()).resolves.toMatchObject({ swept: 1, succeeded: 1, retrying: 0, failed: 0 });

    const final = await webhookStore.getDelivery(delivery!.id);
    expect(final).toMatchObject({ status: "success", attempt: 2, responseStatus: 200 });
    // Signature was included on the sweep re-attempt because the secret was resolved.
    const lastCall = fetchMock.mock.calls.at(-1);
    const headers = new Headers((lastCall?.[1] as RequestInit | undefined)?.headers);
    expect(headers.get("x-cms-signature")).toMatch(/^sha256=/);
    fetchMock.mockRestore();
  });

  test("sweeper marks 4xx terminal failures as failed without retrying further", async () => {
    const webhookStore = new MemoryWebhookStore();
    const webhook = await webhookStore.createWebhook({
      name: "Gone",
      url: "https://hooks.test/gone",
      events: ["content.created"],
      enabled: true
    });
    await webhookStore.appendDelivery({
      id: "gone_endpoint",
      webhookId: webhook.id,
      eventType: "content.created",
      url: webhook.url,
      attempt: 1,
      status: "retrying",
      requestBody: JSON.stringify({ event: "content.created" }),
      nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
      createdAt: new Date().toISOString()
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
    const result = await runWebhookRetrySweep({ store: webhookStore });
    expect(result).toMatchObject({ swept: 1, succeeded: 0, failed: 1, retrying: 0 });

    await expect(webhookStore.getDelivery("gone_endpoint")).resolves.toMatchObject({
      status: "failed",
      attempt: 2,
      responseStatus: 404
    });

    // Subsequent sweep finds nothing pending (status is failed, no nextAttemptAt).
    const noop = await runWebhookRetrySweep({ store: webhookStore });
    expect(noop).toMatchObject({ swept: 0, succeeded: 0, retrying: 0, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  test("sweeper follows 30s->5m->1h backoff and gives up after 3 attempts on 5xx", async () => {
    const webhookStore = new MemoryWebhookStore();
    const webhook = await webhookStore.createWebhook({
      name: "Flaky",
      url: "https://hooks.test/flaky",
      events: ["content.created"],
      enabled: true
    });
    await webhookStore.appendDelivery({
      id: "flaky_delivery",
      webhookId: webhook.id,
      eventType: "content.created",
      url: webhook.url,
      attempt: 1,
      status: "retrying",
      requestBody: JSON.stringify({ event: "content.created" }),
      nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
      createdAt: new Date().toISOString()
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("oops", { status: 500 }));

    // Sweep 1: attempt 1 -> 2, next backoff = 5m (300s).
    const before2 = Date.now();
    const sweep1 = await runWebhookRetrySweep({ store: webhookStore });
    expect(sweep1).toMatchObject({ swept: 1, retrying: 1, failed: 0 });
    const d2 = await webhookStore.getDelivery("flaky_delivery");
    expect(d2?.attempt).toBe(2);
    expect(d2?.status).toBe("retrying");
    const delay2 = Date.parse(d2?.nextAttemptAt ?? "") - before2;
    expect(delay2).toBeGreaterThanOrEqual(300 * 1000 - 5_000);
    expect(delay2).toBeLessThan(300 * 1000 + 5_000);

    // Backdate and sweep 2: attempt 2 -> 3 hits the 3-attempt cap and fails.
    await webhookStore.updateDelivery?.("flaky_delivery", { nextAttemptAt: new Date(Date.now() - 1_000).toISOString() });
    const sweep2 = await runWebhookRetrySweep({ store: webhookStore });
    expect(sweep2).toMatchObject({ swept: 1, retrying: 0, failed: 1 });
    const d3 = await webhookStore.getDelivery("flaky_delivery");
    expect(d3).toMatchObject({ status: "failed", attempt: 3, responseStatus: 500, nextAttemptAt: undefined });
    fetchMock.mockRestore();
  });

  test("webhookDeliveryCleanupJob removes deliveries older than retentionDays", async () => {
    const webhookStore = new MemoryWebhookStore();
    const now = new Date("2026-05-22T12:00:00.000Z");
    await webhookStore.appendDelivery({
      id: "old_delivery",
      webhookId: null,
      eventType: "content.created",
      url: "https://hooks.test/x",
      attempt: 3,
      status: "failed",
      requestBody: "{}",
      createdAt: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString()
    });
    await webhookStore.appendDelivery({
      id: "fresh_delivery",
      webhookId: null,
      eventType: "content.created",
      url: "https://hooks.test/x",
      attempt: 1,
      status: "success",
      requestBody: "{}",
      createdAt: now.toISOString()
    });

    const result = await webhookDeliveryCleanupJob({ store: webhookStore, retentionDays: 30, now });
    expect(result).toMatchObject({ deletedCount: 1 });
    await expect(webhookStore.getDelivery("old_delivery")).resolves.toBeNull();
    await expect(webhookStore.getDelivery("fresh_delivery")).resolves.not.toBeNull();
  });
});
