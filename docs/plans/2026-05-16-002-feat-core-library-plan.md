---
title: "feat: Core Library — createCMS API and Hono Composition"
date: 2026-05-16
type: feat
status: active
depth: deep
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
ideation-ideas: ["#2 CMS as Deployable Library", "#14 createCMS Returns Hono + Internals"]
---

# feat: Core Library — createCMS API and Hono Composition

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 2
**Research inputs used:** skill review, framework docs, architecture review

### Key Improvements

1. Clarify that the core builder is the single composition root for runtime metadata.
2. Separate internal Hono typing from public contract generation.
3. Add stronger guarantees around deterministic feature registration.

## Summary

`@hono-cms/core` is the single entry point through which every consumer — a Cloudflare Worker, a Next.js route, an Elysia app, or a bare Node.js server — instantiates the CMS. This plan specifies the `createCMS` function, its TypeScript type surface, the internal bootstrap sequence that wires providers together, the Hono route composition model, WinterTC compatibility, and the package scaffolding required to ship `packages/core` as a publishable npm package.

This is Plan 002 of 18. Every subsequent plan (schema, adapters, auth, content routes, GraphQL, OpenAPI, admin SPA, CLI) imports from or depends on the API surface defined here. Getting these types and contracts right up front is the plan's primary purpose.

---

## Problem Frame

Strapi's architectural ceiling is its monolithic bootstrap: a single Koa process that couples the HTTP framework, admin panel, database connection, and auth layer in one mandatory startup sequence. This makes Strapi impossible to embed, impossible to deploy on edge runtimes, and expensive to operate.

The inverse pattern — *CMS as an importable library* — eliminates all three problems simultaneously. `createCMS` returns a Hono application already wired with routes, auth, RBAC, and optional features. The developer exports it as a Worker, mounts it at a sub-path, or passes it to any framework that accepts `(Request) => Promise<Response>`. There is no CMS process to run separately, no CORS to configure between admin and API, no second infrastructure artifact.

The central design challenge this plan addresses: how do you make that composition ergonomic, type-safe, synchronous at the call site, and tree-shakeable across all providers?

---

## Scope Boundaries

### In Scope

- `CMSConfig` TypeScript type covering all top-level config keys
- Provider discriminated unions for `db`, `storage`, `cache`, `email`, `crons`
- `createCMS` function — synchronous, generic, returns `Hono & { auth: BetterAuth; db: DrizzleInstance }`
- Provider factory functions that instantiate adapters from config (tree-shakeable)
- Hono app composition and route mounting order
- `cms.scheduled` export for Cloudflare Cron Triggers
- Package scaffolding: `package.json`, `tsdown.config.ts`, `vitest.config.ts`, `tsconfig.json`
- Public export surface of `@hono-cms/core`
- WinterTC compatibility tests

### Deferred to Follow-Up Work

- Content route handler implementations (Plan 003 — content routes)
- Schema compiler / `defineCollection` internals (Plan 001 — schema package)
- Individual adapter package implementations (`@hono-cms/adapter-d1`, etc. — Plan 004+)
- GraphQL schema generation and Apollo integration internals (covered by the graphql feature plan)
- OpenAPI spec generation logic (covered by the openapi feature plan)
- `cms.scheduled` job handler logic bodies (covered by the crons plan)
- Admin SPA (Plan 005+)
- CLI (`cms dev`, `cms schema plan/apply`) — separate package

### Outside This Product's Identity

- Providing a hosted / managed CMS service (this is always a self-deployed library)
- Runtime database switching (the provider is fixed at build time by design)
- Wrapping or embedding a third-party CMS engine

---

## Key Technical Decisions

## Research Insights

**Best Practices:**
- Keep `createCMS` as the only place that binds adapters, middleware order, feature metadata, and mounted routes.
- Export Hono `AppType` for internal same-workspace consumers and tests, but avoid making it the only public contract for external clients.
- Use typed Hono middleware `Variables` for shared context such as `user`, `session`, `db`, and request metadata.

**Implementation Details:**
- Add a shared contracts/metadata manifest early so route validators, docs generation, SDK output, and admin discovery read from one normalized source.
- Provide a minimal fake-adapter test fixture so later plans can validate behavior without booting every real subsystem.

**Edge Cases:**
- Duplicate route or feature registration should fail with explicit diagnostics.
- Middleware ordering assumptions for auth, RBAC, docs, and health should be encoded, not left implicit.

### 1. Why `Object.assign` vs returning a wrapper object

`Object.assign(app, { auth, db })` makes the returned value a real `Hono` instance — not a custom class or proxy. This means:

- Every framework that accepts a Hono app accepts `cms` without unwrapping
- `cms.use()`, `cms.route()`, `cms.fetch()` all work natively because the object IS Hono
- TypeScript sees `Hono<HonoEnv> & { auth: BetterAuth; db: DrizzleInstance }` — an intersection, not a wrapper
- The developer never writes `cms.app.use(...)` — there is no `.app` indirection

A wrapper object (`{ app, auth, db }`) would break every framework integration that expects a Hono instance directly. `export default cms` would not work for Cloudflare Workers because Workers calls `.fetch` on the default export — a wrapper object has no `.fetch`. `new Elysia().mount('/cms', cms.fetch)` would require `cms.app.fetch`. The `Object.assign` pattern avoids all of this with zero runtime overhead.

The TypeScript return type must be declared explicitly (`Hono<HonoEnv> & { auth: Auth; db: DB }`) because TypeScript does not infer intersection types from `Object.assign` — this is a known limitation documented in the TS issue tracker. The function signature uses a generic overload to thread the exact `DB` type through.

### 2. Why synchronous bootstrap (not `await createCMS(...)`)

WinterTC-compliant runtimes (Cloudflare Workers, Deno Deploy, Vercel Edge) evaluate the module body once at cold start. All I/O happens inside request handlers. `await createCMS(...)` at module scope would require top-level await, which:

- Forces module evaluation to be async — valid in modern ESM but prevents synchronous re-export patterns
- Moves provider connection errors from import-time to first-request-time, making startup failures silent
- Prevents `export default await createCMS(...)` in Workers (top-level await works there, but only in ESM Workers, and it serializes cold start)

The correct model: `createCMS` synchronously builds the Hono app and registers all routes. Any I/O (opening a DB connection, pinging the cache) happens the first time a request triggers a handler that needs it — lazy initialization behind the adapter interface. The `DatabaseAdapter` interface used by Plan 001 is designed for this: `adapter.query(...)` returns a Promise; the adapter establishes its connection on first call, not at instantiation.

This also means `createCMS` is safe to call at module scope in Node.js, Bun, Deno, and Workers without any top-level await concern.

### 3. Why tree-shaking via per-provider packages

If `packages/core` imported every provider directly (`@upstash/redis`, `@aws-sdk/client-s3`, `@cloudflare/workers-types`, etc.), every consumer's bundle would include all of them regardless of which providers they configured. A Cloudflare Worker using D1 and R2 would ship the Postgres, Turso, S3, and Postmark clients — increasing the compressed bundle by multiple megabytes and potentially breaking size limits.

The solution: each provider is a **separate npm package** (`@hono-cms/adapter-d1`, `@hono-cms/adapter-postgres`, `@hono-cms/cache-upstash`, etc.) that `packages/core` lists as a peer dependency, not a direct dependency. The factory functions in `packages/core` use conditional branches that import-by-provider-key — but because the unused branches reference packages that are peer deps and not installed, bundlers (esbuild via tsdown) tree-shake them out entirely when the import path resolves to nothing.

