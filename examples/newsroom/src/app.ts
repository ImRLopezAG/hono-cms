/**
 * Newsroom example, migrated to the plugin manifest shape (U25 7/7).
 *
 * Composes the full first-party plugin stack — cors, openapi, cache,
 * jobs-runtime, auth-tokens, rate-limit, content-cache, audit, webhooks,
 * drafts, media — as the canonical starter template.
 */
import { createCMS, type CMSInstance } from "@hono-cms/core";
import { memoryDatabase } from "@hono-cms/adapter-memory";
import { memoryStorage } from "@hono-cms/storage-memory";
import { memoryCache } from "@hono-cms/cache";
import { memoryJobs } from "@hono-cms/jobs";
import { jobsRuntime } from "@hono-cms/jobs-runtime";
import { cors } from "@hono-cms/cors";
import { openapi } from "@hono-cms/openapi";
import { tokensAuth } from "@hono-cms/auth-tokens";
import { rateLimit } from "@hono-cms/rate-limit";
import { contentCache } from "@hono-cms/content-cache";
import { audit } from "@hono-cms/audit";
import { webhooks } from "@hono-cms/webhooks";
import { drafts } from "@hono-cms/drafts";
import { mediaPlugin } from "@hono-cms/media";
import { newsroomSchema } from "./schema";

export type NewsroomCMSOptions = {
  /** Optional callback fired with the raw bootstrap key on first boot. */
  onBootstrapKey?: (key: string) => void;
};

export async function createNewsroomCMS(options: NewsroomCMSOptions = {}): Promise<CMSInstance<typeof newsroomSchema>> {
  return createCMS({
    collections: newsroomSchema,
    db: memoryDatabase({ provider: "memory", collections: newsroomSchema }),
    storage: memoryStorage({ provider: "memory" }),
    plugins: [
      cors({
        origin: true,
        credentials: true,
        allowedHeaders: ["authorization", "content-type", "x-requested-with"],
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
      }),
      openapi({
        title: "Newsroom CMS API (plugin shape)",
        version: "0.2.0",
        description: "Example newsroom built on the plugin-manifest kernel.",
        servers: [{ url: "https://newsroom.example.com", description: "Production" }]
      }),
      memoryCache({}),
      // drafts plugin owns the scheduled-publish job, so disable the
      // built-in jobs-runtime version to avoid a duplicate-registration
      // collision when both plugins co-install.
      jobsRuntime({ adapter: memoryJobs({}), registerScheduledPublish: false }),
      tokensAuth({
        ...(options.onBootstrapKey ? { onBootstrapKey: options.onBootstrapKey } : {})
      }),
      rateLimit({ mutations: { limit: 100, window: "1m" } }),
      contentCache({ ttlSeconds: 30 }),
      audit({}),
      webhooks({}),
      drafts(),
      mediaPlugin({})
    ]
  });
}
