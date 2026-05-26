import type { Hono } from "hono";
import type { CMSCollections, CollectionDefinition, FieldsDefinition, InferCMS } from "@hono-cms/schema";
import type { AuthAdapter, CacheAdapter, DatabaseAdapter, JobsAdapter, StorageAdapter } from "./providers";

export type HonoCMSEnv = {
  Variables: {
    session: { userId: string; roles: string[] } | null;
  };
};

export type CMSInternals<Collections extends CMSCollections> = {
  collections: Collections;
  db: DatabaseAdapter<Collections>;
  storage: StorageAdapter | null;
  cache: CacheAdapter | null;
  jobs: JobsAdapter | null;
  auth: AuthAdapter;
};

export type CMSInstance<Collections extends CMSCollections = CMSCollections> =
  Hono<HonoCMSEnv> &
  CMSInternals<Collections> & {
    content: InferCMS<Collections>;
    scheduled(event: unknown, env?: unknown, ctx?: unknown): Promise<void>;
    scheduledHandler(cron: string, env?: unknown, ctx?: unknown): Promise<void>;
    /**
     * Register a new collection at runtime. The CMS will start serving the
     * collection's REST routes, GraphQL types, and OpenAPI paths immediately
     * — no server restart required. Used by the Content-Type Builder so admins
     * can create a collection and POST records into it without re-`createCMS()`.
     */
    registerCollection(collection: CollectionDefinition<string, FieldsDefinition>): void;
    /**
     * Stop serving a collection that was previously registered (or that the
     * CMS booted with). Routes return 404, GraphQL types are dropped, and
     * OpenAPI paths are refreshed.
     */
    unregisterCollection(name: string): void;
  };
