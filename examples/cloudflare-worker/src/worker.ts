import { createCMS, MemoryApiKeyStore, MemoryMediaStore, type CMSInstance } from "@hono-cms/core";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { createMemoryStorage } from "@hono-cms/storage-memory";
import { createMemoryCache } from "@hono-cms/cache";
import { createCloudflareExport } from "@hono-cms/platform/cloudflare";
import { collections } from "./schema";

export type CloudflareExampleOptions = {
  scheduledHandler?: (cron: string, env: unknown, ctx: unknown) => Promise<void> | void;
};

export function createCloudflareExampleCMS(options: CloudflareExampleOptions = {}) {
  return createCMS({
    collections,
    db: createMemoryDatabase({ provider: "memory", collections }),
    storage: createMemoryStorage({ provider: "memory" }),
    cache: createMemoryCache(),
    mediaStore: new MemoryMediaStore(),
    apiKeyStore: new MemoryApiKeyStore(),
    // contentTypeBuilder.writer is intentionally omitted: Cloudflare Workers
    // have no filesystem, so schema mutation cannot be persisted from here.
    auth: {
      tokens: {
        admin: { userId: "admin_1", roles: ["admin"] },
        editor: { userId: "editor_1", roles: ["editor"] }
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
      path: "/cms/openapi.json",
      docs: "/cms/docs",
      title: "Hono CMS (Cloudflare Worker)",
      version: "0.1.0",
      description: "Example CMS served from a Cloudflare Worker runtime."
    },
    ...(options.scheduledHandler ? {
      jobs: {
        provider: "cloudflare-example",
        register: () => {},
        dispatch: async () => {},
        enqueue: async () => {},
        verify: async () => true,
        scheduledHandler: options.scheduledHandler
      }
    } : {})
  });
}

export function createCloudflareExampleWorker(options: CloudflareExampleOptions = {}) {
  return createCloudflareExport(createCloudflareExampleCMS(options));
}

// Cloudflare Workers forbid async I/O / timers in the global/module scope, so
// we lazy-instantiate the CMS on the first request rather than at import time.
// This still exports a default ExportedHandler compatible with `wrangler dev`.
let cachedCMS: Pick<CMSInstance, "fetch" | "scheduled"> | null = null;
function getCMS(): Pick<CMSInstance, "fetch" | "scheduled"> {
  if (!cachedCMS) cachedCMS = createCloudflareExampleCMS();
  return cachedCMS;
}

export default {
  fetch(request: Request, env: unknown, ctx: unknown) {
    return getCMS().fetch(request, env as never, ctx as never);
  },
  scheduled(event: unknown, env: unknown, ctx: unknown) {
    return getCMS().scheduled(event, env, ctx);
  }
};
