---
title: "feat: Database Adapter Interface and Provider Packages"
date: 2026-05-16
type: feat
status: active
depth: deep
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
ideation-ideas: ["#1 Typed DatabaseAdapter Interface Per npm Package"]
---

# feat: Database Adapter Interface and Provider Packages

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 2
**Research inputs used:** skill review, framework docs, architecture review, performance review

### Key Improvements

1. Add batch-oriented adapter primitives for relation and GraphQL access.
2. Make capability flags and index expectations more explicit.
3. Stabilize the boundary between portable adapters and CMS-owned table access.

## Summary

The `DatabaseAdapter` TypeScript interface is the single architectural decision that makes `@hono-cms` universally deployable. Every other system — content routes, schema migrations, auth wiring, draft/publish, RBAC — calls into an adapter instance. The interface lives in `@hono-cms/schema` (the shared type package) and four concrete adapter packages implement it: `@hono-cms/adapter-d1` (Cloudflare D1 via Drizzle), `@hono-cms/adapter-postgres` (Node.js TCP + Neon HTTP via Drizzle), `@hono-cms/adapter-turso` (libSQL/Turso via Drizzle), and `@hono-cms/adapter-convex` (Convex document store, non-SQL). The adapter is selected at build time — runtime switching is unsupported by design. This plan covers the interface definition, all four adapter implementations, and the generic type threading in `createCMS`.

---

## Problem Frame

Strapi's architectural blocker for edge deployment is Knex.js: it assumes TCP database connections that Workers, Deno Deploy, and Vercel Edge do not support. There is no production Strapi deployment on Cloudflare Workers because the connection model is fundamentally incompatible — not because of bundle size, not because of cold starts. The fix is not an adapter shim over Knex; it is a typed interface that each deployment target implements natively.

The `DatabaseAdapter` interface makes the "universally deployable" promise structurally true. A project targeting D1 imports `@hono-cms/adapter-d1`, passes it to `createCMS`, and the entire CMS operates through Workers-native bindings with no TCP anywhere. A project targeting Neon imports `@hono-cms/adapter-postgres` and gets HTTP-mode Postgres that works on Vercel Edge. Nothing in `@hono-cms/core` is aware of the database technology — only the adapter is.

---

## Scope Boundaries

### In Scope (This Plan)
- `DatabaseAdapter<TDB>` TypeScript interface and all supporting types in `packages/schema/src/adapter.ts`
- `@hono-cms/adapter-d1`: full Drizzle D1 implementation and D1 migration strategy
- `@hono-cms/adapter-postgres`: Node TCP path + Neon HTTP path with runtime detection
- `@hono-cms/adapter-turso`: libSQL/Turso adapter, URL scheme handling, embedded replica pattern
- `@hono-cms/adapter-convex`: Convex document-store adapter including support scope definition and deferred capabilities
- Adapter selection discriminated union in `createCMS` config
- TypeScript generic threading so `cms.db` is correctly typed per adapter

### Deferred to Follow-Up Work
- `@hono-cms/adapter-git` (git-backed JSON for static sites) — mentioned in ideation but not in the 18-plan sequence; defer to a separate plan
- Storage adapter interface (`StorageAdapter`) — parallel design to `DatabaseAdapter`, covered separately in the storage plan
- Cache adapter interface — separate from database adapter; covered in cache layer plan
- Schema IR / Drizzle schema generator per adapter — the per-adapter Drizzle schema generation is referenced here but fully detailed in the schema/migration plan (Plan 002 or equivalent)
- `cms schema plan`, `cms schema apply`, `cms schema check` CLI surface — the `migrate`, `checkDrift`, and `generateMigration` adapter methods are defined here but the CLI surface is detailed in the CLI plan

### Outside This Plan's Scope
- Connection pooling configuration (PgBouncer, Neon pool mode) — implementation detail within the Postgres adapter, not the interface
- Multi-tenancy (per-tenant database isolation) — v2 roadmap
- Read replica routing — ideation rejection #4; not v1

---

## Key Technical Decisions

## Research Insights

**Best Practices:**
- Add explicit batch primitives such as `findManyByIds` or request-scoped relation loaders so higher layers do not reinvent N+1 workarounds.
- Keep provider capability flags first-class for transactions, JSON operators, advisory locking, and health behavior.
- Decide now whether CMS-owned tables use the same adapter API or a separate typed repository/unit-of-work layer; do not mix portable adapters with raw ORM access in feature code.

**Performance Considerations:**
- Document required composite indexes for keyset pagination, relation joins, and scheduled scans instead of assuming sortable IDs are sufficient.
- Normalize provider errors into stable CMS-level shapes before they reach content, auth, or job layers.

**Edge Cases:**
- D1 and Turso are both SQLite-family targets but not identical operationally; capability flags should reflect that difference.
- Migration locking and transaction semantics must degrade predictably when a provider lacks strong primitives.

### Decision 1: Interface lives in `@hono-cms/schema`, not `@hono-cms/core`

`@hono-cms/schema` is the zero-dependency shared type package imported by every package in the monorepo. If the `DatabaseAdapter` interface lived in `@hono-cms/core`, every adapter package would have a dependency on core — creating a circular dependency when core also imports adapters. Placing it in `@hono-cms/schema` breaks the cycle: schema has no dependencies, adapters depend on schema, core depends on both.

A secondary benefit: the schema package can be tree-shaken independently. A project using only the type definitions (for custom adapter implementations) does not pull in core's route generation or migration machinery.

### Decision 2: Build-time adapter selection, runtime switching unsupported

Runtime database switching would require:
1. Every adapter to be bundled (inflating the Worker bundle with D1, Postgres, and libSQL clients simultaneously)
2. Schema migrations to be deferred until runtime (defeating the safe plan/apply model)
3. Connection management to become dynamic (impossible on D1 which uses a Workers binding)

The adapter is selected by which package the developer imports and passes to `createCMS`. Tree-shaking removes the unused adapters. The `provider` discriminant in the config is a type-level tag that lets TypeScript infer the correct `TDB` generic — it does not drive a runtime `switch` statement.

### Decision 3: `client: TDB` is exposed on the adapter for `cms.db` access

