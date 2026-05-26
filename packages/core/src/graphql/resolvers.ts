import { GraphQLError, GraphQLScalarType, Kind, type GraphQLResolveInfo, type SelectionNode, type ValueNode } from "graphql";
import { collectionToZod, type CMSCollections, type PopulateMap } from "@hono-cms/schema";
import { writeAuditEntry } from "../audit";
import { listWithLocaleFallback, localeValidationError } from "../content/i18n";
import { populateRecords } from "../content/populate";
import { deleteWithRelationPolicy, RelationConstraintError } from "../content/delete";
import { forbiddenWriteFields, projectRecord, projectRecords } from "../content/projection";
import { verifyPreviewToken } from "../content/preview";
import { normalizeDraftInput, publishDocument, stripSystemDraftFields, unpublishDocument } from "../content/publish";
import { applyListQuery, filterRecordsByRelations, InvalidCursorError, decodeCursor, publicListResult, splitRelationFilters, validateQueryParams, type RelationFilter } from "../content/query";
import { contentCacheTtl, invalidateContentCache, readContentCacheEntry, stableStringify, writeContentCacheEntry } from "../content/cache";
import { dispatchWebhooks } from "../webhooks";
import type { CMSGraphQLContext } from "./context";
import type { AuditOperation, ContentRecord, ListQuery, WebhookEvent } from "../types/providers";
import type { HookFunction } from "../types/config";

const GRAPHQL_FILTER_OPERATORS = new Set(["eq", "ne", "contains", "notContains", "startsWith", "endsWith", "gt", "gte", "lt", "lte", "in", "nin", "null", "notNull", "between"]);

export type CMSResolvers = {
  Query: Record<string, (parent: unknown, args: Record<string, unknown>, context: CMSGraphQLContext, info: GraphQLResolveInfo) => Promise<unknown>>;
  Mutation: Record<string, (parent: unknown, args: Record<string, unknown>, context: CMSGraphQLContext, info: GraphQLResolveInfo) => Promise<unknown>>;
  JSON: GraphQLScalarType;
};

/**
 * Build the Query + Mutation resolver map plus the JSON scalar implementation
 * used by `makeExecutableSchema`. Resolvers preserve the exact error
 * shapes/codes the hand-rolled handler used to emit so existing tests keep
 * passing while execution flows through Apollo Server.
 */
