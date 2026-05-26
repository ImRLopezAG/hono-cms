# Hono CMS — Architectural Context

This document defines the load-bearing terms that show up across the codebase
after the plugin-system refactor
(`docs/plans/2026-05-25-001-refactor-plugin-system-architecture-plan.md`). When
docs, code, or commit messages use any of these capitalised nouns, the
meaning here is authoritative.

---

## Plugin

A **Plugin** is a declarative manifest passed to `createCMS({ plugins: [...] })`
that extends the kernel without modifying it. Plugins mirror Better Auth's
plugin shape, adapted from `better-call` to Hono:

```ts
type Plugin = {
  id: string;                      // unique within an install
  requires?: readonly string[];    // plugin ids that MUST appear earlier
  schema?: SchemaExtension;        // plugin-owned internal tables
  app?: (app, ctx) => Hono | void; // route mounting
  hooks?: { before?, after? };     // request hooks (Hono middleware shape)
  middlewares?: Array<...>;        // path-scoped middleware
  onRequest?: (req, ctx) => ...;
  onResponse?: (res, ctx) => ...;
  rateLimit?: Array<...>;
  trustedOrigins?: readonly string[];
  installAuthorize?: (ctx) => Authorize;
  capabilities?: CMSPluginCapabilities;
  mountPhase?: "early" | "normal" | "catchAll";
};
```

Built via `createPlugin({...})`. The factory is a type-narrowing pass-through
with a runtime `id` guard.

## AuthPlugin

An **AuthPlugin** is a `Plugin` that additionally carries a `protected`
middleware (and an optional `identity(req)` resolver). Exactly **one**
AuthPlugin may appear in `plugins: [...]` — installing two throws on boot.
Built via `createAuthPlugin({...})`.

The contract: `protected` resolves an `Identity` from the request and either
calls `await next()` (success) or returns a 401 `Response` (failure). The
kernel wires `protected` around content routes the user marks
`access: "protected"` (default for `/api/<collection>/*`).

`identity(req)` is the **self-contained** resolver: it reads identity from the
raw `Request` alone — headers, cookies, body — without depending on Hono
context state set by earlier middleware. The GraphQL apollo handler reaches
through `ctx.plugins.get<AuthPlugin>("auth").identity(req)` to bridge sessions
into per-request GraphQL context.

## Identity

The opaque shape returned by the AuthPlugin and stored at
`ctx.var.identity`. **From core's perspective, `Identity` is `unknown`.** The
plugin that produces it narrows its own type. The kernel never reads inside
it.

`@hono-cms/auth-tokens` produces `{ subjectId, namespace, metadata }`;
better-auth or Clerk plugins produce their own shape. Policy plugins are
written paired with an auth plugin and may rely on its specific shape — that
coupling is intentional.

## Authorize

A function `(action, collection, resource?) => boolean | Promise<boolean>`
exposed as `ctx.var.authorize` and called inside content/route handlers
after `protected` passes. Provided by **one** policy plugin via
`installAuthorize(ctx) => Authorize`. If no plugin installs it, the default
is `() => true` (no-op — only the auth gate runs).

Actions are open-ended strings; the canonical ones are `"read" | "create" |
"update" | "delete" | "publish" | "unpublish" | "admin"`. Collection is
`null` for non-collection-scoped checks (e.g., `authorize("admin", null)` on
plugin admin routes).

## Internal table vs. CMS collection

- A **CMS collection** is what `defineCollection("<name>", fields)` produces
  — the user-facing content entities served via `/api/<collection>`. They
  appear in the admin Content Manager, GraphQL schema, and OpenAPI spec.
- An **internal table** is plugin-owned storage declared via
  `Plugin.schema` (e.g., `api_keys`, `roles`, `audit_log`, `webhooks`,
  `media`, `translations`). Internal tables flow through
  `SchemaSnapshot.systemTables` and migrate alongside collections via one
  Drizzle journal, but are **invisible to the public content surface** —
  never appear at `/cms/schema`, never get OpenAPI routes, never show up in
  the admin Content Manager.

