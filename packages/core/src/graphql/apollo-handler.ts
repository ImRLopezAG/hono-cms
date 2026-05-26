import { ApolloServer, HeaderMap, type ApolloServerOptions, type BaseContext } from "@apollo/server";
import type { GraphQLFormattedError, GraphQLSchema, ValueNode } from "graphql";
import { GraphQLError, parse, print, Kind, type DocumentNode, type OperationDefinitionNode, type SelectionNode, type SelectionSetNode, type FieldNode } from "graphql";
import type { CMSCollections } from "@hono-cms/schema";
import type { CMSGraphQLContext } from "./context";

const MAX_GRAPHQL_SELECTION_DEPTH = 3;
const MAX_GRAPHQL_SELECTION_FIELDS = 80;
const MAX_GRAPHQL_POPULATE_FIELDS = 10;

export type CreateApolloHandlerOptions = {
  schema: GraphQLSchema;
  introspection: boolean;
  collections: CMSCollections;
  /**
   * Builds the request-scoped CMS context (collections, db, auth session,
   * hooks, etc.) for each incoming Web Request.
   */
  context: (request: Request) => Promise<CMSGraphQLContext> | CMSGraphQLContext;
};

type GraphQLRequestBody = {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
};

/**
 * Build the GraphQL HTTP handler backed by Apollo Server. Matches the
 * canonical `startServerAndCreateHandler` pattern from
 * `apollo-server-integration-next`: takes a Web `Request`, returns a Web
 * `Response`. Adds CMS-specific concerns on top: introspection gating,
 * demand-limit guards, and resurfacing the in-resolver content cache as
 * ETag/`x-cms-cache` headers on the outgoing response.
 */