In practice this means the factory functions use a **registry pattern** populated by the adapter packages themselves (each adapter registers itself at import time), not a static `switch` that imports all adapters. The consumer's `package.json` only installs the adapters they use, which are the only ones present in `node_modules`, which are the only ones that survive bundling.

### 4. Why `cms.fetch` and not a custom property for the WinterTC handler

The WinterTC fetch handler signature is `(request: Request, env?, ctx?) => Promise<Response>`. Hono's native `.fetch` method already IS this signature — it is the canonical WinterTC-compliant handler. Creating a separate `cms.handler` or `cms.mount` property would be redundant and would require documentation explaining the difference.

By making `cms` a real Hono instance (via `Object.assign`), `cms.fetch` is Hono's own `.fetch`. Every framework integration (Cloudflare Workers `export default cms`, Elysia `.mount('/cms', cms.fetch)`, Next.js `export { handler as GET }`) works via the same property with no adapter code in `packages/core`.

The only special-case export is `cms.scheduled` for Cloudflare Cron Triggers, which call the Worker's `scheduled` export with a `ScheduledController` argument, not a `Request`. This is a thin wrapper that translates `scheduled(event, env, ctx)` into the appropriate internal job handler call.

### 5. How TypeScript generics thread the DB type through

`createCMS` is generic over the `DbConfig` variant. The factory function `createDatabaseAdapter<C extends DbConfig>(config: C)` returns a discriminated type: when `C` is `SqliteDbConfig`, the return type is `LibSQLDatabase<typeof schema>`; when `C` is `D1DbConfig`, the return type is `DrizzleD1Database<typeof schema>`; etc.

The `CMSInstance` return type is parameterized on the resolved DB type:

```
createCMS<C extends CMSConfig>(config: C): CMSInstance<InferDbType<C>>
type CMSInstance<DB> = Hono<HonoEnv> & { auth: Auth; db: DB }
```

`InferDbType` is a conditional type that maps from `CMSConfig['db']['provider']` to the correct Drizzle instance type. This means `cms.db` is typed as `LibSQLDatabase` when provider is `'sqlite'`, `DrizzleD1Database` when provider is `'d1'`, etc. — no `as any` casts required at call sites.

The Drizzle schema object passed to the adapter factory is the compiled schema from `@hono-cms/schema`. The adapter packages re-export the Drizzle schema extended with their own tables (auth tables, webhook tables, etc.) so the returned instance type reflects the full schema, not just content tables.

---

## High-Level Technical Design

*This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Bootstrap flow

```
createCMS(config: CMSConfig)
  │
  ├─ createDatabaseAdapter(config.db)     → DatabaseAdapter & DrizzleInstance
  ├─ createStorageAdapter(config.storage) → StorageAdapter
  ├─ createCacheAdapter(config.cache)     → CacheAdapter
  ├─ createEmailProvider(config.email)    → EmailProvider
  ├─ createJobsProvider(config.crons)     → JobsProvider
  │
  ├─ betterAuth({ database: drizzleAdapter(db), plugins, email })
  │
  ├─ new Hono<HonoEnv>()
  │    ├─ .use('*', injectServices({ db, storage, cache }))   // context injection
  │    ├─ .route('/api/auth', authRouter(auth))               // better-auth handler
  │    ├─ .use('/api/*', rbacMiddleware(auth))                // RBAC gate
  │    ├─ .route('/api', contentRouter(schema, db, cache))    // collection CRUD
  │    ├─ .route('/cms/jobs', jobsRouter(jobs))               // cron job endpoints
  │    ├─ .get('/cms/health', healthHandler({ db, storage, cache, email, jobs }))
  │    ├─ [if graphql] .all('/graphql', graphqlHandler(schema, db, auth))
  │    └─ [if openapi] .get('/cms/openapi.json', openapiHandler(schema))
  │                    .get('/cms/docs', scalarHandler(config.openapi))
  │
  └─ return Object.assign(app, { auth, db })
       → type: Hono<HonoEnv> & { auth: BetterAuth; db: DrizzleInstance }
```

### Deployment patterns (WinterTC surface)

```
Cloudflare Worker:   export default cms
                     export const scheduled = cms.scheduled

Elysia embed:        new Elysia().mount('/cms', cms.fetch)

Hono embed:          app.all('/cms/*', c => cms.fetch(c.req.raw))

Next.js App Router:  const h = (req: Request) => cms.fetch(req)
                     export { h as GET, h as POST, h as PUT, ... }

Node.js standalone:  serve({ fetch: cms.fetch, port: 3000 })
```

### Provider registry (tree-shaking mechanism)

```
@hono-cms/adapter-d1
  └─ on import: registerDatabaseProvider('d1', D1AdapterFactory)

@hono-cms/adapter-postgres
  └─ on import: registerDatabaseProvider('postgres', PostgresAdapterFactory)

packages/core/src/providers/db.ts
  └─ createDatabaseAdapter(config):
       factory = registry.get(config.provider)
       if (!factory) throw ConfigError(`No adapter registered for '${config.provider}'`)
       return factory(config)
```

The consumer's entry file imports the adapter packages they need. Unused adapters are never in `node_modules` and never bundled.

---

## Output Structure

```
packages/core/
├── package.json
├── tsconfig.json
├── tsdown.config.ts
├── vitest.config.ts
├── src/
│   ├── index.ts                        # public barrel — createCMS + all types
│   ├── create-cms.ts                   # createCMS implementation
│   ├── types/
│   │   ├── config.ts                   # CMSConfig and all sub-config types
│   │   ├── instance.ts                 # CMSInstance, HonoEnv, InferDbType
│   │   └── providers.ts                # DatabaseAdapter, StorageAdapter, etc. interfaces
│   ├── providers/
│   │   ├── registry.ts                 # provider registration primitives
│   │   ├── db.ts                       # createDatabaseAdapter factory
│   │   ├── storage.ts                  # createStorageAdapter factory
│   │   ├── cache.ts                    # createCacheAdapter factory
│   │   ├── email.ts                    # createEmailProvider factory
│   │   └── jobs.ts                     # createJobsProvider factory
│   ├── routes/
│   │   ├── auth.ts                     # better-auth Hono handler mounting
│   │   ├── content.ts                  # content router stub (delegates to plan 003)
│   │   ├── graphql.ts                  # graphql route mounting (conditional)
│   │   ├── openapi.ts                  # openapi + scalar route mounting (conditional)
│   │   ├── health.ts                   # GET /cms/health handler
│   │   └── jobs.ts                     # POST /cms/jobs/* handlers
│   ├── middleware/
│   │   ├── inject-services.ts          # context injection middleware
│   │   └── rbac.ts                     # RBAC permission middleware stub
│   └── scheduled.ts                    # cms.scheduled export for CF Cron Triggers
└── test/
    ├── create-cms.test.ts              # unit tests for createCMS bootstrap
    ├── config-types.test-d.ts          # type-level tests (tsd / expect-type)
    ├── provider-factories.test.ts      # unit tests for factory functions
    ├── route-composition.test.ts       # integration: all routes mounted correctly
    ├── wintertc.test.ts                # WinterTC handler compatibility tests
    └── fixtures/
        ├── minimal-config.ts           # test fixture — sqlite + no optional features
        └── full-config.ts              # test fixture — all providers + all features
```

---

## Implementation Units

### U1. CMSConfig type definition