The `createCMS` return shape (from ideation idea #14) includes `cms.db` — the raw Drizzle client. Without exposing `client` on the adapter, `createCMS` would have no way to surface the typed Drizzle instance to the developer. The alternative — wrapping every possible Drizzle query method in the adapter interface — would make the interface enormous and lag behind Drizzle's API surface. Exposing `client: TDB` means developers get direct Drizzle access for queries outside the CMS-generated routes, typed correctly (e.g., `DrizzleD1Database` when using the D1 adapter), with full Drizzle API surface available.

For the Convex adapter, `client: ConvexHttpClient` serves the same purpose — developers who need to call Convex functions outside the CMS-generated routes can access the typed Convex client directly.

### Decision 4: The interface does not abstract away Drizzle — it exposes raw Drizzle via `client`

The CMS core (route handlers, middleware, migration runner) does NOT call `adapter.client.select(...)` directly. Core calls the interface methods (`adapter.query(...)`, `adapter.create(...)`). The `client` property exists exclusively for the `cms.db` escape hatch that developers use in their own custom routes.

This means the interface methods in the adapter are thin, well-tested wrappers over Drizzle queries, not a full query language reimplementation. The Drizzle API surface is preserved for developer use; the interface methods cover only what the CMS core needs.

### Decision 5: Convex adapter scope is explicitly limited

Convex has no SQL surface. Joins, aggregations, and raw SQL expressions cannot be mapped to Convex queries. The adapter implements the full interface but some operations are semantically different:
- `query` → Convex `paginate` (cursor-based, no offset support)
- Relations → ID references (no in-database joins; populate happens at the application layer)
- `migrate` → Convex schema push (declarative, not migration file-based)
- `checkDrift` → schema comparison against Convex's live schema
- `generateMigration` → generates a Convex `schema.ts` file, not SQL

Operations that are genuinely unsupported throw an `AdapterCapabilityError` with a clear message rather than silently producing wrong results.

---

## High-Level Technical Design

> This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

### Interface Shape (directional)

```
// packages/schema/src/adapter.ts
// --------------------------------
// Supporting types
QueryParams        → filters, sort, pagination (page|cursor), populate, fields
PopulateParams     → subset of QueryParams for relation loading
PaginatedResult<T> → { data: T[], meta: { total?, cursor?, page?, pageSize? } }
CreateInput<T>     → Omit<T, 'id' | 'createdAt' | 'updatedAt' | 'status'>
UpdateInput<T>     → Partial<CreateInput<T>>
SchemaDiff         → { added: FieldChange[], removed: FieldChange[], altered: FieldChange[] }
MigrationFile      → { filename: string, sql?: string, convexSchema?: string }
CMSSchema          → the compiled schema from @hono-cms/schema (collection definitions)
AdapterCapabilityError → thrown when an operation is unsupported by an adapter

// The interface
DatabaseAdapter<TDB = unknown>
  client: TDB                                            // raw Drizzle or Convex client
  query<T>(col, params): Promise<PaginatedResult<T>>     // list with filter/sort/paginate/populate
  findOne<T>(col, id, params?): Promise<T | null>        // single record + optional populate
  create<T>(col, data): Promise<T>                       // insert, return created record
  update<T>(col, id, data): Promise<T>                   // update, return updated record
  delete(col, id): Promise<void>                         // hard delete
  publish(col, id): Promise<void>                        // draft → published
  unpublish(col, id): Promise<void>                      // published → draft
  migrate(schema): Promise<void>                         // apply pending migrations
  checkDrift(schema): Promise<SchemaDiff>                // compare schema to live DB
  generateMigration(schema): Promise<MigrationFile>      // generate migration artifact
```

### Adapter Selection Flow (directional)

```
createCMS({ db: { provider: 'd1', binding: env.DB }, ... })
   │
   ▼
DbConfig discriminated union
  provider: 'd1'       → D1Config      { binding: D1Database }
  provider: 'postgres' → PostgresConfig { url: string, mode?: 'tcp'|'http' }
  provider: 'turso'    → TursoConfig   { url: string, authToken?: string }
  provider: 'convex'   → ConvexConfig  { url: string }
   │
   ▼
resolveAdapter<TConfig>(config: TConfig): DatabaseAdapter<InferClient<TConfig>>
   │
   ├── 'd1'       → new D1Adapter(config)        → client: DrizzleD1Database
   ├── 'postgres' → new PostgresAdapter(config)  → client: DrizzlePostgresDatabase
   ├── 'turso'    → new TursoAdapter(config)     → client: DrizzleLibSQLDatabase
   └── 'convex'   → new ConvexAdapter(config)    → client: ConvexHttpClient
   │
   ▼
createCMS returns: Hono & { db: InferClient<TConfig>; auth: BetterAuth }
```

### Dependency Graph

```
┌──────────────────────────────────────────────────────────┐
│                    @hono-cms/schema                       │
│  DatabaseAdapter<TDB>, QueryParams, PaginatedResult, ... │
└──────────────┬───────────────────────────────────────────┘
               │ imported by all adapters and core
       ┌───────┼────────────────────────────────┐
       ▼       ▼               ▼                ▼
 adapter-d1  adapter-postgres  adapter-turso  adapter-convex
       │       │               │                │
       └───────┴───────────────┴────────────────┘
                       │ adapter passed to
                       ▼
               @hono-cms/core (createCMS)
```

---

## Output Structure

```
packages/
├── schema/
│   └── src/
│       ├── adapter.ts          ← DatabaseAdapter<TDB> interface + all supporting types
│       ├── index.ts            ← re-exports adapter.ts alongside collection/field types
│       └── errors.ts           ← AdapterCapabilityError, AdapterConfigError
├── adapter-d1/
│   ├── src/
│   │   ├── index.ts            ← D1Adapter class + createD1Adapter factory
│   │   ├── query-builder.ts    ← QueryParams → Drizzle .select() translation
│   │   ├── migrate.ts          ← D1 migration runner via drizzle-kit/api
│   │   └── schema-generator.ts ← CMSSchema → Drizzle SQLite table definitions
│   ├── tests/
│   │   └── adapter.test.ts
│   └── package.json
├── adapter-postgres/
│   ├── src/
│   │   ├── index.ts            ← PostgresAdapter class + createPostgresAdapter factory
│   │   ├── runtime-detect.ts   ← detect edge vs Node.js, select neon-http vs node-postgres
│   │   ├── query-builder.ts    ← QueryParams → Drizzle PG .select() translation
│   │   ├── migrate.ts          ← Postgres migration runner
│   │   └── schema-generator.ts ← CMSSchema → Drizzle PG table definitions
│   ├── tests/
│   │   └── adapter.test.ts
│   └── package.json
├── adapter-turso/
│   ├── src/
│   │   ├── index.ts            ← TursoAdapter class + createTursoAdapter factory
│   │   ├── query-builder.ts    ← QueryParams → Drizzle libSQL .select() translation
│   │   ├── migrate.ts          ← libSQL migration runner
│   │   └── schema-generator.ts ← CMSSchema → Drizzle SQLite table definitions
│   ├── tests/
│   │   └── adapter.test.ts
│   └── package.json
└── adapter-convex/
    ├── src/
    │   ├── index.ts            ← ConvexAdapter class + createConvexAdapter factory
    │   ├── query-translator.ts ← QueryParams → Convex query/filter translation
    │   ├── schema-generator.ts ← CMSSchema → Convex schema.ts generation
    │   └── capabilities.ts     ← supported/unsupported operation declarations
    ├── tests/
    │   └── adapter.test.ts
    └── package.json
```

---

## Implementation Units

### U1. DatabaseAdapter Interface and Supporting Types

**Goal:** Define the canonical `DatabaseAdapter<TDB>` TypeScript interface and all supporting types in `packages/schema/src/adapter.ts`. This is the single file every adapter and core package depends on. Get the type signatures right here; changing them later cascades across all four adapters.

**Requirements:** Enables all adapter packages (U2–U5). Enables adapter selection and type threading (U6). Every method on the interface must have a clear rationale for being there vs. being an internal adapter implementation detail.

**Dependencies:** None (this is U1, the foundation).

**Files:**
- `packages/schema/src/adapter.ts` — interface and all types (create)
- `packages/schema/src/errors.ts` — `AdapterCapabilityError`, `AdapterConfigError` (create)
- `packages/schema/src/index.ts` — re-export from `adapter.ts` (create/modify)
- `packages/schema/package.json` — package manifest, `tsdown` build config (create)
- `packages/schema/tsdown.config.ts` — build config, `format: ['esm', 'cjs']`, `dts: true`, `platform: 'neutral'` (create)
- `packages/schema/vitest.config.ts` — `defineProject` config (create)

**Approach:**

*Why each method is on the interface (not an internal detail):*

- `query` — Core needs to list documents for REST GET collection endpoints and GraphQL `findMany` resolvers. The filter, sort, pagination, and populate shape must be portable across SQL and Convex, so it belongs on the interface.
- `findOne` — Core needs to fetch a single document for REST GET /collection/:id and GraphQL `findOne`. The populate shape for relations must be adapter-handled since the join strategy differs (SQL JOIN vs Convex `ctx.db.get(id)`).
- `create` — Core needs to insert documents from REST POST and GraphQL mutations. Returning the created record is required for the response body and for the auto-generated SDK.
- `update` — Core needs to update documents from REST PUT/PATCH and GraphQL mutations. Must return the updated record for the same reasons.
- `delete` — Core needs hard delete for REST DELETE and GraphQL mutations. Draft/publish logic (`publish`/`unpublish`) is separate because it is a CMS-semantic operation, not a generic CRUD operation.
- `publish` / `unpublish` — These are CMS-semantic state transitions, not generic updates. Separating them from `update` allows the adapter to implement draft/publish semantics correctly per backend (SQL: update `status` column; Convex: update document field). They are on the interface — not just in core — because the SQL adapters need to handle the `draftAndPublish: true` row duplication strategy, which is adapter-specific.
- `migrate` — Used by `cms dev` auto-migrate and `cms schema apply`. Must be on the interface because migration execution is radically different per adapter (D1: via Wrangler binding; Postgres: via node-postgres; Convex: via Convex CLI push).
- `checkDrift` — Used by `cms schema plan` and `cms schema check --assert-clean` in CI. Returns a `SchemaDiff` that is human-readable (semantic field changes, not raw SQL diff). On the interface because the comparison strategy differs per adapter.
- `generateMigration` — Used by `cms schema plan` to produce the migration artifact before applying. Returns a `MigrationFile` whose `sql` field is populated for SQL adapters and whose `convexSchema` field is populated for Convex.

*NOT on the interface (implementation details):*
- Transaction management — core does not compose multi-step transactions across adapter calls; each adapter method is self-contained. If an adapter needs internal transactions (e.g., D1 batch for draft/publish), it handles them internally.
- Connection pool configuration — adapter-internal.
- Raw query execution — the `client: TDB` escape hatch serves this need without adding a polymorphic raw-query method that can't be typed portably.
- Batch operations — deferred to a future `batchCreate` / `batchUpdate` extension on the interface; not needed for v1 core.

*Supporting type decisions:*

`QueryParams` covers: `filters` (nested object, Strapi-compatible operator syntax), `sort` (array of `field:direction` strings), `pagination` (discriminated union: `{ page, pageSize }` for offset or `{ limit, cursor }` for cursor), `populate` (array of relation field names or a nested object for selective field population), `fields` (array of field names to include).

`PaginatedResult<T>` carries `{ data: T[], meta: { total?: number, cursor?: string, page?: number, pageSize?: number } }`. The cursor and page fields are mutually exclusive at runtime; both are optional so the same type works for both pagination strategies.

`CreateInput<T>` is `Omit<T, 'id' | 'createdAt' | 'updatedAt' | 'status'>` — the CMS manages these fields. `UpdateInput<T>` is `Partial<CreateInput<T>>` — all fields optional for PATCH semantics.

`SchemaDiff` is `{ added: FieldChange[], removed: FieldChange[], altered: FieldChange[], collections: { added: string[], removed: string[] } }` where `FieldChange` carries `{ collection, field, from?, to? }`.

`MigrationFile` is `{ filename: string, sql?: string, convexSchema?: string, appliedAt?: Date }`. SQL adapters populate `sql`; Convex populates `convexSchema`.

`CMSSchema` is the compiled output of `@hono-cms/schema`'s collection definitions — a `Record<string, CollectionDef>` where each `CollectionDef` carries field definitions, relations, permissions, and lifecycle config. This type is defined in `@hono-cms/schema` alongside `DatabaseAdapter`.

`AdapterCapabilityError` extends `Error` with a `capability: string` field naming the unsupported operation (e.g., `'offset-pagination'`, `'join-populate'`). Used by the Convex adapter to clearly surface limitations at runtime rather than silently failing.

**Patterns to follow:** Drizzle's own TypeScript interface approach in `drizzle-orm/` (each driver exports a typed database instance; the generic is threaded through); Hono's `MiddlewareHandler<Env>` pattern for threading generics.

**Test scenarios:**
- Type-level test: `DatabaseAdapter<DrizzleD1Database>` satisfies `DatabaseAdapter<unknown>` (structural subtyping)
- Type-level test: `CreateInput<Article>` does not include `id`, `createdAt`, `updatedAt`, or `status`
- Type-level test: `PaginatedResult<Article>` has `data: Article[]` and `meta` with optional cursor and page fields
- Type-level test: `AdapterCapabilityError` is throwable and has a `capability` string field
- Unit test: `SchemaDiff` with added, removed, and altered fields serializes to JSON correctly (for CLI output)
- Type-level test: `MigrationFile` with only `sql` set (Postgres path) compiles; with only `convexSchema` set (Convex path) compiles

**Verification:** `packages/schema` builds with `tsdown` producing `.d.ts`, ESM, and CJS outputs. Type-checking (`tsc --noEmit`) passes with zero errors. The interface can be imported in a test file and a class that implements it type-checks correctly.

---

### U2. @hono-cms/adapter-d1 — Cloudflare D1 Adapter

**Goal:** Implement `DatabaseAdapter<DrizzleD1Database>` using `drizzle-orm/d1`. This adapter is the Cloudflare Workers deployment path — zero TCP, Workers-native D1 binding, edge-compatible by construction.

**Requirements:** Enables Cloudflare D1 deployment. Implements all `DatabaseAdapter` interface methods for SQL semantics.

**Dependencies:** U1 (interface must be defined before implementation).

**Files:**
- `packages/adapter-d1/src/index.ts` — `D1Adapter` class + `createD1Adapter` factory (create)
- `packages/adapter-d1/src/query-builder.ts` — `QueryParams` → Drizzle D1 `select()` chain translation (create)
- `packages/adapter-d1/src/migrate.ts` — D1 migration runner using `drizzle-kit/api` (create)
- `packages/adapter-d1/src/schema-generator.ts` — `CMSSchema` → Drizzle SQLite table definitions (create)
- `packages/adapter-d1/tests/adapter.test.ts` — Vitest tests using D1 emulation (create)
- `packages/adapter-d1/package.json` — package manifest (create)
- `packages/adapter-d1/tsdown.config.ts` — build config, `platform: 'neutral'` (create)
- `packages/adapter-d1/vitest.config.ts` — `defineProject` with `@cloudflare/vitest-pool-workers` (create)

**Approach:**

*Constructor and initialization:* `D1Adapter` accepts `{ binding: D1Database }`. The constructor calls `drizzle(binding, { schema: generatedDrizzleSchema })` and stores the result as `this.client`. The `generatedDrizzleSchema` is built by `schema-generator.ts` from the `CMSSchema` passed to `createCMS`. This means the Drizzle schema is constructed at adapter creation time — before any requests — so Drizzle's type inference is available for the `client` property.

*`query` implementation:* Translates `QueryParams` → a Drizzle `db.select().from(table).where(...).orderBy(...).limit(...).offset(...)` chain. Filters use Drizzle's `eq`, `ne`, `like`, `gt`, `lt`, `gte`, `lte`, `inArray` operators mapped from the Strapi-compatible operator names (`$eq`, `$contains`, `$startsWith`, etc.). Cursor pagination: encode the cursor as a base64-encoded `{ id, createdAt }` tuple; apply `where(gt(table.createdAt, cursor.createdAt))` (or equivalent). Offset pagination: `limit(pageSize).offset(page * pageSize)`. For `count` in offset pagination, a separate `db.select({ count: sql`count(*)` }).from(table).where(...)` query runs before the data fetch. Populate (relations): for each relation field in `populate`, execute a separate `db.select().from(relatedTable).where(inArray(relatedTable.id, parentIds))` query — N+1 avoided via batch selection.

*`findOne` implementation:* `db.select().from(table).where(eq(table.id, id)).limit(1)`. Returns the first result or `null`. Apply populate with the same relation-batch strategy as `query`.

*`create` implementation:* `db.insert(table).values({ ...data, id: generateId(), createdAt: new Date(), updatedAt: new Date(), status: 'draft' }).returning()`. D1 supports `RETURNING` via Drizzle's `.returning()`.

*`update` implementation:* `db.update(table).set({ ...data, updatedAt: new Date() }).where(eq(table.id, id)).returning()`.

*`delete` implementation:* `db.delete(table).where(eq(table.id, id))`. If the collection has `draftAndPublish: true`, both the draft and published rows are deleted (D1 supports multi-row delete via `or(eq(...), eq(...))`).

*`publish` / `unpublish` implementation:* For collections with `draftAndPublish: true`, the CMS stores draft and published state in a single row using a `status` column (`'draft' | 'published'`). `publish` runs `db.update(table).set({ status: 'published', publishedAt: new Date() }).where(eq(table.id, id))`. `unpublish` sets `status: 'draft'`, `publishedAt: null`. For collections without `draftAndPublish`, both methods throw `AdapterCapabilityError('publish-on-non-draft-collection')`.

*`migrate` implementation:* Uses `drizzle-kit/api`'s `migrate()` with the D1 dialect. D1 migrations run via the D1 binding's `exec()` method — `binding.exec(sqlStatement)`. The migration runner reads SQL files from the migrations directory, checks the `drizzle_migrations` table for applied migrations, and runs pending ones in sequence. In a Workers environment, the D1 binding is passed from the Worker's `env` object — no file system access is needed.

*`checkDrift` implementation:* Uses `drizzle-kit/api`'s introspect functionality against the D1 binding to get the live schema. Compares against the expected schema generated from `CMSSchema`. Returns `SchemaDiff`.

*`generateMigration` implementation:* Uses `drizzle-kit/api`'s `generate()` to produce SQL migration statements. Returns `MigrationFile` with the SQL content.

*Test strategy:* Use `@cloudflare/vitest-pool-workers` — this runs tests in the actual Workers runtime (miniflare) with a real in-memory D1 instance. This is the recommended approach for D1 testing as of 2026, replacing the older `wrangler dev --local` approach. Each test creates a fresh D1 database via `env.DB` (injected by the pool worker), runs migrations to set up the schema, then tests the adapter methods against real data.

**Test scenarios:**
- `query` with no filters returns all records with correct `meta.total`
- `query` with `filters: { title: { $contains: 'hello' } }` returns only matching records
- `query` with cursor pagination returns the correct next cursor and subsequent page
- `query` with offset pagination (`page: 2, pageSize: 5`) returns the correct slice
- `query` with `populate: ['author']` returns records with the `author` relation populated
- `query` with `fields: ['title', 'status']` strips unrequested fields from results
- `findOne` returns `null` for a non-existent ID
- `findOne` returns the correct record for an existing ID
- `create` inserts a record and returns it with `id`, `createdAt`, `updatedAt` set
- `create` sets `status: 'draft'` by default for `draftAndPublish` collections
- `update` returns the updated record with `updatedAt` refreshed
- `update` on a non-existent ID throws (or returns `null` — define this behavior)
- `delete` removes the record; subsequent `findOne` returns `null`
- `publish` sets `status: 'published'` and `publishedAt`
- `unpublish` sets `status: 'draft'` and clears `publishedAt`
- `publish` on a collection without `draftAndPublish` throws `AdapterCapabilityError`
- `migrate` applies pending SQL migration files to the D1 in-memory DB
- `checkDrift` returns empty diff when schema matches
- `checkDrift` returns non-empty diff when a column has been added to the schema but not the DB
- `generateMigration` produces valid SQL for a new table

**Verification:** All Vitest tests pass inside the Workers pool (real miniflare execution). `tsdown` build produces `.d.ts`, ESM, CJS. The adapter implements `DatabaseAdapter<DrizzleD1Database>` — TypeScript confirms the structural match at build time.

---

### U3. @hono-cms/adapter-postgres — Node.js TCP + Neon HTTP Adapter

**Goal:** Implement `DatabaseAdapter<DrizzlePostgresDatabase>` with two internal sub-paths: `drizzle-orm/node-postgres` for Node.js TCP connections, and `drizzle-orm/neon-http` for Neon's HTTP-mode Postgres (edge-compatible). The correct path is selected automatically based on runtime detection.

**Requirements:** Enables Node.js and Vercel Edge deployment via Postgres/Neon. Two sub-paths must not require the developer to choose; the adapter detects the environment.

**Dependencies:** U1.

**Files:**
- `packages/adapter-postgres/src/index.ts` — `PostgresAdapter` class + `createPostgresAdapter` factory (create)
- `packages/adapter-postgres/src/runtime-detect.ts` — runtime detection logic (create)
- `packages/adapter-postgres/src/query-builder.ts` — `QueryParams` → Drizzle PG `.select()` chain (create)
- `packages/adapter-postgres/src/migrate.ts` — Postgres migration runner (create)
- `packages/adapter-postgres/src/schema-generator.ts` — `CMSSchema` → Drizzle PG table definitions (create)
- `packages/adapter-postgres/tests/adapter.test.ts` — Vitest integration tests (create)
- `packages/adapter-postgres/package.json` — package manifest (create)
- `packages/adapter-postgres/tsdown.config.ts` — `platform: 'neutral'` (create)
- `packages/adapter-postgres/vitest.config.ts` — `defineProject` (create)

**Approach:**

*Runtime detection (`runtime-detect.ts`):* The detection strategy must not hardcode environment variable names (Vercel-specific) and must work in bun, Node.js, Deno, and Workers. Detection order:
1. If `typeof process === 'undefined'` → not Node.js → use `neon-http` path
2. If `process.env.NEON_DATABASE_URL` or the URL contains `neon.tech` → Neon, prefer `neon-http` unless explicitly overridden
3. If `process.versions?.node` is defined → Node.js → use `node-postgres` path
4. Default fallback → `neon-http` (conservative: HTTP works everywhere TCP works, but not vice versa)

The developer can override with `mode: 'tcp' | 'http'` in the config to bypass detection.

*`neon-http` sub-path:* Uses `@neondatabase/serverless` + `drizzle-orm/neon-http`. The Neon serverless driver uses `fetch` internally — no TCP socket. Compatible with Vercel Edge, Cloudflare Workers (with `hyperdrive` if needed), and any `fetch`-capable runtime. Connection is stateless per request — no persistent connection pool. This is correct for serverless: each invocation gets a fresh connection via HTTP.

*`node-postgres` sub-path:* Uses `pg` (the `pg` npm package) + `drizzle-orm/node-postgres`. Creates a `Pool` with the connection URL. The pool is held as a module-level singleton (created once per process, reused across requests). Connection pool size defaults to `{ max: 10 }` and is configurable via the adapter config.

*`query` implementation:* Same `QueryParams` → Drizzle chain as D1 adapter, but using `drizzle-orm/pg-core` table definitions. Postgres supports more operator types (full-text search `to_tsvector`/`to_tsquery` is available but deferred). `RETURNING` is supported natively. Cursor pagination on Postgres is more efficient — use `WHERE (created_at, id) > ($cursor_ts, $cursor_id)` composite cursor to avoid index scans on large tables.

*Neon HTTP mode difference:* `drizzle-orm/neon-http` does not support `prepare()` (prepared statements) because the HTTP protocol is stateless. Every query is executed as a plain string. This means parameter binding uses the Neon driver's built-in escaping rather than Postgres's `$1` placeholders. Drizzle handles this transparently — the adapter code is the same; the driver handles the difference.

*`migrate` implementation:* Postgres migrations use `drizzle-kit/api`'s `migrate()` with the Postgres dialect. On the `node-postgres` path, migrations run against the Pool connection. On the `neon-http` path, migrations run via the HTTP client — Neon supports DDL statements over HTTP. The migrations table is `drizzle_migrations` (Drizzle's default).