export function buildResolvers(collections: CMSCollections): CMSResolvers {
  const Query: CMSResolvers["Query"] = {};
  const Mutation: CMSResolvers["Mutation"] = {};

  for (const collection of Object.values(collections)) {
    const collectionName = collection.name;
    const singularRoot = singularize(collectionName);
    const singularType = pascal(singularRoot);

    Query[collectionName] = (_parent, args, context, info) => listResolver(context, info, collectionName, args);
    Query[singularRoot] = (_parent, args, context, info) => itemResolver(context, info, collectionName, args);

    Mutation[`create${singularType}`] = (_parent, args, context, info) => createResolver(context, info, collectionName, args);
    Mutation[`update${singularType}`] = (_parent, args, context, info) => updateResolver(context, info, collectionName, args);
    Mutation[`delete${singularType}`] = (_parent, args, context) => deleteResolver(context, collectionName, args);
    if (collection.options.draftAndPublish) {
      Mutation[`publish${singularType}`] = (_parent, args, context, info) => publishResolver(context, info, collectionName, args, "publish");
      Mutation[`unpublish${singularType}`] = (_parent, args, context, info) => publishResolver(context, info, collectionName, args, "unpublish");
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
  context: CMSGraphQLContext,
  info: GraphQLResolveInfo,
  collectionName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (!context.canRead(collectionName)) {
    throw forbidden();
  }
  const collection = context.collections[collectionName];
  if (!collection) throw notFound(`Unknown collection "${collectionName}"`);

  const locale = typeof args.locale === "string" ? args.locale : undefined;
  if (localeValidationError(collection, locale ?? null)) {
    throw graphqlError("Invalid locale", "VALIDATION_ERROR");
  }

  const selection = collectSelection(info);
  const selectedFields = selection.itemFields;
  const selectedRelationFields = selection.itemRelations;

  let query: ListQuery;
  try {
    query = buildListQuery(args, selectedFields, selectedRelationFields);
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw graphqlError("Invalid cursor", "VALIDATION_ERROR");
    }
    throw error;
  }
  const validationQuery: ListQuery = { ...query };
  if (!Array.isArray(args.fields)) delete validationQuery.fields;
  if (query.populate) {
    validationQuery.populate = Object.fromEntries(
      Object.keys(query.populate).map((field) => [field, true])
    ) as PopulateMap;
  }
  const queryIssues = validateQueryParams(context.collections, collectionName, validationQuery);
  if (queryIssues.length) {
    throw graphqlError(queryIssues[0]?.message ?? "Invalid query", "VALIDATION_ERROR", { issues: queryIssues });
  }

  const publicStatus = context.publicStatus(collectionName);
  const ttl = context.session ? null : contentCacheTtl(context.contentCache);
  const cacheSource = cacheSourceForResolver(info, args);
  if (ttl !== null) {
    const cached = await readContentCacheEntry(context.cache, collectionName, cacheSource);
    if (cached) {
      const ifNoneMatch = context.request.headers.get("if-none-match");
      context.cacheOutcome.value = ifNoneMatch === cached.etag
        ? { status: "hit", etag: cached.etag, notModified: true }
        : { status: "hit", etag: cached.etag };
      return cached.body;
    }
  }

  const filteredQuery = { ...query, ...publicStatus };
  const { directFilters, relationFilters } = splitRelationFilters(context.collections, collectionName, filteredQuery.filters);
  const listQuery = { ...filteredQuery, filters: directFilters };
  const result = relationFilters.length
    ? await listWithRelationFilters(context, collectionName, collection, listQuery, relationFilters)
    : await listWithLocaleFallback((nextQuery) => context.db.list(collectionName, nextQuery), collection, listQuery);
  const populated = await populateRecords(context.db, context.collections, collectionName, result.items, query.populate, { ...publicStatus, session: context.session });
  const publicResult = publicListResult(result);
  const body = {
    ...publicResult,
    meta: paginationMeta(publicResult),
    items: projectRecords(collection, populated, query.fields, context.session)
  };
  await maybeWriteCache(context, collectionName, cacheSource, body, ttl);
  return body;
}

async function itemResolver(
  context: CMSGraphQLContext,
  info: GraphQLResolveInfo,
  collectionName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (!context.canRead(collectionName)) {
    throw forbidden();
  }
  const collection = context.collections[collectionName];
  if (!collection) throw notFound(`Unknown collection "${collectionName}"`);

  const locale = typeof args.locale === "string" ? args.locale : undefined;
  if (localeValidationError(collection, locale ?? null)) {
    throw graphqlError("Invalid locale", "VALIDATION_ERROR");
  }
  const id = typeof args.id === "string" ? args.id : undefined;
  if (!id) throw graphqlError("id is required", "VALIDATION_ERROR");

  const selection = collectSelection(info);
  const selectedFields = selection.fields;
  const selectedRelationFields = selection.relations;
  let query: ListQuery;
  try {
    query = buildListQuery(args, selectedFields, selectedRelationFields);
  } catch (error) {
    if (error instanceof InvalidCursorError) throw graphqlError("Invalid cursor", "VALIDATION_ERROR");
    throw error;
  }
  const validationQuery: ListQuery = { ...query };
  if (!Array.isArray(args.fields)) delete validationQuery.fields;
  if (query.populate) {
    validationQuery.populate = Object.fromEntries(Object.keys(query.populate).map((field) => [field, true])) as PopulateMap;
  }
  const queryIssues = validateQueryParams(context.collections, collectionName, validationQuery);
  if (queryIssues.length) {
    throw graphqlError(queryIssues[0]?.message ?? "Invalid query", "VALIDATION_ERROR", { issues: queryIssues });
  }

  const publicStatus = context.publicStatus(collectionName);
  const preview = typeof args.preview === "string"
    ? await verifyPreviewToken(context.cache, args.preview)
    : null;
  const hasPreviewAccess = preview?.collection === collectionName && preview.documentId === id;
  const ttl = context.session || hasPreviewAccess ? null : contentCacheTtl(context.contentCache);
  const cacheSource = cacheSourceForResolver(info, args);
  if (ttl !== null) {
    const cached = await readContentCacheEntry(context.cache, collectionName, cacheSource);
    if (cached) {
      const ifNoneMatch = context.request.headers.get("if-none-match");
      context.cacheOutcome.value = ifNoneMatch === cached.etag
        ? { status: "hit", etag: cached.etag, notModified: true }
        : { status: "hit", etag: cached.etag };
      return cached.body;
    }
  }
  const record = await context.db.get(collectionName, id, query);
  if (!record || (!hasPreviewAccess && publicStatus.status === "published" && record.status !== "published")) {
    return null;
  }
  const [populated] = await populateRecords(context.db, context.collections, collectionName, [record], query.populate, { ...publicStatus, session: context.session });
  const body = projectRecord(collection, populated ?? record, query.fields, context.session);
  await maybeWriteCache(context, collectionName, cacheSource, body, ttl);
  return body;
}

async function createResolver(
  context: CMSGraphQLContext,
  info: GraphQLResolveInfo,
  collectionName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (!context.canAccess(collectionName, "create")) throw forbidden();
  const collection = context.collections[collectionName];
  if (!collection) throw notFound(`Unknown collection "${collectionName}"`);
  const data = readDataArg(args);
  const invalidFields = invalidInputFields(collection, data);
  if (invalidFields.length) throw invalidInputFieldsError(invalidFields);
  const forbiddenFields = forbiddenWriteFields(collection, data, context.session);
  if (forbiddenFields.length) throw forbiddenFieldsError(forbiddenFields);
  const parsed = collectionToZod(collection).safeParse(data);
  if (!parsed.success) {
    throw graphqlError("Validation error", "VALIDATION_ERROR", { issues: parsed.error.issues });
  }
  try {
    const input = await runHooks(context.hooks?.beforeCreate, parsed.data, { collection: collectionName, session: context.session, request: context.request });
    const record = await context.db.create(collectionName, normalizeDraftInput(collection.options.draftAndPublish, input));
    await runHooks(context.hooks?.afterCreate, record, { collection: collectionName, id: record.id, session: context.session, request: context.request });
    await writeMutationSideEffects(context, {
      operation: "create",
      eventType: "content.created",
      collection: collectionName,
      before: null,
      after: record,
      record
    });
    return projectRecord(collection, record, selectionTopFields(info), context.session);
  } catch (error) {
    throw mutationError(error);
  }
}

async function updateResolver(
  context: CMSGraphQLContext,
  info: GraphQLResolveInfo,
  collectionName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (!context.canAccess(collectionName, "update")) throw forbidden();
  const collection = context.collections[collectionName];
  if (!collection) throw notFound(`Unknown collection "${collectionName}"`);
  const id = readIdArg(args);
  const before = await context.db.get(collectionName, id);
  const data = stripSystemDraftFields(readDataArg(args));
  const invalidFields = invalidInputFields(collection, data);
  if (invalidFields.length) throw invalidInputFieldsError(invalidFields);
  const forbiddenFields = forbiddenWriteFields(collection, data, context.session);
  if (forbiddenFields.length) throw forbiddenFieldsError(forbiddenFields);
  try {
    const input = await runHooks(context.hooks?.beforeUpdate, data, { collection: collectionName, id, session: context.session, request: context.request });
    const record = await context.db.update(collectionName, id, input);
    await runHooks(context.hooks?.afterUpdate, record, { collection: collectionName, id: record.id, session: context.session, request: context.request });
    await writeMutationSideEffects(context, {
      operation: "update",
      eventType: "content.updated",
      collection: collectionName,
      before,
      after: record,
      record
    });
    return projectRecord(collection, record, selectionTopFields(info), context.session);
  } catch (error) {
    throw mutationError(error);
  }
}

async function deleteResolver(
  context: CMSGraphQLContext,
  collectionName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (!context.canAccess(collectionName, "delete")) throw forbidden();
  const collection = context.collections[collectionName];
  if (!collection) throw notFound(`Unknown collection "${collectionName}"`);
  const id = readIdArg(args);
  try {
    const existing = await context.db.get(collectionName, id);
    await runHooks(context.hooks?.beforeDelete, existing ?? {}, { collection: collectionName, id, session: context.session, request: context.request });
    await deleteWithRelationPolicy(context.db, context.collections, collectionName, id);
    await runHooks(context.hooks?.afterDelete, existing ?? {}, { collection: collectionName, id, session: context.session, request: context.request });
    if (existing) {
      await writeMutationSideEffects(context, {
        operation: "delete",
        eventType: "content.deleted",
        collection: collectionName,
        before: existing,
        after: null,
        record: existing
      });
    }
    return true;
  } catch (error) {
    throw mutationError(error);
  }
}

async function publishResolver(
  context: CMSGraphQLContext,
  info: GraphQLResolveInfo,
  collectionName: string,
  args: Record<string, unknown>,
  action: "publish" | "unpublish"
): Promise<unknown> {
  if (!context.canAccess(collectionName, "publish")) throw forbidden();
  const collection = context.collections[collectionName];
  if (!collection) throw notFound(`Unknown collection "${collectionName}"`);
  if (!collection.options.draftAndPublish) {
    throw graphqlError("Draft publishing is not enabled", "BAD_REQUEST");
  }
  const id = readIdArg(args);
  try {
    const before = await context.db.get(collectionName, id);
    const record = action === "publish"
      ? await publishDocument(context.db, collectionName, id)
      : await unpublishDocument(context.db, collectionName, id);
    await writeMutationSideEffects(context, {
      operation: action,
      eventType: action === "publish" ? "content.published" : "content.unpublished",
      collection: collectionName,
      before,
      after: record,
      record
    });
    return projectRecord(collection, record, selectionTopFields(info), context.session);
  } catch (error) {
    throw mutationError(error);
  }
}

function mutationError(error: unknown): GraphQLError {
  if (error instanceof GraphQLError) return error;
  if (error instanceof RelationConstraintError) {
    return graphqlError(error.message, error.code, {
      collection: error.collection,
      relatedCollection: error.relatedCollection,
      field: error.field,
      relatedIds: error.relatedIds
    });
  }
  return graphqlError(error instanceof Error ? error.message : "Mutation failed", "BAD_REQUEST");
}

async function runHooks(
  hooks: HookFunction[] | undefined,
  input: Record<string, unknown>,
  ctx: { collection: string; id?: string; session: CMSGraphQLContext["session"]; request: Request }
): Promise<Record<string, unknown>> {
  let current = input;
  for (const hook of hooks ?? []) {
    const next = await hook(current, ctx);
    if (next) current = next;
  }
  return current;
}

async function writeMutationSideEffects(
  context: CMSGraphQLContext,
  input: {
    operation: AuditOperation;
    eventType: WebhookEvent["type"];
    collection: string;
    before: ContentRecord | null;
    after: ContentRecord | null;
    record: ContentRecord;
  }
): Promise<void> {
  const requestId = context.request.headers.get("x-request-id") ?? crypto.randomUUID();
  await invalidateContentCache(context.cache, input.collection);
  await writeAuditEntry({
    store: context.auditStore ?? null,
    operation: input.operation,
    collection: input.collection,
    before: input.before,
    after: input.after,
    session: context.session,
    requestId,
    ...(context.auditConfig ? { config: context.auditConfig } : {})
  });
  await dispatchWebhooks({
    staticTargets: context.webhooks ?? [],
    store: context.webhookStore ?? null,
    ...(context.jobs?.enqueue ? { retry: { enqueue: (endpoint: string, body?: unknown, options?: { delay?: number }) => context.jobs?.enqueue?.(endpoint, body, options) ?? Promise.resolve() } } : {}),
    event: {
      type: input.eventType,
      collection: input.collection,
      record: input.record,
      previous: input.before,
      timestamp: new Date().toISOString(),
      requestId
    }
  });
}

async function listWithRelationFilters(
  context: CMSGraphQLContext,
  collectionName: string,
  collection: NonNullable<CMSCollections[string]>,
  query: ListQuery,
  relationFilters: readonly RelationFilter[]
): Promise<{ items: ContentRecord[]; nextCursor?: string; total?: number }> {
  const sourceQuery: ListQuery = { ...query, limit: 200 };
  delete sourceQuery.cursor;
  delete sourceQuery.cursorCreatedAt;
  delete sourceQuery.page;
  delete sourceQuery.pageSize;
  const all = await collectRecords((nextQuery) => listWithLocaleFallback((localeQuery) => context.db.list(collectionName, localeQuery), collection, nextQuery), sourceQuery);
  const related = await filterRecordsByRelations(context.db, context.collections, all, relationFilters, query.status === "published" ? { status: "published" } : {});
  return applyListQuery(related, { ...query, filters: {} });
}

async function collectRecords(
  list: (query: ListQuery) => Promise<{ items: ContentRecord[]; nextCursor?: string }>,
  query: ListQuery
): Promise<ContentRecord[]> {
  const items: ContentRecord[] = [];
  let cursor: string | undefined;
  do {
    const nextQuery: ListQuery = { ...query };
    if (cursor) nextQuery.cursor = cursor;
    const result = await list(nextQuery);
    items.push(...result.items);
    cursor = result.nextCursor;
  } while (cursor);
  return items;
}

// --- query/argument helpers ---------------------------------------------------

function buildListQuery(args: Record<string, unknown>, selectedFields: string[], selectedRelationFields: Record<string, string[]> = {}): ListQuery {
  const query: ListQuery = {};
  const pagination = args.pagination && typeof args.pagination === "object" && !Array.isArray(args.pagination)
    ? args.pagination as Record<string, unknown>
    : {};
  const limit = typeof pagination.limit === "number" ? pagination.limit : args.limit;
  const cursor = typeof pagination.cursor === "string" ? pagination.cursor : args.cursor;
  const page = typeof pagination.page === "number" ? pagination.page : args.page;
  const pageSize = typeof pagination.pageSize === "number" ? pagination.pageSize : args.pageSize;
  if (typeof limit === "number") query.limit = Math.min(Math.max(limit, 1), 100);
  if (typeof cursor === "string") {
    const decoded = decodeCursor(cursor);
    query.cursor = decoded.id;
    query.cursorCreatedAt = decoded.createdAt;
  }
  if (typeof page === "number" && Number.isInteger(page) && page > 0) query.page = page;
  if (typeof pageSize === "number" && Number.isInteger(pageSize) && pageSize > 0) {
    query.pageSize = Math.min(Math.max(pageSize, 1), 100);
    query.limit = query.pageSize;
  }
  if (typeof args.status === "string") query.status = args.status as NonNullable<ListQuery["status"]>;
  if (typeof args.sort === "string") query.sort = args.sort;
  if (Array.isArray(args.sort)) {
    const sort = args.sort.filter((field): field is string => typeof field === "string");
    if (sort.length) query.sort = sort.join(",");
  }
  if (args.filters && typeof args.filters === "object" && !Array.isArray(args.filters)) {
    query.filters = normalizeFilters(args.filters as Record<string, unknown>);
  }
  if (typeof args.locale === "string") query.locale = args.locale;
  const fields = Array.isArray(args.fields) ? args.fields.filter((field): field is string => typeof field === "string") : selectedFields;
  if (fields.length) query.fields = fields;
  const populate = Array.isArray(args.populate) ? args.populate.filter((field): field is string => typeof field === "string") : Object.keys(selectedRelationFields);
  if (populate.length) query.populate = populateMap(populate, selectedRelationFields);
  return query;
}

function populateMap(paths: string[], selectedRelationFields: Record<string, string[]> = {}): PopulateMap {
  const map: PopulateMap = {};
  for (const path of paths) {
    const fields = selectedRelationFields[path];
    map[path] = fields?.length ? { fields } : true;
  }
  return map;
}

function normalizeFilters(filters: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(filters)) normalized[field] = normalizeFilterValue(value);
  return normalized;
}

function normalizeFilterValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    normalized[GRAPHQL_FILTER_OPERATORS.has(key) ? `$${key}` : key] = normalizeFilterValue(nestedValue);
  }
  return normalized;
}

function paginationMeta(result: { nextCursor?: string; total?: number }): { pagination: { cursor?: string; hasMore: boolean; total?: number } } {
  const pagination: { cursor?: string; hasMore: boolean; total?: number } = { hasMore: Boolean(result.nextCursor) };
  if (result.nextCursor) pagination.cursor = result.nextCursor;
  if (typeof result.total === "number") pagination.total = result.total;
  return { pagination };
}

function readDataArg(args: Record<string, unknown>): Record<string, unknown> {
  const data = args.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("data is required");
  return data as Record<string, unknown>;
}

function readIdArg(args: Record<string, unknown>): string {
  if (typeof args.id !== "string" || !args.id) throw new Error("id is required");
  return args.id;
}

function invalidInputFields(collection: NonNullable<CMSCollections[string]>, data: Record<string, unknown>): string[] {
  return Object.keys(data).filter((fieldName) => {
    const field = collection.fields[fieldName];
    return !field || field.private;
  });
}

// --- selection introspection -------------------------------------------------

type SelectionSummary = {
  /** Top-level field names selected on the parent type (no items wrapper). */
  fields: string[];
  /** Sub-object selections on the parent type, keyed by field name. */
  relations: Record<string, string[]>;
  /** Fields selected inside the `items` sub-selection if present, else falls back to `fields`. */
  itemFields: string[];
  /** Relation selections inside the `items` sub-selection if present, else falls back to `relations`. */
  itemRelations: Record<string, string[]>;
};

