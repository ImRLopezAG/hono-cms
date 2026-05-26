import { ApolloServer, HeaderMap, type ApolloServerOptions, type BaseContext } from "@apollo/server";
import { GraphQLError, Kind, parse, type DocumentNode, type GraphQLFormattedError, type GraphQLSchema, type OperationDefinitionNode } from "graphql";
import type { GraphQLContext } from "./context";

export type CreateApolloHandlerOptions = {
  schema: GraphQLSchema;
  /**
   * When false, GraphQL introspection queries (`__schema`, `__type`) are
   * rejected with a `GRAPHQL_VALIDATION_FAILED` error before Apollo executes
   * them. Defaults to true.
   */
  introspection?: boolean;
};

type GraphQLRequestBody = {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
};

/**
 * Build the GraphQL HTTP handler backed by Apollo Server. Matches the
 * canonical `startServerAndCreateHandler` pattern: takes a Web `Request`,
 * resolves the request-scoped {@link GraphQLContext}, and returns a Web
 * `Response`.
 *
 * Introspection gating happens at the document level — when disabled, any
 * top-level `__*` selection short-circuits with a validation error before
 * Apollo executes.
 */
export function createApolloHandler(
  options: CreateApolloHandlerOptions
): (request: Request, context: GraphQLContext) => Promise<Response> {
  const introspection = options.introspection !== false;
  const serverConfig: ApolloServerOptions<BaseContext> = {
    schema: options.schema,
    introspection: true,
    includeStacktraceInErrorResponses: false,
    formatError: passthroughFormatError
  };
  const server = new ApolloServer<BaseContext>(serverConfig);
  server.startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests();

  return async function handler(request: Request, context: GraphQLContext): Promise<Response> {
    const body = await readGraphQLBody(request);
    if (!body.query) {
      return jsonResponse({
        data: null,
        errors: [{ message: "GraphQL query is required", extensions: { code: "BAD_REQUEST" } }]
      }, 400);
    }

    let document: DocumentNode | undefined;
    try {
      document = parse(body.query);
    } catch {
      return jsonResponse({
        data: null,
        errors: [{ message: "GraphQL query is required", extensions: { code: "BAD_REQUEST" } }]
      }, 400);
    }

    if (!introspection) {
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

    const method = request.method.toUpperCase();
    const httpGraphQLResponse = await server.executeHTTPGraphQLRequest({
      context: async () => context as unknown as BaseContext,
      httpGraphQLRequest: {
        body,
        headers: webHeadersToMap(request.headers),
        method: method === "GET" ? "POST" : method,
        search: ""
      }
    });

    const responseHeaders = new Headers();
    for (const [key, value] of httpGraphQLResponse.headers) responseHeaders.set(key, value);
    responseHeaders.set("content-type", "application/json");

    if (httpGraphQLResponse.body.kind !== "complete") {
      return new Response("Streaming GraphQL responses are not supported", { status: 500 });
    }

    return new Response(httpGraphQLResponse.body.string, {
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
  // Apollo's body decoder requires a matching content-type — GET requests
  // routed through the POST execution path won't have one set otherwise.
  if (!result.has("content-type")) result.set("content-type", "application/json");
  return result;
}

function passthroughFormatError(formatted: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  if (error instanceof GraphQLError && error.extensions) {
    return { ...formatted, extensions: { ...formatted.extensions, ...error.extensions } };
  }
  return formatted;
}

function findIntrospectionRoot(document: DocumentNode): string | null {
  const op = document.definitions.find((def): def is OperationDefinitionNode => def.kind === Kind.OPERATION_DEFINITION);
  if (!op) return null;
  for (const selection of op.selectionSet.selections) {
    if (selection.kind === Kind.FIELD && selection.name.value.startsWith("__")) return selection.name.value;
  }
  return null;
}
