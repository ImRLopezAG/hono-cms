import { GraphQLError, GraphQLScalarType, Kind, type GraphQLResolveInfo, type SelectionNode, type ValueNode } from "graphql";
import { collectionToZod, type CMSCollections } from "@hono-cms/schema";
import type { GraphQLContext } from "./context";

const GRAPHQL_FILTER_OPERATORS = new Set([
  "eq", "ne", "contains", "notContains", "startsWith", "endsWith",
  "gt", "gte", "lt", "lte", "in", "nin", "null", "notNull", "between"
]);

export type CMSResolvers = {
  Query: Record<string, (parent: unknown, args: Record<string, unknown>, context: GraphQLContext, info: GraphQLResolveInfo) => Promise<unknown>>;
  Mutation: Record<string, (parent: unknown, args: Record<string, unknown>, context: GraphQLContext, info: GraphQLResolveInfo) => Promise<unknown>>;
  JSON: GraphQLScalarType;
};

/**
 * Build the Query + Mutation resolver map plus the JSON scalar implementation
 * used by `makeExecutableSchema`. The U21 plugin carve preserves the legacy
 * resolver shape (list, item, create, update, delete, publish, unpublish) but
 * drops the direct audit/webhook/content-cache calls — those concerns now
 * subscribe to the events this module emits on `ctx.events`.
 */
export function buildResolvers(collections: CMSCollections): CMSResolvers {
  const Query: CMSResolvers["Query"] = {};
  const Mutation: CMSResolvers["Mutation"] = {};

  for (const collection of Object.values(collections)) {
    const collectionName = collection.name;
    const singularRoot = singularize(collectionName);
    const singularType = pascal(singularRoot);

    Query[collectionName] = (_parent, args, context) => listResolver(context, collectionName, args);
    Query[singularRoot] = (_parent, args, context) => itemResolver(context, collectionName, args);

    Mutation[`create${singularType}`] = (_parent, args, context) => createResolver(context, collectionName, args);
    Mutation[`update${singularType}`] = (_parent, args, context) => updateResolver(context, collectionName, args);
    Mutation[`delete${singularType}`] = (_parent, args, context) => deleteResolver(context, collectionName, args);
    if (collection.options.draftAndPublish) {
      Mutation[`publish${singularType}`] = (_parent, args, context) => publishResolver(context, collectionName, args, "publish");
      Mutation[`unpublish${singularType}`] = (_parent, args, context) => publishResolver(context, collectionName, args, "unpublish");
    }
  }

  const JSON = new GraphQLScalarType({
    name: "JSON",
    description: "Arbitrary JSON value passed through without coercion.",
    serialize: (value) => value,
    parseValue: (value) => value,
    parseLiteral: parseJSONLiteral
  });

  return { Query, Mutation, JSON };
}

function parseJSONLiteral(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return ast.values.map((node) => parseJSONLiteral(node));
    case Kind.OBJECT:
      return Object.fromEntries(ast.fields.map((field) => [field.name.value, parseJSONLiteral(field.value)]));
    default:
      return null;
  }
}

async function listResolver(
  context: GraphQLContext,
  collectionName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const collection = context.collections[collectionName];
  if (!collection) throw notFound(`Unknown collection "${collectionName}"`);

  const query: Record<string, unknown> = {};
  const pagination = args.pagination && typeof args.pagination === "object" && !Array.isArray(args.pagination)
    ? args.pagination as Record<string, unknown>
    : {};
  const limit = typeof pagination.limit === "number" ? pagination.limit : args.limit;
  const cursor = typeof pagination.cursor === "string" ? pagination.cursor : args.cursor;
  const page = typeof pagination.page === "number" ? pagination.page : args.page;
  const pageSize = typeof pagination.pageSize === "number" ? pagination.pageSize : args.pageSize;
  if (typeof limit === "number") query.limit = Math.min(Math.max(limit, 1), 100);
  if (typeof cursor === "string") query.cursor = cursor;
  if (typeof page === "number" && Number.isInteger(page) && page > 0) query.page = page;
  if (typeof pageSize === "number" && Number.isInteger(pageSize) && pageSize > 0) {
    query.pageSize = Math.min(Math.max(pageSize, 1), 100);
    query.limit = query.pageSize;
  }
  if (typeof args.status === "string") query.status = args.status;
  if (typeof args.sort === "string") query.sort = args.sort;
  if (Array.isArray(args.sort)) {
    const sort = args.sort.filter((field): field is string => typeof field === "string");
    if (sort.length) query.sort = sort.join(",");
  }
  if (args.filters && typeof args.filters === "object" && !Array.isArray(args.filters)) {
    query.filters = normalizeFilters(args.filters as Record<string, unknown>);
  }
  if (typeof args.locale === "string") query.locale = args.locale;
  if (Array.isArray(args.fields)) {
    const fields = args.fields.filter((field): field is string => typeof field === "string");
    if (fields.length) query.fields = fields;
  }

  const result = await context.db.list(collectionName, query);
  const items = projectRecords(collection, result.items, args.fields);
  return {
    items,
    nextCursor: result.nextCursor,
    meta: {
      pagination: {
        cursor: result.nextCursor,
        hasMore: Boolean(result.nextCursor),
        total: result.total
      }
    }
  };
}