**Goal:** Define the complete TypeScript type for the `createCMS` argument, including all sub-config types, provider discriminated unions, and required vs optional fields. This is the developer-facing contract — every field the user can pass to `createCMS`.

**Requirements:** Covers all config keys from the ideation: `db`, `storage`, `cache`, `email`, `crons`, `auth`, `graphql`, `openapi`, `i18n`, `webhooks`, `schema`. Each sub-type is a discriminated union keyed on `provider`. Optional fields use `?` — only `db` is required (every other config key is optional and the CMS operates without it).

**Dependencies:** None (pure TypeScript types, no runtime imports).

**Files:**
- `packages/core/src/types/config.ts` — primary type definitions
- `packages/core/src/types/providers.ts` — abstract adapter interfaces (`DatabaseAdapter`, `StorageAdapter`, `CacheAdapter`, `EmailProvider`, `JobsProvider`)
- `packages/core/src/types/instance.ts` — `CMSInstance<DB>`, `HonoEnv`, `InferDbType<C>`
- `packages/core/test/config-types.test-d.ts` — type-level tests

**Approach:**

`DbConfig` is a discriminated union on the `provider` literal:

- `{ provider: 'sqlite'; options: { url: string } }` — libSQL/Turso via `@hono-cms/adapter-sqlite`
- `{ provider: 'd1'; binding: D1Database }` — Cloudflare D1 via `@hono-cms/adapter-d1`
- `{ provider: 'postgres'; options: { connectionString: string } }` — Neon/Supabase/PlanetScale via `@hono-cms/adapter-postgres`
- `{ provider: 'turso'; options: { url: string; authToken: string } }` — Turso embedded replicas via `@hono-cms/adapter-turso`
- `{ provider: 'convex'; options: { url: string } }` — Convex via `@hono-cms/adapter-convex`

`StorageConfig`:
- `{ provider: 'r2'; binding: R2Bucket }` — Cloudflare R2 binding
- `{ provider: 's3'; options: { bucket: string; region: string; credentials: { accessKeyId: string; secretAccessKey: string } } }`
- `{ provider: 'blob'; token: string }` — Vercel Blob
- `{ provider: 'local'; dir: string }` — Node.js dev

`CacheConfig`:
- `{ provider: 'upstash'; url: string; token: string }` — Upstash Redis HTTP
- `{ provider: 'kv'; binding: KVNamespace }` — Cloudflare KV (read cache only — document this limitation)
- `{ provider: 'memory' }` — in-process, dev only

`EmailConfig`:
- `{ provider: 'resend'; apiKey: string; from?: string }` — Resend
- `{ provider: 'postmark'; token: string; from?: string }` — Postmark
- `{ provider: 'smtp'; host: string; port: number; user: string; pass: string; from?: string }` — generic SMTP
- `{ provider: 'console' }` — default dev behavior (logs to stdout, never sends)

`CronsConfig`:
- `{ provider: 'qstash'; token: string; currentSigningKey?: string; nextSigningKey?: string }` — QStash HMAC verification
- `{ provider: 'vercel' }` — no token, same-deployment cron via `vercel.json`
- `{ provider: 'cloudflare' }` — uses `scheduled` export, no HTTP endpoint
- `{ provider: 'none' }` — disables background jobs

`AuthConfig`:
- `{ plugins?: BetterAuthPlugin[]; trustedOrigins?: string[]; secret?: string }` — all fields optional; `secret` defaults to `process.env.BETTER_AUTH_SECRET`

`GraphQLConfig`:
- `true` (shorthand for default options) or `{ path?: string; introspection?: boolean; playground?: boolean }`

`OpenAPIConfig`:
- `true` (shorthand) or `{ path?: string; docs?: string; title?: string; version?: string }`

`I18nConfig`:
- `{ locales: string[]; default: string; provider: 'anthropic' | 'openai' | 'gateway'; model: string; apiKey?: string }`

`WebhookConfig` (array element):
- `{ url: string; events: string[]; secret?: string }` — events use glob patterns (`*.publish`)

`SchemaConfig`:
- `{ dir: string }` — defaults to `'./cms/collections'` when omitted

`CMSConfig` top-level shape:
- `db` — **required**
- `storage`, `cache`, `email`, `crons`, `auth`, `graphql`, `openapi`, `i18n`, `webhooks`, `schema` — all optional

The `D1Database`, `R2Bucket`, and `KVNamespace` types are sourced from `@cloudflare/workers-types`. These are declared as peer-optional — the types file uses `/// <reference types="@cloudflare/workers-types" />` only inside a conditional block guarded by a `// @ts-ignore` or declared ambient when the package is absent. The cleaner approach: the binding-based config types (`D1DbConfig`, `R2StorageConfig`, `KVCacheConfig`) live in a separate `types/cloudflare.ts` file that consumers import only if they use CF bindings. The main `config.ts` union references them via `import type`.

**Test scenarios:**

Type-level tests using `expect-type` or `tsd` (`test/config-types.test-d.ts`):

1. `CMSConfig` with only `db` required — TypeScript accepts `{ db: { provider: 'sqlite', options: { url: '...' } } }` without error
2. Missing `db` field — TypeScript produces a type error
3. `db: { provider: 'sqlite' }` without `options` — TypeScript produces a type error (discriminated union exhaustiveness)
4. `db: { provider: 'd1', options: { url: '...' } }` — TypeScript produces a type error (`d1` provider requires `binding`, not `options`)
5. `graphql: true` — accepted; `graphql: { path: '/gql', introspection: false }` — accepted; `graphql: 'yes'` — type error
6. `auth: { plugins: [organization()] }` — accepted; `auth: { unknownField: true }` — type error
7. `webhooks: [{ url: 'https://...', events: ['*.publish'] }]` — accepted
8. `i18n: { locales: ['en'], default: 'en', provider: 'anthropic', model: 'claude-haiku-4-5' }` — accepted; `i18n: { locales: [], default: 'en', provider: 'anthropic', model: '...' }` — should warn (empty locales — consider a minimum-length tuple type or runtime validation)
9. Full config with all keys — accepted without error
10. `InferDbType<{ db: { provider: 'sqlite'; options: { url: string } } }>` resolves to `LibSQLDatabase` (not `unknown`, not `any`)
11. `InferDbType<{ db: { provider: 'd1'; binding: D1Database } }>` resolves to `DrizzleD1Database`

**Verification:** `pnpm tsc --noEmit` in `packages/core` passes. All type-level test cases compile correctly when valid and produce errors when invalid. No `any` leaks visible in IDE hover — `cms.db` shows the concrete Drizzle type.

---

### U2. createCMS function core

**Goal:** Implement the `createCMS` function body: instantiate adapters from config using provider factories, compose the Hono app with all route registrations in the correct order, attach `auth` and `db` via `Object.assign`, and return the typed `CMSInstance`.

**Requirements:**
- Synchronous — no `await` at the function body level; all I/O deferred to request time
- Bootstrap sequence matches the ideation: DB → storage → cache → email → auth → RBAC middleware → content routes → graphql (conditional) → openapi (conditional) → health → webhooks → jobs → `Object.assign` return
- Generic over `C extends CMSConfig` to thread the `db` provider type through to the return type
- `HonoEnv` variables interface carries `{ db: DatabaseAdapter; storage: StorageAdapter | null; cache: CacheAdapter | null; ... }` so handlers access services via `c.var`

**Dependencies:** U1 (type definitions), U3 (provider factories)

