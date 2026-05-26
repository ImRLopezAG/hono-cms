/**
 * TanStack Start example, migrated to the plugin manifest shape (U25).
 *
 * The CMS is built with `createPluginCMS` from `@hono-cms/core`. Plugin
 * factories run inside the request lifecycle, so the TanStack Start
 * file route at `/api/cms/$` lazily instantiates the CMS on first
 * request — keeping module load free of timers and I/O (matches the
 * Cloudflare Worker example shape).
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

export type TanstackExampleOptions = {
  /** Optional callback fired with the raw bootstrap key on first boot. */
  onBootstrapKey?: (key: string) => void;
};

export async function createTanstackExampleCMS(
  options: TanstackExampleOptions = {}
): Promise<PluginCMSInstance<typeof tanstackStartSchema>> {
  return createPluginCMS({
    collections: tanstackStartSchema,
    db: memoryDatabase({ provider: "memory", collections: tanstackStartSchema }),
    storage: memoryStorage({ provider: "memory" }),
    plugins: [
      cors({
        origin: true,
        credentials: true,
        allowedHeaders: ["authorization", "content-type", "x-requested-with"],
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
      }),
      openapi({
        title: "Hono CMS (TanStack Start, plugin shape)",
        version: "0.2.0",
        description: "Plugin-manifest example served via a TanStack Start splat API route."
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

/**
 * Lazy fetch handler suitable for the TanStack Start splat file route.
 *
 * The CMS factory is async and Workers-style environments can't run it
 * at module load — so we cache a single promise and resolve it on the
 * first incoming request. Subsequent requests reuse the cached instance.
 */
export function createTanstackExampleHandler(options: TanstackExampleOptions = {}) {
  let cached: PluginCMSInstance<typeof tanstackStartSchema> | null = null;
  let initPromise: Promise<PluginCMSInstance<typeof tanstackStartSchema>> | null = null;

  async function get(): Promise<PluginCMSInstance<typeof tanstackStartSchema>> {
    if (cached) return cached;
    if (!initPromise) initPromise = createTanstackExampleCMS(options);
    cached = await initPromise;
    return cached;
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const cms = await get();
      return cms.fetch(request);
    }
  };
}

/** Default lazy handler used by the file route at `/api/cms/$`. */
export const cms = createTanstackExampleHandler();