async function itemResolver(
  context: GraphQLContext,
  collectionName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const collection = context.collections[collectionName];
  if (!collection) throw notFound(`Unknown collection "${collectionName}"`);
  const id = readIdArg(args);
  const record = await context.db.get(collectionName, id);
  if (!record) return null;
  return projectRecord(collection, record, args.fields);
}

async function createResolver(
  context: GraphQLContext,
  collectionName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const collection = context.collections[collectionName];
  if (!collection) throw notFound(`Unknown collection "${collectionName}"`);
  const data = readDataArg(args);

  // Validate input against the collection's Zod schema.
  const parsed = collectionToZod(collection).safeParse(data);
  if (!parsed.success) {
    throw graphqlError("Validation error", "VALIDATION_ERROR", { issues: parsed.error.issues });
  }

  try {
    // Run before-create hooks (shared lifecycle hook registry — same hooks that
    // REST mutations fire). Returning `void` keeps the existing payload; a
    // returned object replaces the payload.
    const input = await context.hooks.run(
      "before-create",
      collectionName,
      parsed.data as Record<string, unknown>,
      { collection: collectionName, identity: context.identity, request: context.request }
    );

    const record = await context.db.create(collectionName, input);

    await context.hooks.run(
      "after-create",
      collectionName,
      record as unknown as Record<string, unknown>,
      { collection: collectionName, id: record.id, identity: context.identity, request: context.request }
    );

    // Fan out the event so audit, webhooks, content-cache, etc. can react.
    await context.events.emit("content:after-create", {
      collection: collectionName,
      record,
      identity: context.identity,
      request: context.request
    });

    return projectRecord(collection, record, null);
  } catch (error) {
    throw mutationError(error);
  }
}

async function updateResolver(
  context: GraphQLContext,
  collectionName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const collection = context.collections[collectionName];
  if (!collection) throw notFound(`Unknown collection "${collectionName}"`);
  const id = readIdArg(args);
  const data = readDataArg(args);
  const before = await context.db.get(collectionName, id);
  try {
    const input = await context.hooks.run(
      "before-update",
      collectionName,
      data,
      { collection: collectionName, id, identity: context.identity, request: context.request }
    );
    const record = await context.db.update(collectionName, id, input);
    await context.hooks.run(
      "after-update",
      collectionName,
      record as unknown as Record<string, unknown>,
      { collection: collectionName, id: record.id, identity: context.identity, request: context.request }
    );
    await context.events.emit("content:after-update", {
      collection: collectionName,
      record,
      before,
      identity: context.identity,
      request: context.request
    });
    return projectRecord(collection, record, null);
  } catch (error) {
    throw mutationError(error);
  }
}