**Files:**
- `packages/core/src/create-cms.ts` — function implementation
- `packages/core/src/middleware/inject-services.ts` — service injection middleware
- `packages/core/src/scheduled.ts` — `cms.scheduled` export factory
- `packages/core/test/create-cms.test.ts` — unit and integration tests

**Approach:**

`createCMS` body in order:

1. Call `createDatabaseAdapter(config.db)` → `{ adapter, db }` (adapter is the abstract interface; `db` is the Drizzle instance)
2. Call `createStorageAdapter(config.storage ?? null)` → `StorageAdapter | null`
3. Call `createCacheAdapter(config.cache ?? null)` → `CacheAdapter | null`
4. Call `createEmailProvider(config.email ?? { provider: 'console' })` → `EmailProvider`
5. Call `createJobsProvider(config.crons ?? { provider: 'none' }, { db })` → `JobsProvider`
6. Construct the better-auth instance: `betterAuth({ database: drizzleAdapter(db, { schema: authSchema }), plugins: config.auth?.plugins ?? [], emailAndPassword: { enabled: true }, ... })` — import `better-auth` and `@better-auth/drizzle-adapter` as direct dependencies of `packages/core` (not peer deps, because better-auth is always used)
7. `const app = new Hono<HonoEnv>()`
8. `app.use('*', injectServices({ db: adapter, storage, cache, email, jobs, auth }))` — stores all service instances in `c.var` for downstream handlers
9. `app.route('/api/auth', authRouter(auth))` — wraps better-auth's Hono handler
10. `app.use('/api/*', rbacMiddleware({ auth, cache }))` — reads session; attaches role to context; rejects unauthorized ops
11. `app.route('/api', contentRouter({ schema: compiledSchema, db: adapter, cache, webhooks: config.webhooks ?? [] }))` — REST CRUD for all collections
12. `app.route('/cms/jobs', jobsRouter({ jobs, db: adapter, cache }))` — job endpoint stubs
13. `app.get('/cms/health', healthHandler({ db: adapter, storage, cache, email, jobs }))` — always registered
14. If `config.graphql` is truthy: `app.all('/graphql', graphqlHandler({ schema: compiledSchema, db: adapter, auth }))` — Apollo via `@as-integrations/next`
15. If `config.openapi` is truthy: `app.get(openapiPath, openapiHandler({ schema: compiledSchema }))` then `app.get(docsPath, scalarHandler({ openapiPath }))`
16. Build `cms.scheduled` via `createScheduledHandler({ jobs, db: adapter, crons: config.crons ?? null })`
17. `return Object.assign(app, { auth, db, scheduled: cms.scheduled }) as CMSInstance<InferDbType<C>>`

The compiled schema is resolved from `config.schema?.dir ?? './cms/collections'`. The schema compiler is imported from `@hono-cms/schema` (a peer dependency — it must be installed by the consumer). In the `packages/core` context, schema compilation happens synchronously at import time by reading the pre-compiled schema exports. The `contentRouter` and other route constructors accept the compiled schema as a plain object — no dynamic file I/O in `createCMS` itself.

`HonoEnv` shape:
```
type HonoEnv = {
  Variables: {
    db: DatabaseAdapter
    storage: StorageAdapter | null
    cache: CacheAdapter | null
    email: EmailProvider
    jobs: JobsProvider
    auth: BetterAuth
    session: Session | null    // populated by RBAC middleware on /api/* routes
    role: string | null        // populated by RBAC middleware
  }
}
```

The `as CMSInstance<InferDbType<C>>` cast at the return statement is the only `as` in the codebase. It is necessary because `Object.assign` returns `Hono & { auth: ...; db: ... }` and TypeScript cannot narrow the `db` type to the generic without an explicit cast. A comment explaining this MUST accompany the cast.

**Test scenarios** (`test/create-cms.test.ts`):

Happy path:
1. `createCMS({ db: { provider: 'sqlite', options: { url: ':memory:' } } })` returns a value with a `.fetch` method (is a Hono instance)
2. Returned value has `.auth` property (is a better-auth instance — check for `auth.api.getSession` function)
3. Returned value has `.db` property (check for Drizzle query interface — `db.query` or `db.select`)
4. Returned value has `.scheduled` property (is a function with arity matching `(event, env, ctx) => Promise<void>`)
5. With `graphql: true`, `GET /graphql` route is registered — a request to the handler returns a non-404 response
6. With `openapi: true`, `GET /cms/openapi.json` returns 200 with `Content-Type: application/json`
7. With `openapi: { docs: '/docs' }`, `GET /docs` returns 200 with HTML body
8. Without `graphql` config, `GET /graphql` returns 404
9. Without `openapi` config, `GET /cms/openapi.json` returns 404

Service injection:
10. A request to any `/api/*` route has `c.var.db` populated (not undefined)
11. A request to any `/api/*` route has `c.var.auth` populated
12. With no `storage` config, `c.var.storage` is null — no error thrown

Route ordering (important — auth must come before content routes, RBAC before content handlers):
13. `GET /api/auth/session` responds before `/api/*` RBAC middleware rejects the request (auth routes are exempt from RBAC)
14. `GET /api/articles` without a session returns 401 for a collection with no `public: { read: true }` permission
15. `GET /cms/health` returns 200 without any Authorization header (always unauthenticated)

**Verification:** All tests pass. TypeScript noEmit passes. An implementer can import `createCMS` in a test file, call it with a minimal sqlite config, and `await cms.fetch(new Request('http://localhost/cms/health'))` returns a 200 `Response`.

---

### U3. Provider factory functions

**Goal:** Implement the five factory functions (`createDatabaseAdapter`, `createStorageAdapter`, `createCacheAdapter`, `createEmailProvider`, `createJobsProvider`) and the provider registry system that allows adapter packages to self-register. Each factory accepts a typed config object and returns the appropriate adapter instance.

**Requirements:**
- Each factory must throw a descriptive `CMSConfigError` when the provider is not registered (adapter package not installed / not imported)
- The registry pattern must be the sole coupling point — factories never import adapter packages directly
- `createEmailProvider` defaults to `console` provider when config is null — the console provider is the only provider implemented inside `packages/core` (all others live in adapter packages)
- `createJobsProvider` accepts a `none` provider and returns a no-op `JobsProvider` — implemented inside core
- `createCacheAdapter` accepts `null` config and returns a no-op `CacheAdapter` — implemented inside core as a memory provider
- Error messages must name the missing package: `"No database adapter registered for 'postgres'. Install @hono-cms/adapter-postgres and import it before calling createCMS."`

**Dependencies:** U1 (type definitions)

**Files:**
- `packages/core/src/providers/registry.ts` — `ProviderRegistry` class / factory
- `packages/core/src/providers/db.ts` — `createDatabaseAdapter` + db registry
- `packages/core/src/providers/storage.ts` — `createStorageAdapter` + storage registry
- `packages/core/src/providers/cache.ts` — `createCacheAdapter` + cache registry + in-core memory provider
- `packages/core/src/providers/email.ts` — `createEmailProvider` + email registry + in-core console provider
- `packages/core/src/providers/jobs.ts` — `createJobsProvider` + jobs registry + in-core none/noop provider
- `packages/core/test/provider-factories.test.ts` — unit tests

**Approach:**

`ProviderRegistry<Config, Instance>` is a generic class with two methods:
- `register(provider: string, factory: (config: Config) => Instance): void`
- `create(config: Config): Instance` — calls `registry.get(config.provider)`, throws `CMSConfigError` if not found

