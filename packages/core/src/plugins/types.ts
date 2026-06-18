import type { Context, Hono, MiddlewareHandler } from "hono";
import type {
  AdapterCapabilities,
  CMSCollections,
  CollectionDefinition,
  ContentRecord,
  FieldsDefinition
} from "@hono-cms/schema";
import type { HonoCMSEnv } from "../types/instance";
import type {
  AuditStore,
  CacheAdapter,
  DatabaseAdapter,
  JobEnqueueOptions,
  JobHandler,
  JobsAdapter,
  MediaStore,
  StorageAdapter,
  TranslationProvider,
  TranslationStore,
  WebhookStore,
  WebhookTarget
} from "../types/providers";

export type Awaitable<T> = T | Promise<T>;

export type Identity = unknown;

export type AuthorizeAction =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "publish"
  | "unpublish"
  | "admin"
  | (string & {});

export type Authorize = (
  action: AuthorizeAction,
  collection: string | null,
  resource?: ContentRecord | null
) => boolean | Promise<boolean>;

export type FieldType = "string" | "number" | "boolean" | "date" | "json";

export type FieldDef = {
  type: FieldType;
  required?: boolean;
  unique?: boolean;
  references?: { table: string; field?: string };
};

export type PluginTableDef = {
  fields: Record<string, FieldDef>;
  modelName?: string;
  disableMigration?: boolean;
};

export type SchemaExtension = Record<string, PluginTableDef>;

export type CMSPluginCapabilities<Collections extends CMSCollections = CMSCollections> = {
  reads?: readonly (keyof Collections & string)[];
  writes?: readonly ((keyof Collections & string) | "media")[];
  requiresEnv?: readonly string[];
  requiresAdapter?: readonly (keyof AdapterCapabilities)[];
};

export type RateLimitDeclaration = {
  pathMatcher: (path: string) => boolean;
  limit: number;
  window: number;
};

export type HookMatcher = (c: Context<HonoCMSEnv>) => boolean;

export type MiddlewareDeclaration = {
  path: string | RegExp;
  middleware: MiddlewareHandler<HonoCMSEnv>;
};

export type HookDeclaration = {
  matcher: HookMatcher;
  handler: MiddlewareHandler<HonoCMSEnv>;
};

export type LifecycleHookEvent =
  | "before-create"
  | "after-create"
  | "before-update"
  | "after-update"
  | "before-delete"
  | "after-delete";

export type LifecycleHookContext = {
  collection: string;
  id?: string;
  identity: Identity | null;
  request: Request;
};

export type LifecycleHookHandler = (
  input: Record<string, unknown>,
  ctx: LifecycleHookContext
) => Awaitable<Record<string, unknown> | void>;

export type HookRegistry = {
  on(event: LifecycleHookEvent, collection: string | "*", handler: LifecycleHookHandler): () => void;
  run(
    event: LifecycleHookEvent,
    collection: string,
    input: Record<string, unknown>,
    ctx: LifecycleHookContext
  ): Promise<Record<string, unknown>>;
};

export type PluginEvents = {
  on<E extends keyof CMSEvents>(event: E, handler: (payload: CMSEvents[E]) => Awaitable<void>): () => void;
  emit<E extends keyof CMSEvents>(event: E, payload: CMSEvents[E]): Promise<void>;
};

/**
 * Cross-plugin contract for the `"jobs"` service published by
 * `@hono-cms/jobs-runtime`. The runtime's full `JobsService` extends this; the
 * minimum surface needed for consumers like `audit`, `drafts`, `i18n`, and
 * `webhooks` lives here so cross-plugin consumption types automatically.
 */
export interface JobsService {
  /** Register a job handler under `name`. Mounts `POST /cms/jobs/<name>`. */
  registerJob(name: string, handler: JobHandler): void;
  /** Dispatch a registered job in-process. */
  dispatch(name: string, payload?: unknown): Promise<void>;
  /** Enqueue an HTTP-style job through the configured adapter. */
  enqueue(endpoint: string, body?: unknown, opts?: JobEnqueueOptions): Promise<void>;
  /** Read-only handle to the underlying queue adapter. */
  readonly adapter: JobsAdapter;
}

/**
 * Canonical contract for the `"audit"` service published by `@hono-cms/audit`.
 * The full shape lives here so consumers and tests get typed access without
 * importing the producer package.
 */
export interface AuditService {
  readonly store: AuditStore;
  readonly config: {
    readonly retentionDays: number;
    readonly excludeFields: readonly string[];
    readonly maxFieldBytes: number;
  };
}

/**
 * Canonical contract for the `"i18n"` service published by `@hono-cms/i18n`.
 */
export interface I18nService {
  readonly store: TranslationStore;
  readonly provider: TranslationProvider | null;
  readonly config: {
    readonly autoTranslate: boolean;
    readonly translateOnPublish: boolean;
  };
}

/**
 * Canonical contract for the `"webhooks"` service published by
 * `@hono-cms/webhooks`.
 */
export interface WebhooksService {
  readonly store: WebhookStore;
  readonly targets: readonly WebhookTarget[];
}

/**
 * Canonical contract for the `"media"` service published by
 * `@hono-cms/media`.
 */
