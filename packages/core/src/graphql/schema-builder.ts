import { makeExecutableSchema } from "@graphql-tools/schema";
import type { GraphQLSchema } from "graphql";
import type { CMSCollections } from "@hono-cms/schema";
import { createGraphQLSDL } from "../graphql";
import { buildResolvers } from "./resolvers";

/**
 * Compile the CMS collections into a real `GraphQLSchema` backed by
 * `@graphql-tools/schema`. The SDL is the same string emitted at
 * `/cms/graphql/schema`, ensuring REST clients, the SDL endpoint, and the
 * Apollo Server execution path all describe the schema identically.
 */
export function buildGraphQLSchema(collections: CMSCollections): GraphQLSchema {
  const typeDefs = createGraphQLSDL(collections);
  const resolvers = buildResolvers(collections);
  return makeExecutableSchema({ typeDefs, resolvers });
}