Each domain has its own singleton registry created from `ProviderRegistry`. Adapter packages call `dbRegistry.register('d1', D1AdapterFactory)` on import. Because the consumer's entry file imports the adapter package (`import '@hono-cms/adapter-d1'`) before calling `createCMS`, the registration happens before the factory runs.

The console email provider and memory cache provider are registered at module load time inside `email.ts` and `cache.ts` respectively — they're always available regardless of what the consumer installs.

The jobs `none` provider is registered at module load time inside `jobs.ts`. Its methods are all no-ops that log a debug message.

`createDatabaseAdapter` returns both the abstract `DatabaseAdapter` (for route handlers) and the raw `DrizzleInstance` (for `cms.db`). The factory signature: `(config: DbConfig) => { adapter: DatabaseAdapter; db: DrizzleInstance }`.

**Test scenarios** (`test/provider-factories.test.ts`):

Registry:
1. Registering a provider and calling `create` with that provider key returns the factory's output
2. Calling `create` with an unregistered provider key throws `CMSConfigError`
3. `CMSConfigError` message includes the provider name and the missing package name
4. Registering the same provider key twice replaces the previous factory (last-write wins — documented behavior)

Database factory:
5. `createDatabaseAdapter({ provider: 'sqlite', options: { url: ':memory:' } })` succeeds when the sqlite adapter is registered (mock the registry in tests)
6. `createDatabaseAdapter({ provider: 'postgres', ... })` throws `CMSConfigError` when postgres adapter is not registered

Cache factory:
7. `createCacheAdapter(null)` returns a `CacheAdapter` instance (in-core memory provider)
8. `createCacheAdapter({ provider: 'memory' })` returns a `CacheAdapter` instance
9. In-core memory cache `set` then `get` returns the stored value
10. In-core memory cache `get` after TTL expiry returns `null`
11. `createCacheAdapter({ provider: 'upstash', url: '...', token: '...' })` throws `CMSConfigError` when upstash cache package is not registered

Email factory:
12. `createEmailProvider({ provider: 'console' })` returns a provider (always registered in core)
13. `createEmailProvider(null)` falls back to console provider — no error
14. Console provider `sendEmail(...)` logs to stdout and returns `{ success: true }` (spy on console.log in test)
15. `createEmailProvider({ provider: 'resend', apiKey: '...' })` throws when resend package is not registered

Jobs factory:
16. `createJobsProvider({ provider: 'none' }, { db: mockDb })` returns a `JobsProvider`
17. `JobsProvider.none` methods are no-ops — calling `enqueueWebhookRetry(...)` resolves without error and logs a debug trace
18. `createJobsProvider({ provider: 'qstash', token: '...' }, { db: mockDb })` throws when qstash package is not registered

**Verification:** All factory tests pass using mock registry registrations. No direct imports of adapter packages in `packages/core/src/`. `pnpm build` in `packages/core` produces a bundle with no references to adapter package module IDs.

---

### U4. Route composition

**Goal:** Implement the Hono sub-routers that `createCMS` mounts. Each sub-router is a factory function that accepts the relevant services and returns a `Hono` router. This unit specifies the mounting structure, route prefix conventions, and the interface between `createCMS` and each sub-router.

**Requirements:**
- All routes are mounted by `createCMS`, never by the end user (zero Hono boilerplate in consumer code)
- Auth routes at `/api/auth/*` are always mounted before RBAC middleware — auth routes are exempt from RBAC by design
- RBAC middleware is mounted at `/api/*` scope only — `GET /cms/health`, `/graphql`, and `/cms/docs` are outside its scope
- Job handler routes at `/cms/jobs/*` are secured by provider-specific signature verification (QStash HMAC, Vercel shared secret) — not by better-auth RBAC
- Stubs are acceptable for content routes and job handlers in this plan — the actual handler implementations belong to Plans 003 and the crons plan respectively. The stubs must return 501 with a JSON body so integration tests can verify the route is registered.
- Health check is always registered, never configurable

**Dependencies:** U1 (types), U2 (createCMS wiring), U3 (provider factories)

**Files:**
- `packages/core/src/routes/auth.ts` — better-auth Hono handler wrapper
- `packages/core/src/routes/content.ts` — content router stub
- `packages/core/src/routes/graphql.ts` — graphql route factory (conditional)
- `packages/core/src/routes/openapi.ts` — openapi + scalar route factory (conditional)
- `packages/core/src/routes/health.ts` — health check handler (implemented fully in this plan)
- `packages/core/src/routes/jobs.ts` — job route stubs with signature verification middleware
- `packages/core/src/middleware/inject-services.ts` — service injection into Hono context
- `packages/core/src/middleware/rbac.ts` — RBAC middleware stub (full implementation in auth plan)
- `packages/core/test/route-composition.test.ts` — integration tests

**Approach:**

**Auth router** (`routes/auth.ts`): better-auth ships a `toWebHandler()` or `.handler` that takes a `Request` and returns `Response`. The Hono handler wraps this: `app.all('/api/auth/*', c => auth.handler(c.req.raw))`. The sub-router is minimal — one line delegating to better-auth. All `/api/auth/*` paths are handled by better-auth; any path not recognized by better-auth returns 404 from within better-auth's handler.

**Content router** (`routes/content.ts`): Exports `createContentRouter({ schema, db, cache, webhooks })` returning a `Hono` router. In this plan, returns a router with `app.all('/*', c => c.json({ error: 'not implemented' }, 501))`. The full CRUD implementation is Plan 003. The stub exists so `createCMS` can mount it and integration tests confirm the route exists at `/api/`.

**GraphQL route** (`routes/graphql.ts`): Exports `createGraphQLHandler({ schema, db, auth, config })`. When `config.graphql` is truthy, returns an `async (c: Context) => Response` handler suitable for `app.all('/graphql', handler)`. Uses `@as-integrations/next` (`startServerAndCreateHandler`) internally. In this plan, the handler returns 501. The full Apollo integration is the graphql plan.

**OpenAPI routes** (`routes/openapi.ts`): Exports `createOpenAPIRoutes({ schema, config })`. Returns `{ openapiPath, docsPath, openapiHandler, docsHandler }`. `openapiHandler` returns 501 in this plan. `docsHandler` returns an HTML page with the Scalar CDN link pointing to `openapiPath`. The Scalar HTML scaffold can be fully implemented now — it is a static HTML template with a configurable `spec-url` attribute. The OpenAPI JSON generation is the openapi plan.

**Health handler** (`routes/health.ts`): Fully implemented in this plan. The handler calls `adapter.healthCheck()` on each configured service concurrently via `Promise.allSettled`. Each adapter's `healthCheck()` returns `{ status: 'ok' | 'error'; latency_ms?: number; error?: string }`. The root status is `'ok'` only if all critical adapters (db) are ok — storage, cache, email, and jobs are non-critical (degraded response still returns 200 if they fail, db failure returns 503). Response shape:

```json
{
  "status": "ok" | "degraded",
  "version": "@hono-cms/core@0.1.0",
  "db":      { "status": "ok", "latency_ms": 3 },
  "storage": { "status": "ok", "latency_ms": 12 } | null,
  "cache":   { "status": "ok", "latency_ms": 8 } | null,
  "email":   { "status": "ok" } | null,
  "crons":   { "status": "ok" } | null
}
```

