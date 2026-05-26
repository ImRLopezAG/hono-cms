/**
 * Configuration types for the `@hono-cms/openapi` plugin.
 *
 * `OpenAPIConfig` is ported verbatim from
 * `packages/core/src/types/config.ts:33-52` so the plugin owns its public
 * surface without re-importing from core. Keep these declarations in sync
 * until the kernel drops its inline `openapi:` config key in favor of
 * `plugins: [openapi(...)]`.
 *
 * `CorsConfig`/`CorsOrigin` are duplicated for the same reason — the plugin's
 * spec-routes-only CORS option is independent of the global CMS CORS plugin
 * and we don't want a hard dependency on `@hono-cms/cors` from this package.
 */

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

export type OpenAPIServer = {
  url: string;
  description?: string;
};

export type OpenAPIConfig = {
  title?: string;
  version?: string;
  description?: string;
  servers?: readonly OpenAPIServer[];
  /** Public docs route. `docsPath` is kept as a backwards-compatible alias. */
  docs?: string;
  docsPath?: string;
  /** Public OpenAPI JSON route. `specPath` is kept as a backwards-compatible alias. */
  path?: string;
  specPath?: string;
  /**
   * CORS policy for the public spec/docs routes. Independent of any global
   * CORS plugin so the kernel can serve spec/docs cross-origin even when the
   * rest of the API is locked down.
   */
  cors?: boolean | CorsConfig;
  /**
   * When `true` the plugin omits the `/docs` route and gates the spec path
   * behind `path`/`specPath` being explicitly set. Defaults to `false`. The
   * kernel previously inferred this from `NODE_ENV`; plugin consumers should
   * pass it explicitly.
   */
  production?: boolean;
  /**
   * GraphQL spec hints — when set the assembled spec describes the GraphQL
   * paths. `false` removes the GraphQL section entirely. Defaults to `false`
   * since this plugin only owns spec assembly and the GraphQL plugin is the
   * source of truth for its own routes.
   */
  graphql?: false | {
    path?: string;
    schemaPath?: string;
  };
};

/**
 * Description of a single OpenAPI path entry — the shape `addPath()` accepts.
 *
 * Keys are HTTP methods (lowercase) plus optional `parameters` / `summary` /
 * extension fields. The plugin merges each registered entry into the assembled
 * spec under the given path.
 */
export type OpenAPIPathItem = Record<string, unknown>;

export type OpenAPISpec = {
  openapi: string;
  info: Record<string, unknown>;
  servers?: unknown;
  tags?: unknown;
  paths: Record<string, OpenAPIPathItem>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
  [key: string]: unknown;
};

/**
 * Service registered on the plugin registry under id `"openapi"`. Other
 * plugins (`auth-tokens`, `media`, …) call `addPath()` to inject their routes
 * into the spec, `refresh()` to force a rebuild, and `getSpec()` to read the
 * current cached spec.
 */
export type OpenAPIService = {
  /** Force the cached spec + ETag to be rebuilt on the next read. */
  refresh(): void;
  /** Return the (lazily built) merged OpenAPI document. */
  getSpec(): OpenAPISpec;
  /**
   * Merge an additional path into the spec. Plugins call this when they mount
   * their own routes so the assembled document stays in lockstep with the
   * running API surface.
   */
  addPath(path: string, methods: OpenAPIPathItem): void;
};
