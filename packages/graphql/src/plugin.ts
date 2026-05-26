import {
  createPlugin,
  type Identity,
  type Plugin,
  type PluginContext
} from "@hono-cms/core";
import type { GraphQLSchema } from "graphql";
import { createApolloHandler } from "./apollo-handler";
import type { GraphQLContext } from "./context";
import { buildGraphQLSchema } from "./schema-builder";
import { createGraphQLSDL } from "./sdl";

/** Plugin id under which the GraphQL plugin self-registers. */
export const GRAPHQL_PLUGIN_ID = "graphql";

/** Default mount path. */
export const DEFAULT_GRAPHQL_PATH = "/graphql";

/** Plugin id of the auth plugin we look up for the session bridge. */
const AUTH_TOKENS_PLUGIN_ID = "auth-tokens";

/** Legacy alias paths kept for v0.x compatibility. */
const LEGACY_GRAPHQL_PATH = "/cms/graphql";
const LEGACY_GRAPHQL_SCHEMA_PATH = "/cms/graphql/schema";

export type GraphQLPluginConfig = {
  /** GraphQL endpoint. Defaults to `/graphql`. */
  path?: string;
  /** SDL endpoint. Defaults to `${path}/schema`. */
  schemaPath?: string;
  /**
   * Allow introspection queries. Defaults to `true` outside production
   * (`process.env.NODE_ENV === "production"` flips the default to `false`).
   */
  introspection?: boolean;
  /**
   * Mount `/cms/graphql` and `/cms/graphql/schema` aliases for compatibility
   * with the legacy core wiring. Defaults to `true`.
   */
  legacyAliases?: boolean;
};

/**
 * Build the `Plugin` manifest for `/graphql` + `/graphql/schema` (plus the
 * `/cms/*` legacy aliases).
 *
 * Behaviour:
 *   1. Build a `GraphQLSchema` from `ctx.collections` at install time.
 *   2. Subscribe to `schema:after-collection-add|remove|update` so the schema
 *      + apollo handler get rebuilt lazily. If a rebuild throws (e.g. the
 *      newly-added collection collides with a system field name) the previous
 *      handler stays active — GraphQL traffic keeps serving the last-known-
 *      good schema while REST continues to see the new collection.
 *   3. Resolve the session identity per-request via
 *      `ctx.plugins.get<AuthPlugin>("auth-tokens").identity(req)`. The contract
 *      is self-contained: `identity(req)` must resolve from the raw `Request`
 *      alone (headers/cookies/body) without depending on Hono context state.
 *      That's the KTD-2 / R15 architectural rule.
 *   4. `POST /graphql` executes via Apollo Server; `GET /graphql/schema`
 *      returns the textual SDL.
 */
export function graphql(opts: GraphQLPluginConfig = {}): Plugin {
  const path = opts.path ?? DEFAULT_GRAPHQL_PATH;
  const schemaPath = opts.schemaPath ?? `${path}/schema`;
  const introspectionDefault = !isProduction();
  const introspection = opts.introspection ?? introspectionDefault;
  const legacyAliases = opts.legacyAliases !== false;

  return createPlugin({
    id: GRAPHQL_PLUGIN_ID,
    app: (app, ctx) => {
      let schema: GraphQLSchema = buildGraphQLSchema(ctx.collections);
      let handler = createApolloHandler({ schema, introspection });

      const rebuild = (): void => {
        try {
          const next = buildGraphQLSchema(ctx.collections);
          schema = next;
          handler = createApolloHandler({ schema, introspection });
        } catch (err) {
          // Schema rebuild failure: keep the previous handler so GraphQL
          // traffic stays on the last-known-good schema. REST routes (the
          // content-type-builder owns those) keep serving the new collection.
          console.warn(
            "@hono-cms/graphql: schema rebuild failed; keeping previous schema:",
            err instanceof Error ? err.message : err
          );
        }
      };

      ctx.events.on("schema:after-collection-add", () => rebuild());
      ctx.events.on("schema:after-collection-remove", () => rebuild());
      ctx.events.on("schema:after-collection-update", () => rebuild());

      // -- handler wiring ---------------------------------------------------

      const buildContext = async (request: Request): Promise<GraphQLContext> => {
        const identity = await resolveIdentity(request, ctx);
        return {
          collections: ctx.collections,
          db: ctx.db,
          identity,
          request,
          events: ctx.events,
          hooks: ctx.hooks
        };
      };

      const serveGraphQL = async (request: Request): Promise<Response> => {
        const requestContext = await buildContext(request);
        return handler(request, requestContext);
      };

      const serveSDL = (): Response =>
        new Response(createGraphQLSDL(ctx.collections), {
          headers: { "content-type": "text/plain; charset=utf-8" }
        });

      // -- routes -----------------------------------------------------------

      app.all(path, (c) => serveGraphQL(c.req.raw));
      app.get(schemaPath, () => serveSDL());

      if (legacyAliases && path !== LEGACY_GRAPHQL_PATH) {
        app.all(LEGACY_GRAPHQL_PATH, (c) => serveGraphQL(c.req.raw));
      }
      if (legacyAliases && schemaPath !== LEGACY_GRAPHQL_SCHEMA_PATH) {
        app.get(LEGACY_GRAPHQL_SCHEMA_PATH, () => serveSDL());
      }

      return app;
    }
  });
}

type IdentityResolver = (req: Request, ctx: PluginContext) => Promise<Identity | null> | Identity | null;

async function resolveIdentity(
  request: Request,
  ctx: PluginContext
): Promise<Identity | null> {
  if (!ctx.plugins.has(AUTH_TOKENS_PLUGIN_ID)) return null;
  // The auth plugin can publish its `identity` resolver in one of two shapes:
  //  - On the service object it registers (`ctx.plugins.get("auth-tokens")` →
  //    `{ identity(req, ctx): Promise<Identity | null> }`).
  //  - On the `AuthPlugin` manifest itself (the R15 contract). The kernel
  //    doesn't auto-register manifests on the service registry today, so this
  //    branch is reserved for plugins that explicitly register themselves.
  const candidate = ctx.plugins.get<{ identity?: IdentityResolver }>(AUTH_TOKENS_PLUGIN_ID);
  const resolver = typeof candidate?.identity === "function" ? candidate.identity : undefined;
  if (!resolver) return null;
  try {
    const result = await resolver(request, ctx);
    return result ?? null;
  } catch {
    // Auth plugins should not throw on a missing token; treat any throw as
    // anonymous so GraphQL public reads remain reachable.
    return null;
  }
}

function isProduction(): boolean {
  if (typeof process === "undefined") return false;
  return process.env?.NODE_ENV === "production";
}
