import { createCMS, MemoryApiKeyStore, MemoryMediaStore } from "@hono-cms/core";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { createMemoryStorage } from "@hono-cms/storage-memory";
import { createMemoryCache } from "@hono-cms/cache";
import "@hono-cms/jobs";
import { createVercelHandler, generateVercelJson } from "@hono-cms/platform/vercel";
import { collections } from "./schema";

export const runtime = "edge";
export const cronSecret = "vercel-edge-cron-secret";

/**
 * Build a fresh CMS wired up with every in-memory adapter in the workspace so
 * the example boots without any external services. Mirrors the cross-runtime
 * matrix wiring (see `examples/bun-server`, `examples/cloudflare-worker`,
 * `examples/elysia-host`). Real deployments swap each adapter for its
 * production counterpart (Postgres / R2 / Upstash / QStash).
 */
export function createVercelExampleCMS() {
  return createCMS({
    collections,
    db: createMemoryDatabase({ provider: "memory", collections }),
    storage: createMemoryStorage({ provider: "memory" }),
    cache: createMemoryCache(),
    mediaStore: new MemoryMediaStore(),
    apiKeyStore: new MemoryApiKeyStore(),
    auth: {
      tokens: {
        admin: { userId: "vercel-admin", roles: ["admin"] },
        editor: { userId: "vercel-editor", roles: ["editor"] }
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
      title: "Hono CMS (Vercel Edge)",
      version: "0.1.0",
      description: "Example CMS exported as a Vercel Edge route handler — `(Request) => Response`."
    },
    jobs: { provider: "vercel", secret: cronSecret, cronOnly: true }
  });
}

export const cms = createVercelExampleCMS();
export const handler = createVercelHandler(cms);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;

export const vercelJson = generateVercelJson({
  "/cms/jobs/scheduled-publish": "*/15 * * * *",
  "/cms/jobs/audit-log-cleanup": "0 3 * * *"
});
