import type { CMSCollections, CollectionDefinition, FieldsDefinition } from "@hono-cms/schema";
import type { CMSPlugin } from "../plugins";
import type { AuditStore, AuthAdapter, CacheAdapter, DatabaseAdapter, JobsAdapter, MediaStore, StorageAdapter, TranslationProvider, TranslationStore, WebhookStore, WebhookTarget } from "./providers";
import type { ApiKeyStore, BuiltInAuthConfig } from "../auth";
import type { AuthConfig } from "../auth/better-auth";
import type { OrganizationStore } from "../organization";

export type ProviderConfig<Provider extends string = string, Options extends Record<string, unknown> = Record<string, unknown>> =
  { provider: Provider } & Options;

export type RBACRule = {
  action: "create" | "read" | "update" | "delete" | "publish";
  collection: string;
  roles: readonly string[];
};

export type CorsOrigin =
  | boolean
  | "*"
  | string
  | readonly string[]
  | ((origin: string | null, request: Request) => boolean | string | null | undefined);

export type CorsConfig = {
  origin?: CorsOrigin;
  credentials?: boolean;
  methods?: readonly string[];
  allowedHeaders?: readonly string[];
  exposedHeaders?: readonly string[];
  maxAge?: number;
};

export type OpenAPIConfig = {
  title?: string;
  version?: string;
  description?: string;
  servers?: readonly {
    url: string;
    description?: string;
  }[];
  /** Public docs route. `docsPath` is kept as a backwards-compatible alias. */
  docs?: string;
  docsPath?: string;
  /** Public OpenAPI JSON route. `specPath` is kept as a backwards-compatible alias. */
  path?: string;
  specPath?: string;
  /**
   * CORS policy for the public spec/docs routes. Defaults to the global CMS
   * CORS policy when configured, otherwise keeps the legacy wildcard behavior.
   */
  cors?: boolean | CorsConfig;
};

export type GraphQLConfig = {
  /** Public GraphQL route. Defaults to `/graphql`; `/cms/graphql` remains mounted as a compatibility alias. */
  path?: string;
  /** SDL route. Defaults to `${path}/schema`; `/cms/graphql/schema` remains mounted as a compatibility alias. */
  schemaPath?: string;
  /** Introspection is enabled outside production and disabled in production unless explicitly enabled. */
  introspection?: boolean;
};

export type RateLimitConfig = {
  limit?: number;
  window?: string;
  prefix?: string;
};

export type SchemaWriteResult = {
  path?: string;
  source?: string;
  artifacts?: readonly string[];
  migrations?: readonly string[];
  message?: string;
};

export type SchemaWriteLifecycleInput = {
  collection: CollectionDefinition<string, FieldsDefinition>;
  source: string;
  mode: "create" | "update";
  result: SchemaWriteResult;
};

export type SchemaRemoveLifecycleInput = {
  collection: CollectionDefinition<string, FieldsDefinition>;
  mode: "remove";
  result: SchemaWriteResult;
};

export type SchemaWriter = {
  importPath?: string;
  writeCollection(input: {
    collection: CollectionDefinition<string, FieldsDefinition>;
    source: string;
    mode: "create" | "update";
  }): Promise<SchemaWriteResult> | SchemaWriteResult;
  /**
   * Optional: remove a previously generated collection file (and any other
   * artifacts the writer manages). Without this hook the backend exposes the
   * `DELETE /cms/content-types/:name` route as 501 — the writer cannot
   * guarantee a clean removal on disk.
   */
  removeCollection?(input: {
    collection: CollectionDefinition<string, FieldsDefinition>;
  }): Promise<SchemaWriteResult> | SchemaWriteResult;
  afterWrite?(input: SchemaWriteLifecycleInput): Promise<SchemaWriteResult | void> | SchemaWriteResult | void;
  afterRemove?(input: SchemaRemoveLifecycleInput): Promise<SchemaWriteResult | void> | SchemaWriteResult | void;
};

export type CMSConfig<Collections extends CMSCollections = CMSCollections> = {
  collections: Collections;
  env?: Record<string, unknown>;
  baseUrl?: string;
  db: DatabaseAdapter<Collections> | ProviderConfig;
  storage?: StorageAdapter | ProviderConfig;
  mediaStore?: MediaStore;
  cache?: CacheAdapter | ProviderConfig;
  contentCache?: false | {
    ttlSeconds?: number;
  };
  rateLimit?: false | {
    mutations?: RateLimitConfig;
    graphql?: false | RateLimitConfig;
    media?: false | RateLimitConfig;
    auth?: false | RateLimitConfig;
    admin?: false | RateLimitConfig;
    jobs?: false | RateLimitConfig;
  };
  i18n?: {
    provider?: TranslationProvider;
    store?: TranslationStore;
    autoTranslate?: boolean;
    translateOnPublish?: boolean;
  };
  jobs?: JobsAdapter | ProviderConfig;
  auth?: AuthAdapter | BuiltInAuthConfig | AuthConfig;
  apiKeyStore?: ApiKeyStore;
  organizationStore?: OrganizationStore;
  contentTypeBuilder?: false | {
    writer?: SchemaWriter;
  };
  rbac?: {
    publicRead?: boolean;
    rules?: readonly RBACRule[];
  };
  cors?: boolean | CorsConfig;
  openapi?: boolean | OpenAPIConfig;
  graphql?: false | GraphQLConfig;
  media?: {
    presignExpirySeconds?: number;
    maxPresignUploadSizeBytes?: number;
    /**
     * Allows browser-executable media types such as SVG, HTML, and XML.
     * Disabled by default so uploaded assets cannot become stored XSS payloads.
     */
    allowActiveContent?: boolean;
  };
  preview?: {
    url?: string;
  };
  auditLog?: false | {
    store?: AuditStore;
    retentionDays?: number;
    excludeFields?: readonly string[];
    maxFieldBytes?: number;
  };
  webhooks?: readonly WebhookTarget[];
  webhookStore?: WebhookStore;
  /**
   * Number of days to retain webhook delivery rows. Run by the
   * `webhook-delivery-cleanup` job. Defaults to 30. Set to 0 to disable.
   */
  webhookDeliveryRetentionDays?: number;
  plugins?: readonly CMSPlugin<Collections>[];
  hooks?: {
    beforeCreate?: HookFunction[];
    afterCreate?: HookFunction[];
    beforeUpdate?: HookFunction[];
    afterUpdate?: HookFunction[];
    beforeDelete?: HookFunction[];
    afterDelete?: HookFunction[];
  };
};

export type HookContext = {
  collection: string;
  id?: string;
  session: { userId: string; roles: string[] } | null;
  request: Request;
};

export type HookFunction = (input: Record<string, unknown>, context: HookContext) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
