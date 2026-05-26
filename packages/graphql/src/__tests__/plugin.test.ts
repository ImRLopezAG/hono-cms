import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import {
  defineCollection,
  defineSchema,
  fields
} from "@hono-cms/schema";
import {
  createPluginContext,
  installPlugins,
  type CMSEvents,
  type HonoCMSEnv,
  type Identity,
  type PluginContext
} from "@hono-cms/core";
import { graphql, type GraphQLPluginConfig } from "../plugin";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function makeCollections() {
  return defineSchema({
    articles: defineCollection("articles", {
      title: fields.string({ required: true }),
      slug: fields.string({})
    }, {})
  });
}

type AppSetup = {
  app: Hono<HonoCMSEnv>;
  ctx: PluginContext<ReturnType<typeof makeCollections>>;
};

async function buildApp(opts: GraphQLPluginConfig = {}): Promise<AppSetup> {
  const collections = makeCollections();
  const db = createMemoryDatabase({ provider: "memory", collections });
  const app = new Hono<HonoCMSEnv>();
  const ctx = createPluginContext({ collections, db, env: {} });
  await installPlugins([graphql(opts)], app, ctx);
  return { app, ctx };
}

type GraphQLResponse = {
  data?: unknown;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
};

async function gql(app: Hono<HonoCMSEnv>, body: { query: string; variables?: unknown }, path = "/graphql"): Promise<GraphQLResponse> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  expect(res.status).toBeLessThan(500);
  return await res.json() as GraphQLResponse;
}

/* -------------------------------------------------------------------------- */
/* Mount paths + SDL endpoint                                                 */
/* -------------------------------------------------------------------------- */

describe("graphql plugin — mounting + SDL", () => {
  it("mounts /graphql for POST and GET", async () => {
    const { app } = await buildApp();
    const post = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles { items { id title } } }" })
    });
    expect(post.status).toBe(200);
    const postBody = await post.json() as { data: { articles: { items: unknown[] } } };
    expect(postBody.data.articles.items).toEqual([]);

    const get = await app.request(`/graphql?query=${encodeURIComponent("{ articles { items { id title } } }")}`);
    expect(get.status).toBe(200);
  });

  it("serves SDL at /graphql/schema", async () => {
    const { app } = await buildApp();
    const res = await app.request("/graphql/schema");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const sdl = await res.text();
    expect(sdl).toContain("type Query");
    expect(sdl).toContain("type Articles");
    expect(sdl).toContain("createArticle");
  });

  it("mounts the /cms/graphql and /cms/graphql/schema legacy aliases by default", async () => {
    const { app } = await buildApp();
    const post = await app.request("/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles { items { id } } }" })
    });
    expect(post.status).toBe(200);

    const schema = await app.request("/cms/graphql/schema");
    expect(schema.status).toBe(200);
    expect(await schema.text()).toContain("type Query");
  });

  it("skips legacy aliases when legacyAliases is false", async () => {
    const { app } = await buildApp({ legacyAliases: false });
    const post = await app.request("/cms/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles { items { id } } }" })
    });
    expect(post.status).toBe(404);
  });

  it("honours custom path and schemaPath", async () => {
    const { app } = await buildApp({ path: "/api/gql", schemaPath: "/api/gql.sdl" });
    const post = await app.request("/api/gql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles { items { id } } }" })
    });
    expect(post.status).toBe(200);

    const schema = await app.request("/api/gql.sdl");
    expect(schema.status).toBe(200);
    expect(await schema.text()).toContain("type Query");
  });
});

/* -------------------------------------------------------------------------- */
/* Queries + mutations                                                         */
/* -------------------------------------------------------------------------- */

