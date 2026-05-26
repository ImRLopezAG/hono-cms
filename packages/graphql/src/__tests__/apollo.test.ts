import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { defineCollection, defineSchema, fields, type CMSCollections } from "@hono-cms/schema";
import { createEventBus, createHookRegistry } from "@hono-cms/core";
import { buildGraphQLSchema } from "../schema-builder";
import { createApolloHandler } from "../apollo-handler";
import type { GraphQLContext } from "../context";

function makeCollections(): CMSCollections {
  return defineSchema({
    articles: defineCollection("articles", {
      title: fields.string({ required: true })
    }, {})
  });
}

async function buildContext(collections: CMSCollections, request: Request): Promise<GraphQLContext> {
  const db = createMemoryDatabase({ provider: "memory", collections });
  return {
    collections,
    db,
    identity: null,
    request,
    events: createEventBus(),
    hooks: createHookRegistry()
  };
}

describe("createApolloHandler", () => {
  it("executes a simple list query and returns JSON", async () => {
    const collections = makeCollections();
    const schema = buildGraphQLSchema(collections);
    const handler = createApolloHandler({ schema });

    const request = new Request("http://x/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles { items { id title } meta { pagination { hasMore } } } }" })
    });
    const context = await buildContext(collections, request);
    const response = await handler(request, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json() as { data: { articles: { items: unknown[]; meta: { pagination: { hasMore: boolean } } } } };
    expect(body.data.articles.items).toEqual([]);
    expect(body.data.articles.meta.pagination.hasMore).toBe(false);
  });

  it("rejects requests without a query body", async () => {
    const collections = makeCollections();
    const schema = buildGraphQLSchema(collections);
    const handler = createApolloHandler({ schema });

    const request = new Request("http://x/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const context = await buildContext(collections, request);
    const response = await handler(request, context);
    expect(response.status).toBe(400);
    const body = await response.json() as { errors: Array<{ extensions: { code: string } }> };
    expect(body.errors[0]?.extensions.code).toBe("BAD_REQUEST");
  });

  it("rejects introspection queries when introspection is false", async () => {
    const collections = makeCollections();
    const schema = buildGraphQLSchema(collections);
    const handler = createApolloHandler({ schema, introspection: false });

    const request = new Request("http://x/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __schema { queryType { name } } }" })
    });
    const context = await buildContext(collections, request);
    const response = await handler(request, context);
    expect(response.status).toBe(200);
    const body = await response.json() as { errors: Array<{ extensions: { code: string }; message: string }> };
    expect(body.errors[0]?.extensions.code).toBe("GRAPHQL_VALIDATION_FAILED");
    expect(body.errors[0]?.message).toContain("introspection is disabled");
  });

  it("answers introspection queries when introspection is true", async () => {
    const collections = makeCollections();
    const schema = buildGraphQLSchema(collections);
    const handler = createApolloHandler({ schema, introspection: true });

    const request = new Request("http://x/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __schema { queryType { name } } }" })
    });
    const context = await buildContext(collections, request);
    const response = await handler(request, context);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { __schema: { queryType: { name: string } } } };
    expect(body.data.__schema.queryType.name).toBe("Query");
  });

  it("handles GET requests with the query in the URL", async () => {
    const collections = makeCollections();
    const schema = buildGraphQLSchema(collections);
    const handler = createApolloHandler({ schema });

    const query = encodeURIComponent("{ articles { items { id } } }");
    const request = new Request(`http://x/graphql?query=${query}`);
    const context = await buildContext(collections, request);
    const response = await handler(request, context);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { articles: { items: unknown[] } } };
    expect(body.data.articles.items).toEqual([]);
  });
});