The `DatabaseAdapter` interface includes `healthCheck(): Promise<HealthStatus>`. The adapter's health check is a lightweight ping — for SQL adapters, a `SELECT 1` with a 2-second timeout. The timeout is enforced via `Promise.race` — health checks that exceed 2 seconds return `{ status: 'error', error: 'timeout' }`.

**Jobs router** (`routes/jobs.ts`): Exports `createJobsRouter({ jobs, db, cache })`. Routes:
- `POST /cms/jobs/webhook-retry`
- `POST /cms/jobs/scheduled-publish`
- `POST /cms/jobs/cache-sweep`

Each route verifies the caller signature via the jobs provider before executing — `jobs.verifyRequest(c.req.raw)` returns `{ valid: boolean }`. Invalid requests receive 401. Valid requests with no implementation yet receive 501. Signature verification logic lives in each jobs adapter package. The `none` provider's `verifyRequest` always returns `{ valid: true }`.

**RBAC middleware** (`middleware/rbac.ts`): In this plan, a stub that extracts the session from better-auth, attaches it to `c.set('session', session)` and `c.set('role', role)`, and calls `next()`. The actual role→permission matrix evaluation is implemented in the auth plan (Plan 00X). The stub ensures the middleware is wired in the correct position so auth plan can plug in without changing `create-cms.ts`.

**Inject services middleware** (`middleware/inject-services.ts`): A middleware factory `injectServices({ db, storage, cache, email, jobs, auth })` that calls `c.set()` for each service. This makes services available to all downstream handlers via `c.var.db`, `c.var.storage`, etc. without passing them as closure arguments to every route handler.

**Test scenarios** (`test/route-composition.test.ts`):