export interface MediaService {
  readonly store: MediaStore;
  readonly config: {
    readonly presignExpirySeconds: number;
    readonly maxPresignUploadSizeBytes: number;
    readonly allowActiveContent: boolean;
  };
}

/**
 * Cross-plugin contract for the `"openapi"` service published by
 * `@hono-cms/openapi`. Other plugins call `addPath(...)` when they mount
 * their own routes so the assembled document stays in lockstep with the
 * running API surface.
 */
export interface OpenAPIService {
  refresh(): void;
  getSpec(): unknown;
  addPath(path: string, methods: unknown): void;
}

/**
 * Open registry of typed plugin services. The canonical service IDs ship with
 * their minimum cross-plugin contracts inline so `ctx.plugins.get("cache")`
 * returns `CacheAdapter` universally — no per-package import dance needed.
 *
 * Third-party plugins can extend the registry via module augmentation:
 *
 *     declare module "@hono-cms/core" {
 *       interface CMSPluginServices {
 *         "my-plugin": MyService;
 *       }
 *     }
 *
 * IDs not registered fall through to `unknown`, preserving the open-ended
 * nature of the service registry while rewarding contributors who declare
 * their contract.
 */
export interface CMSPluginServices {
  cache: CacheAdapter;
  jobs: JobsService;
  audit: AuditService;
  i18n: I18nService;
  webhooks: WebhooksService;
  media: MediaService;
  openapi: OpenAPIService;
  // `"auth-tokens"` deliberately lives in `@hono-cms/auth-tokens` itself —
  // see that package's `declare module "@hono-cms/core"` block. AuthPlugin
  // implementations are the most variable surface (different vendors expose
  // different shapes), so the augmentation pattern belongs at the producer.
}

export type PluginServices = {
  get<K extends string>(
    id: K
  ): K extends keyof CMSPluginServices ? CMSPluginServices[K] : unknown;
  has(id: string): boolean;
  register<K extends string>(
    id: K,
    value: K extends keyof CMSPluginServices ? CMSPluginServices[K] : unknown
  ): void;
};

export type PluginContext<Collections extends CMSCollections = CMSCollections> = {
  collections: Collections;
  db: DatabaseAdapter<Collections>;
  storage?: StorageAdapter | undefined;
  mediaStore?: MediaStore | undefined;
  env: Record<string, unknown>;
  baseUrl?: string | undefined;
  plugins: PluginServices;
  events: PluginEvents;
  hooks: HookRegistry;
  systemTables: ReadonlyMap<string, PluginTableDef>;
};

export type MountPhase = "early" | "normal" | "catchAll";

export type Plugin<Collections extends CMSCollections = CMSCollections> = {
  id: string;
  requires?: readonly string[];
  schema?: SchemaExtension;
  app?: (app: Hono<HonoCMSEnv>, ctx: PluginContext<Collections>) => Hono<HonoCMSEnv> | void | Promise<Hono<HonoCMSEnv> | void>;
  hooks?: {
    before?: ReadonlyArray<HookDeclaration>;
    after?: ReadonlyArray<HookDeclaration>;
  };
  middlewares?: ReadonlyArray<MiddlewareDeclaration>;
  onRequest?: (req: Request, ctx: PluginContext<Collections>) => Awaitable<Response | Request | void>;
  onResponse?: (res: Response, ctx: PluginContext<Collections>) => Awaitable<Response | void>;
  rateLimit?: ReadonlyArray<RateLimitDeclaration>;
  trustedOrigins?: readonly string[];
  installAuthorize?: (ctx: PluginContext<Collections>) => Authorize;
  capabilities?: CMSPluginCapabilities<Collections>;
  mountPhase?: MountPhase;
};

export type AuthPlugin<Collections extends CMSCollections = CMSCollections> = Plugin<Collections> & {
  protected: MiddlewareHandler<HonoCMSEnv>;
  identity?: (req: Request, ctx: PluginContext<Collections>) => Awaitable<Identity | null>;
};

export interface CMSEvents {
  "schema:after-collection-add": {
    name: string;
    collection: CollectionDefinition<string, FieldsDefinition>;
  };
  "schema:after-collection-remove": { name: string };
  "schema:after-collection-update": {
    name: string;
    before: CollectionDefinition<string, FieldsDefinition>;
    after: CollectionDefinition<string, FieldsDefinition>;
  };
  "content:after-create": {
    collection: string;
    record: ContentRecord;
    identity: Identity | null;
    request: Request;
  };
  "content:after-update": {
    collection: string;
    record: ContentRecord;
    before: ContentRecord | null;
    identity: Identity | null;
    request: Request;
  };
  "content:after-delete": {
    collection: string;
    id: string;
    record: ContentRecord | null;
    identity: Identity | null;
    request: Request;
  };
  "content:after-publish": {
    collection: string;
    record: ContentRecord;
    identity: Identity | null;
    request: Request;
  };
  "content:after-unpublish": {
    collection: string;
    record: ContentRecord;
    identity: Identity | null;
    request: Request;
  };
  "media:after-upload": {
    record: Record<string, unknown>;
    identity: Identity | null;
    request: Request;
  };
  "media:after-delete": {
    record: Record<string, unknown>;
    identity: Identity | null;
    request: Request;
  };
}

export class CMSPluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CMSPluginError";
  }
}