export function createApolloHandler(options: CreateApolloHandlerOptions): (request: Request) => Promise<Response> {
  const serverConfig: ApolloServerOptions<BaseContext> = {
    schema: options.schema,
    introspection: true, // always allow Apollo to know about introspection; we gate at the validation layer
    includeStacktraceInErrorResponses: false,
    formatError: cmsFormatError,
    validationRules: []
  };
  const server = new ApolloServer<BaseContext>(serverConfig);
  server.startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests();
  const privateOutputFields = buildPrivateOutputFieldMap(options.collections);
  const rootFieldTypes = buildRootFieldTypeMap(options.collections);
  const relationFieldTypes = buildRelationFieldTypeMap(options.collections);
  const collectionTypeNames = new Set(Object.values(options.collections).map((collection) => pascalCase(collection.name)));

  return async function handler(request: Request): Promise<Response> {
    const body = await readGraphQLBody(request);
    if (!body.query) {
      return jsonResponse({ data: null, errors: [{ message: "GraphQL query is required", extensions: { code: "BAD_REQUEST" } }] }, 400);
    }

    // Parse the query once so we can run CMS-specific demand checks and strip
    // private-field selections before Apollo validates the document. If
    // parsing fails outright we surface a `BAD_REQUEST` (matching the legacy
    // contract) instead of leaning on Apollo's `GRAPHQL_PARSE_FAILED`.
    let document: DocumentNode | undefined;
    try {
      document = parse(body.query);
    } catch {
      return jsonResponse({ data: null, errors: [{ message: "GraphQL query is required", extensions: { code: "BAD_REQUEST" } }] }, 400);
    }

    if (!options.introspection) {
      const introspectionRoot = findIntrospectionRoot(document);
      if (introspectionRoot) {
        return jsonResponse({
          data: { [introspectionRoot]: null },
          errors: [{
            message: "GraphQL introspection is disabled",
            path: [introspectionRoot],
            extensions: { code: "GRAPHQL_VALIDATION_FAILED" }
          }]
        });
      }
    }

    // Surface private-field filter references with the legacy
    // VALIDATION_ERROR shape (Apollo would otherwise reject these as
    // GRAPHQL_VALIDATION_FAILED on an unknown filter input field).
    const privateFilter = findPrivateFilterReference(document, body.variables ?? {}, options.collections, rootFieldTypes);
    if (privateFilter) {
      return jsonResponse({
        data: { [privateFilter.rootName]: null },
        errors: [{
          message: privateFilter.message,
          path: [privateFilter.rootName],
          extensions: { code: "VALIDATION_ERROR", issues: [{ path: privateFilter.path, message: privateFilter.message }] }
        }]
      });
    }

    const demand = validateDemand(document);
    if (demand) {
      const root = demand.fieldName ?? "";
      const data = root ? { [root]: null } : null;
      return jsonResponse({
        data,
        errors: [{
          message: demand.message,
          path: demand.path,
          extensions: { code: "QUERY_COMPLEXITY", issues: [{ path: demand.path, message: demand.message }] }
        }]
      });
    }

    const sanitized = stripPrivateFieldSelections(document, privateOutputFields, rootFieldTypes, relationFieldTypes, collectionTypeNames);
    const queryText = sanitized === document ? body.query : print(sanitized);
    const rewrittenBody = sanitized === document ? body : { ...body, query: queryText };

    const context = await options.context(request);

    const method = request.method.toUpperCase();
    // Apollo's HTTP transport prefers a JSON body for POST and a query string
    // for GET; mixing both confuses it. When the document was rewritten to
    // strip private fields we always send the rewritten body and rely on
    // Apollo's POST-style decoding regardless of the original verb.
    const httpGraphQLResponse = await server.executeHTTPGraphQLRequest({
      context: async () => context as unknown as BaseContext,
      httpGraphQLRequest: {
        body: rewrittenBody,
        headers: webHeadersToMap(request.headers),
        method: method === "GET" ? "POST" : method,
        search: ""
      }
    });

    const responseHeaders = new Headers();
    for (const [key, value] of httpGraphQLResponse.headers) responseHeaders.set(key, value);

    if (httpGraphQLResponse.body.kind !== "complete") {
      // Streaming responses are not used by the CMS today; fall back to a 500.
      return new Response("Streaming GraphQL responses are not supported", { status: 500 });
    }

    let payload = JSON.parse(httpGraphQLResponse.body.string) as { data: unknown; errors?: GraphQLFormattedError[] };
    payload = normalizeFieldNullPropagation(payload);

    // Resurface the cache outcome (set by resolvers) on the HTTP envelope.
    const cacheOutcome = context.cacheOutcome.value;
    if (cacheOutcome?.etag) {
      responseHeaders.set("etag", cacheOutcome.etag);
      responseHeaders.set("x-cms-cache", cacheOutcome.status);
      if (cacheOutcome.notModified) {
        return new Response(null, { status: 304, headers: responseHeaders });
      }
    }

    responseHeaders.set("content-type", "application/json");
    return new Response(JSON.stringify(payload), {
      status: httpGraphQLResponse.status ?? 200,
      headers: responseHeaders
    });
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function readGraphQLBody(request: Request): Promise<GraphQLRequestBody> {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const query = url.searchParams.get("query") ?? undefined;
    const variablesText = url.searchParams.get("variables");
    const operationName = url.searchParams.get("operationName") ?? undefined;
    const variables = variablesText ? JSON.parse(variablesText) as Record<string, unknown> : undefined;
    const body: GraphQLRequestBody = {};
    if (query) body.query = query;
    if (variables) body.variables = variables;
    if (operationName) body.operationName = operationName;
    return body;
  }
  try {
    return await request.clone().json() as GraphQLRequestBody;
  } catch {
    return {};
  }
}

function webHeadersToMap(headers: Headers): HeaderMap {
  const result = new HeaderMap();
  headers.forEach((value, key) => result.set(key.toLowerCase(), value));
  // We always feed Apollo a parsed JSON body even when the original request
  // was GET (see executeHTTPGraphQLRequest below); make sure Apollo sees a
  // matching content-type so its body decoder accepts the payload.
  if (!result.has("content-type")) result.set("content-type", "application/json");
  return result;
}

function cmsFormatError(formatted: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  // Map Apollo's default validation-error code (string `GRAPHQL_VALIDATION_FAILED`)
  // through unchanged. Mutation/resolver errors that throw GraphQLError already
  // carry their CMS extensions, which we preserve verbatim.
  if (error instanceof GraphQLError && error.extensions) {
    return {
      ...formatted,
      extensions: { ...formatted.extensions, ...error.extensions }
    };
  }
  return formatted;
}

/**
 * Apollo nulls `data` entirely when a top-level Query/Mutation field has a
 * non-null return type and its resolver throws. The legacy hand-rolled
 * GraphQL handler instead set `data[fieldName] = null` with the error at
 * `path: [fieldName]`. We restore that shape so consumers built against the
 * legacy contract keep working.
 */
function normalizeFieldNullPropagation(payload: { data: unknown; errors?: GraphQLFormattedError[] }): { data: unknown; errors?: GraphQLFormattedError[] } {
  if (payload.data !== null || !payload.errors?.length) return payload;
  const synthesized: Record<string, null> = {};
  for (const error of payload.errors) {
    const path = error.path ?? [];
    const first = path[0];
    if (typeof first === "string" && path.length === 1) {
      synthesized[first] = null;
    }
  }
  if (Object.keys(synthesized).length === 0) return payload;
  return { ...payload, data: synthesized };
}

type PrivateFilterViolation = { rootName: string; path: (string | number)[]; message: string };

/**
 * Walk the top-level `filters` argument on the first root field and emit a
 * `VALIDATION_ERROR` if it references a private field. The filter input SDL
 * deliberately excludes private fields (per Plan-6 U4 contract), so this
 * pre-flight check yields the legacy error shape instead of Apollo's stricter
 * `GRAPHQL_VALIDATION_FAILED` on an unknown input field.
 */
function findPrivateFilterReference(
  document: DocumentNode,
  variables: Record<string, unknown>,
  collections: CMSCollections,
  rootFieldTypes: Map<string, string>
): PrivateFilterViolation | null {
  const op = document.definitions.find((def): def is OperationDefinitionNode => def.kind === Kind.OPERATION_DEFINITION);
  if (!op) return null;
  for (const selection of op.selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) continue;
    const rootName = selection.name.value;
    const targetType = rootFieldTypes.get(rootName);
    if (!targetType) continue;
    const targetCollection = Object.values(collections).find((collection) => pascalCase(collection.name) === targetType);
    if (!targetCollection) continue;
    const filtersArg = selection.arguments?.find((arg) => arg.name.value === "filters");
    if (!filtersArg) continue;
    const filterObject = readArgValue(filtersArg.value, variables);
    if (!filterObject || typeof filterObject !== "object" || Array.isArray(filterObject)) continue;
    const violation = walkFilterForPrivate(filterObject as Record<string, unknown>, targetCollection, collections, ["filter"]);
    if (violation) return { rootName, ...violation };
  }
  return null;
}

