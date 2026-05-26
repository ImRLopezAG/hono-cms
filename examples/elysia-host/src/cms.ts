import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { createCMS, MemoryApiKeyStore, MemoryMediaStore } from "@hono-cms/core";
import { createMemoryStorage } from "@hono-cms/storage-memory";
import { createMemoryCache } from "@hono-cms/cache";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";

export const elysiaExampleSchema = defineSchema({
  posts: defineCollection("posts", {
    title: fields.string({ required: true }),
    slug: fields.uid({ required: true, targetField: "title" }),
    excerpt: fields.text(),
    body: fields.richtext()
  }, { draftAndPublish: true }),
  authors: defineCollection("authors", {
    name: fields.string({ required: true }),
    bio: fields.richtext()
  })
});

export function createElysiaExampleCMS() {
  return createCMS({
    collections: elysiaExampleSchema,
    db: createMemoryDatabase({ provider: "memory", collections: elysiaExampleSchema }),
    storage: createMemoryStorage({ provider: "memory" }),
    cache: createMemoryCache(),
    mediaStore: new MemoryMediaStore(),
    apiKeyStore: new MemoryApiKeyStore(),
    auth: {
      tokens: {
        admin: { userId: "elysia-admin", roles: ["admin"] },
        editor: { userId: "elysia-editor", roles: ["editor"] }
      }
    },
    rbac: { publicRead: true },
    cors: {
      origin: true,
      credentials: true,
      allowedHeaders: ["authorization", "content-type", "x-requested-with"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    },
    openapi: {
      title: "Hono CMS (ElysiaJS host)",
      version: "0.1.0",
      description: "Example CMS mounted as a child route inside an ElysiaJS application."
    }
  });
}

export const cms = createElysiaExampleCMS();