function collectSelection(info: GraphQLResolveInfo): SelectionSummary {
  const fieldNode = info.fieldNodes[0];
  const top = collectFromSelections(fieldNode?.selectionSet?.selections ?? []);
  const itemsNode = (fieldNode?.selectionSet?.selections ?? []).find(
    (node): node is SelectionNode & { name: { value: string }; selectionSet?: { selections: readonly SelectionNode[] } } =>
      node.kind === Kind.FIELD && (node as { name: { value: string } }).name.value === "items"
  );
  const itemsSummary = itemsNode?.selectionSet
    ? collectFromSelections(itemsNode.selectionSet.selections)
    : top;
  return {
    fields: top.fields,
    relations: top.relations,
    itemFields: itemsSummary.fields,
    itemRelations: itemsSummary.relations
  };
}

function collectFromSelections(selections: readonly SelectionNode[]): { fields: string[]; relations: Record<string, string[]> } {
  const fields = new Set<string>();
  const relations: Record<string, string[]> = {};
  for (const node of selections) {
    if (node.kind !== Kind.FIELD) continue;
    const name = node.name.value;
    if (name === "items" || name === "nextCursor" || name === "meta") continue;
    if (node.selectionSet?.selections.length) {
      // The legacy projection layer drops fields that aren't included in the
      // explicit field selection list — relation roots need to live in both
      // `fields` (so they survive projection) and `relations` (so populate
      // picks them up).
      fields.add(name);
      relations[name] = [...collectFromSelections(node.selectionSet.selections).fields];
    } else {
      fields.add(name);
    }
  }
  return { fields: [...fields], relations };
}

