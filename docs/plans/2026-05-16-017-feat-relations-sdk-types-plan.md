---
title: "feat: Relations, Populate API, and Auto-Generated TypeScript SDK"
date: 2026-05-16
type: feat
status: active
depth: deep
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
ideation-ideas: ["#11 Relations + Auto-Generated SDK Types on Every Schema Change", "#12 Content Query API"]
---

# feat: Relations, Populate API, and Auto-Generated TypeScript SDK

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 2
**Research inputs used:** skill review, framework docs, architecture review, performance review

### Key Improvements

1. Tighten populate limits with breadth/node budgets in addition to depth.
2. Reposition public SDK generation around the OpenAPI contract instead of duplicating contract authorities.
3. Make deterministic, incremental SDK output part of the plan.

## Summary

This plan covers three deeply interrelated capabilities that together make `@hono-cms` a first-class TypeScript headless CMS: a complete relation definition system (all four cardinalities, validated at schema-load time), the `?populate=` query API that resolves relations on demand using Drizzle's relational query engine, and an auto-generated TypeScript SDK (`cms/sdk/index.ts`) that regenerates whenever the schema changes and is committed to git as a stable build artifact.

The SDK generation is the Convex model applied to SQL: schema change → immediate type regeneration → compile errors surface in the frontend before any data is fetched. Relation population is implemented via Drizzle's first-class relational query API rather than manual JOINs, giving type-safe nested queries with a depth limit of three to prevent circular traversal explosions. The `buildQuery<T>` typed helper re-exported from the SDK ties the content query API (Plan 006) to the schema type system — filter keys are typed to actual collection field names, not `unknown`.

This is Plan 017 of 18. It extends:
- **Plan 005 (Schema System)** — adds `RelationFieldDefinition` to the type system and extends `generateDrizzleSchema` with FK columns, join tables, and `relations()` helper generation
- **Plan 006 (Content API / RBAC)** — adds populate parsing and Drizzle relational query execution to the route factory and GraphQL resolver layer
- **Plan 016 (Draft/Publish)** — extends the draft filter to apply to populated relations, not just top-level queries

---

## Problem Frame

`@hono-cms` collections can declare relations (author, tags, categories), but without the infrastructure in this plan:
- Relations are just FK `text` columns in the DB with no enforced referential integrity
- There is no `?populate=author` behavior — callers receive only the raw `authorId` string
- Frontend TypeScript code has no typed representation of populated vs. unpopulated shapes
- Filter parameters, sort fields, and populate keys are all untyped `string` → `unknown` at the call site