Using `app.request()` (Hono's built-in test helper) on the `cms` instance from a minimal in-memory config:

Health route:
1. `GET /cms/health` → 200, `{ "status": "ok" }` when all services healthy
2. `GET /cms/health` → 503, `{ "status": "degraded" }` when DB health check throws (mock the adapter)
3. `GET /cms/health` is accessible without Authorization header
4. `GET /cms/health` includes `db.latency_ms` field in response body
5. DB health check that takes > 2 seconds returns `{ status: 'error', error: 'timeout' }` for the db field

Auth routes:
6. `GET /api/auth/session` → not 404 (better-auth handles it; actual status depends on session state)
7. Auth routes are accessible without RBAC blocking them — a request without a session to `/api/auth/session` should not return 403 from RBAC middleware (may return 401 from better-auth, but that is better-auth's decision)

Content route stub:
8. `GET /api/anything` → 501 (stub is mounted)
9. `POST /api/anything` → 501

Jobs routes:
10. `POST /cms/jobs/webhook-retry` with no signature → 401
11. `POST /cms/jobs/webhook-retry` with valid signature (using `none` provider in test, which accepts all) → 501 (stub body)
12. `POST /cms/jobs/cache-sweep` → 501 (stub)

GraphQL (conditional):
13. With `graphql: true` — `GET /graphql` → not 404
14. Without `graphql` config — `GET /graphql` → 404

OpenAPI (conditional):
15. With `openapi: true` — `GET /cms/openapi.json` → 501 (stub JSON generator, but route exists)
16. With `openapi: true` — `GET /cms/docs` → 200 with `Content-Type: text/html` (Scalar HTML scaffold is real)
17. Without `openapi` config — `GET /cms/docs` → 404

Service injection:
18. A custom handler added via `cms.use('*', c => { c.json({ db: typeof c.var.db }) })` sees `c.var.db` as a non-null object

**Verification:** All route composition tests pass. `GET /cms/health` returns a valid JSON response in a real test environment with an in-memory SQLite database.

---

### U5. WinterTC compatibility and deployment patterns

**Goal:** Verify that `cms.fetch` is a valid WinterTC fetch handler and that the deployment patterns (Workers, Elysia, Next.js, Node.js) are tested and documented via runnable test scenarios. Implement `cms.scheduled` as a Cloudflare Cron Trigger handler.

**Requirements:**
- `cms.fetch` signature must be `(request: Request, env?: unknown, ctx?: ExecutionContext) => Promise<Response>`
- `cms.scheduled` signature must be `(controller: ScheduledController, env?: unknown, ctx?: ExecutionContext) => Promise<void>`
- All four deployment patterns must have test coverage demonstrating they work
- Tests must use the standard `Request`/`Response` Web APIs, not Node.js `http.IncomingMessage`

**Dependencies:** U2 (createCMS), U4 (routes)

**Files:**
- `packages/core/src/scheduled.ts` — `createScheduledHandler` implementation
- `packages/core/test/wintertc.test.ts` — WinterTC and deployment pattern tests

**Approach:**

`createScheduledHandler({ jobs, db, crons })` returns an async function matching the Cloudflare `scheduled` export signature. The function receives a `ScheduledController` with `event.cron` (the cron expression that matched) and dispatches to the appropriate job handler:

- `'0 * * * *'` (or matching pattern) → `jobs.executeWebhookRetry()`
- `'*/5 * * * *'` → `jobs.executeCacheSweep()`
- etc.

The dispatch table is configured by the crons config. For non-Cloudflare providers, `cms.scheduled` still exists but logs a warning if called (the cron triggers come from QStash or Vercel HTTP calls, not the `scheduled` export).

`@cloudflare/workers-types` provides the `ScheduledController` and `ExecutionContext` types. These are dev dependencies only — type import, not value import.

WinterTC compliance verification approach: create a `Request` object using the global `Request` constructor (available in Vitest with the `@cloudflare/vitest-pool-workers` pool or with `globalThis.Request` polyfilled by the test environment). Call `cms.fetch(request)` and assert the return value is a `Response`. Verify `response.body` is a `ReadableStream | null`, `response.headers` is a `Headers` instance, and `response.status` is a number. This confirms the handler follows the Fetch API contract.

Vitest environment: use `@cloudflare/vitest-pool-workers` for the WinterTC tests so they run in a real Workers runtime. The `vitest.config.ts` in `packages/core` should use `defineProject` with two projects: one standard Node.js environment for unit/integration tests, one Cloudflare Workers pool for WinterTC tests. The WinterTC tests are the only ones in the workers pool.

**Test scenarios** (`test/wintertc.test.ts`):

WinterTC fetch compliance:
1. `cms.fetch(new Request('http://localhost/cms/health'))` returns a `Promise<Response>`
2. The resolved value is a `Response` instance (`result instanceof Response`)
3. `response.status` is `200` for the health route
4. `response.headers.get('content-type')` contains `application/json`
5. `response.body` is a `ReadableStream` (body is streamable, not pre-buffered)
6. Calling `cms.fetch` with a `POST` request to `/api/auth/sign-in` with a JSON body — handler receives the body correctly (no body truncation or stream exhaustion)

Cloudflare Worker deployment pattern:
7. `export default cms` pattern: assert that `cms.fetch` is callable as the Workers default export handler — `await cms.fetch(new Request('http://localhost/cms/health'))` returns 200. (This is the same as WinterTC test 1; the test documents the pattern explicitly)
8. `cms.scheduled` is defined (not undefined)
9. `cms.scheduled` is a function with arity 3 (controller, env, ctx)
10. Calling `cms.scheduled({ cron: '0 * * * *', scheduledTime: Date.now(), noRetry: () => {} }, {}, { waitUntil: () => {} })` resolves without throwing (noop provider)

Elysia embed pattern:
11. `new Elysia().mount('/cms', cms.fetch)` — the mount call does not throw and the Elysia app responds to `GET /cms/health` by delegating to `cms.fetch` (assert the response status matches what `cms.fetch` returns directly)

Hono embed pattern:
12. `const host = new Hono(); host.all('/cms/*', c => cms.fetch(c.req.raw))` — `host.request('/cms/health')` returns 200

Next.js App Router pattern:
13. `const handler = (req: Request) => cms.fetch(req)` — `handler(new Request('http://localhost/cms/health'))` returns 200 (same as direct fetch)

Node.js standalone pattern (type-check only, no runtime test — `@hono/node-server` is not a dependency):
14. TypeScript accepts `{ fetch: cms.fetch }` as the argument to `serve` from `@hono/node-server` (type-level test only)

**Verification:** WinterTC tests pass in `@cloudflare/vitest-pool-workers` environment. All deployment pattern tests pass in Node.js test environment. `pnpm tsc --noEmit` in `packages/core` accepts `export default cms` without any type errors.

---

### U6. @hono-cms/core package scaffolding

**Goal:** Create the complete package configuration for `packages/core`: `package.json` with correct exports field and peer dependencies, `tsdown.config.ts` for dual ESM/CJS builds with `dts: true`, `vitest.config.ts` with `defineProject` for multi-environment testing, and `tsconfig.json` with strict mode and path aliases. Define the public export surface of the package.

**Requirements:**
- `package.json` must have an `exports` field with at least three sub-paths: `.` (main), `./types` (type-only re-exports), `./providers` (provider registry — for adapter packages to call `dbRegistry.register(...)`)
- Build produces dual ESM (`.mjs`) and CJS (`.cjs`) with declaration files (`.d.ts`) and declaration maps (`.d.ts.map`)
- No adapter packages as direct dependencies — they are listed as optional peer dependencies with `peerDependenciesMeta`
- `better-auth` and `hono` are direct dependencies (always required)
- `@hono-cms/schema` is a direct dependency (always required)
- `vitest.config.ts` uses `defineProject` with two test environments

**Dependencies:** U1–U5 (all implementation units are scaffolded by this)

**Files:**
- `packages/core/package.json`
- `packages/core/tsconfig.json`
- `packages/core/tsdown.config.ts`
- `packages/core/vitest.config.ts`

**Approach:**

`package.json` key fields:
- `name: "@hono-cms/core"`
- `version: "0.0.1"`
- `type: "module"` — ESM-first
- `exports`:
  - `"."` → `{ "import": "./dist/index.mjs", "require": "./dist/index.cjs", "types": "./dist/index.d.ts" }`
  - `"./types"` → `{ "import": "./dist/types/index.mjs", "require": "./dist/types/index.cjs", "types": "./dist/types/index.d.ts" }` — allows consumers to import types only without the runtime
  - `"./providers"` → `{ "import": "./dist/providers/registry.mjs", "require": "./dist/providers/registry.cjs", "types": "./dist/providers/registry.d.ts" }` — adapter packages use this to call `dbRegistry.register()`
- `main: "./dist/index.cjs"` — CJS fallback
- `module: "./dist/index.mjs"` — ESM entry (for bundlers that read this field)
- `types: "./dist/index.d.ts"`
- `files: ["dist", "src"]` — ship source for source maps
- `sideEffects: false` — tell bundlers this package is tree-shakeable
- `dependencies`: `{ "hono": "^4", "better-auth": "^1", "@hono-cms/schema": "workspace:*", "@better-auth/drizzle-adapter": "^1" }`
- `devDependencies`: `{ "tsdown": "...", "vitest": "...", "@cloudflare/vitest-pool-workers": "...", "@cloudflare/workers-types": "...", "tsd": "...", "expect-type": "...", "drizzle-orm": "..." }` — Drizzle is a dev dep (types only) since the actual Drizzle client comes from adapter packages
- `peerDependencies`: list all adapter packages as optional peers with `peerDependenciesMeta: { "@hono-cms/adapter-d1": { optional: true }, ... }`

`tsdown.config.ts`:
```
defineConfig({
  entry: ['src/index.ts', 'src/types/index.ts', 'src/providers/registry.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    'better-auth',
    'hono',
    '@hono-cms/schema',
    // all adapter packages — they are never bundled into core
    /^@hono-cms\/adapter-/,
    /^@hono-cms\/cache-/,
    /^@hono-cms\/email-/,
    /^@hono-cms\/jobs-/,
  ],
})
```
This is directional — the implementing agent should adjust based on tsdown's actual API.

`vitest.config.ts`:
```
defineProject([
  {
    // Standard unit + integration tests
    test: {
      name: 'core-node',
      environment: 'node',
      include: ['test/**/*.test.ts'],
      exclude: ['test/wintertc.test.ts'],
    },
  },
  {
    // WinterTC compatibility tests — run in real Workers runtime
    test: {
      name: 'core-workers',
      pool: '@cloudflare/vitest-pool-workers',
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.test.toml' },
        },
      },
      include: ['test/wintertc.test.ts'],
    },
  },
])
```

`tsconfig.json` key settings:
- `"strict": true`
- `"module": "ESNext"`, `"moduleResolution": "Bundler"` — required for tsdown compatibility
- `"target": "ES2022"` — Workers minimum
- `"lib": ["ES2022", "DOM"]` — DOM for Fetch API types (`Request`, `Response`, `ReadableStream`)
- `"paths": { "@hono-cms/schema": ["../schema/src/index.ts"] }` — workspace path alias for dev

Public `src/index.ts` exports:
- `createCMS` (default export and named)
- All types from `types/config.ts`, `types/instance.ts`, `types/providers.ts`
- `defineCollection` re-exported from `@hono-cms/schema` — so consumers can do `import { createCMS, defineCollection } from '@hono-cms/core'` without a separate schema package import

**Test scenarios:**

Build verification:
1. `pnpm build` in `packages/core` completes without error and produces `dist/index.mjs`, `dist/index.cjs`, `dist/index.d.ts`
2. `dist/index.mjs` does not contain any adapter package module IDs (grep for `adapter-d1`, `adapter-postgres`, etc. — none found)
3. `dist/index.d.ts` exports `createCMS`, `CMSConfig`, `DbConfig`, `StorageConfig`, `CacheConfig`, `EmailConfig`, `CronsConfig`, `AuthConfig`, `GraphQLConfig`, `OpenAPIConfig`, `I18nConfig`, `WebhookConfig`, `SchemaConfig`, `CMSInstance`, `defineCollection`
4. `dist/providers/registry.mjs` exports `dbRegistry`, `storageRegistry`, `cacheRegistry`, `emailRegistry`, `jobsRegistry` and their `register` methods
5. Importing `@hono-cms/core` in a test file and calling `createCMS` works without a build step (TypeScript resolves to `src/index.ts` via `paths`)

Package export correctness:
6. `require('@hono-cms/core')` in a CJS context resolves to `dist/index.cjs` (test with a CJS test file using `require`)
7. `import '@hono-cms/core/providers'` resolves without error and exposes the registry
8. `import type { CMSConfig } from '@hono-cms/core/types'` resolves without pulling in runtime code (type-only import, confirmed by checking no JS is emitted for that import in the consumer bundle)

`Test expectation: none` for tsconfig.json itself — it is pure configuration with no behavioral surface to test.

**Verification:** `pnpm build` succeeds. `pnpm typecheck` (tsc noEmit) succeeds. A consumer package that `import`s from `@hono-cms/core` using the workspace path resolves all types correctly. The `dist/` output can be published to npm without additional processing.

---

## Dependencies and Sequencing

```
U1 (types)
  └─► U3 (factories)
        └─► U2 (createCMS core)
              └─► U4 (route composition)
                    └─► U5 (WinterTC tests)
U6 (package scaffolding) — can start in parallel with U1; gates the build
```

U1 and U6 can be worked in parallel. U3 depends on U1's type definitions but not on U6's build config. U2 depends on U3. U4 depends on U2 for the Hono app instance. U5 depends on U4 for the health route and the full composition. All units should use source-level TypeScript imports via workspace paths — no build step required during development.

---

## Deferred Implementation Notes

The following questions are knowable only during execution:

- **`betterAuth` Hono integration exact import path**: better-auth's Hono integration may ship as `better-auth/hono` or `better-auth/integrations/hono` — the implementing agent should verify in the better-auth docs at implementation time and not assume the import path from memory.
- **`@as-integrations/next` version compatibility**: The Apollo Server integration package version compatible with the Apollo Server version used must be checked at implementation time. The plan uses the integration conceptually; the exact `startServerAndCreateHandler` import path may vary by version.
- **`@cloudflare/vitest-pool-workers` wrangler config**: The workers pool requires a `wrangler.test.toml`. Its minimal content (SQLite binding for test DB, etc.) should be determined at implementation time based on the actual test fixture requirements.
- **tsdown `external` pattern syntax**: The regex-based external configuration in tsdown's config API (`/^@hono-cms\/adapter-/`) should be verified against tsdown's actual documentation — it may use a string prefix pattern instead.
- **`InferDbType` conditional type bounds**: The exact conditional type for mapping `db.provider` to the Drizzle type depends on what each adapter package exports. Implementation should use `unknown` as the fallback and narrow at the call site if the conditional type cannot be statically resolved for all provider variants at this plan's time.
- **`drizzleAdapter` import**: `@better-auth/drizzle-adapter` vs `better-auth/adapters/drizzle` — verify the correct package/import path in better-auth v1's documentation.

---

## System-Wide Impact

This plan establishes contracts that all 17 subsequent plans depend on. Changes to the following after this plan ships are breaking:

| Contract | Downstream dependents |
|---|---|
| `CMSConfig` top-level shape | Every consumer's `createCMS(...)` call site; all adapter plans |
| `CMSInstance<DB>` return type | Admin SPA (`cms.db` access), custom route plans |
| `HonoEnv` Variables shape | All route handler plans (content, auth, graphql, openapi) |
| Provider registry interface | All adapter packages (`@hono-cms/adapter-*`) |
| `@hono-cms/core` public exports | CLI plan, admin SPA build, all consumer code |
| Route prefix conventions (`/api/`, `/api/auth/*`, `/cms/health`, `/cms/jobs/*`) | Admin SPA routing, docs, openapi spec plan |
| `cms.scheduled` signature | Cloudflare deployment template plan |

Changes to the provider discriminated union shapes (adding a new `provider` variant) are **additive and non-breaking** — existing consumers continue to compile. Removing a variant or changing required fields on an existing variant is breaking.

---

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `Object.assign` TypeScript return type doesn't narrow the DB generic correctly | Medium | High — `cms.db` typed as `unknown` in consumer code | Use a function overload per DB provider as fallback; accept the cast with a comment |
| better-auth Hono handler API changes between minor versions | Low | Medium — `routes/auth.ts` wrapper breaks | Pin better-auth to a minor version range in `package.json`; isolate the integration in `routes/auth.ts` so changes are one-file fixes |
| `@cloudflare/vitest-pool-workers` environment setup is non-trivial | Medium | Low — WinterTC tests can fall back to Node.js `@edge-runtime/jest-environment` | Start WinterTC tests with the Node.js environment; migrate to Workers pool as the second step once other tests pass |
| Tree-shaking registry pattern adds complexity for adapter authors | Medium | Medium — authors don't know how to register their adapter | Provide a `createAdapterFactory` helper in `packages/core/src/providers/registry.ts` and document the pattern in the adapter authoring guide |
| Route ordering bug (RBAC fires before auth routes are mounted) | Low | High — auth endpoints return 401/403 | Mount order is explicitly tested in U4 test scenario #7; lint rule or comment in `create-cms.ts` marking the mount order as significant |

---

## Alternative Approaches Considered

### Async factory (`await createCMS(config)`)

An async factory allows `createCMS` to open DB connections, run schema assertions, and verify env vars before the first request. This catches misconfiguration at startup rather than on first request.

**Why rejected:** WinterTC compatibility requires that the Worker module body completes synchronously (or with top-level await). Top-level await works in ESM Workers but serializes cold start — every cold start waits for DB ping + cache ping + auth setup before serving the first request. On a D1 database with Workers, that could be 100–300ms of forced cold start per invocation. The lazy-initialization model (establish connection on first request, cache the connection in a module-level singleton) achieves the same correctness guarantee without the cold start penalty.

### Wrapper object (`{ app, auth, db }`)

Returning `{ app, auth, db }` instead of an extended Hono instance is simpler to type and avoids the `Object.assign` cast.

**Why rejected:** Every framework integration becomes two lines instead of one. Workers requires `export default cms.app` — the developer must know to unwrap. Elysia requires `cms.app.fetch`. The Hono-IS-the-CMS philosophy is the central API ergonomic claim. The added complexity of `Object.assign` is confined to one line in `create-cms.ts` and is a well-known pattern in the Hono ecosystem.

### Single bundle with all providers

Shipping all adapters in `packages/core` eliminates the multi-package installation complexity. The consumer doesn't need to install `@hono-cms/adapter-d1` separately.

**Why rejected:** D1 requires `@cloudflare/workers-types`; Postgres requires `pg`; Turso requires `@libsql/client`. Bundling all of them into `packages/core` makes a Cloudflare Worker that only uses D1 ship the full Postgres and libSQL clients — adding ~200KB+ to a compressed bundle and potentially importing Node.js-only APIs (`net`, `tls`) that Workers rejects at startup. The per-provider package approach is the only architecture that is both edge-compatible and reasonably sized.

---

## Verification Checklist

Before marking this plan complete, an implementer should verify:

- [ ] `pnpm tsc --noEmit` in `packages/core` passes with zero errors
- [ ] `pnpm test` in `packages/core` passes all test suites (unit, integration, type-level)
- [ ] `pnpm build` produces `dist/index.mjs`, `dist/index.cjs`, `dist/index.d.ts`, `dist/providers/registry.mjs`
- [ ] `dist/index.mjs` contains no adapter package module IDs (bundle is clean)
- [ ] `createCMS({ db: { provider: 'sqlite', options: { url: ':memory:' } } })` returns a value where `cms.fetch(new Request('http://localhost/cms/health'))` resolves to a 200 `Response`
- [ ] `cms.auth` is defined and has an `api` property with `getSession`
- [ ] `cms.db` TypeScript type matches the provider (for sqlite: `LibSQLDatabase`, not `unknown`)
- [ ] `cms.scheduled` is defined and callable
- [ ] Route composition tests confirm: auth routes exempt from RBAC, health always accessible, graphql/openapi conditional on config
- [ ] WinterTC tests pass: `cms.fetch` is a valid `(Request) => Promise<Response>` handler
- [ ] All deployment patterns type-check without errors (`export default cms`, `.mount('/cms', cms.fetch)`, etc.)
- [ ] Public export surface matches the declared exports: `createCMS`, all config types, `defineCollection` re-export
