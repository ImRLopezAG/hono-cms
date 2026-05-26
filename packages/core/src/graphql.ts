/**
 * GraphQL SDL generator.
 *
 * Plan-6 U4/U5 history: this module used to host an 800-line hand-rolled
 * GraphQL handler (`handleGraphQL`) that parsed queries with a regex-based
 * mini-parser, walked CMS collections directly, and produced an ad-hoc
 * response envelope. That handler is now replaced by `./graphql/apollo-handler`
 * which serves a real `GraphQLSchema` (built via `./graphql/schema-builder`)
 * through Apollo Server v5. The CMS-specific execution paths (RBAC, audit,
 * webhooks, hooks, ETag caching, query demand limits) moved into Apollo
 * resolvers under `./graphql/resolvers.ts`.
 *
 * The SDL builder below is kept because:
 * - the public `/cms/graphql/schema` endpoint still serves the textual SDL,
 *   and existing tests assert on the precise string layout;
 * - `buildGraphQLSchema` reuses these definitions verbatim as `typeDefs`
 *   passed into `makeExecutableSchema`, guaranteeing the served SDL and the
 *   executed schema stay in lockstep.
 */
import { isManyRelation, type CMSCollections, type FieldDefinition } from "@hono-cms/schema";

export function createGraphQLSDL(collections: CMSCollections): string {
  const filterInputs = Object.values(collections).map((collection) => {
    const typeName = pascal(collection.name);
    const fields = Object.entries(collection.fields)
      .filter(([, field]) => !field.private)
      .map(([name, field]) => `  ${name}: ${graphQLFilterInputType(field, collections)}`)
      .join("\n");
    return `input ${typeName}FilterInput {\n${fields}\n}`;
  });
  const types = Object.values(collections).map((collection) => {
    const fields = [
      "  id: ID!",
      "  createdAt: String",
      "  updatedAt: String",
      collection.options.draftAndPublish ? "  status: ContentStatus" : null,
      collection.options.draftAndPublish ? "  publishedAt: String" : null,
      collection.options.i18n ? "  locale: String" : null,
      ...Object.entries(collection.fields)
        .filter(([, field]) => !field.private)
        .map(([name, field]) => `  ${name}: ${graphQLOutputType(field)}`)
    ].filter(Boolean).join("\n");
    return `type ${pascal(collection.name)} {\n${fields}\n}\n\ntype ${pascal(collection.name)}Connection {\n  items: [${pascal(collection.name)}!]!\n  nextCursor: String\n  meta: PaginationMeta!\n}`;
  });

  const queryFields = Object.values(collections).flatMap((collection) => {
    const singular = singularize(collection.name);
    const typeName = pascal(collection.name);
    return [
      `  ${collection.name}(filters: ${typeName}FilterInput, pagination: PaginationInput, limit: Int, cursor: String, page: Int, pageSize: Int, sort: [String!], status: ContentStatus, locale: String, preview: String, populate: [String!], fields: [String!]): ${typeName}Connection!`,
      `  ${singular}(id: ID!, locale: String, preview: String, populate: [String!], fields: [String!]): ${typeName}`
    ];
  }).join("\n");
  const inputTypes = Object.values(collections).flatMap((collection) => {
    const typeName = pascal(collection.name);
    // Include private fields in the create/update inputs so Apollo's
    // validator does not reject queries that historically tolerated them;
    // `./graphql/resolvers.ts` rejects them at execute time with the legacy
    // `VALIDATION_ERROR` extension code.
    const createFields = Object.entries(collection.fields)
      .map(([name, field]) => `  ${name}: ${graphQLInputType(field)}`);
    const updateFields = createFields;
    return [
      `input ${typeName}CreateInput {\n${createFields.join("\n")}\n}`,
      `input ${typeName}UpdateInput {\n${updateFields.join("\n")}\n}`
    ];
  });
  const mutationFields = Object.values(collections).flatMap((collection) => {
    const singular = pascal(singularize(collection.name));
    const typeName = pascal(collection.name);
    return [
      `  create${singular}(data: ${typeName}CreateInput!): ${typeName}!`,
      `  update${singular}(id: ID!, data: ${typeName}UpdateInput!): ${typeName}!`,
      `  delete${singular}(id: ID!): Boolean!`,
      collection.options.draftAndPublish ? `  publish${singular}(id: ID!): ${typeName}!` : null,
      collection.options.draftAndPublish ? `  unpublish${singular}(id: ID!): ${typeName}!` : null
    ].filter(Boolean);
  }).join("\n");

  return [
    "scalar JSON",
    "enum ContentStatus { draft published archived }",
    "type PaginationInfo { cursor: String hasMore: Boolean! total: Int }",
    "type PaginationMeta { pagination: PaginationInfo! }",
    "input PaginationInput { limit: Int cursor: String page: Int pageSize: Int }",
    "input StringFilter { eq: String ne: String contains: String notContains: String startsWith: String endsWith: String in: [String!] nin: [String!] null: Boolean notNull: Boolean between: [String!] }",
    "input NumberFilter { eq: Float ne: Float gt: Float gte: Float lt: Float lte: Float in: [Float!] nin: [Float!] null: Boolean notNull: Boolean between: [Float!] }",
    "input BooleanFilter { eq: Boolean ne: Boolean null: Boolean notNull: Boolean }",
    "input IDFilter { eq: ID ne: ID in: [ID!] nin: [ID!] null: Boolean notNull: Boolean }",
    ...filterInputs,
    ...types,
    ...inputTypes,
    `type Query {\n${queryFields}\n}`,
    `type Mutation {\n${mutationFields}\n}`
  ].join("\n\n");
}

function singularize(name: string): string {
  return name.endsWith("ies") ? `${name.slice(0, -3)}y` : name.endsWith("s") ? name.slice(0, -1) : `${name}Item`;
}

function pascal(value: string): string {
  return value.split(/[-_]/).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("");
}

function graphQLOutputType(field: FieldDefinition): string {
  switch (field.kind) {
    case "number":
      return "Float";
    case "boolean":
      return "Boolean";
    case "json":
      return "JSON";
    case "relation":
      return isManyRelation(field) ? `[${pascal(field.target)}!]` : pascal(field.target);
    case "media":
      return "ID";
    default:
      return "String";
  }
}

function graphQLInputType(field: FieldDefinition): string {
  const suffix = field.required ? "!" : "";
  switch (field.kind) {
    case "number":
      return `Float${suffix}`;
    case "boolean":
      return `Boolean${suffix}`;
    case "json":
      return `JSON${suffix}`;
    case "relation":
      return isManyRelation(field) ? `[ID!]` : `ID${suffix}`;
    case "media":
      return `ID${suffix}`;
    default:
      return `String${suffix}`;
  }
}

function graphQLFilterInputType(field: FieldDefinition, collections: CMSCollections): string {
  switch (field.kind) {
    case "number":
      return "NumberFilter";
    case "boolean":
      return "BooleanFilter";
    case "relation":
      return collections[field.target] ? `${pascal(field.target)}FilterInput` : "IDFilter";
    case "media":
      return "IDFilter";
    default:
      return "StringFilter";
  }
}
