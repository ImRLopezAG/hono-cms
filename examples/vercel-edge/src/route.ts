/**
 * Vercel Edge example, migrated to the plugin manifest shape (U25).
 *
 * Vercel Edge functions run on a Web-standard `(Request) => Response`
 * contract — the same surface the plugin runtime produces. We avoid
 * module-load side effects (no factory invocation at import time) by
 * lazy-instantiating the CMS on first request. This mirrors the
 * `cloudflare-worker` example: Workers and Vercel Edge share the same
 * "no setInterval/no fs at module scope" constraint.
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

export const runtime = "edge";

export type VercelExampleOptions = {
  /** Optional callback fired with the raw bootstrap key on first boot. */
  onBootstrapKey?: (key: string) => void;
};

export async function createVercelExampleCMS(options: VercelExampleOptions = {}): Promise<CMSInstance<typeof collections>> {
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
        title: "Hono CMS (Vercel Edge, plugin shape)",
        version: "0.2.0",
        description: "Plugin-manifest example exported as a Vercel Edge `(Request) => Response` handler."
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

export type VercelEdgeHandler = (request: Request) => Promise<Response>;

/**
 * Build a lazy `(Request) => Promise<Response>` handler. The CMS factory
 * runs on the first request — never at module load — so the Edge runtime
 * global scope stays free of timers and I/O.
 */
export function createVercelExampleHandler(options: VercelExampleOptions = {}): VercelEdgeHandler {
  let cached: CMSInstance<typeof collections> | null = null;
  let initPromise: Promise<CMSInstance<typeof collections>> | null = null;

  async function get(): Promise<CMSInstance<typeof collections>> {
    if (cached) return cached;
    if (!initPromise) initPromise = createVercelExampleCMS(options);
    cached = await initPromise;
    return cached;
  }

  return async (request) => {
    const cms = await get();
    return cms.fetch(request);
  };
}

// Lazy default handler — instantiated once at module load, but the CMS
// factory inside it only runs when the first request arrives.
export const handler: VercelEdgeHandler = createVercelExampleHandler();

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;

export default handler;