The two channels share one migration generator and one Drizzle client.
Plugins introspect internal tables via `ctx.systemTables.get("<name>")`.

## Kernel scope

After the refactor, `packages/core` keeps only:

- Plugin runtime: `createCMS`, `createPlugin`, `createAuthPlugin`,
  `installPlugins`, manifest types, lifecycle ordering, plugin DI context,
  schema-merging across plugins.
- Adapter interface types: `DatabaseAdapter`, `StorageAdapter`,
  `CacheAdapter`, `JobsAdapter` (types only — no implementations).
- Schema types (re-exported from `@hono-cms/schema`).
- Minimal content REST: `GET/POST/PUT/PATCH/DELETE /api/<collection>` and
  `GET /api/<collection>/:id`.
- Health endpoints: `/cms/health`, `/cms/health/live`, `/cms/health/ready`.
- The `protected` + `authorize` glue wired around content routes.

Target line count for `create-cms.ts`: ≤ 300 (down from 2,553).

## Service registry (`ctx.plugins.get/has`)

A typed string-keyed registry plugins use to publish a per-instance service
and consume services produced by earlier plugins:

```ts
// In one plugin's app(...)
ctx.plugins.register("cache", cacheAdapterInstance);

// In a later plugin's app(...)  (declares requires: ["cache"])
const cache = ctx.plugins.get<CacheAdapter>("cache");
```

The typing on `get<T>(id)` is `as`-cast — the caller asserts the shape. A
future improvement could use TypeScript module augmentation (like Better
Auth) for precise typing.

## Event bus (`ctx.events.on/emit`)

A string-keyed pub/sub for cross-plugin coordination. Handlers may be async;
`emit(...)` returns the awaited `Promise.all` of all subscribers. **A
handler that throws does not block siblings** — errors are aggregated and
re-thrown as `AggregateError` after all handlers complete.

The event-key vocabulary is open via module augmentation:

```ts
declare module "@hono-cms/core" {
  interface CMSEvents {
    "myplugin:something-happened": { payload: ... };
  }
}
```

Canonical events: `schema:after-collection-{add,remove,update}`,
`content:after-{create,update,delete,publish,unpublish}`,
`media:after-{upload,delete}`.

### Event delivery semantics — "fast handler" rule

`content:after-*` and `media:after-*` handlers are awaited by the kernel
before the response is returned. To prevent slow subscribers from blocking
mutations, **handlers must be fast and non-blocking**. Handlers that need to
do I/O (HTTP delivery, external API calls, expensive computation) MUST
enqueue a job via `ctx.plugins.get<JobsService>("jobs").enqueue(...)` and
return immediately. The job handler does the real work.

`@hono-cms/webhooks` is the canonical example: its event subscribers
enqueue a `webhook-deliver` job; the job runner then performs HTTP delivery.

## Hook registry (`ctx.hooks.on/run`)

Structured replacement for the old free-form `hooks` config object. Plugins
register lifecycle handlers tied to a specific `(event, collection)` pair:

```ts
ctx.hooks.on("before-create", "articles", async (input, ctx) => {
  return { ...input, slug: slugify(input.title) };
});
```

The kernel's content REST handlers invoke the registry at exact lifecycle
points. Hooks differ from events in that hooks **transform input** (the
return value replaces the running payload) while events are **fan-out
notifications**.

## Plugin install order

`createCMS({ plugins: [...] })` installs plugins in **array order**, modified
only by `mountPhase` grouping:

1. `mountPhase: "early"` plugins install first, in array order.
2. `mountPhase: "normal"` (default) installs next, in array order.
3. `mountPhase: "catchAll"` (max one) installs last.

A plugin declaring `requires: ["cache"]` causes `createCMS` to throw on
boot if `"cache"` does not appear earlier in the array. Error messages name
the offending plugin and the missing dependency.

The `catchAll` slot is owned by `@hono-cms/content-type-builder` — its
TrieRouter sub-app catch-all dispatcher must register after every explicit
`/api/*` route the rest of the plugins mount.

