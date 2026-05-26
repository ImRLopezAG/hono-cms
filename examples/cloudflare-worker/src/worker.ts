/**
 * Cloudflare Worker example, migrated to the plugin manifest shape (U25).
 *
 * Workers ban module-load side effects (setInterval, fs); the plugin
 * runtime is structured so factory invocation runs inside the request
 * lifecycle. The CMS is lazy-instantiated on first request.
 */
import { createCMS, type CMSInstance } from "@hono-cms/core";
import { memoryDatabase } from "@hono-cms/adapter-memory";
import { memoryStorage } from "@hono-cms/storage-memory";
import { memoryCache } from "@hono-cms/cache";
import { memoryJobs } from "@hono-cms/jobs";
import { jobsRuntime } from "@hono-cms/jobs-runtime";
import { cors } from "@hono-cms/cors";
import { tokensAuth } from "@hono-cms/auth-tokens";
import { rateLimit } from "@hono-cms/rate-limit";
import { audit } from "@hono-cms/audit";
import { openapi } from "@hono-cms/openapi";
import { collections } from "./schema";

export type CloudflareExampleOptions = {
  scheduledHandler?: (cron: string, env: unknown, ctx: unknown) => Promise<void> | void;
  onBootstrapKey?: (key: string) => void;
};

export async function createCloudflareExampleCMS(options: CloudflareExampleOptions = {}): Promise<CMSInstance<typeof collections>> {
  return createCMS({
    collections,
    db: memoryDatabase({ provider: "memory", collections }),
    storage: memoryStorage({ provider: "memory" }),
    plugins: [
      cors({
        origin: true,
        credentials: true,
        allowedHeaders: ["authorization", "content-type", "x-requested-with"],
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
      }),
      openapi({
        title: "Hono CMS (Cloudflare Worker, plugin shape)",
        version: "0.2.0",
        description: "Plugin-manifest example served from a Cloudflare Worker."
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

export type CloudflareExport = {
  fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
  scheduled?(event: unknown, env: unknown, ctx: unknown): Promise<void>;
};

export function createCloudflareExampleWorker(options: CloudflareExampleOptions = {}): CloudflareExport {
  let cached: CMSInstance<typeof collections> | null = null;
  let initPromise: Promise<CMSInstance<typeof collections>> | null = null;

  async function get(): Promise<CMSInstance<typeof collections>> {
    if (cached) return cached;
    if (!initPromise) initPromise = createCloudflareExampleCMS(options);
    cached = await initPromise;
    return cached;
  }

  return {
    async fetch(request, _env, _ctx) {
      const cms = await get();
      return cms.fetch(request);
    },
    ...(options.scheduledHandler
      ? {
          async scheduled(event, env, ctx) {
            const cron = typeof (event as { cron?: unknown }).cron === "string"
              ? (event as { cron: string }).cron
              : "";
            await options.scheduledHandler!(cron, env, ctx);
          }
        }
      : {})
  };
}

// Lazy-instantiated default export for `wrangler dev`. The CMS factory runs
// on the first request — never at module load — so Workers global scope
// stays free of timers and I/O.
const defaultExport = createCloudflareExampleWorker();

export default defaultExport;