describe("graphql plugin — CRUD against the database adapter", () => {
  it("returns matching records on a list query", async () => {
    const { app, ctx } = await buildApp();
    await ctx.db.create("articles", { title: "First" });
    await ctx.db.create("articles", { title: "Second" });

    const body = await gql(app, { query: "{ articles { items { id title } meta { pagination { hasMore } } } }" });
    expect(body.errors).toBeUndefined();
    const data = body.data as { articles: { items: Array<{ id: string; title: string }>; meta: { pagination: { hasMore: boolean } } } };
    expect(data.articles.items.map((item) => item.title).sort()).toEqual(["First", "Second"]);
    expect(data.articles.meta.pagination.hasMore).toBe(false);
  });

  it("fires content:after-create on a create mutation and returns the record", async () => {
    const { app, ctx } = await buildApp();
    const seen: CMSEvents["content:after-create"][] = [];
    ctx.events.on("content:after-create", (payload) => {
      seen.push(payload);
    });

    const body = await gql(app, {
      query: `mutation { createArticle(data: { title: "Hello" }) { id title } }`
    });
    expect(body.errors).toBeUndefined();
    const data = body.data as { createArticle: { id: string; title: string } };
    expect(data.createArticle.title).toBe("Hello");
    expect(data.createArticle.id).toBeTruthy();

    // Event fired, audit/webhooks plugins would observe it the same way.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.collection).toBe("articles");
    expect(seen[0]?.record.title).toBe("Hello");
  });

  it("fires content:after-update on an update mutation", async () => {
    const { app, ctx } = await buildApp();
    const created = await ctx.db.create("articles", { title: "Old" });
    const seen: CMSEvents["content:after-update"][] = [];
    ctx.events.on("content:after-update", (payload) => {
      seen.push(payload);
    });

    const body = await gql(app, {
      query: `mutation($id: ID!) { updateArticle(id: $id, data: { title: "New" }) { id title } }`,
      variables: { id: created.id }
    });
    expect(body.errors).toBeUndefined();
    const data = body.data as { updateArticle: { id: string; title: string } };
    expect(data.updateArticle.title).toBe("New");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.before?.title).toBe("Old");
  });

  it("fires content:after-delete on a delete mutation", async () => {
    const { app, ctx } = await buildApp();
    const created = await ctx.db.create("articles", { title: "Bye" });
    const seen: CMSEvents["content:after-delete"][] = [];
    ctx.events.on("content:after-delete", (payload) => {
      seen.push(payload);
    });

    const body = await gql(app, {
      query: `mutation($id: ID!) { deleteArticle(id: $id) }`,
      variables: { id: created.id }
    });
    expect(body.errors).toBeUndefined();
    expect((body.data as { deleteArticle: boolean }).deleteArticle).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe(created.id);
  });

  it("runs before-create / after-create lifecycle hooks", async () => {
    const { app, ctx } = await buildApp();
    const seen: string[] = [];
    ctx.hooks.on("before-create", "articles", async (input) => {
      seen.push(`before-create:${(input as { title: string }).title}`);
      return { ...input, title: `${(input as { title: string }).title}!` };
    });
    ctx.hooks.on("after-create", "articles", (record) => {
      seen.push(`after-create:${(record as { title: string }).title}`);
    });

    const body = await gql(app, {
      query: `mutation { createArticle(data: { title: "Hooked" }) { id title } }`
    });
    expect(body.errors).toBeUndefined();
    const data = body.data as { createArticle: { id: string; title: string } };
    // Before-hook mutated the payload before persistence.
    expect(data.createArticle.title).toBe("Hooked!");
    expect(seen).toEqual(["before-create:Hooked", "after-create:Hooked!"]);
  });

  it("returns a validation error when a required field is missing", async () => {
    const { app } = await buildApp();
    // Apollo rejects this at validation time (the SDL declares `title: String!`),
    // surfacing `GRAPHQL_VALIDATION_FAILED`. If the field is optional in the SDL
    // and only required by the underlying Zod schema, the resolver throws our
    // own `VALIDATION_ERROR`. Both shapes are acceptable here.
    const body = await gql(app, {
      query: `mutation { createArticle(data: { slug: "no-title" }) { id } }`
    });
    const code = body.errors?.[0]?.extensions?.code;
    expect(["GRAPHQL_VALIDATION_FAILED", "VALIDATION_ERROR"]).toContain(code);
  });
});

/* -------------------------------------------------------------------------- */
/* Introspection gating                                                        */
/* -------------------------------------------------------------------------- */

describe("graphql plugin — introspection gating", () => {
  it("allows introspection by default", async () => {
    const { app } = await buildApp();
    const body = await gql(app, { query: "{ __schema { queryType { name } } }" });
    expect(body.errors).toBeUndefined();
    const data = body.data as { __schema: { queryType: { name: string } } };
    expect(data.__schema.queryType.name).toBe("Query");
  });

  it("rejects introspection when introspection is false", async () => {
    const { app } = await buildApp({ introspection: false });
    const body = await gql(app, { query: "{ __schema { queryType { name } } }" });
    expect(body.errors).toBeDefined();
    expect(body.errors?.[0]?.extensions?.code).toBe("GRAPHQL_VALIDATION_FAILED");
    expect(body.errors?.[0]?.message).toContain("introspection is disabled");
  });
});

/* -------------------------------------------------------------------------- */
/* Schema rebuild via events                                                   */
/* -------------------------------------------------------------------------- */