function selectionTopFields(info: GraphQLResolveInfo): string[] {
  const summary = collectSelection(info);
  return summary.fields;
}

function cacheSourceForResolver(info: GraphQLResolveInfo, args: Record<string, unknown>): string {
  const selection = info.fieldNodes[0]?.selectionSet ? printSelectionSet(info.fieldNodes[0].selectionSet.selections) : "";
  return `graphql:${info.fieldName}:${stableStringify(args)}:${selection}`;
}

function printSelectionSet(selections: readonly SelectionNode[]): string {
  const parts: string[] = [];
  for (const node of selections) {
    if (node.kind !== Kind.FIELD) continue;
    parts.push(node.selectionSet?.selections.length
      ? `${node.name.value} { ${printSelectionSet(node.selectionSet.selections)} }`
      : node.name.value);
  }
  return parts.join(" ");
}

async function maybeWriteCache(
  context: CMSGraphQLContext,
  collection: string,
  cacheSource: string,
  body: unknown,
  ttl: number | null
): Promise<void> {
  if (ttl === null || !context.cache) {
    context.cacheOutcome.value = { status: "miss" };
    return;
  }
  const entry = await writeContentCacheEntry(context.cache, collection, cacheSource, body, ttl);
  context.cacheOutcome.value = { status: "miss", etag: entry.etag };
}