function walkFilterForPrivate(
  filter: Record<string, unknown>,
  collection: NonNullable<CMSCollections[string]>,
  collections: CMSCollections,
  trail: (string | number)[]
): { path: (string | number)[]; message: string } | null {
  for (const [fieldName, value] of Object.entries(filter)) {
    const field = collection.fields[fieldName];
    if (!field) continue;
    if (field.private) {
      return { path: [...trail, fieldName], message: `Field "${fieldName}" is private` };
    }
    if (field.kind === "relation" && value && typeof value === "object" && !Array.isArray(value)) {
      const targetCollection = collections[field.target as keyof typeof collections];
      if (targetCollection) {
        const nested = walkFilterForPrivate(value as Record<string, unknown>, targetCollection, collections, [...trail, fieldName]);
        if (nested) return nested;
      }
    }
  }
  return null;
}

function readArgValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
    case Kind.ENUM:
      return node.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(node.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return node.values.map((value) => readArgValue(value, variables));
    case Kind.OBJECT:
      return Object.fromEntries(node.fields.map((field) => [field.name.value, readArgValue(field.value, variables)]));
    case Kind.VARIABLE:
      return variables[node.name.value];
    default:
      return undefined;
  }
}

function findIntrospectionRoot(document: DocumentNode): string | null {
  const op = document.definitions.find((def): def is OperationDefinitionNode => def.kind === Kind.OPERATION_DEFINITION);
  if (!op) return null;
  for (const selection of op.selectionSet.selections) {
    if (selection.kind === Kind.FIELD && selection.name.value.startsWith("__")) return selection.name.value;
  }
  return null;
}

