import type { Context, Hono, MiddlewareHandler } from "hono";
import type {
  AdapterCapabilities,
  CMSCollections,
  CollectionDefinition,
  ContentRecord,
  FieldsDefinition
} from "@hono-cms/schema";
import type { HonoCMSEnv } from "../types/instance";
import type { DatabaseAdapter, MediaStore, StorageAdapter } from "../types/providers";

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

export type PluginServices = {
  get<T = unknown>(id: string): T;
  has(id: string): boolean;
  register(id: string, value: unknown): void;
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