## Bootstrap key

When `@hono-cms/auth-tokens` boots and finds an empty `api_keys` table, it
generates one root-scoped key and writes it to
`<process.cwd()>/.cms-bootstrap-key` with mode `0o600`. The file's first
line is a `# DO NOT COMMIT — generated by @hono-cms/auth-tokens on first
run` banner; the second line is the raw `sk_<48-hex>` token. Subsequent
boots are no-ops.

Serverless and read-only filesystems: when `process`/`fs.writeFileSync` are
unavailable OR a write fails with `EROFS`, the plugin falls back to reading
`env.CMS_BOOTSTRAP_KEY`. If neither is available, boot emits a single
descriptive error message naming the env var. An `onBootstrapKey(key)`
callback option lets users wire the key into their own secret manager.

## Module-load safety rule

**No package importable by a Workers/Edge entrypoint runs work at module
top level.** Adapter packages export factory functions that the user calls
inside `createCMS({...})` — work happens inside the request lifecycle, not
at import time.

The historical cause: `packages/cache/src/index.ts` registered the memory
cache via `registerProvider(...)` at the bottom of the file, and
`MemoryCacheAdapter`'s constructor ran `setInterval(...)`. This broke
Cloudflare Workers global scope. The plugin manifest model + lazy
construction inside factories eliminates both.

Adapter packages affected by this rule:
`adapter-{memory,postgres,d1,turso,convex}`,
`storage-{local,memory,r2,s3,vercel-blob}`, `cache`, `jobs`.

---

## Refactor status as of 2026-05-26

The plan covers 26 implementation units across 8 phases. Current state:

**Done and tested:**

- **Phase 0** (U1–U5): plugin runtime foundation in `packages/core/src/plugins/`.
  Tests: 22 plugin-runtime tests + 56 schema tests passing.
- **Phase 1** (U7–U8): `@hono-cms/auth-tokens` with full api_keys + roles +
  bootstrap + protected + authorize. 82 tests passing.
- **Phase 2** (U9): `@hono-cms/cors`. 22 tests.
- **Phase 3** (U10–U12): `@hono-cms/openapi`, `@hono-cms/cache` (promoted to
  plugin), `@hono-cms/jobs-runtime` + adapter factory exports.
  17 + 27 + 49 tests = 93 tests.
- **Phase 4** (U13–U15): `@hono-cms/rate-limit`, `@hono-cms/content-cache`,
  `@hono-cms/preview`. 27 + 32 + 13 = 72 tests.
- **Phase 5** (U16–U17): `@hono-cms/audit` (30 tests),
  `@hono-cms/webhooks` (10 smoke tests; route-level coverage deferred).
- **Plugin-system end-to-end**: `tools/plugin-system-e2e` composes 6
  plugins together over HTTP. 8 integration tests passing.

**Deferred / partial:**

- **Phase 6** (U18–U22): `i18n` (scaffold only), `media`, `drafts`, `graphql`,
  `content-type-builder`. The legacy implementations of these still live in
  `packages/core/src/{content,media,graphql}/` and serve traffic via the
  existing `createCMS` code path. Carving them into plugins is the next
  follow-up.
- **U6**: trimming `CMSConfig` to direct adapters only.
- **U23**: deletion of `OrganizationStore`, `BuiltInAuthConfig`, the
  `core/src/auth/` directory, and the providers registry. Held until U18–U22
  carves land so deletion targets are unreferenced.
- **U24**: full migration of 10 adapter packages from `registerProvider`
  side-effects to named factory exports. Currently only the `@hono-cms/cache`
  factories exist alongside transitional `registerProvider` shims that keep
  legacy core tests green.
- **U25**: `examples/newsroom` rewrite to use `plugins: [...]`.

**Plan supersession:** ADR 0001 (this commit) supersedes
`docs/plans/2026-05-16-002-feat-core-library-plan.md` §U3 ("The registry
pattern must be the sole coupling point"). The registry remains in place
only as a transitional shim during the carve.