describe("graphql plugin — runtime schema rebuild", () => {
  it("rebuilds the schema after schema:after-collection-add and serves queries against the new collection", async () => {
    const { app, ctx } = await buildApp();
    // The collection isn't there yet — query should return an error.
    const before = await gql(app, { query: "{ posts { items { id } } }" });
    expect(before.errors).toBeDefined();

    // Mutate the live collections (kernel-shared reference) + emit the event
    // the plugin listens for. content-type-builder will do this the same way.
    const collections = ctx.collections as unknown as Record<string, unknown>;
    collections.posts = defineCollection(
      "posts",
      { headline: fields.string({ required: true }) },
      {}
    );
    await ctx.events.emit("schema:after-collection-add", {
      name: "posts",
      collection: collections.posts as never
    });

    // Schema rebuilt — same query now succeeds.
    const after = await gql(app, { query: "{ posts { items { headline } } }" });
    expect(after.errors).toBeUndefined();
    const data = after.data as { posts: { items: unknown[] } };
    expect(data.posts.items).toEqual([]);

    // SDL endpoint reflects the new shape too (it reads ctx.collections at
    // request time, no rebuild required).
    const sdl = await (await app.request("/graphql/schema")).text();
    expect(sdl).toContain("type Posts");
  });

  it("keeps the previous schema active when a rebuild throws (schema rebuild failure)", async () => {
    const { app, ctx } = await buildApp();
    // Sanity: articles queryable before the bad rebuild.
    const baseline = await gql(app, { query: "{ articles { items { id } } }" });
    expect(baseline.errors).toBeUndefined();

    // Swap in an invalid collection that will trip the SDL builder when
    // `buildGraphQLSchema` is called. We simulate the failure by stubbing the
    // collections to a shape that fails parsing — but the cleanest path here
    // is to mutate `name` to an empty string so `defineCollection` doesn't
    // produce a valid identifier. Actually simpler: stub a non-object
    // collection. We patch the prototype briefly to throw on rebuild.
    const collections = ctx.collections as unknown as Record<string, unknown>;
    // Inject a broken collection — invalid `name` makes `pascal()` produce ""
    // and the SDL ends up emitting `type {`, which makes `makeExecutableSchema`
    // throw. Any throw path is fine for this test — the assertion is that
    // GraphQL traffic keeps serving.
    collections.broken = { name: "", fields: {}, options: {} };
    // eslint-disable-next-line no-console
    const warnSpy = (globalThis as { console: { warn: (...args: unknown[]) => void } }).console.warn;
    let warned = false;
    (globalThis as { console: { warn: (...args: unknown[]) => void } }).console.warn = () => {
      warned = true;
    };
    try {
      await ctx.events.emit("schema:after-collection-add", {
        name: "broken",
        collection: collections.broken as never
      });
    } catch {
      // Swallow — the plugin handler shouldn't throw, but the event bus may
      // bubble unrelated errors; the assertion below is what matters.
    } finally {
      (globalThis as { console: { warn: (...args: unknown[]) => void } }).console.warn = warnSpy;
    }
    expect(warned).toBe(true);

    // Existing query still works (last-known-good schema retained).
    const after = await gql(app, { query: "{ articles { items { id } } }" });
    expect(after.errors).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Session bridge                                                              */
/* -------------------------------------------------------------------------- */

describe("graphql plugin — session bridge", () => {
  it("passes identity resolved by the auth plugin's identity(req) into resolvers", async () => {
    // Build a minimal auth plugin that registers `identity()` under the
    // `auth-tokens` id. The graphql plugin should look it up and feed the
    // resolved identity to mutation hooks/events.
    const collections = makeCollections();
    const db = createMemoryDatabase({ provider: "memory", collections });
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext({ collections, db, env: {} });

    const fakeAuthPlugin = {
      id: "auth-tokens",
      app: (_app: Hono<HonoCMSEnv>, c: PluginContext) => {
        c.plugins.register("auth-tokens", {
          identity: (req: Request): Identity | null => {
            const auth = req.headers.get("authorization");
            if (auth === "Bearer alice") return { subjectId: "user-alice", namespace: "editor" };
            return null;
          }
        });
      }
    };

    // Plugin order: auth-tokens before graphql (graphql depends on the
    // service being registered).
    await installPlugins([fakeAuthPlugin as never, graphql({})], app, ctx);

    const observed: unknown[] = [];
    ctx.events.on("content:after-create", (payload) => {
      observed.push(payload.identity);
    });

    // Authenticated request — identity should propagate.
    const authed = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer alice" },
      body: JSON.stringify({ query: `mutation { createArticle(data: { title: "Auth" }) { id } }` })
    });
    expect(authed.status).toBe(200);

    // Anonymous request — identity null.
    const anon = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: `mutation { createArticle(data: { title: "Anon" }) { id } }` })
    });
    expect(anon.status).toBe(200);

    expect(observed).toEqual([
      { subjectId: "user-alice", namespace: "editor" },
      null
    ]);
  });

  it("treats identity() throws as anonymous (keeps GraphQL reachable)", async () => {
    const collections = makeCollections();
    const db = createMemoryDatabase({ provider: "memory", collections });
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext({ collections, db, env: {} });

    const fakeAuthPlugin = {
      id: "auth-tokens",
      app: (_app: Hono<HonoCMSEnv>, c: PluginContext) => {
        c.plugins.register("auth-tokens", {
          identity: () => {
            throw new Error("auth backend offline");
          }
        });
      }
    };

    await installPlugins([fakeAuthPlugin as never, graphql({})], app, ctx);

    const res = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ articles { items { id } } }" })
    });
    expect(res.status).toBe(200);
    const body = await res.json() as GraphQLResponse;
    expect(body.errors).toBeUndefined();
  });
});
