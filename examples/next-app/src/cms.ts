import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { createCMS, MemoryApiKeyStore, MemoryMediaStore, type SchemaWriter } from "@hono-cms/core";
import { createMemoryStorage } from "@hono-cms/storage-memory";
import { createMemoryCache } from "@hono-cms/cache";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { createFileSchemaWriter } from "./schema-writer";

export const nextExampleSchema = defineSchema({
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

export function createNextExampleCMS(options: { contentTypeWriter?: SchemaWriter } = {}) {
  return createCMS({
    collections: nextExampleSchema,
    db: createMemoryDatabase({ provider: "memory", collections: nextExampleSchema }),
    storage: createMemoryStorage({ provider: "memory" }),
    cache: createMemoryCache(),
    mediaStore: new MemoryMediaStore(),
    apiKeyStore: new MemoryApiKeyStore(),
    auth: { tokens: { admin: { userId: "next-admin", roles: ["admin"] } } },
    ...(options.contentTypeWriter ? { contentTypeBuilder: { writer: options.contentTypeWriter } } : {}),
    rbac: { publicRead: true },
    cors: {
      origin: true,
      credentials: true,
      allowedHeaders: ["authorization", "content-type", "x-requested-with"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    },
    openapi: {
      title: "Next App CMS",
      version: "0.1.0",
      description: "Next.js App Router example using Web Request route handlers."
    }
  });
}

import { resolve } from "node:path";

const defaultSchemaWriter = createFileSchemaWriter({
  baseDir: resolve(process.cwd(), "generated-collections")
});

export const cms = createNextExampleCMS({ contentTypeWriter: defaultSchemaWriter });