type DemandViolation = { message: string; path: (string | number)[]; fieldName?: string };

function validateDemand(document: DocumentNode): DemandViolation | null {
  const operation = document.definitions.find((def): def is OperationDefinitionNode => def.kind === Kind.OPERATION_DEFINITION);
  if (!operation?.selectionSet) return null;
  const rootSelection = operation.selectionSet.selections.find((node): node is SelectionNode & { name: { value: string }; arguments?: readonly { name: { value: string }; value: { kind: string } }[]; selectionSet?: { selections: readonly SelectionNode[] } } => node.kind === Kind.FIELD);
  if (!rootSelection) return null;
  const fieldName = rootSelection.name.value;
  // Skip introspection roots; they aren't subject to demand limits.
  if (fieldName.startsWith("__")) return null;

  const depth = selectionDepth(rootSelection.selectionSet?.selections ?? [], 1);
  if (depth > MAX_GRAPHQL_SELECTION_DEPTH) {
    return { message: `GraphQL selection depth is limited to ${MAX_GRAPHQL_SELECTION_DEPTH}`, path: [fieldName], fieldName };
  }
  const fieldCount = countFields(rootSelection.selectionSet?.selections ?? []);
  if (fieldCount > MAX_GRAPHQL_SELECTION_FIELDS) {
    return { message: `GraphQL selection is limited to ${MAX_GRAPHQL_SELECTION_FIELDS} fields`, path: [fieldName], fieldName };
  }
  const populateCount = countPopulateArgument(rootSelection.arguments ?? []) + countRelationSelections(rootSelection.selectionSet?.selections ?? []);
  if (populateCount > MAX_GRAPHQL_POPULATE_FIELDS) {
    return { message: `GraphQL populate is limited to ${MAX_GRAPHQL_POPULATE_FIELDS} relations`, path: [fieldName, "populate"], fieldName };
  }
  return null;
}

function selectionDepth(selections: readonly SelectionNode[], current: number): number {
  let max = current;
  for (const node of selections) {
    if (node.kind !== Kind.FIELD) continue;
    if (node.selectionSet?.selections.length) {
      const sub = selectionDepth(node.selectionSet.selections, current + 1);
      if (sub > max) max = sub;
    }
  }
  return max;
}

function countFields(selections: readonly SelectionNode[]): number {
  let count = 0;
  for (const node of selections) {
    if (node.kind !== Kind.FIELD) continue;
    count += 1;
    if (node.selectionSet?.selections.length) {
      count += countFields(node.selectionSet.selections);
    }
  }
  return count;
}

