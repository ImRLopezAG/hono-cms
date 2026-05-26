/**
 * Elysia-host example, migrated to the plugin manifest shape (U25).
 */
import { memoryDatabase } from "@hono-cms/adapter-memory";
import { createCMS, type CMSInstance } from "@hono-cms/core";
import { memoryStorage } from "@hono-cms/storage-memory";
import { memoryCache } from "@hono-cms/cache";
import { memoryJobs } from "@hono-cms/jobs";
import { jobsRuntime } from "@hono-cms/jobs-runtime";
import { cors } from "@hono-cms/cors";
import { tokensAuth } from "@hono-cms/auth-tokens";
import { rateLimit } from "@hono-cms/rate-limit";
import { audit } from "@hono-cms/audit";
import { openapi } from "@hono-cms/openapi";
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

export type ElysiaCMSOptions = {
  onBootstrapKey?: (key: string) => void;
};

export async function createElysiaExampleCMS(opts: ElysiaCMSOptions = {}): Promise<CMSInstance<typeof elysiaExampleSchema>> {
  return createCMS({
    collections: elysiaExampleSchema,
    db: memoryDatabase({ provider: "memory", collections: elysiaExampleSchema }),
    storage: memoryStorage({ provider: "memory" }),
    plugins: [
      cors({
        origin: true,
        credentials: true,
        allowedHeaders: ["authorization", "content-type", "x-requested-with"],
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
      }),
      openapi({
        title: "Hono CMS (ElysiaJS host, plugin shape)",
        version: "0.2.0",
        description: "Plugin-manifest example mounted under /api/cms inside Elysia."
      }),
      memoryCache({}),
      jobsRuntime({ adapter: memoryJobs({}) }),
      tokensAuth({
        ...(opts.onBootstrapKey ? { onBootstrapKey: opts.onBootstrapKey } : {})
      }),
      rateLimit({ mutations: { limit: 100, window: "1m" } }),
      audit({})
    ]
  });
}
