/**
 * Next.js App Router example, migrated to the plugin manifest shape (U25).
 *
 * Uses `createPluginCMS` from `@hono-cms/core` — every cross-cutting
 * concern lands as a plugin entry, instead of legacy `cache:`/`auth:`/`cors:`
 * config slots. The factory is async because plugin registration is async.
 */
import { memoryDatabase } from "@hono-cms/adapter-memory";
import { createPluginCMS, type PluginCMSInstance } from "@hono-cms/core";
import { memoryCache } from "@hono-cms/cache";
import { memoryStorage } from "@hono-cms/storage-memory";
import { memoryJobs } from "@hono-cms/jobs";
import { jobsRuntime } from "@hono-cms/jobs-runtime";
import { cors } from "@hono-cms/cors";
import { tokensAuth } from "@hono-cms/auth-tokens";
import { rateLimit } from "@hono-cms/rate-limit";
import { audit } from "@hono-cms/audit";
import { openapi } from "@hono-cms/openapi";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";

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

export type NextCMSOptions = {
  /** Optional callback fired with the raw bootstrap key on first boot. */
  onBootstrapKey?: (key: string) => void;
};

export async function createNextExampleCMS(
  options: NextCMSOptions = {}
): Promise<PluginCMSInstance<typeof nextExampleSchema>> {
  return createPluginCMS({
    collections: nextExampleSchema,
    db: memoryDatabase({ provider: "memory", collections: nextExampleSchema }),
    storage: memoryStorage({ provider: "memory" }),
    plugins: [
      cors({
        origin: true,
        credentials: true,
        allowedHeaders: ["authorization", "content-type", "x-requested-with"],
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
      }),
      openapi({
        title: "Hono CMS (Next.js App Router, plugin shape)",
        version: "0.2.0",
        description: "Plugin-manifest example mounted under the Next.js App Router catch-all."
      }),
      memoryCache({}),
      jobsRuntime({ adapter: memoryJobs({}) }),
      tokensAuth({
        ...(options.onBootstrapKey ? { onBootstrapKey: options.onBootstrapKey } : {})
      }),
      rateLimit({ mutations: { limit: 100, window: "1m" } }),
      audit({})
    ]
  });
}