The ideation (#11, #12) identifies this gap as the primary DX blocker for frontend adoption: a developer who adds an `author` relation to `articles` gains nothing until the SDK tells them `article.author` is `Author | undefined` (populated) or `article.authorId` is `string` (always present), and until `buildQuery<Article>({ filters: { title: { $contains: 'hello' } } })` is typed to the actual `Article` field map.

---

## Scope Boundaries

### In scope
- `RelationFieldDefinition` TypeScript type with `target`, `cardinality`, and `onDelete` options
- Cross-collection relation validation at schema-load time (Plan 005 U7 extension)
- Drizzle schema generator extension for FK columns (many-to-one, one-to-one), join tables (many-to-many), and `relations()` helper generation (all cardinalities)
- `?populate=` query-string parsing: comma-separated shorthand, bracket-syntax selective fields, `?populate=*` wildcard
- Drizzle relational query execution in the route factory (Plan 006 U1 extension)
- Depth limit of 3 on nested populate
- `generateSDK(collections: CollectionDefinition[]): string` — produces valid TypeScript source
- SDK types: base entity, `Populated` intersection variant, `CreateInput`, `UpdateInput`
- `CMSClient` mapped type with one namespace per collection
- `buildQuery<T>` generic helper using `qs.stringify` internally
- SDK output path: `{schema.dir}/../sdk/index.ts` in the developer's project
- Dev-mode SDK regeneration trigger (piggybacking on the Plan 005 U4 schema watcher)
- `cms schema generate` CLI command for manual SDK regeneration
- `cms build` SDK regeneration as a pre-build step
- `onDelete` behavior per relation: `'cascade' | 'restrict' | 'set_null'`
- Many-to-many delete: join table row removal, not cascade on the target
- `fieldPermissions` (Plan 006) applied to populated relation fields
- Draft/publish filter (Plan 016) applied to populated relations

### Deferred to Follow-Up Work
- Nested relation filters (`?filters[author][name][$startsWith]=John`) — query parser already supports the bracket syntax (Plan 006 U2); Drizzle relational query `where` on nested `with` is a follow-up
- GraphQL auto-resolved nested relations — GraphQL already returns relation fields as resolved objects (Plan 006 U4); this plan covers REST populate only; GraphQL populate is implicit via type resolvers
- SDK npm package publication (`@my-project/cms-sdk`) — the SDK file is generated into the developer's project; packaging is a follow-up developer concern
- Polymorphic relations (`morphTo`) — deferred; standard four-cardinality relations cover v1 scope
- Relation ordering on many-to-many join tables (e.g., sort by join table `createdAt`) — deferred
- Self-referential relations where `target === collection.name` (e.g., `parent` on a `categories` collection) — allowed at the type level but depth limit provides the safety guard; full testing deferred

### Outside this product's identity
- A separate "relation editor" UI beyond what the CT Builder provides for other field types
- GraphQL subscription support for relation changes in real time
- Generated SQL `VIEW`s that flatten populated relations for BI tools

---

## Key Technical Decisions

## Research Insights

**Best Practices:**
- Use relation metadata as the shared source for populate behavior, admin relation UX, and generated client typing.
- Prefer the OpenAPI-derived SDK as the public client contract and keep schema-derived helpers thin wrappers over that contract where possible.
- Keep populated-vs-unpopulated distinctions explicit in the type system rather than hiding them behind `any`.

**Performance Considerations:**
- Add breadth or total-node budgets for populate, not just nesting depth limits.
- Use request-scoped batching for relation resolution so repeated references do not degenerate into per-row lookups.

**Edge Cases:**
- Circular relations need explicit truncation or error behavior.
- Deleted or forbidden related records should serialize consistently across REST, GraphQL, and generated client helpers.

### 1. Why the SDK is a generated `.ts` file (not Hono RPC `typeof app`)

Hono RPC's `hc<typeof app>` gives end-to-end type safety with zero codegen — it is the correct approach when the Hono app is always present in the same TypeScript project. The CMS, however, is a library deployed on the server; the frontend may be a completely separate repository (a Next.js app, a mobile React Native client, a third-party integration) that never imports the Hono app instance.

`typeof app` inference also breaks when the route factory generates routes dynamically from a runtime schema array — TypeScript cannot statically infer a union type over a `map()` call over a runtime array. The factory's return type would degrade to `Hono<any>`, defeating the purpose.

The generated `.ts` file captures the schema's type information at generation time and serves any TypeScript consumer regardless of their deployment model. It is the Convex `api.d.ts` pattern applied to SQL: schema-derived static types committed to the repo, consumed anywhere TypeScript runs.

### 2. How the populated vs. unpopulated type distinction is handled

The base entity type uses optional relation fields (`author?: Author`) to represent the fact that the field is only present when `?populate=author` was requested. The `Populated` intersection variant (`ArticlePopulated = Article & { author: Author; tags: Tag[] }`) makes those relations required — the type a caller can use when they know they passed `?populate=*` or an explicit list.

This distinction matters because a caller who does `const a = await sdk.articles.findOne(id)` and then `a.author.name` gets a TypeScript error (`'author' is possibly undefined`). A caller who does `const a = await sdk.articles.findOne(id, { populate: ['author'] })` and casts to `ArticlePopulated` gets `a.author.name` type-safely. The optional/required split makes the difference explicit in the type system rather than hiding it behind `any`.

The `findOne` and `findMany` signatures in `CMSClient` return `Article` (unpopulated) by default. A future enhancement (v2) can overload these with a generic `populate` parameter that narrows the return type. For v1, `ArticlePopulated` is the typed alias the caller uses with an explicit cast after populate.

### 3. Why the SDK file is committed to git (type stability across CI)

The SDK file is a build artifact like `drizzle/schema.ts` or Prisma's `node_modules/.prisma/client/index.d.ts` — it is derived from the schema but committed so that:

1. **CI type-checks pass without running the CMS dev server**: `tsc` can type-check frontend code that imports `cms/sdk` without needing the CMS to regenerate the SDK on every CI run
2. **Type drift is visible in PRs**: a PR that adds a `tags` relation produces a diff in `cms/sdk/index.ts` — reviewers see the new `tags?: Tag[]` field appear in the `Article` type, making schema changes visible to frontend consumers at review time
3. **The SDK is stable between dev server restarts**: the frontend doesn't lose types when the dev server is down
4. **No runtime codegen in production**: the deployed CMS never needs to write to the filesystem at runtime (important for read-only edge runtimes like CF Workers)

The `.gitignore` convention recommended in the setup guide explicitly excludes the SDK from ignore patterns — it must be committed, not gitignored.

### 4. Drizzle ORM relational queries vs. manual JOIN queries

Manual `JOIN` queries require the route factory to construct SQL strings or Drizzle query builder chains that vary based on which fields are being populated. This produces complex conditional logic that is hard to type-check and error-prone for deeply nested cases.

Drizzle's relational query API (`db.query.articles.findMany({ with: { author: true, tags: true } })`) is:
- **Type-safe**: the `with` key is typed to the collection's defined `relations()` — passing an invalid relation name is a TypeScript error
- **Composition-friendly**: nesting `with: { author: { with: { company: true } } }` is natural and recursive
- **Correct for many-to-many**: Drizzle handles join table traversal automatically when the `relations()` helper declares the join table columns
- **Dialect-agnostic**: the same relational query works across SQLite, Postgres, and libSQL without dialect-specific JOIN syntax

The `relations()` helper generated by `generateDrizzleSchema` (Plan 005 U3 extension) is what makes `db.query.*` available and typed. Without it, the route factory would fall back to raw `JOIN` queries that cannot be type-checked against the schema.

### 5. Depth limit on nested populate (3 levels) and enforcement

Circular relations (`articles → authors → articles`) are structurally valid and intended. Without a depth limit, `?populate=*` on a circular schema would cause infinite recursion in the populate resolver. The depth limit of 3 is enforced in two places:

1. **At populate parse time**: the `parsePopulate` function assigns a `depth` to each populate entry based on dot-notation nesting (`author.company.address` = depth 3). Entries exceeding depth 3 are silently dropped from the parsed populate object and logged as a warning.
2. **At Drizzle query construction time**: `buildWithClause(populateMap, depth = 0)` is a recursive function that stops recursing when `depth >= 3`, returning `true` (populate everything at that level) instead of a nested `with` object. This is the hard stop that prevents runaway queries regardless of how `parsePopulate` was called.

Depth 3 is chosen because it covers the practical cases (`author.company.address`, `tags.category.parent`) without enabling deeply nested population chains that produce N+1-style load patterns across large related datasets. The limit is a CMS-level constant exported from `packages/core/src/content/populate.ts` so it can be referenced in documentation and tests.

---

## High-Level Technical Design

*This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Relation field → Drizzle schema → SDK type pipeline

```
defineCollection({ fields: { author: { type: 'relation', target: 'authors', cardinality: 'many-to-one' } } })
       │
       ▼  (Plan 005 U3 extension — generateDrizzleSchema)
Drizzle schema:
  articles table:        text('author_id').references(() => authors.id, { onDelete: 'restrict' })
  articlesRelations:     relations(articles, ({ one }) => ({ author: one(authors, { fields: [articles.authorId], references: [authors.id] }) }))
       │
       ▼  (this plan U2 extension)
db.query.articles.findMany({ with: { author: true } })
       │
       ▼  (this plan U3 — populate query execution)
Response: { id, title, author: { id, name, avatar }, authorId: 'clx...' }
       │
       ▼  (this plan U4 — generateSDK)
SDK type:
  export type Article = { id: string; title: string; author?: Author; authorId: string; ... }
  export type ArticlePopulated = Article & { author: Author }
```

### Populate parse → Drizzle `with` clause construction

```
Input: ?populate=author,tags&populate[author][fields]=name,avatar

parsePopulate(query) →
  {
    author: { fields: ['name', 'avatar'], depth: 1 },
    tags:   { fields: '*', depth: 1 },
  }

buildWithClause(populateMap, collection, depth=0) →
  {
    author: { columns: { name: true, avatar: true } },
    tags:   true,
  }

db.query.articles.findMany({ with: <above> })
```

### SDK file structure (generated output)

```
// cms/sdk/index.ts — AUTO-GENERATED by @hono-cms/schema, NEVER written manually
// Updated: 2026-05-16T12:00:00Z
// Schema version: <hash of all CollectionDefinition names+fields>

// --- Primitive helpers (static, always the same) ---
export type PaginatedResponse<T> = { data: T[]; meta: { pagination: { ... } } }
export type QueryParams<T> = { filters?: DeepFilters<T>; sort?: ...; pagination?: ...; populate?: ... }
export type PopulateParams<T> = { populate?: Array<keyof RelationFields<T>> | '*' }
export type CreateInput<T> = Omit<T, 'id' | 'createdAt' | 'updatedAt' | 'status' | ...>
export type UpdateInput<T> = Partial<CreateInput<T>>
export type DeepFilters<T> = { [K in keyof T]?: FilterOperators<T[K]> }

// --- Collection types (one block per collection, alphabetically sorted) ---
export type Article = { id: string; title: string; authorId: string; author?: Author; tags?: Tag[]; ... }
export type ArticlePopulated = Article & { author: Author; tags: Tag[] }

export type Author = { id: string; name: string; avatar?: string; ... }
export type AuthorPopulated = Author

export type Tag = { id: string; name: string; slug: string }
export type TagPopulated = Tag

// --- CMSClient (one namespace per collection, alphabetically sorted) ---
export type CMSClient = {
  articles: {
    findMany:  (params?: QueryParams<Article>)                        => Promise<PaginatedResponse<Article>>
    findOne:   (id: string, params?: PopulateParams<Article>)         => Promise<Article | null>
    create:    (data: CreateInput<Article>)                           => Promise<Article>
    update:    (id: string, data: UpdateInput<Article>)               => Promise<Article>
    delete:    (id: string)                                           => Promise<void>
    publish:   (id: string)                                           => Promise<Article>
    unpublish: (id: string)                                           => Promise<Article>
  }
  authors: { ... }
  tags: { ... }
}

// --- buildQuery helper ---
export function buildQuery<T>(params: QueryParams<T>): string

// --- qs re-export ---
export { qs } from 'qs'
```

### Dependency graph for this plan's units

```
U1 (RelationFieldDefinition type)
 └─► U2 (Drizzle FK + join table + relations() generation)
       └─► U3 (Populate query execution in route factory)
 └─► U4 (SDK generator — generateSDK function)
       └─► U5 (SDK generation trigger in dev mode)
       └─► U6 (buildQuery typed helper — part of SDK output)
U7 (Relation API edge cases — crosses U2, U3, Plan 006 RBAC, Plan 016 draft filter)
```

---

## Output Structure

```
packages/schema/src/
  types/
    fields.ts                    ← MODIFIED: add RelationFieldDefinition
    collection.ts                ← MODIFIED: add relation target validation hook
  sdk-generator.ts               ← NEW: generateSDK(collections): string
  __tests__/
    sdk-generator.test.ts        ← NEW

packages/core/src/
  content/
    populate.ts                  ← NEW: parsePopulate, buildWithClause, POPULATE_DEPTH_LIMIT
    route-factory.ts             ← MODIFIED: integrate populate into findMany / findOne handlers
    __tests__/
      populate.test.ts           ← NEW

packages/cli/src/
  commands/
    schema.ts                    ← MODIFIED: add 'generate' subcommand calling generateSDK

// Developer's project (output — not in the monorepo):
cms/
  collections/
    articles.ts
    authors.ts
    tags.ts
  sdk/
    index.ts                     ← GENERATED: developer commits this file
```

---

## Implementation Units

### U1. RelationFieldDefinition Type System Extension

**Goal:** Extend the `FieldDefinition` discriminated union (Plan 005 U1) with a complete `RelationFieldDefinition` type covering all four cardinalities and the `onDelete` behavior option. Add the `onDelete` constraint to the type so that downstream generators (U2) and the CLI help text can reference it unambiguously.

**Requirements:**
- `RelationFieldDefinition` must carry: `type: 'relation'`, `target: string`, `cardinality: 'many-to-one' | 'one-to-one' | 'one-to-many' | 'many-to-many'`, `onDelete?: 'cascade' | 'restrict' | 'set_null'`
- `onDelete` default when omitted: `'restrict'` for many-to-one and one-to-one; `'cascade'` for many-to-many (join table rows) — the default is computed at generator time (U2), not stored in the type
- `required?: boolean` is valid on many-to-one and one-to-one only (FK column can be nullable or not); one-to-many and many-to-many have no nullable concept at the DB level (they are always collections, potentially empty)
- TypeScript must reject `{ type: 'relation', cardinality: 'many-to-one' }` without `target` — `target` is always required
- The type must be exported from `packages/schema/src/index.ts` as part of the public API

**Dependencies:** Plan 005 U1 (existing FieldDefinition union).

**Files:**
- `packages/schema/src/types/fields.ts` — add `RelationFieldDefinition` variant to the discriminated union
- `packages/schema/src/types/collection.ts` — no change needed (relations are fields, already part of `fields` record)
- `packages/schema/__tests__/fields.test.ts` — extend with relation-specific type tests

**Approach:**

The `RelationFieldDefinition` is a discriminated union member on `type: 'relation'`. The `cardinality` property further discriminates behavior but is not itself a discriminant for TypeScript structural purposes — both many-to-one and one-to-many share `type: 'relation'`. The generator (U2) branches on `cardinality` at runtime.

Directional type shape (not final signature):

```ts
// Owning-side relations (FK on this table)
type OwningRelation = {
  type: 'relation'
  target: string
  cardinality: 'many-to-one' | 'one-to-one'
  required?: boolean
  onDelete?: 'cascade' | 'restrict' | 'set_null'
}

// Inverse / collection relations (no column on this table)
type InverseRelation = {
  type: 'relation'
  target: string
  cardinality: 'one-to-many' | 'many-to-many'
  onDelete?: 'cascade' | 'restrict'   // 'set_null' not applicable for collections
}

type RelationFieldDefinition = OwningRelation | InverseRelation
```

This is directional — the implementer may choose a flat type with conditional properties instead of a union of unions, depending on what produces cleaner discriminated-union exhaustion in switch statements downstream.

**Test scenarios:**
- TypeScript: `{ type: 'relation', target: 'authors', cardinality: 'many-to-one' }` — compiles without error
- TypeScript: `{ type: 'relation', cardinality: 'many-to-one' }` (missing `target`) — TypeScript error
- TypeScript: `{ type: 'relation', target: 'authors', cardinality: 'many-to-one', onDelete: 'cascade' }` — compiles
- TypeScript: `{ type: 'relation', target: 'authors', cardinality: 'many-to-many', onDelete: 'set_null' }` — TypeScript error (set_null not valid for collection relations)
- TypeScript: `{ type: 'relation', target: 'authors', cardinality: 'many-to-one', required: true }` — compiles
- TypeScript: `{ type: 'relation', target: 'tags', cardinality: 'one-to-many', required: true }` — TypeScript error (`required` not valid on inverse relations)
- Runtime: `defineCollection` (Plan 005 U2) does not throw when a valid relation field is defined — cross-collection target validation is deferred to schema compiler (Plan 005 U7)
- Runtime: `defineCollection` throws `DefinitionError` with code `'INVALID_CARDINALITY'` when `cardinality` is not one of the four valid values

**Verification:** `tsc --noEmit` passes on the updated `fields.ts`. All new test cases pass in Vitest.

---

### U2. Drizzle Relation Schema Generation

**Goal:** Extend `generateDrizzleSchema` (Plan 005 U3) to produce correct Drizzle column declarations for all four relation cardinalities, generate join tables for many-to-many relations, generate the Drizzle `relations()` helper for every collection, and handle the `onDelete` behavior on FK references. The generated Drizzle schema must enable `db.query.<collection>.findMany({ with: {...} })` — the relational query API that U3 depends on.

**Requirements:**
- Many-to-one: add `{fieldName}_id TEXT` column with `.references(() => targetTable.id, { onDelete })` to the owning table
- One-to-one: same as many-to-one plus `.unique()` on the FK column
- Many-to-many: generate join table named `{collectionA}_{collectionB}` (alphabetically sorted, underscore-joined) with composite PK and two FK columns, each with `onDelete: 'cascade'` (join row removal, not target deletion)
- One-to-many: no column on the source table; only a Drizzle `relations()` entry declaring the `many()` side
- `relations()` helper: generated for every collection regardless of whether it has relations — all collections need the empty `relations()` export for the Drizzle relational query API to work
- Join tables must be deduplicated: if `articles` declares `tags` as many-to-many AND `tags` declares `articles` as many-to-many, the join table is generated exactly once
- Generated `relations()` declarations must correctly wire both sides of each relation (the owning collection and the target collection)

**Dependencies:** U1, Plan 005 U1 (FieldDefinition), Plan 005 U3 (generateDrizzleSchema).

**Files:**
- `packages/schema/src/drizzle-generator.ts` — extend with relation column generation and `relations()` helper generation
- `packages/schema/__tests__/drizzle-generator.test.ts` — extend with relation-specific generation tests

**Approach:**

The generator processes collections in two passes:

**Pass 1 — Table column generation (existing U3 logic extended):**
For each collection's fields, when the field is a relation:
- `many-to-one`: emit `text('{fieldName}_id', { length: 24 }).references(() => {target}Table.id, { onDelete: '{onDelete ?? restrict}' })`; if `required: true`, append `.notNull()`
- `one-to-one`: same as many-to-one plus `.unique()`
- `one-to-many`: skip — no column emitted on this table
- `many-to-many`: skip — handled in join table pass

**Pass 2 — Join table generation:**
After all table declarations, iterate the full collection graph and collect all unique many-to-many pairs. A pair is a canonical set `{ collectionA, collectionB }` where `collectionA < collectionB` alphabetically. For each unique pair, emit:

```
// join table: articles ↔ tags
export const articlesTags = sqliteTable('articles_tags', {
  articleId: text('article_id', { length: 24 }).notNull()
               .references(() => articlesTable.id, { onDelete: 'cascade' }),
  tagId:     text('tag_id', { length: 24 }).notNull()
               .references(() => tagsTable.id, { onDelete: 'cascade' }),
}, (t) => ({
  pk: primaryKey({ columns: [t.articleId, t.tagId] })
}))
```

**Pass 3 — `relations()` helper generation:**
For every collection, emit a `relations()` export that wires all relation fields. This is what enables `db.query.*`:

```
// directional — not final syntax
export const articlesRelations = relations(articlesTable, ({ one, many }) => ({
  author: one(authorsTable, {
    fields:     [articlesTable.authorId],
    references: [authorsTable.id],
  }),
  tags: many(articlesTagsTable),   // many-to-many via join table
}))

export const authorsRelations = relations(authorsTable, ({ many }) => ({
  articles: many(articlesTable),   // one-to-many: no FK on authors table
}))

export const tagsRelations = relations(tagsTable, ({ many }) => ({
  articles: many(articlesTagsTable),
}))

export const articlesTagsRelations = relations(articlesTagsTable, ({ one }) => ({
  article: one(articlesTable, { fields: [articlesTagsTable.articleId], references: [articlesTable.id] }),
  tag:     one(tagsTable,     { fields: [articlesTagsTable.tagId],     references: [tagsTable.id]     }),
}))
```

**Circular relation handling:** Articles referencing authors and authors referencing articles (via one-to-many) is valid and expected. The generator processes all collections in the same pass — it does not need to topologically sort them because it emits Drizzle schema code (strings), not imported objects. Forward references in the emitted code are fine because the Drizzle `relations()` functions use arrow functions (`() => authorsTable`) that are resolved at runtime after all exports are defined.

**Test scenarios:**
- Many-to-one: `articles.author` (many-to-one → authors) generates `author_id TEXT` FK column on `articles` table
- Many-to-one with `required: true`: generates `.notNull()` on the FK column
- Many-to-one with `onDelete: 'cascade'`: generates `{ onDelete: 'cascade' }` on the `.references()` call
- One-to-one: `articles.category` (one-to-one → categories) generates unique FK column
- One-to-many: `authors.articles` (one-to-many → articles) generates no column on `authors` table; generates a `many(articlesTable)` entry in `authorsRelations`
- Many-to-many: `articles.tags` generates join table `articles_tags` with composite PK
- Many-to-many deduplication: if both `articles` and `tags` declare the same many-to-many relation, the join table `articles_tags` appears exactly once in the generated output
- Join table naming: `articles` ↔ `tags` → `articles_tags`; `tags` ↔ `articles` (declared in that order) → same `articles_tags` (alphabetical sort)
- `relations()` helper: generated output for `articles` includes `author` as `one(authorsTable, {...})` and `tags` as `many(articlesTagsTable)`
- `relations()` helper: generated output for `authors` includes `articles` as `many(articlesTable)` (the reverse one-to-many)
- `relations()` helper: generated output for join table includes both `one(articlesTable)` and `one(tagsTable)`
- Snapshot test: a fixed multi-collection schema produces a stable generated string
- Generated TypeScript compiles without errors when processed by `tsc` or Bun

**Verification:** Generated Drizzle schema compiles. `db.query.articles.findMany({ with: { author: true, tags: true } })` is typed correctly (no TypeScript error) when consuming the generated schema in a test harness.

---

### U3. Populate Query Implementation

**Goal:** Implement `parsePopulate(query: ParsedQs): PopulateMap` and `buildWithClause(populateMap: PopulateMap, collection: CollectionDefinition, depth: number): DrizzleWithClause` in `packages/core/src/content/populate.ts`. Integrate these into the route factory (Plan 006 U1) so that `GET /api/articles?populate=author,tags` executes a Drizzle relational query and returns the populated objects inline. Enforce the depth limit of 3.

**Requirements:**
- Parse `?populate=author,tags` (comma-separated shorthand)
- Parse `?populate[author][fields]=name,avatar&populate[tags][fields]=name,slug` (bracket selective fields)
- Parse `?populate=*` (populate all relations defined on the collection)
- Build a Drizzle `with` clause object from the parsed populate map
- Selective field population: `populate[author][fields]=name,avatar` translates to `{ columns: { name: true, avatar: true } }` in the `with` clause
- Depth limit 3: enforced at `buildWithClause` recursion depth; entries beyond depth 3 are silently dropped with a warning log
- `?populate=*` expands to all relation field names defined in the collection definition (not nested — only one level by default for wildcard)
- Draft/publish filter (Plan 016) applies to populated relations: when populating `articles` from `authors`, only `status: 'published'` articles are included in the relation unless the request carries an admin session
- `fieldPermissions` (Plan 006 RBAC) applies to populated relation fields: the `stripForbiddenFields` function is called on each populated sub-object using the role from the Hono context

**Dependencies:** U1, U2 (Drizzle `relations()` must be generated for relational queries to work), Plan 005 U1, Plan 006 U1 (route factory), Plan 006 U3 (RBAC stripForbiddenFields), Plan 016 (draft filter).

**Files:**
- `packages/core/src/content/populate.ts` — NEW: parsePopulate, buildWithClause, POPULATE_DEPTH_LIMIT constant
- `packages/core/src/content/route-factory.ts` — MODIFIED: inject populate into findMany and findOne handlers
- `packages/core/src/content/__tests__/populate.test.ts` — NEW

**Approach:**

**`parsePopulate(query: ParsedQs): PopulateMap`:**

`qs.parse` (already used in Plan 006 U2) converts the raw query string into a nested object. `parsePopulate` reads the `populate` key from the parsed object and normalizes it into:

```ts
// directional — not final type
type PopulateEntry = {
  fields: string[] | '*'  // '*' = all fields on the related collection
  populate?: PopulateMap  // nested populate (depth 2+)
  depth: number
}
type PopulateMap = Record<string, PopulateEntry>
```

Cases:
- `populate=author,tags` → `qs` produces `{ populate: 'author,tags' }` — split on comma, produce `{ author: { fields: '*', depth: 1 }, tags: { fields: '*', depth: 1 } }`
- `populate[author][fields]=name,avatar` → `qs` produces `{ populate: { author: { fields: 'name,avatar' } } }` — produce `{ author: { fields: ['name', 'avatar'], depth: 1 } }`
- `populate=*` → expand to all relation field names on the collection at depth 1
- `populate[author][populate][company][fields]=name` → nested populate at depth 2

**`buildWithClause(populateMap, collection, depth = 0)`:**

Recursively builds the Drizzle `with` clause object. For each entry in `populateMap`:
1. If `depth >= POPULATE_DEPTH_LIMIT (3)`, skip the entry and log a warning
2. If `fields === '*'`, use `true` (populate all columns on the relation)
3. If `fields` is an array, use `{ columns: Object.fromEntries(fields.map(f => [f, true])) }`
4. If there is a nested `populate` on the entry, recurse: `with: buildWithClause(entry.populate, relatedCollection, depth + 1)`
5. Return the assembled object passed directly to Drizzle's `with` option

**Route factory integration (Plan 006 U1 extension):**

In `findMany` and `findOne` handlers:
1. Parse `c.req.query()` through `parsePopulate`
2. Pass the result to `buildWithClause(populateMap, collection, 0)` to get the Drizzle `with` clause
3. Pass the `with` clause to `db.query[collection.name].findMany({ with: withClause, where: ..., limit: ..., orderBy: ... })`
4. After the query, for each populated sub-object:
   a. Apply `stripForbiddenFields(subObject, relatedCollection, ctx.role)` (RBAC)
   b. Apply draft filter: if `relatedCollection.draftAndPublish && !isAdmin(ctx)`, filter out `status !== 'published'` items from populated arrays (for one-to-many and many-to-many results)

**Draft filter on populated relations:** For one-to-many and many-to-many, the populated result is an array. The route handler filters this array after the query (not via Drizzle `where` on the `with` clause — Drizzle's relational API supports `where` on `with` but it is deferred to the nested filter follow-up plan). For now, post-query array filtering is the correct v1 approach.

**`?populate=*` expansion:** When `populate=*` is parsed, the route handler calls `getRelationFields(collection)` — a helper that returns all field names where `field.type === 'relation'`. This is used to expand `*` into the full relation field list before passing to `buildWithClause`.

**Test scenarios:**
- `parsePopulate({ populate: 'author,tags' })` → `{ author: { fields: '*', depth: 1 }, tags: { fields: '*', depth: 1 } }`
- `parsePopulate({ populate: { author: { fields: 'name,avatar' } } })` → `{ author: { fields: ['name', 'avatar'], depth: 1 } }`
- `parsePopulate({ populate: '*' })` with a collection that has `author` and `tags` relations → `{ author: { fields: '*', depth: 1 }, tags: { fields: '*', depth: 1 } }`
- `parsePopulate({})` → `{}`
- `buildWithClause({ author: { fields: '*', depth: 1 } }, ...)` → `{ author: true }`
- `buildWithClause({ author: { fields: ['name', 'avatar'], depth: 1 } }, ...)` → `{ author: { columns: { name: true, avatar: true } } }`
- Depth limit: `buildWithClause` with a `populate` entry at `depth: 3` (the limit) returns `{}` for that entry, not a recursive `with` clause
- Depth limit: nesting `populate[a][populate][b][populate][c][populate][d]` (depth 4) — the `d` level is silently dropped
- Populate with selective fields excludes unspecified fields from the response: given `article.author` is populated with `fields: ['name']`, the response `author` object contains `name` but not `avatar` or `email`
- RBAC interaction: populating `authors.articles` where `articles._internalNotes` is restricted to `admin` role — for a non-admin request, `_internalNotes` is absent from each article in the populated array
- Draft filter on populated one-to-many: `GET /api/authors/1?populate=articles` for a public request — only `status: 'published'` articles appear in the populated `articles` array
- Draft filter on populated many-to-many: `GET /api/articles?populate=tags` — tags have no `draftAndPublish`, so all tags appear (no filter applied)
- Integration test: request `GET /api/articles?populate=author,tags` against a test DB → response contains `author` object and `tags` array inline; `authorId` is also present

**Verification:** Integration tests run against a test SQLite DB with a multi-collection schema. `GET /api/articles?populate=author` returns the full author object nested in each article. `GET /api/articles?populate[author][fields]=name` returns only `name` on the author sub-object. Depth-limit warning is logged when depth > 3.

---

### U4. TypeScript SDK Generator

**Goal:** Implement `generateSDK(collections: CollectionDefinition[]): string` in `packages/schema/src/sdk-generator.ts`. The function produces a valid TypeScript source string representing the full typed SDK for the given collection set. The output is deterministic (same schema → same output), sorted alphabetically (collections and their namespaces), and self-contained (no imports beyond built-in helpers and `qs`).

**Requirements:**
- Produces valid TypeScript — no syntax errors
- Base entity type: FK ID fields as `string` (e.g., `authorId: string`), relation fields as optional (`author?: Author`, `tags?: Tag[]`)
- `Populated` intersection type per collection: relation fields required (`author: Author`, `tags: Tag[]`), only generated for collections that have at least one relation field
- `CreateInput<T>`: omit `id`, `createdAt`, `updatedAt`, `status`, `publishedAt`, `locale`, `createdBy`, `updatedBy` (all system fields); all remaining fields follow their `required` setting
- `UpdateInput<T>`: all fields optional (partial update semantics)
- `CMSClient` type: one namespace per collection with `findMany`, `findOne`, `create`, `update`, `delete`; for collections with `draftAndPublish: true`, also `publish` and `unpublish`
- Alphabetical sort: collection type blocks appear A→Z; `CMSClient` namespaces appear A→Z; within a type, fields appear A→Z (system fields last)
- File header comment with generation timestamp and schema hash for reproducibility tracking
- Static helper types (PaginatedResponse, QueryParams, PopulateParams, DeepFilters, FilterOperators, CreateInput, UpdateInput) emitted once at the top of the file — not re-generated per collection
- Output path determined by caller (not hardcoded) — `generateSDK` returns a string; the caller writes it

**Dependencies:** U1, Plan 005 U1 (CollectionDefinition, FieldDefinition types).

**Files:**
- `packages/schema/src/sdk-generator.ts` — NEW
- `packages/schema/__tests__/sdk-generator.test.ts` — NEW

**Approach:**

`generateSDK` iterates `collections` (sorted alphabetically by `name`) and for each collection:

1. **Emits the base entity type:** For each field in the collection (sorted alphabetically by key):
   - Scalar fields: map field type to TypeScript primitive (`string`, `number`, `boolean`, `Date`)
   - Relation many-to-one / one-to-one: emit `{fieldName}Id: string` (always-present FK) AND `{fieldName}?: {TargetTypeName}` (optional populated object)
   - Relation one-to-many / many-to-many: emit `{fieldName}?: {TargetTypeName}[]` (optional populated array); no FK column on this side
   - Media fields: emit `{fieldName}Id: string` and `{fieldName}?: MediaFile`
   - System fields at the end: `id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, plus conditional `status`, `publishedAt`, `locale`

2. **Emits the Populated intersection type** (only if the collection has at least one relation field):
   `export type {Name}Populated = {Name} & { {fieldName}: {TargetTypeName}; ... }`

3. **Accumulates CMSClient namespace** for the collection — deferred to a single final emit block.

**TypeScript primitive mapping** (directional):

| Field type | TypeScript type |
|---|---|
| `string`, `text`, `richtext`, `email`, `url`, `uid`, `enumeration` | `string` |
| `integer`, `float` | `number` |
| `boolean` | `boolean` |
| `datetime`, `date`, `time` | `Date` |
| `json` | `Record<string, unknown>` |
| `password` | never emitted (excluded from all SDK types — write-only, never returned) |
| `relation` many-to-one / one-to-one | `{TargetTypeName} \| undefined` (optional) + FK `string` |
| `relation` one-to-many / many-to-many | `{TargetTypeName}[] \| undefined` (optional) |
| `media` (single) | `MediaFile \| undefined` (optional) |
| `media` (multiple) | `MediaFile[] \| undefined` (optional) |
| `component` | `Record<string, unknown>` (typed component support deferred) |
| `dynamiczone` | `Array<Record<string, unknown>>` (typed polymorphic support deferred) |

**`enumeration` type:** Instead of `string`, emit the literal union: `'draft' | 'published'` for an enumeration with those values.

**Static helper types** emitted once (not regenerated per collection): `PaginatedResponse<T>`, `QueryParams<T>`, `PopulateParams<T>`, `CreateInput<T>`, `UpdateInput<T>`, `DeepFilters<T>`, `FilterOperators<T>`, `MediaFile` (standard media metadata shape), `CMSPaginationMeta`.

**Schema hash:** A simple deterministic hash of `collections.map(c => c.name + JSON.stringify(c.fields)).join('')` — not cryptographic, just reproducible. Included in the file header comment so that CI can detect stale SDK files by comparing the hash in the comment against the hash of the current schema.

**Alphabetical sort guarantee:** `collections.sort((a, b) => a.name.localeCompare(b.name))` before iterating. Fields sorted by key within each type block.

**Test scenarios:**
- `generateSDK([articleCollection])` with `author` (many-to-one) produces: `authorId: string` AND `author?: Author` on the `Article` type
- `generateSDK([articleCollection])` with `tags` (many-to-many) produces: `tags?: Tag[]` on the `Article` type (no `tagsIds` FK — join table has no single FK column on articles)
- `generateSDK([articleCollection])` with `draftAndPublish: true` produces `status: 'draft' | 'published'` and `publish` + `unpublish` on the `CMSClient.articles` namespace
- `generateSDK([articleCollection])` — `ArticlePopulated` type is emitted with `author: Author` (required, not optional)
- `generateSDK([articleCollection])` — `password` field is NOT present on the emitted `Article` type
- `generateSDK([articleCollection, authorCollection])` — collections appear in alphabetical order: `Article` before `Author`
- `generateSDK([...])` called twice with the same collections produces identical strings (idempotency / no diff noise)
- `generateSDK([articleCollection])` — `CreateInput<Article>` omits `id`, `createdAt`, `updatedAt`, `status`, `publishedAt`
- `generateSDK([articleCollection])` — `enumeration` field with `values: ['draft', 'published']` produces `'draft' | 'published'` in the type (not `string`)
- `generateSDK([...])` — produced TypeScript string compiles without errors when written to disk and type-checked
- `generateSDK([articleCollection])` where `articleCollection` has no relation fields — `ArticlePopulated` type is NOT emitted (no populated intersection needed)
- Schema hash in header comment changes when a field is added to a collection

**Verification:** Generated TypeScript compiles via `tsc --noEmit` in a test harness. Snapshot test confirms output is stable. Round-trip: generate SDK, write to temp file, import the type in a TypeScript test, assert that `Article` type has `authorId: string` and `author?: Author`.

---

### U5. SDK Generation Trigger in Dev Mode

**Goal:** Wire `generateSDK()` into the dev-mode schema watcher (Plan 005 U4) so that the SDK is regenerated automatically every time the schema changes in the admin CT Builder. Enforce < 500ms generation time. Document the git commit convention for the generated file.

**Requirements:**
- SDK regeneration must happen immediately after a successful schema change + auto-migration cycle (the same `onSchemaChange` callback that invalidates the schema cache in Plan 005 U4)
- Generation time (from `CollectionDefinition[]` in memory to `cms/sdk/index.ts` written to disk) must be < 500ms for a schema of up to 30 collections
- TypeScript compilation of the generated file is NOT required during generation — the developer's `tsc --watch` or editor picks it up automatically from disk
- The output path `{schema.dir}/../sdk/index.ts` is computed relative to the schema directory (e.g., if `schema.dir` is `./cms/collections`, the SDK goes to `./cms/sdk/index.ts`)
- The `cms/sdk/` directory is created if it does not exist
- The generated file header includes a timestamp and schema hash so developers can see when it was last regenerated
- Manual CLI trigger: `cms schema generate` regenerates the SDK without running migrations
- Build-time trigger: `cms build` calls `generateSDK` before bundling the CMS handler

**Dependencies:** U4 (generateSDK function), Plan 005 U4 (dev watcher onSchemaChange callback), Plan 005 U7 (schema cache provides CollectionDefinition[]).

**Files:**
- `packages/schema/src/dev-watcher.ts` — MODIFIED: add `generateSDK` call to the `onSchemaChange` handler
- `packages/cli/src/commands/schema.ts` — MODIFIED: add `generate` subcommand
- `packages/core/src/create-cms.ts` — MODIFIED: add `generateSDK` to the `cms build` pre-build step

**Approach:**

**Dev watcher integration:**

The existing Plan 005 U4 watcher fires `onSchemaChange(collections: CollectionDefinition[])` after a successful migration. Extend this:

```
// directional — not final implementation
onSchemaChange: async (collections) => {
  const start = performance.now()
  const sdkSource = generateSDK(collections)
  const sdkPath = path.join(options.schema.dir, '..', 'sdk', 'index.ts')
  await fs.mkdir(path.dirname(sdkPath), { recursive: true })
  await fs.writeFile(sdkPath, sdkSource, 'utf-8')
  const elapsed = performance.now() - start
  if (elapsed > 500) {
    console.warn(`[hono-cms] SDK generation took ${elapsed.toFixed(0)}ms (target: <500ms)`)
  }
  console.log(`[hono-cms] SDK regenerated at ${sdkPath} (${elapsed.toFixed(0)}ms)`)
}
```

Generation is fast because `generateSDK` is pure string concatenation with no I/O, no TypeScript compilation, and no external tool invocations. For 30 collections with 15 fields each, benchmark measurements should confirm < 100ms. The 500ms budget is conservative.

**`cms schema generate` CLI command:**

A new `generate` subcommand of `cms schema`. It:
1. Loads the schema from `options.schema.dir` using `loadSchema` (Plan 005 U7)
2. Calls `generateSDK(collections)`
3. Writes to the SDK output path
4. Prints "SDK generated at cms/sdk/index.ts"

No migration is triggered — this is a type-only regeneration.

**Git commit convention:**

The setup guide (developer-facing documentation, out of scope for this plan's implementation but noted here) instructs:
- `cms/sdk/` is NOT in `.gitignore` — the file must be committed
- Committing `cms/sdk/index.ts` alongside `cms/collections/*.ts` changes in the same commit is the expected workflow
- CI can detect a stale SDK by comparing the schema hash in the file header comment against a freshly-computed hash. A future `cms schema check-sdk` command can enforce this as a CI gate (deferred to follow-up)

**Test scenarios:**
- After a schema change in the dev watcher, `cms/sdk/index.ts` is written within 500ms (benchmark with a 30-collection schema)
- `cms schema generate` with a valid schema writes the SDK file to the correct path
- `cms schema generate` creates the `cms/sdk/` directory if it does not exist
- `cms schema generate` with an invalid schema (missing relation target) throws and does not write a partial SDK file
- Dev watcher: after two consecutive schema changes, the SDK file reflects the second change (not the first)
- SDK output path is relative to `schema.dir`: if `schema.dir` is `/project/cms/collections`, SDK path is `/project/cms/sdk/index.ts`

**Verification:** Integration test: start the dev watcher, write a collection file, assert `cms/sdk/index.ts` is written and contains the expected type. Run `cms schema generate` in a temp project, assert file created at correct path.

---

### U6. buildQuery Typed Helper

**Goal:** Implement `buildQuery<T>(params: QueryParams<T>): string` and include it in the generated SDK output. The function uses `qs.stringify` internally. `QueryParams<T>` is typed to the specific collection's field names — `filters.title.$contains` is typed as `string` (not `unknown`). Re-export `qs` from the SDK for callers who need custom stringification.

**Requirements:**
- `QueryParams<T>` generic type uses `T` to constrain filter keys to `keyof T` — passing a field name not on the collection is a TypeScript error
- Filter operators (`$eq`, `$contains`, `$startsWith`, `$in`, `$gt`, `$lt`, `$gte`, `$lte`, `$null`) are typed per field type — `$contains` is valid on `string` fields, not on `number` fields
- `buildQuery` accepts `filters`, `sort`, `pagination`, `populate`, and `fields` parameters
- The returned string is the full query string including the leading `?` (or without, configurable by option)
- `buildQuery` is exported from the generated SDK file (static function body, not per-collection)
- `qs` is re-exported as a named export from the SDK so callers can use `qs.stringify` directly for edge cases

**Dependencies:** U4 (SDK generator — buildQuery body is emitted by generateSDK as a static block).

**Files:**
- `packages/schema/src/sdk-generator.ts` — MODIFIED: emit `buildQuery` function and `QueryParams` generic type in the generated output
- `packages/schema/__tests__/sdk-generator.test.ts` — extend with `buildQuery` type-checking tests

**Approach:**

`buildQuery<T>` is a static function whose **body** is emitted into the SDK file by `generateSDK`. The function itself is not in `packages/schema/src/` at runtime — it lives in the generated `cms/sdk/index.ts` in the developer's project.

**`QueryParams<T>` type structure** (emitted as part of the SDK's static helper types):

```ts
// directional — not final type
type FilterOperators<V> =
  V extends string  ? { $eq?: V; $ne?: V; $contains?: string; $startsWith?: string; $endsWith?: string; $in?: V[]; $null?: boolean } :
  V extends number  ? { $eq?: V; $ne?: V; $gt?: V; $gte?: V; $lt?: V; $lte?: V; $in?: V[]; $null?: boolean } :
  V extends boolean ? { $eq?: V; $null?: boolean } :
  V extends Date    ? { $gt?: Date; $gte?: Date; $lt?: Date; $lte?: Date; $null?: boolean } :
  never

type DeepFilters<T> = {
  [K in keyof T]?: T[K] extends object ? DeepFilters<T[K]> : FilterOperators<T[K]>
}

type QueryParams<T> = {
  filters?:    DeepFilters<T>
  sort?:       `${string & keyof T}:${'asc' | 'desc'}` | Array<`${string & keyof T}:${'asc' | 'desc'}`>
  pagination?: { page?: number; pageSize?: number } | { cursor?: string; limit?: number }
  populate?:   Array<string & keyof T> | '*'
  fields?:     Array<string & keyof T>
  locale?:     string
}
```

**`buildQuery<T>` function body** (emitted into SDK as a static block):

```ts
// directional — not final implementation
export function buildQuery<T>(params: QueryParams<T>): string {
  return '?' + qs.stringify(params, { encodeValuesOnly: true, allowDots: false })
}
```

The function is generic at the TypeScript level (type checking happens at the call site) but the runtime body is trivially thin — just `qs.stringify`. The TypeScript generics ensure that:
- `buildQuery<Article>({ filters: { title: { $contains: 'hello' } } })` compiles
- `buildQuery<Article>({ filters: { nonExistentField: { $eq: 'x' } } })` is a TypeScript error
- `buildQuery<Article>({ sort: 'title:asc' })` compiles; `buildQuery<Article>({ sort: 'badField:asc' })` is a TypeScript error

**`qs` re-export:** The SDK emits `export { qs } from 'qs'` (or a re-export from the bundled qs — depending on whether the SDK is bundled or a plain `.ts` file). In practice, the generated SDK file imports `qs` at the top and re-exports it. The developer's project must have `qs` as a dependency, which the CMS setup guide instructs.

**Test scenarios:**
- TypeScript: `buildQuery<Article>({ filters: { title: { $contains: 'hello' } } })` — compiles without error
- TypeScript: `buildQuery<Article>({ filters: { nonExistentField: { $eq: 'x' } } })` — TypeScript error on `nonExistentField`
- TypeScript: `buildQuery<Article>({ filters: { title: { $gt: 5 } } })` — TypeScript error (`$gt` not valid on string fields)
- TypeScript: `buildQuery<Article>({ sort: 'title:asc' })` — compiles
- TypeScript: `buildQuery<Article>({ sort: 'badField:asc' })` — TypeScript error
- Runtime: `buildQuery<Article>({ filters: { title: { $contains: 'hello' } }, pagination: { page: 1, pageSize: 10 } })` returns a `?filters[title][$contains]=hello&pagination[page]=1&pagination[pageSize]=10` string (qs bracket encoding)
- Runtime: `buildQuery<Article>({ populate: ['author', 'tags'] })` returns `?populate[0]=author&populate[1]=tags` or similar qs array encoding
- `qs` is importable from the generated SDK: `import { qs } from './cms/sdk'` resolves without error

**Verification:** TypeScript compiler rejects the invalid-field and invalid-operator cases. `buildQuery` returns a parseable query string that the CMS route handler's `qs.parse` reconstructs correctly (round-trip test: `qs.parse(buildQuery<Article>(...).slice(1))` deep-equals the input params).

---

### U7. Relation API Edge Cases

**Goal:** Cover the edge cases that arise from the interaction of the relation system with deletion semantics, RBAC field permissions, and draft/publish filtering. Ensure these are explicitly handled in the route factory and documented with test coverage — not discovered at runtime.

**Requirements:**
- `DELETE /api/articles/:id` behavior is determined by `onDelete` on each relation that references `articles`:
  - `restrict`: delete is rejected with `409 Conflict` if any related records exist (DB-level FK constraint, propagated as a typed error response)
  - `cascade`: related records in the target table are deleted (or join rows removed for many-to-many)
  - `set_null`: the FK column on the related table is set to `NULL` (requires the FK column to be nullable in the Drizzle schema — enforced by type validation: `onDelete: 'set_null'` is only valid when `required: false` on the owning side)
- Many-to-many delete: deleting a record removes its join table rows; the join table `onDelete: 'cascade'` on the FK references handles this at the DB level automatically
- `fieldPermissions` applied to populated relations: if role `editor` cannot see `articles._internalNotes`, then `GET /api/authors?populate=articles` for an editor must also strip `_internalNotes` from every article in the populated array
- Draft/publish filter on populated relations: when populating a `draftAndPublish` collection from a public (unauthenticated) request, only `status: 'published'` items appear in the populated array; admin requests see all statuses

**Dependencies:** U2 (onDelete option in Drizzle FK generation), U3 (populate query execution + RBAC strip), Plan 006 U3 (checkPermission, stripForbiddenFields), Plan 016 (draft filter).

**Files:**
- `packages/core/src/content/route-factory.ts` — MODIFIED: handle FK constraint errors on delete; apply fieldPermissions to populated sub-objects
- `packages/core/src/content/populate.ts` — MODIFIED: apply draft filter to populated arrays
- `packages/core/src/content/__tests__/populate.test.ts` — MODIFIED: add edge-case test scenarios
- `packages/core/src/content/__tests__/route-factory-relations.test.ts` — NEW: delete behavior, cascade, restrict, set_null

**Approach:**

**Delete FK constraint handling:**

The route factory's `DELETE /:id` handler wraps the adapter delete call in a `try/catch`. When the DB throws a FK constraint violation (SQLite: `SQLITE_CONSTRAINT_FOREIGNKEY`, Postgres: error code `23503`), the handler catches the error and returns `409 Conflict` with:

```json
{
  "error": "RELATION_CONSTRAINT",
  "message": "Cannot delete this record: related records exist in 'articles'. Set onDelete: 'cascade' on the relation to allow deletion.",
  "relatedCollection": "articles"
}
```

This is an application-level translation of the DB error — callers do not receive raw SQLite/Postgres error text. The `restrict` behavior is the DB default when `onDelete` is not specified, so no special Drizzle-level configuration is needed — FK violations propagate naturally.

**Many-to-many delete:** `DELETE /api/articles/:id` when `articles` has a many-to-many relation with `tags`. The join table has `onDelete: 'cascade'` on the `article_id` FK (generated by U2). Deleting the article automatically removes all `articles_tags` rows for that article at the DB level. No application-level join table cleanup is required. The `tags` records themselves are not deleted.

**`onDelete: 'set_null'` validation:** At schema definition time (Plan 005 U2 `defineCollection`), add a validation: if a relation field has `onDelete: 'set_null'`, it must also have `required: false` (or no `required` key). If `required: true` and `onDelete: 'set_null'` are both set, throw `DefinitionError` with code `'INCOMPATIBLE_RELATION_OPTIONS'`. This prevents a NOT NULL FK column from having a set_null behavior that would create a constraint conflict at DB level.

**`fieldPermissions` on populated relations:**

The existing `stripForbiddenFields(data, collection, role)` from Plan 006 is already applied to top-level query results. For populated sub-objects, it must be applied recursively.

After `buildWithClause` executes the Drizzle relational query, the route handler iterates the populated fields in the result. For each populated sub-object or array:
1. Identify the related collection definition from the schema cache
2. Call `stripForbiddenFields(subObject, relatedCollection, ctx.role)` on each item
3. Return the stripped result

This is called once per populated relation per result item — for `findMany` returning 20 articles each with an `author`, this means 20 `stripForbiddenFields` calls. Each call is O(fields) — negligible for typical field counts.

**Draft filter on populated collections:**

After the Drizzle relational query returns, for each populated field that is a one-to-many or many-to-many relation to a collection with `draftAndPublish: true`:
1. If the request role is not `admin` (i.e., the public or authenticated filter applies)
2. Filter the populated array: `items.filter(item => item.status === 'published')`

This is a post-query filter — it does not modify the SQL query. For v1, this is acceptable given typical relation array sizes. The follow-up plan (nested relation filter via Drizzle `where` on `with`) will move this to the DB level for performance.

**Test scenarios:**
- `DELETE /api/articles/id` where an `authors` collection has `onDelete: 'restrict'` on its `articles` relation — response is `409 Conflict` with `RELATION_CONSTRAINT` error body; article record is NOT deleted
- `DELETE /api/articles/id` where `onDelete: 'cascade'` — article and related child records are deleted; response is `204 No Content`
- `DELETE /api/tags/id` where `articles` has a many-to-many relation with `tags` via `onDelete: 'cascade'` on join table — `articles_tags` rows for that tag are removed; article records themselves are untouched
- `onDelete: 'set_null'` + `required: true` in `defineCollection` — throws `DefinitionError` with code `'INCOMPATIBLE_RELATION_OPTIONS'`
- `GET /api/authors?populate=articles` as an `editor` role where `articles._internalNotes` has `fieldPermissions: ['admin']` — response articles in the `articles` array do not contain `_internalNotes`
- `GET /api/authors?populate=articles` as an `admin` role — response articles include `_internalNotes`
- `GET /api/authors/1?populate=articles` for a public (unauthenticated) request, with `articles` having `draftAndPublish: true` — only `status: 'published'` articles appear in the `articles` array; draft articles are filtered out
- `GET /api/authors/1?populate=articles` for an `admin` request — all articles (draft and published) appear in the populated array
- `GET /api/articles?populate=tags` where `tags` does not have `draftAndPublish: true` — all tags appear (no draft filter applied)
- DB-level cascade: delete an article with two tags (via join table with `onDelete: 'cascade'`) — verify via a subsequent DB query that `articles_tags` rows are gone but `tags` table rows remain

**Verification:** Integration tests run against a real SQLite test DB with seeded relation data. Each delete scenario verified by querying the DB after the delete request. RBAC field stripping on populated sub-objects verified by inspecting the API response JSON.

---

## Dependency Graph

```
U1 (RelationFieldDefinition type)
 │
 ├─► U2 (Drizzle FK + join table + relations() generation)
 │     │
 │     └─► U3 (Populate query execution)
 │           │
 │           └─► U7 (Edge cases: delete behavior, RBAC on populate, draft filter)
 │
 └─► U4 (generateSDK)
       │
       ├─► U5 (Dev mode trigger)
       └─► U6 (buildQuery typed helper — emitted by U4)
```

U2 and U4 can be worked in parallel after U1 is complete. U3 depends on U2 (the `relations()` helpers must exist for `db.query.*` to be available). U7 depends on U3 (populate infrastructure) and Plan 006 RBAC (stripForbiddenFields). U5 depends on U4. U6 is part of U4's output — the `buildQuery` function is emitted by `generateSDK`.

---

## Risk Analysis

### R1: Drizzle relational query API stability across dialects

The Drizzle `relations()` API and `db.query.*` relational query surface are marked stable in Drizzle ORM v0.30+. However, behavior differences exist between the SQLite core and PostgreSQL adapters for complex nested `with` clauses (particularly around nullable FK columns and left vs. inner join semantics). Mitigation: the integration tests for U3 must run against both SQLite (via `better-sqlite3`) and Postgres (via a test Postgres container in CI). If dialect-specific behavior is discovered, it is isolated in the adapter packages (per Plan 003's adapter interface), not in this plan's populate logic.

### R2: SDK type drift between generation and consumption

If a developer modifies `cms/sdk/index.ts` manually (forgetting the auto-generated warning) or runs the dev server after changing collection files without regenerating the SDK, the SDK types diverge from the schema. Mitigation: the schema hash in the SDK file header enables a future `cms schema check-sdk` CI gate. For v1, the dev watcher's immediate regeneration on schema change minimizes the window of drift. The file header comment `// AUTO-GENERATED — do not edit manually` is the primary developer-facing guard.

### R3: Circular relation populate causing depth-limit bypass via multiple code paths

If the depth limit is only enforced in `buildWithClause` but not in `parsePopulate`, a caller could construct a query with manually crafted bracket syntax that bypasses the `parsePopulate` normalization and reaches `buildWithClause` at the wrong depth. Mitigation: enforce depth in both places — `parsePopulate` assigns and enforces the depth ceiling; `buildWithClause` enforces it independently as a hard stop. The tests in U3 must cover the case where deeply nested bracket syntax is passed directly.

### R4: `fieldPermissions` on populated relations causing N+1 stripForbiddenFields calls

For a `findMany` returning 100 articles each populated with an `author`, the route handler calls `stripForbiddenFields` 100 times. `stripForbiddenFields` is O(fields) — for a 20-field author collection, this is 2,000 field iterations per request. This is acceptable for v1. If profiling shows this is a bottleneck, the optimization is to pre-compute a "allowed fields mask" for the role+collection combination once per request and apply it as a bulk `pick` on the array — deferred to follow-up.

### R5: `buildQuery` TypeScript generic inference with complex filter shapes

The `DeepFilters<T>` type uses conditional types and mapped types that can produce expensive TypeScript inference for deeply nested filter shapes. For a collection with 20 fields, `tsc` inference on `buildQuery<Article>({ filters: { ... } })` must remain fast. Mitigation: keep `DeepFilters<T>` at one level of depth for v1 (top-level field filters only). Nested relation filters (`filters[author][name][$contains]=...`) are parsed by `qs` correctly at runtime but are not typed by `DeepFilters<T>` in v1 — the nested relation filter type support is deferred to the follow-up nested filter plan.

---

## Alternative Approaches Considered

### Alternative: Runtime type generation via Hono RPC `typeof app`

`hc<typeof app>` gives zero-codegen end-to-end types when the consumer imports the Hono app directly. Rejected for three reasons documented in Key Technical Decision #1: (1) the route factory generates routes from a runtime collection array, defeating `typeof` inference; (2) consumers in separate repos cannot import the Hono app instance; (3) the generated `.ts` file approach gives type stability across CI without the dev server running.

### Alternative: Prisma-style auto-generated client (runtime fetch with types)

Generate a full client package (not just types) that wraps `fetch` calls to the CMS API. Rejected for v1 because it would require either publishing to npm (operational overhead) or monorepo-local linking (friction for projects not using workspaces). The generated `index.ts` file is simpler: the developer imports the types and uses their own `fetch` or any HTTP client. A bundled client generator is a follow-up for v2.

### Alternative: Manual JOIN queries instead of Drizzle relational queries

Building `db.select().from(articles).leftJoin(authors, eq(articles.authorId, authors.id))` manually in the route factory is more explicit but requires the factory to know the join conditions at code-generation time, handle many-to-many with two joins (articles → articles_tags → tags), and produce type-safe results. Drizzle's relational query API handles all of this correctly with less code and better types. Rejected: Drizzle's `relations()` + `db.query.*` is the correct tool for this use case, explicitly designed for it.

### Alternative: Depth limit via query complexity scoring (instead of fixed depth)

Assign each relation a "cost" and reject queries exceeding a total complexity budget (similar to GraphQL complexity analysis). More flexible than a fixed depth limit but significantly more complex to implement and explain to developers. The fixed depth of 3 covers all practical use cases and is a one-line constant. Complexity scoring is a follow-up enhancement for high-traffic deployments.

---

## Phased Delivery

**Phase 1 — Type foundation (U1):** Add `RelationFieldDefinition` to the type system. No runtime behavior change — pure type extension. Unblocks all other units.

**Phase 2 — Schema generation (U2):** Extend `generateDrizzleSchema` with FK columns, join tables, and `relations()` helper. Can be snapshot-tested before any runtime infrastructure is in place. Dev auto-migration (Plan 005 U4) picks up the updated generator automatically — relation FK columns and join tables start appearing in auto-migrations.

**Phase 3 — SDK generator (U4 + U6):** Implement `generateSDK`. Can be unit-tested in isolation with fixture `CollectionDefinition[]` objects. `buildQuery<T>` is part of the generated output (U6 is developed alongside U4). Does not require U2 to be complete — the generator works from the `CollectionDefinition` type definition alone.

**Phase 4 — Populate query (U3):** Implement populate parsing and Drizzle relational query execution in the route factory. Requires U2 to be complete (the `relations()` helpers must be generated and applied to the dev DB before `db.query.*` is available). This is the gate that must be passed before integration testing of populate behavior.

**Phase 5 — SDK trigger (U5) + Edge cases (U7):** Wire SDK generation into the dev watcher. Implement the delete constraint handling and RBAC/draft-filter interactions on populated results. U5 is straightforward after U4; U7 requires U3 and is integration-tested against a multi-collection test DB.

---

## System-Wide Impact

**Packages modified by this plan:**
- `packages/schema` — new `sdk-generator.ts`; modified `drizzle-generator.ts` and `types/fields.ts`
- `packages/core` — new `populate.ts`; modified `route-factory.ts`
- `packages/cli` — modified `commands/schema.ts`

**Downstream consumers affected:**
- **Admin SPA (Plan 007):** CT Builder field editor gains a `Relation` field type. The relation picker UI (select target collection, select cardinality) writes a `RelationFieldDefinition` to the collection file. The CT Builder calls `cms schema generate` (or the generate API endpoint) after saving a relation field to trigger SDK regeneration.
- **Plan 006 (Content API / RBAC):** Route factory is modified in place — populate logic is injected into the existing `findMany` and `findOne` handlers. No API contract change for callers that do not pass `?populate`.
- **Plan 016 (Draft/Publish):** The draft filter already applied at the top-level route handler is now also applied to populated relation arrays. No API contract change for non-populate requests.
- **Plan 005 (Schema System):** The dev watcher callback is extended to call `generateSDK` after successful migrations. No change to the migration or schema compilation behavior.
- **Developer projects:** `cms/sdk/index.ts` appears in the developer's project as a new committed file after the first dev server run that encounters this plan's code.

**Breaking changes:** None for existing Plan 006 API consumers — populate is additive. The Drizzle schema generator output changes (new FK columns and join tables) will trigger new auto-migrations in dev for any existing dev DB that has collections with relation fields defined. This is expected and correct behavior.

---

## Deferred Implementation Notes

- **Nested relation filter typing in `DeepFilters<T>`:** `buildQuery<Article>({ filters: { author: { name: { $contains: 'John' } } } })` is not type-checked by `DeepFilters<T>` in v1 (it parses correctly at runtime via `qs`). Typed nested relation filters require `DeepFilters` to recurse through relation field types, which requires the SDK generator to emit the related collection's field types as nested filter shapes. Deferred — the runtime behavior is correct; the type narrowing is the gap.
- **Drizzle `where` on `with` clauses for draft/publish filtering on populated relations:** Currently handled as post-query array filtering (U3). Moving to a Drizzle-native `where` in the relational query (`.findMany({ with: { articles: { where: eq(articles.status, 'published') } } })`) is more efficient for large relation arrays. Deferred to the nested filter follow-up plan.
- **Self-referential many-to-many relations** (e.g., a `categories` collection with a `relatedCategories` many-to-many to itself): the join table name would be `categories_categories`. The generator must handle this case — a collection can be both sides of a many-to-many with itself. Deferred pending explicit test coverage and schema validation.
- **SDK compilation check in CI** (`cms schema check-sdk`): a command that re-generates the SDK from the current schema and compares the hash in the file header against the freshly-computed hash, failing CI if they differ. Deferred to follow-up.
- **`ArticlePopulated` as generic overload on `findOne`/`findMany`:** `findOne<P extends boolean = false>(id, params, populated?: P): Promise<P extends true ? ArticlePopulated : Article>` — the v2 typed populate overload that makes the populated/unpopulated distinction type-safe without an explicit cast. Deferred: requires TypeScript conditional return types on the `CMSClient` methods, which adds complexity to the SDK generator. The explicit `ArticlePopulated` cast covers v1.
