/**
 * `@hono-cms/graphql` — Apollo Server-backed GraphQL plugin for hono-cms.
 *
 * Exposes a single factory, {@link graphql}, that wraps:
 *
 *  - The GraphQL SDL generator (the textual schema at `GET /graphql/schema`).
 *  - The executable schema (built once at install, rebuilt lazily on the
 *    `schema:after-collection-*` events).
 *  - Apollo Server HTTP handler — introspection-gated, no demand limits.
 *  - The session bridge: `identity(req)` resolved via
 *    `ctx.plugins.get<AuthPlugin>("auth-tokens").identity(req)`, matching the
 *    R15 / KTD-2 architectural rule.
 *  - Compatibility aliases at `/cms/graphql` and `/cms/graphql/schema`.
 *
 * Add to your CMS config:
 *
 *     import { createCMS } from "@hono-cms/core";
 *     import { graphql } from "@hono-cms/graphql";
 *
 *     const cms = createCMS({
 *       db,
 *       collections,
 *       plugins: [graphql({})]
 *     });
 */
export { graphql, GRAPHQL_PLUGIN_ID, DEFAULT_GRAPHQL_PATH } from "./plugin";
export type { GraphQLPluginConfig } from "./plugin";
export { buildGraphQLSchema } from "./schema-builder";
export { createGraphQLSDL } from "./sdl";
export { createApolloHandler } from "./apollo-handler";
export type { CreateApolloHandlerOptions } from "./apollo-handler";
export { buildResolvers } from "./resolvers";
export type { CMSResolvers } from "./resolvers";
export type { GraphQLContext } from "./context";
