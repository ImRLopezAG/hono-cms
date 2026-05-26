import type { CMSCollections } from "@hono-cms/schema";
import type { AuditConfig } from "../audit";
import type { ContentCacheOptions } from "../content/cache";
import type { HookFunction } from "../types/config";
import type { AuditStore, AuthSession, CacheAdapter, DatabaseAdapter, JobsAdapter, WebhookStore, WebhookTarget } from "../types/providers";

/**
 * Context carried by the Apollo Server resolvers. Built once per HTTP request
 * from the surrounding `createCMS` configuration. Resolvers are kept thin and
 * delegate to the shared content helpers using these references.
 */
export type CMSGraphQLContext = {
  collections: CMSCollections;
  db: DatabaseAdapter<CMSCollections>;
  cache: CacheAdapter | null;
  contentCache?: ContentCacheOptions;
  session: AuthSession | null;
  jobs: JobsAdapter | null;
  request: Request;
  introspection?: boolean;
  canRead(collection: string): boolean;
  canAccess(collection: string, action: "create" | "update" | "delete" | "publish"): boolean;
  publicStatus(collection: string): { status?: "published" };
  hooks?: {
    beforeCreate?: HookFunction[];
    afterCreate?: HookFunction[];
    beforeUpdate?: HookFunction[];
    afterUpdate?: HookFunction[];
    beforeDelete?: HookFunction[];
    afterDelete?: HookFunction[];
  };
  auditStore?: AuditStore | null;
  auditConfig?: AuditConfig;
  webhooks?: readonly WebhookTarget[];
  webhookStore?: WebhookStore | null;
  /**
   * Per-request mutable bag used by the Apollo handler to surface caching
   * outcomes (ETags, x-cms-cache header, 304s) at the HTTP response layer.
   * Apollo Server clones the context object before handing it to resolvers,
   * so we share state via this nested object — its identity survives the
   * clone because the wrapper still points at the same inner reference.
   */
  cacheOutcome: { value?: CacheOutcome };
};

export type CacheOutcome = {
  status: "hit" | "miss";
  etag?: string;
  /** When set, the handler should return a 304 with these headers and an empty body. */
  notModified?: boolean;
};
