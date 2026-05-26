import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { createCMS, MemoryApiKeyStore, MemoryMediaStore } from "@hono-cms/core";
import { createMemoryStorage } from "@hono-cms/storage-memory";
import { createMemoryCache } from "@hono-cms/cache";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";

export const tanstackStartSchema = defineSchema({
  posts: defineCollection(
    "posts",
    {
      title: fields.string({ required: true }),
      slug: fields.uid({ required: true, targetField: "title" }),
      body: fields.richtext()
    },
    { draftAndPublish: true }
  ),
  authors: defineCollection("authors", {
    name: fields.string({ required: true }),
    bio: fields.richtext()
  })
});

export function createTanstackStartCMS() {
  return createCMS({
    collections: tanstackStartSchema,
    db: createMemoryDatabase({ provider: "memory", collections: tanstackStartSchema }),
    storage: createMemoryStorage({ provider: "memory" }),
    cache: createMemoryCache(),
    mediaStore: new MemoryMediaStore(),
    apiKeyStore: new MemoryApiKeyStore(),
    auth: { tokens: { admin: { userId: "tanstack-start-admin", roles: ["admin"] } } },
    rbac: { publicRead: true },
    cors: {
      origin: true,
      credentials: true,
      allowedHeaders: ["authorization", "content-type", "x-requested-with"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    },
    openapi: {
      title: "TanStack Start CMS",
      version: "0.1.0",
      description: "TanStack Start example using a catch-all API route that delegates to cms.fetch."
    }
  });
}

export const cms = createTanstackStartCMS();