// --- error helpers -----------------------------------------------------------

function graphqlError(message: string, code: string, extra?: Record<string, unknown>): GraphQLError {
  return new GraphQLError(message, { extensions: { code, ...(extra ?? {}) } });
}

function forbidden(): GraphQLError {
  return graphqlError("Forbidden", "FORBIDDEN");
}

function notFound(message: string): GraphQLError {
  return graphqlError(message, "NOT_FOUND");
}

function forbiddenFieldsError(fields: string[]): GraphQLError {
  return graphqlError(`Forbidden field${fields.length === 1 ? "" : "s"}: ${fields.join(", ")}`, "FORBIDDEN_FIELD", {
    issues: fields.map((field) => ({ path: [field], message: `Field "${field}" cannot be written by this session.` }))
  });
}

function invalidInputFieldsError(fields: string[]): GraphQLError {
  return graphqlError(`Invalid input field${fields.length === 1 ? "" : "s"}: ${fields.join(", ")}`, "VALIDATION_ERROR", {
    issues: fields.map((field) => ({ path: ["data", field], message: `Field "${field}" is not available in GraphQL input.` }))
  });
}

// --- naming helpers ----------------------------------------------------------

function singularize(name: string): string {
  return name.endsWith("ies") ? `${name.slice(0, -3)}y` : name.endsWith("s") ? name.slice(0, -1) : `${name}Item`;
}

function pascal(value: string): string {
  return value.split(/[-_]/).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("");
}