function countRelationSelections(selections: readonly SelectionNode[]): number {
  // Mirror legacy: any nested selection inside `items { ... }` whose field has
  // its own selection set is treated as a populated relation.
  const itemsNode = selections.find((node): node is SelectionNode & { name: { value: string }; selectionSet?: { selections: readonly SelectionNode[] } } => node.kind === Kind.FIELD && (node as { name: { value: string } }).name.value === "items");
  const target = itemsNode?.selectionSet?.selections ?? selections;
  const names = new Set<string>();
  for (const node of target) {
    if (node.kind !== Kind.FIELD) continue;
    if (node.name.value === "items" || node.name.value === "meta" || node.name.value === "nextCursor") continue;
    if (node.selectionSet?.selections.length) names.add(node.name.value);
  }
  return names.size;
}

function countPopulateArgument(args: readonly { name: { value: string }; value: { kind: string } }[]): number {
  const populateArg = args.find((arg) => arg.name.value === "populate");
  if (!populateArg) return 0;
  const value = populateArg.value as { kind: string; values?: readonly unknown[] };
  if (value.kind !== Kind.LIST) return 0;
  return value.values?.length ?? 0;
}

// --- private-field stripping -------------------------------------------------

/**
 * Build `{ TypeName -> Set<privateFieldName> }` so the query rewrite can drop
 * private-field selections (mirroring what `projectRecords` does at the data
 * layer) before Apollo validates the query. Without this rewrite, queries
 * that historically worked against the hand-rolled handler would now hit
 * `GRAPHQL_VALIDATION_FAILED` from Apollo's strict validator.
 */
function buildPrivateOutputFieldMap(collections: CMSCollections): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const collection of Object.values(collections)) {
    const typeName = pascalCase(collection.name);
    const privateFields = new Set<string>();
    for (const [fieldName, field] of Object.entries(collection.fields)) {
      if (field.private) privateFields.add(fieldName);
    }
    if (privateFields.size) map.set(typeName, privateFields);
  }
  return map;
}

/**
 * Build `{ rootFieldName -> TypeName }` so we can identify which collection
 * type a top-level Query/Mutation field returns. Used as the starting point
 * for the recursive private-field stripping pass.
 */
function buildRootFieldTypeMap(collections: CMSCollections): Map<string, string> {
  const map = new Map<string, string>();
  for (const collection of Object.values(collections)) {
    const typeName = pascalCase(collection.name);
    const singular = singularize(collection.name);
    const singularType = pascalCase(singular);
    map.set(collection.name, typeName); // Query list -> Connection type, but items -> typeName
    map.set(singular, typeName);
    map.set(`create${singularType}`, typeName);
    map.set(`update${singularType}`, typeName);
    map.set(`publish${singularType}`, typeName);
    map.set(`unpublish${singularType}`, typeName);
  }
  return map;
}

/**
 * Build `{ TypeName -> { relationField -> TargetTypeName } }` so the
 * recursive private-field stripper can walk into populated relations.
 */
function buildRelationFieldTypeMap(collections: CMSCollections): Map<string, Map<string, string>> {
  const map = new Map<string, Map<string, string>>();
  for (const collection of Object.values(collections)) {
    const typeName = pascalCase(collection.name);
    const inner = new Map<string, string>();
    for (const [fieldName, field] of Object.entries(collection.fields)) {
      if (field.kind === "relation" && typeof field.target === "string") {
        inner.set(fieldName, pascalCase(field.target));
      }
    }
    if (inner.size) map.set(typeName, inner);
  }
  return map;
}