*`checkDrift` and `generateMigration`:* Use `drizzle-kit/api` introspect + generate. Same pattern as D1 but with the `pg` dialect.

*Test strategy:* Two test strategies:
- *Unit tests with `pg-mem`*: For logic that doesn't require a real Postgres server (filter translation, query builder, error handling), use `pg-mem` — an in-memory Postgres implementation that works in Node.js without Docker. Fast, no external service needed.
- *Integration tests with testcontainers*: For migration tests and end-to-end adapter method tests, use `@testcontainers/postgresql` to spin up a real Postgres 16 container. These are slower but prove real behavior. Run in CI; skip locally when `POSTGRES_INTEGRATION=0`.

**Test scenarios:**
- `query` with `$contains` filter produces correct `LIKE '%value%'` SQL (verifiable via pg-mem)
- `query` cursor pagination returns correct second page and cursor is opaque (base64)
- `query` offset pagination returns correct slice with accurate `meta.total`
- `findOne` with non-existent ID returns `null`
- `create` returns the created record with server-assigned `id` and `createdAt`
- `update` with partial data only updates specified fields; other fields unchanged
- `delete` hard-deletes the record
- `publish` sets `status: 'published'` atomically
- Runtime detection: when `typeof process === 'undefined'`, selects `neon-http`
- Runtime detection: when `process.versions.node` is defined, selects `node-postgres`
- Runtime detection: when `mode: 'http'` is explicit, uses `neon-http` regardless of environment
- Neon HTTP mode: `query` executes without prepared statements (no `$1` params in raw SQL)
- Migration: `migrate()` applies pending SQL files to a test Postgres database (testcontainers)
- `checkDrift` returns correct diff when a column is added to `CMSSchema` but not the DB
- `generateMigration` produces valid Postgres DDL for a new collection

