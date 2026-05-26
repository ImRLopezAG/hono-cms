import { makeExecutableSchema } from "@graphql-tools/schema";
import type { GraphQLSchema } from "graphql";
import type { CMSCollections } from "@hono-cms/schema";
import { createGraphQLSDL } from "./sdl";
import { buildResolvers } from "./resolvers";

/**
 * Compile the CMS collections into a real `GraphQLSchema` backed by
 * `@graphql-tools/schema`. The SDL fed in here is the same string emitted at
 * `/graphql/schema`, ensuring REST clients, the SDL endpoint, and the Apollo
 * execution path describe the schema identically.
 */
export function buildGraphQLSchema(collections: CMSCollections): GraphQLSchema {
  const typeDefs = createGraphQLSDL(collections);
  const resolvers = buildResolvers(collections);
  return makeExecutableSchema({ typeDefs, resolvers });
}