function stripPrivateFieldSelections(
  document: DocumentNode,
  privateOutputFields: Map<string, Set<string>>,
  rootFieldTypes: Map<string, string>,
  relationFieldTypes: Map<string, Map<string, string>>,
  collectionTypeNames: Set<string>
): DocumentNode {
  let changed = false;

  function visitSelectionSet(selectionSet: SelectionSetNode | undefined, parentType: string | undefined): SelectionSetNode | undefined {
    if (!selectionSet) return selectionSet;
    const privateForType = parentType ? privateOutputFields.get(parentType) : undefined;
    const nextSelections: SelectionNode[] = [];
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        const fieldName = selection.name.value;
        if (privateForType?.has(fieldName)) {
          changed = true;
          continue;
        }
        const subType = parentType ? subFieldType(parentType, fieldName, relationFieldTypes) : undefined;
        // Auto-expand a bare relation selection (e.g. `... author }`) into
        // `{ id }` so Apollo's strict validation does not reject queries
        // that the legacy parser tolerated. The resolver layer then projects
        // the populated relation down to just `id`.
        if (subType && collectionTypeNames.has(subType) && !selection.selectionSet) {
          changed = true;
          const expanded: FieldNode = {
            ...selection,
            selectionSet: { kind: Kind.SELECTION_SET, selections: [{ kind: Kind.FIELD, name: { kind: Kind.NAME, value: "id" } }] }
          };
          nextSelections.push(expanded);
          continue;
        }
        const subSet = visitSelectionSet(selection.selectionSet, subType);
        nextSelections.push(subSet === selection.selectionSet ? selection : { ...selection, ...(subSet ? { selectionSet: subSet } : {}) } as FieldNode);
      } else {
        nextSelections.push(selection);
      }
    }
    return nextSelections === selectionSet.selections ? selectionSet : { ...selectionSet, selections: nextSelections };
  }

  const definitions = document.definitions.map((def) => {
    if (def.kind !== Kind.OPERATION_DEFINITION) return def;
    const nextSelections: SelectionNode[] = [];
    for (const selection of def.selectionSet.selections) {
      if (selection.kind !== Kind.FIELD) {
        nextSelections.push(selection);
        continue;
      }
      const rootName = selection.name.value;
      // The Query list field returns `<Type>Connection`, so we need to descend
      // into the connection wrapper before reaching the entity type. Single
      // entity / mutation roots return the entity type directly.
      const rootIsList = collectionListRootType(rootName, rootFieldTypes);
      const rootType = rootIsList ? `${rootIsList}Connection` : rootFieldTypes.get(rootName);
      // Delete mutations return `Boolean!`; the legacy parser silently
      // ignored any selection set on it. Apollo's validator rejects that, so
      // drop the bogus selection here to keep the legacy contract.
      if (rootName.startsWith("delete") && selection.selectionSet) {
        changed = true;
        const { selectionSet: _, ...rest } = selection;
        nextSelections.push(rest as FieldNode);
        continue;
      }
      const sub = visitSelectionSet(selection.selectionSet, rootType);
      nextSelections.push(sub === selection.selectionSet ? selection : { ...selection, ...(sub ? { selectionSet: sub } : {}) } as FieldNode);
    }
    if (!changed) return def;
    return { ...def, selectionSet: { ...def.selectionSet, selections: nextSelections } };
  });

  if (!changed) return document;
  return { ...document, definitions };
}

function collectionListRootType(rootName: string, rootFieldTypes: Map<string, string>): string | undefined {
  // List root field names match the collection name (which is plural in the
  // canonical shape). We detect by checking whether the type registered for
  // this root matches the pascal-cased root (i.e. `articles -> Articles`).
  const candidate = rootFieldTypes.get(rootName);
  if (!candidate) return undefined;
  return pascalCase(rootName) === candidate ? candidate : undefined;
}

function subFieldType(parentType: string, fieldName: string, relationFieldTypes: Map<string, Map<string, string>>): string | undefined {
  // Connection type pattern: `${typeName}Connection { items: [Type!]! }`
  if (fieldName === "items" && parentType.endsWith("Connection")) {
    return parentType.slice(0, -"Connection".length);
  }
  if (fieldName === "meta" || fieldName === "nextCursor") return undefined;
  return relationFieldTypes.get(parentType)?.get(fieldName);
}

function pascalCase(value: string): string {
  return value.split(/[-_]/).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("");
}

function singularize(value: string): string {
  return value.endsWith("ies") ? `${value.slice(0, -3)}y` : value.endsWith("s") ? value.slice(0, -1) : `${value}Item`;
}