**Verification:** pg-mem unit tests pass in Node.js (`vitest run`). Testcontainers integration tests pass in CI with a real Postgres 16 container. TypeScript confirms `PostgresAdapter` implements `DatabaseAdapter<DrizzlePostgresDatabase>`. Both `neon-http` and `node-postgres` paths are exercised in tests.

---

### U4. @hono-cms/adapter-turso — libSQL / Turso Adapter

**Goal:** Implement `DatabaseAdapter<DrizzleLibSQLDatabase>` using `@libsql/client` + `drizzle-orm/libsql`. Supports all libSQL URL schemes: `file:` for local dev, `libsql://` for Turso cloud, `https://` for embedded HTTP mode.

**Requirements:** Enables Turso cloud deployment and local SQLite-compatible development. Embedded replica pattern for edge.

**Dependencies:** U1.

**Files:**
- `packages/adapter-turso/src/index.ts` — `TursoAdapter` class + `createTursoAdapter` factory (create)
- `packages/adapter-turso/src/query-builder.ts` — `QueryParams` → Drizzle libSQL `.select()` chain (create)
- `packages/adapter-turso/src/migrate.ts` — libSQL migration runner (create)
- `packages/adapter-turso/src/schema-generator.ts` — `CMSSchema` → Drizzle SQLite table definitions (shared logic with D1; extract to a shared internal module) (create)
- `packages/adapter-turso/tests/adapter.test.ts` — Vitest integration tests (create)
- `packages/adapter-turso/package.json` — package manifest (create)
- `packages/adapter-turso/tsdown.config.ts` — `platform: 'neutral'` (create)
- `packages/adapter-turso/vitest.config.ts` — `defineProject` (create)

