import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { createCMS, MemoryApiKeyStore, MemoryMediaStore } from "@hono-cms/core";
import { createMemoryCache } from "@hono-cms/cache";
import { createMemoryJobs } from "@hono-cms/jobs";
import { createMemoryStorage } from "@hono-cms/storage-memory";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";

/**
 * Schema for the Bun-native example: a blog with posts (draft/publish workflow)
 * and authors (always-live). Mirrors the shape of the other cross-runtime
 * examples so the matrix doc can compare runtimes apples-to-apples.
 */
export const bunExampleSchema = defineSchema({
  posts: defineCollection("posts", {
    title: fields.string({ required: true }),
    slug: fields.uid({ required: true, targetField: "title" }),
    body: fields.richtext()
  }, { draftAndPublish: true }),
  authors: defineCollection("authors", {
    name: fields.string({ required: true }),
    bio: fields.richtext()
  })
});

/**
 * Build a fresh CMS wired up with every "memory" provider in the workspace so
 * the example boots without any external services. Real deployments swap each
 * adapter for its production counterpart (Postgres / R2 / Upstash / QStash).
 */
export function createBunExampleCMS() {
  return createCMS({
    collections: bunExampleSchema,
    db: createMemoryDatabase({ provider: "memory", collections: bunExampleSchema }),
    storage: createMemoryStorage({ provider: "memory" }),
    cache: createMemoryCache(),
    jobs: createMemoryJobs(),
    mediaStore: new MemoryMediaStore(),
    apiKeyStore: new MemoryApiKeyStore(),
    auth: {
      tokens: {
        admin: { userId: "bun-admin", roles: ["admin"] },
        editor: { userId: "bun-editor", roles: ["editor"] }
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
      title: "Hono CMS (Bun.serve)",
      version: "0.1.0",
      description: "Example CMS booted directly by Bun.serve({ fetch }) — no third-party framework."
    }
  });
}

export const cms = createBunExampleCMS();