async function deleteResolver(
  context: GraphQLContext,
  collectionName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const collection = context.collections[collectionName];
  if (!collection) throw notFound(`Unknown collection "${collectionName}"`);
  const id = readIdArg(args);
  try {
    const existing = await context.db.get(collectionName, id);
    await context.hooks.run(
      "before-delete",
      collectionName,
      (existing as unknown as Record<string, unknown>) ?? {},
      { collection: collectionName, id, identity: context.identity, request: context.request }
    );
    await context.db.delete(collectionName, id);
    await context.hooks.run(
      "after-delete",
      collectionName,
      (existing as unknown as Record<string, unknown>) ?? {},
      { collection: collectionName, id, identity: context.identity, request: context.request }
    );
    if (existing) {
      await context.events.emit("content:after-delete", {
        collection: collectionName,
        id,
        record: existing,
        identity: context.identity,
        request: context.request
      });
    }
    return true;
  } catch (error) {
    throw mutationError(error);
  }
}

async function publishResolver(
  context: GraphQLContext,
  collectionName: string,
  args: Record<string, unknown>,
  action: "publish" | "unpublish"
): Promise<unknown> {
  const collection = context.collections[collectionName];
  if (!collection) throw notFound(`Unknown collection "${collectionName}"`);
  if (!collection.options.draftAndPublish) {
    throw graphqlError("Draft publishing is not enabled", "BAD_REQUEST");
  }
  const id = readIdArg(args);
  const opOnDb = action === "publish" ? context.db.publish : context.db.unpublish;
  if (!opOnDb) throw graphqlError(`Adapter does not support ${action}`, "BAD_REQUEST");
  try {
    const record = await opOnDb.call(context.db, collectionName, id);
    await context.events.emit(
      action === "publish" ? "content:after-publish" : "content:after-unpublish",
      {
        collection: collectionName,
        record,
        identity: context.identity,
        request: context.request
      }
    );
    return projectRecord(collection, record, null);
  } catch (error) {
    throw mutationError(error);
  }
}

// --- helpers ---------------------------------------------------------------

function mutationError(error: unknown): GraphQLError {
  if (error instanceof GraphQLError) return error;
  return graphqlError(error instanceof Error ? error.message : "Mutation failed", "BAD_REQUEST");
}

function readDataArg(args: Record<string, unknown>): Record<string, unknown> {
  const data = args.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw graphqlError("data is required", "VALIDATION_ERROR");
  }
  return data as Record<string, unknown>;
}

function readIdArg(args: Record<string, unknown>): string {
  if (typeof args.id !== "string" || !args.id) {
    throw graphqlError("id is required", "VALIDATION_ERROR");
  }
  return args.id;
}

function projectRecord(
  collection: NonNullable<CMSCollections[string]>,
  record: Record<string, unknown>,
  selectedFields: unknown
): Record<string, unknown> {
  // Strip private fields from the output. Private fields never leak out of the
  // GraphQL surface regardless of selection set.
  const fields = collection.fields;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const def = fields[key];
    if (def?.private) continue;
    out[key] = value;
  }
  if (Array.isArray(selectedFields)) {
    const allowed = new Set(selectedFields.filter((f): f is string => typeof f === "string"));
    // Always preserve identifier columns so resolvers can chain.
    allowed.add("id");
    for (const key of Object.keys(out)) {
      if (!allowed.has(key)) delete out[key];
    }
  }
  return out;
}

function projectRecords(
  collection: NonNullable<CMSCollections[string]>,
  records: readonly Record<string, unknown>[],
  selectedFields: unknown
): Record<string, unknown>[] {
  return records.map((record) => projectRecord(collection, record, selectedFields));
}

function normalizeFilters(filters: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(filters)) normalized[field] = normalizeFilterValue(value);
  return normalized;
}

function normalizeFilterValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    normalized[GRAPHQL_FILTER_OPERATORS.has(key) ? `$${key}` : key] = normalizeFilterValue(nestedValue);
  }
  return normalized;
}

function graphqlError(message: string, code: string, extra?: Record<string, unknown>): GraphQLError {
  return new GraphQLError(message, { extensions: { code, ...(extra ?? {}) } });
}

function notFound(message: string): GraphQLError {
  return graphqlError(message, "NOT_FOUND");
}

function singularize(name: string): string {
  return name.endsWith("ies") ? `${name.slice(0, -3)}y` : name.endsWith("s") ? name.slice(0, -1) : `${name}Item`;
}

function pascal(value: string): string {
  return value.split(/[-_]/).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("");
}

// `SelectionNode` is re-exported for the apollo handler so it can avoid a
// second `graphql` import; tree-shaking drops it when unused.
export type { SelectionNode };