**Approach:**

*URL schemes and client creation:*
- `file:./dev.db` or `file::memory:` — `createClient({ url: 'file::memory:' })` for in-process SQLite. No auth token needed. Used for local dev and tests.
- `libsql://dbname-org.turso.io` — Turso cloud endpoint. Requires `authToken`. Uses the Turso HTTP/WebSocket protocol (not TCP in the traditional sense — Turso's libSQL protocol runs over WebSockets, which are available on Workers and edge runtimes).
- `https://dbname-org.turso.io` — Turso HTTP-only mode. Compatible with environments that don't support WebSockets (some edge runtimes). Slower than WebSocket but universally compatible.
- `wss://` prefix — explicit WebSocket mode.

The adapter constructor calls `createClient({ url, authToken })` from `@libsql/client` and then `drizzle(client, { schema: generatedDrizzleSchema })`. The libSQL client handles URL scheme routing internally — the adapter does not need to branch per scheme.

*Embedded replica pattern:* Turso supports embedded replicas — a local SQLite file that syncs from the Turso cloud database. This is configured via `createClient({ url: 'file:./local.db', syncUrl: 'libsql://...', authToken: '...' })`. On supported runtimes (Node.js, Bun), writes go to the local file and sync to Turso cloud; reads come from the local file with sub-millisecond latency. The adapter config accepts an optional `syncUrl` and `syncInterval` to enable this pattern. On edge runtimes where the file system is not writable (Vercel Edge, Workers), the embedded replica is skipped automatically — the adapter falls back to direct cloud queries.

*SQLite semantic differences:* libSQL is SQLite-compatible. The query builder shares significant logic with the D1 adapter — both use `drizzle-orm/sqlite-core`. The key difference: D1 uses the Workers D1 binding (`drizzle(env.DB, ...)`); libSQL uses the `@libsql/client` HTTP/WebSocket client (`drizzle(client, ...)`). Extract shared SQLite query-building logic into a `packages/adapter-turso/src/query-builder.ts` that can be copied to or shared with the D1 adapter if both packages mature similarly. (A shared internal package `@hono-cms/adapter-sqlite-shared` is a future refactor — not v1.)

*`migrate` implementation:* libSQL supports running SQL statements via `client.execute(sql)` or `client.batch(statements)`. The migration runner reads SQL files from the migrations directory, checks the `drizzle_migrations` table, and applies pending statements via `client.batch()` for atomicity.

*`checkDrift` and `generateMigration`:* Use `drizzle-kit/api` with the `sqlite` dialect. Same pattern as D1.

*Test strategy:* Use `file::memory:` — an in-process SQLite database that the libSQL client creates when the URL is `file::memory:`. This is fast, requires no external service, and is correct for unit and integration tests. No Docker or miniflare needed. Each test file creates a fresh in-memory database.

**Test scenarios:**
- `file::memory:` URL creates a working in-process SQLite database
- `libsql://` URL with `authToken` is accepted by the client constructor (mock the HTTP request in unit tests, or use a test Turso database in CI)
- `query` with filters produces correct SQLite `WHERE` clauses
- `query` with cursor pagination returns correct second page
- `findOne` returns `null` for non-existent ID
- `create` inserts and returns the record with all CMS-managed fields populated
- `update` returns the updated record
- `delete` removes the record
- `publish` / `unpublish` update `status` correctly
- `migrate` applies pending migrations to the in-memory SQLite DB
- `checkDrift` returns empty diff when schema matches live DB
- Embedded replica config: adapter accepts `syncUrl` and `syncInterval` without error (smoke test)
- `https://` URL scheme accepted (no WebSocket assumption in tests)

**Verification:** All Vitest tests pass using `file::memory:`. TypeScript confirms `TursoAdapter` implements `DatabaseAdapter<DrizzleLibSQLDatabase>`. `tsdown` build succeeds with `platform: 'neutral'`.

---

### U5. @hono-cms/adapter-convex — Convex Document Store Adapter

**Goal:** Implement `DatabaseAdapter<ConvexHttpClient>` for Convex. This is the hardest adapter — Convex has no SQL surface and uses a completely different query model. The adapter translates the `DatabaseAdapter` interface to Convex queries and mutations. The scope of what is supported must be explicitly declared; unsupported operations throw `AdapterCapabilityError`.

**Requirements:** Enables Convex deployment. Must explicitly scope what is and is not supported in v1.

**Dependencies:** U1.

**Files:**
- `packages/adapter-convex/src/index.ts` — `ConvexAdapter` class + `createConvexAdapter` factory (create)
- `packages/adapter-convex/src/query-translator.ts` — `QueryParams` → Convex query filter/order/pagination translation (create)
- `packages/adapter-convex/src/schema-generator.ts` — `CMSSchema` → Convex `schema.ts` generation (create)
- `packages/adapter-convex/src/capabilities.ts` — supported/unsupported operation declarations and `AdapterCapabilityError` throw helpers (create)
- `packages/adapter-convex/tests/adapter.test.ts` — Vitest tests with mocked Convex client (create)
- `packages/adapter-convex/package.json` — package manifest (create)
- `packages/adapter-convex/tsdown.config.ts` — `platform: 'neutral'` (create)
- `packages/adapter-convex/vitest.config.ts` — `defineProject` (create)

**Approach:**

*Convex architecture context:* Convex is a document database with a reactive query engine. Queries and mutations are TypeScript functions defined in a `convex/` directory and deployed to the Convex cloud. They run in Convex's V8 isolates — not in the CMS's runtime. The CMS communicates with Convex via the Convex HTTP client (`ConvexHttpClient` from `convex/browser`) which calls the deployed functions as HTTP requests.

This creates a fundamental structural difference: the CMS's Drizzle adapters execute queries inside the same runtime as the CMS. The Convex adapter makes HTTP calls to external Convex functions. This means:
1. The Convex adapter ships a set of Convex query/mutation functions that must be deployed to the user's Convex project alongside the CMS.
2. The adapter calls these functions via `ConvexHttpClient.query(api.cms.query, { collection, params })` etc.
3. The `@hono-cms/adapter-convex` package exports both the client-side adapter class AND the Convex server functions (in a `convex/` subdirectory) that the user deploys.

*Convex query translation (`query-translator.ts`):* Convex queries use a typed filter builder — `q.eq(q.field('title'), 'hello')`, `q.gte(q.field('createdAt'), timestamp)`. The translator maps `QueryParams.filters` to Convex filter expressions. Supported filter operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte` on indexed fields. Operators requiring table scans (`$contains`, `$startsWith`) are supported but throw a performance warning — Convex requires full-table scan for non-indexed contains.

*Cursor pagination:* Convex's `.paginate({ numItems, cursor })` is native cursor-based pagination. It maps cleanly to `QueryParams.pagination: { limit, cursor }`. Offset pagination is not supported — throws `AdapterCapabilityError('offset-pagination')` with a message explaining that Convex does not support offset-based pagination and cursor pagination should be used instead.

*Relations and populate:* Convex stores relations as ID references (type `Id<'tableName'>`). The `populate` parameter is supported but implemented as sequential `ctx.db.get(id)` calls per related document — not a join. The Convex server function resolves the IDs and returns the populated shape. For `populate` with many-to-many relations (join tables), a separate Convex table stores the join records and the server function queries it. This is functional but less efficient than SQL joins for large datasets.

*Unsupported operations (explicit v1 scope):*
- `query` with `filters` on relation fields (nested filter like `filters[author][name][$contains]`) — throws `AdapterCapabilityError('nested-relation-filter')`. Convex cannot filter on referenced document fields without a compound index that spans both tables.
- `query` with `populate` that uses selective field population (`populate[author][fields]=name`) — throws `AdapterCapabilityError('selective-populate-fields')`. The Convex server function returns full documents; field selection at the application layer is deferred.
- Offset pagination — throws `AdapterCapabilityError('offset-pagination')`.
- `fields` parameter (field selection on the root collection) — deferred; Convex returns full documents. Can be filtered client-side but this is wasteful for large documents.

*`publish` / `unpublish`:* Implemented as a Convex mutation that sets `status: 'published' | 'draft'`. Convex's document model handles this as a field update — same as any other `update`.

*`migrate` implementation:* Convex uses a declarative schema system. "Migrating" means pushing an updated `convex/schema.ts` to the Convex deployment. The `migrate` method generates the updated `convex/schema.ts` from the `CMSSchema` (via `schema-generator.ts`) and then calls the Convex CLI (`npx convex deploy` or the Convex API) to push it. In practice, for v1, `migrate` generates the schema file and logs instructions for the developer to run `npx convex deploy` — programmatic schema push via API is deferred.

*`checkDrift` implementation:* Uses the Convex management API to fetch the current deployed schema and compares it to the expected schema generated from `CMSSchema`. Returns `SchemaDiff`. The Convex management API requires an admin auth token.

*`generateMigration` implementation:* Generates a `convex/schema.ts` file representing the full current `CMSSchema`. Returns `MigrationFile` with `convexSchema` set (not `sql`). The generated schema uses Convex's `defineSchema` and `defineTable` with `v.string()`, `v.number()`, `v.id()` validators.

*CMSSchema → Convex schema mapping:*
- `string` field → `v.string()`
- `number` field → `v.number()`
- `boolean` field → `v.boolean()`
- `richText` field → `v.string()` (HTML or markdown stored as string)
- `date` / `datetime` field → `v.number()` (Unix timestamp; Convex stores dates as numbers)
- `media` field → `v.string()` (storage URL)
- Relation (one-to-one, many-to-one) → `v.id('tableName')` (typed reference)
- Relation (many-to-many) → separate join table `defineTable({ aId: v.id('a'), bId: v.id('b') })`
- `status` (draft/publish) → `v.union(v.literal('draft'), v.literal('published'))`

*Test strategy:* Mock the `ConvexHttpClient` using Vitest's mock system. Tests verify that the adapter calls the correct Convex function names with the correct arguments. Schema generation tests verify the generated `convex/schema.ts` content against expected output. No real Convex deployment is needed for unit tests — the Convex functions themselves are tested separately in their own Convex test environment.

**Test scenarios:**
- `query` with `{ filters: { title: { $eq: 'hello' } } }` calls the Convex query function with correctly translated filter
- `query` with cursor pagination calls Convex `paginate` with `{ numItems, cursor }`
- `query` with offset pagination throws `AdapterCapabilityError('offset-pagination')` with a helpful message
- `findOne` calls Convex `db.get(id)` and returns the document or `null`
- `create` calls the Convex mutation and returns the created document with `_id` mapped to `id`
- `update` calls the Convex mutation with partial data
- `delete` calls the Convex mutation to delete the document by ID
- `publish` calls the Convex mutation setting `status: 'published'`
- `unpublish` calls the Convex mutation setting `status: 'draft'`
- Nested relation filter (`filters[author][name][$eq]`) throws `AdapterCapabilityError('nested-relation-filter')`
- `generateMigration` produces a valid `convex/schema.ts` with correct `v.string()`, `v.number()`, `v.id()` validators
- `generateMigration` maps many-to-many relations to a join table definition in the Convex schema
- `generateMigration` maps `date` fields to `v.number()` (Unix timestamp)
- Schema generator: `draftAndPublish: true` collection includes `status: v.union(v.literal('draft'), v.literal('published'))`
- `client` property is a `ConvexHttpClient` instance accessible for developer escape hatch

**Verification:** All Vitest unit tests pass with mocked Convex client. The `ConvexAdapter` class satisfies the `DatabaseAdapter<ConvexHttpClient>` type. The generated `convex/schema.ts` from test cases is valid Convex schema syntax. All `AdapterCapabilityError` throws are covered by tests.

---

### U6. Adapter Selection and TypeScript Generic Threading in `createCMS`

**Goal:** Wire the discriminated union config type, the adapter factory, and the `createCMS` return type so that `cms.db` is correctly typed per provider without requiring the developer to annotate anything. `cms.db` should be `DrizzleD1Database` when `provider: 'd1'`, `DrizzlePostgresDatabase` when `provider: 'postgres'`, etc.

**Requirements:** Enables type-safe `cms.db` access per ideation idea #14. Enables `createCMS` to select and instantiate the correct adapter from config.

**Dependencies:** U1 (interface), U2–U5 (adapter packages), and the `@hono-cms/core` package structure (which contains `createCMS`).

**Files:**
- `packages/core/src/config.ts` — `DbConfig` discriminated union and `InferDbClient<TConfig>` conditional type (create)
- `packages/core/src/adapter-factory.ts` — `resolveAdapter(config): DatabaseAdapter<InferDbClient<typeof config>>` (create)
- `packages/core/src/create-cms.ts` — `createCMS` signature with generic threading (create or modify)
- `packages/core/tests/create-cms.test.ts` — type-level tests and runtime factory tests (create)

**Approach:**

*Discriminated union config (`config.ts`):*

The `DbConfig` type is a discriminated union on the `provider` literal:

```
// directional sketch — not implementation specification
type D1Config      = { provider: 'd1';       binding: D1Database }
type PostgresConfig = { provider: 'postgres'; url: string; mode?: 'tcp' | 'http' }
type TursoConfig   = { provider: 'turso';    url: string; authToken?: string; syncUrl?: string }
type ConvexConfig  = { provider: 'convex';   url: string }
type DbConfig = D1Config | PostgresConfig | TursoConfig | ConvexConfig
```

The `InferDbClient<TConfig extends DbConfig>` conditional type maps each config variant to its Drizzle client type:

```
// directional sketch
type InferDbClient<T extends DbConfig> =
  T extends D1Config      ? DrizzleD1Database :
  T extends PostgresConfig ? DrizzlePostgresDatabase :
  T extends TursoConfig   ? DrizzleLibSQLDatabase :
  T extends ConvexConfig  ? ConvexHttpClient :
  never
```

*Adapter factory (`adapter-factory.ts`):* A `resolveAdapter` function takes a `DbConfig` and returns `DatabaseAdapter<InferDbClient<typeof config>>`. The factory uses a type guard approach — `if (config.provider === 'd1') return new D1Adapter(config)` — so TypeScript narrows the config type in each branch and the return type is correct. The adapter packages are imported as static imports (tree-shaking removes unused ones).

*`createCMS` signature:*

```
// directional sketch
function createCMS<TConfig extends DbConfig>(config: CMSConfig<TConfig>):
  Hono & { db: InferDbClient<TConfig>; auth: BetterAuth }
```

The generic `TConfig` is inferred from the `db` property of the config object. The developer writes:
```
const cms = createCMS({ db: { provider: 'd1', binding: env.DB }, ... })
// typeof cms.db = DrizzleD1Database — inferred, no annotation needed
```

`createCMS` calls `resolveAdapter(config.db)` to get the adapter instance. It then calls `Object.assign(honoApp, { db: adapter.client, auth: betterAuthInstance })` to attach the typed client and auth instance to the Hono app. The return type annotation ensures TypeScript sees the correct `db` type.

*Why `Object.assign` and not a class:* Hono apps are not meant to be subclassed. `Object.assign` attaches typed properties without losing any native Hono methods or the `fetch` signature. The return type requires an explicit annotation — TypeScript cannot infer `Object.assign`'s return type for the full merged shape, so `createCMS` has an explicit return type annotation.

*Tree-shaking consideration:* All four adapter packages are listed as peer dependencies of `@hono-cms/core`, not direct dependencies. The developer installs only the adapter they need. The adapter factory uses dynamic conditional imports to avoid bundling all four adapters — or uses static imports with the expectation that the bundler's tree-shaker removes the unused paths since they import from separate packages.

*Alternative: lazy adapter factory via dynamic import:* `resolveAdapter` could use `await import('@hono-cms/adapter-d1')` when `provider === 'd1'`. This guarantees tree-shaking but makes `createCMS` async. The synchronous factory pattern is preferred for v1 — developers install only the adapter they need (peer dependency), so the unused adapters are never in the bundle.

**Test scenarios:**
- Type-level test: `createCMS({ db: { provider: 'd1', binding: mockBinding } }).db` has type `DrizzleD1Database` (verified via `satisfies` or `tsd`)
- Type-level test: `createCMS({ db: { provider: 'postgres', url: '...' } }).db` has type `DrizzlePostgresDatabase`
- Type-level test: `createCMS({ db: { provider: 'turso', url: '...' } }).db` has type `DrizzleLibSQLDatabase`
- Type-level test: `createCMS({ db: { provider: 'convex', url: '...' } }).db` has type `ConvexHttpClient`
- Runtime test: `resolveAdapter({ provider: 'd1', binding: mockD1 })` returns an instance of `D1Adapter`
- Runtime test: `resolveAdapter({ provider: 'postgres', url: 'postgres://...' })` returns an instance of `PostgresAdapter`
- Runtime test: `resolveAdapter({ provider: 'turso', url: 'libsql://...' })` returns an instance of `TursoAdapter`
- Runtime test: `resolveAdapter({ provider: 'convex', url: 'https://...' })` returns an instance of `ConvexAdapter`
- Runtime test: `resolveAdapter` with an invalid `provider` value throws `AdapterConfigError`
- Type-level test: `CMSConfig<D1Config>` does not accept a `url` property in the `db` key (D1 requires `binding`)
- Type-level test: passing `{ provider: 'd1', url: '...' }` is a TypeScript compile error (discriminant narrows to `D1Config` which has `binding`, not `url`)
- Runtime test: `createCMS` result implements Hono interface — `cms.fetch`, `cms.use`, `cms.route` all exist
- Runtime test: `cms.db` is the same object as `adapter.client` (identity check)

**Verification:** `tsc --noEmit` on the core package passes with zero errors. Type-level tests (using `tsd` or `expect-type`) confirm the conditional type inference is correct for all four providers. Runtime tests confirm the factory returns the correct adapter class instance per provider.

---

## Deferred Implementation Notes

These are execution-time unknowns that cannot be resolved during planning:

1. **Drizzle schema generator per adapter** — the `schema-generator.ts` in each adapter translates `CMSSchema` to Drizzle table definitions. The exact Drizzle table definition API calls will be written during implementation. The pattern is clear (one `sqliteTable()` per collection, columns from field definitions) but the exact column type mappings (especially for rich text, JSON, and relation fields) will be settled during implementation.

2. **D1 batch API for populate** — D1 may benefit from using `db.batch()` for relation queries in `populate`. Whether the performance gain justifies the API complexity will be assessed when real populate tests run.

3. **Convex server function file structure** — the exact file layout of the Convex functions that ship with `@hono-cms/adapter-convex` (whether they go in `convex/cms/` or a flat `convex/` directory) depends on how Convex function namespacing works with the user's existing `convex/` directory. This will be determined during U5 implementation.

4. **neon-http vs node-postgres type compatibility** — `DrizzleD1Database` and `DrizzleLibSQLDatabase` may not be exactly the type exported by Drizzle — the exact type name will be confirmed by reading the Drizzle source during implementation.

5. **`RETURNING` clause availability** — D1 added `RETURNING` support in late 2024. Verify the minimum Wrangler version required during implementation.

---

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `DatabaseAdapter` interface is too thin for future adapter needs | Medium | High | Favor adding methods over breaking changes; version the interface in semver |
| Convex server function deployment UX is too complex | High | Medium | Ship a `npx hono-cms-convex-init` scaffolding command; document clearly |
| D1 `RETURNING` not available in older Wrangler versions | Low | Medium | Add a minimum Wrangler version requirement to `adapter-d1` `peerDependencies` |
| `InferDbClient` conditional type fails with TypeScript strict mode | Low | High | Test with `strict: true` from the start; use `satisfies` in tests |
| `@cloudflare/vitest-pool-workers` version compatibility | Medium | Low | Pin to a tested version; document in adapter's README |
| Neon HTTP mode does not support all Drizzle features used by the adapter | Medium | Medium | Build the neon-http path first; test against real Neon in CI |

---

## Alternatives Considered

### Alternative: Single adapter package with provider switching at runtime

One `@hono-cms/adapter` package that imports all four clients and switches at runtime based on `provider`. Rejected because:
- Bundle size: a Workers bundle containing D1, postgres, libSQL, and Convex clients is enormous and likely exceeds the Workers bundle size limit (5MB compressed).
- Peer dependency model is standard for plugin ecosystems (Babel, ESLint, Drizzle itself) and signals clearly to the developer which packages they need.
- Runtime switching is architecturally unsound for the D1 path — D1 requires a Workers binding that does not exist in Node.js.

### Alternative: Abstract Drizzle away behind the interface; do not expose `client`

The `DatabaseAdapter` interface could hide Drizzle entirely — no `client` property, all queries go through the interface methods. Rejected because:
- Developers building custom routes (idea #14's `cms.db` escape hatch) need access to Drizzle for queries outside the CMS-generated API surface.
- Implementing every possible Drizzle query variant in the interface methods would require reimplementing Drizzle's query builder.
- The `client: TDB` approach is the same pattern Drizzle itself uses (exposing the typed client for direct use).

### Alternative: Convex adapter uses Convex's real-time subscription model

The Convex adapter could expose reactive queries via Convex's WebSocket subscription API. Rejected for v1 because:
- The `DatabaseAdapter` interface returns Promises — not observables or streams. Supporting reactive queries requires a separate interface or a React hooks layer, which is outside the server-side adapter scope.
- The admin SPA (idea #5) handles real-time updates via TanStack Query's `refetchInterval`, not WebSocket subscriptions.
- Reactive subscriptions are a Convex v2 feature for the admin SPA layer.

---

## System-Wide Impact

- **`@hono-cms/core`** (`createCMS`): directly depends on the `DatabaseAdapter` interface and the `DbConfig` discriminated union defined in this plan. Cannot be implemented until U1 and U6 are complete.
- **`@hono-cms/schema`** (collection definitions): the `CMSSchema` type produced by collection definitions is consumed by `adapter.migrate()`, `adapter.checkDrift()`, and `adapter.generateMigration()`. The schema package plan (Plan 002) must produce a stable `CMSSchema` type before the adapter migration methods can be fully tested.
- **better-auth integration**: `createCMS` shares the Drizzle client from `adapter.client` with better-auth's `drizzleAdapter()`. This means `adapter.client` must be the same object that better-auth's adapter accepts — a raw Drizzle database instance, not a wrapped version.
- **CLI (`cms schema plan/apply/check`)**: calls `adapter.checkDrift()` and `adapter.generateMigration()`. The CLI plan (separate) depends on these methods being stable and correctly typed.
- **GraphQL layer**: Apollo Server resolvers call `adapter.query()` and `adapter.findOne()` for all data fetching. The resolver shape depends on the `PaginatedResult<T>` and populate types defined in U1.

---

## Dependencies / Prerequisites

- `@hono-cms/schema` package scaffold must exist (directory structure, `package.json`, `tsdown.config.ts`) — this is the package where the interface lives.
- `drizzle-orm` (all dialects), `@libsql/client`, `convex` npm packages are available in the registry.
- `@cloudflare/vitest-pool-workers` available for D1 testing — verify the package name and version in the CF Workers docs before writing `adapter-d1`'s `vitest.config.ts`.
- Vitest `defineProject` API stable in the monorepo's Vitest version.
- `tsdown` installed and configured in the monorepo root for all packages.

---

## Success Criteria

1. All four adapter packages build with `tsdown` producing `.d.ts`, ESM, and CJS outputs with `platform: 'neutral'`.
2. TypeScript strict-mode type checking (`tsc --noEmit`) passes across all packages.
3. `cms.db` in a D1 project is typed as `DrizzleD1Database`; in a Postgres project as `DrizzlePostgresDatabase`; etc. — verified by type-level tests.
4. Each adapter passes its own test suite: D1 via `@cloudflare/vitest-pool-workers`, Postgres via `pg-mem` unit + testcontainers integration, Turso via `file::memory:`, Convex via mocked client.
5. `AdapterCapabilityError` is thrown (not silent failure) for all Convex operations that are out of scope, with a message naming the unsupported capability.
6. The `DatabaseAdapter` interface is unchanged between U1 and the first implementation unit — if implementation reveals a gap, the interface is updated in a single coordinated commit that touches U1's files and the affected adapter.
