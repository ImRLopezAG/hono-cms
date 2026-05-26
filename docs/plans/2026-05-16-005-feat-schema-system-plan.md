---
title: "feat: Schema System — defineCollection, Drizzle Generation, Dev/Prod Migration Lifecycle"
date: 2026-05-16
type: feat
status: active
depth: deep
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
ideation-ideas: ["#3 UI-Generated Schema with Auto-Migration in Dev + Plan/Apply CLI in Prod"]
---

# feat: Schema System — defineCollection, Drizzle Generation, Dev/Prod Migration Lifecycle

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 2
**Research inputs used:** skill review, architecture review, performance review

### Key Improvements

1. Promote schema output to the single source for docs, SDKs, and admin metadata.
2. Add safer watcher, diff, and rollout expectations.
3. Make stable field identity and explicit indexing part of the plan.

## Summary

This plan implements `packages/schema` → `@hono-cms/schema`, the foundational package of the entire `@hono-cms` monorepo. The schema system is the IaC core of the product: TypeScript collection definitions are the single source of truth for database structure, API shape, validation rules, permission declarations, and Drizzle migrations. Every other package in the monorepo (`@hono-cms/core`, `@hono-cms/cli`, the adapter packages, and the admin SPA) imports from `@hono-cms/schema` — it has no upstream dependencies within the monorepo.

The work covers seven implementation units: the TypeScript field-definition type system and Zod derivation (U1), the `defineCollection` runtime function with validation (U2), the Drizzle table generator that produces Drizzle schema code from collection definitions (U3), dev-mode file watching and auto-migration (U4), prod-mode plan/apply/check service (U5), the schema file writer that generates TypeScript collection files from definitions (U6), and schema compilation and in-memory caching (U7).

**Problem frame:** Strapi's schema system (JSON files compiled at boot, CT Builder locked to dev mode, migrations require full redeploys) is the primary architectural limitation preventing safe, reviewable, IaC-style content schema management. This plan delivers the replacement: UI-generated TypeScript files committed to git, drizzle-kit-powered migrations in dev, and a human-readable plan/apply CLI in prod. (see origin: `docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md`, Idea #3)

---

## Scope Boundaries

### In scope
- `packages/schema/` package scaffolding, build configuration, and exports
- All 20 field types: `string`, `text`, `richtext`, `integer`, `float`, `boolean`, `datetime`, `date`, `time`, `json`, `email`, `url`, `password`, `uid`, `enumeration`, `media`, `relation`, `component`, `dynamiczone`
- `defineCollection` function with runtime validation and system-field injection
- `generateDrizzleSchema` function producing Drizzle column declarations per field type
- Join table generation for `many-to-many` relations
- Dev-mode file watcher triggering `drizzle-kit generate` + `drizzle-kit migrate`
- Prod-mode `cmsSchemaService.plan`, `.apply`, and `.check` functions
- `generateCollectionFile` — idempotent TypeScript source writer for collection files
- In-memory schema cache with dev-mode invalidation
- Zod schema derivation from field definitions (for API validation)
- System-field injection (`id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, plus conditional `publishedAt`, `status`, `locale`)
- CUID2 as the canonical ID strategy

### Deferred to Follow-Up Work
- `@hono-cms/adapter-*` packages — U3 generates Drizzle schema code targeting the sqlite-core dialect by default; adapters will parameterize dialect in a follow-up plan
- SDK type generation (auto-generated typed client — Idea #11) — depends on U1 types but is planned separately in Plan 011
- GraphQL schema derivation from collection definitions — planned separately in Plan 009
- OpenAPI spec generation from collection definitions — planned separately in Plan 018
- The `cms deploy` infrastructure provisioning command — planned separately in Plan 007
- Content seeding (`cms seed`) — deferred to post-v1

### Outside this product's identity
- Any runtime-specific migration shim (Cloudflare D1 migration API differences are an adapter concern)
- Visual schema diff tooling (PR-integrated ERD rendering)
- Schema versioning beyond git (no lock files, no separate version registry)

---

## Key Technical Decisions

### 1. TypeScript field definitions over JSON schema (like Strapi)

Strapi stores content types as JSON objects in `src/api/<name>/content-types/<name>/schema.json`. JSON is readable but not type-safe: a mistyped `"type": "strinng"` is a runtime error discovered at boot. TypeScript field definitions catch the error at build time in the admin UI (when the CT Builder writes the file), in the developer's editor immediately, and in CI on type-check.

More importantly, TypeScript objects are the native representation for Drizzle, Zod, and Hono RPC. Converting JSON → TypeScript at runtime (what Strapi does) adds a compilation layer that the new CMS eliminates entirely. The collection file *is* the schema — no compilation step between what the admin UI writes and what the CMS reads.

Generated collection files are human-readable committed TypeScript — they can be diffed, reviewed, and reverted in PRs exactly like handwritten code. The "generated but readable" pattern is proven by Prisma (`schema.prisma`), Drizzle Kit (`drizzle.config.ts`), and Convex (`convex/schema.ts`).

### 2. Handling breaking migrations in the plan/apply flow

Breaking changes (column drops, column renames, type changes on populated columns) cannot be handled automatically without risking data loss. The plan/apply model addresses this explicitly:

- **`plan`** detects breaking actions and marks them with `breaking: true` in the `SchemaPlan` object
- **`apply`** refuses to execute breaking actions unless `--force` is passed explicitly
- **Human-readable plan output** uses clear language: "Drop column `salary` from `employees` — BREAKING: this permanently removes data" rather than raw `ALTER TABLE DROP COLUMN`
- **Rename detection**: the plan heuristic treats a simultaneous `drop_column` + `add_column` of the same type as a probable rename and surfaces it as `rename_column` (breaking, interactive) rather than two separate operations. The human must confirm the intent
- **Column type changes**: treated as breaking unless the change is provably safe (e.g., `varchar(255)` → `text`, which is a no-op in most SQL dialects). Widening is safe; narrowing and type changes are breaking

This means developers who need to rename a field go through: `cms schema plan` → review the rename detection → `cms schema apply --force` → commit both the updated collection file and the generated migration. This is the correct behavior — it makes destructive actions explicit and auditable.

### 3. Auto-generated files that are human-readable and committable

The collection file generator (U6) produces idempotent output: the same `CollectionDefinition` object always produces the same TypeScript source. This is achieved by:

- Sorting fields in a canonical order (system fields excluded; user fields alphabetically sorted by key)
- Using a deterministic AST-to-string approach (not a template with dynamic concatenation)
- Formatting with Prettier before writing (so the file matches the project's code style)
- Emitting minimal imports (only `defineCollection` from `@hono-cms/schema`; Zod is not imported directly in the collection file — Zod derivation happens inside `defineCollection` at runtime)

Because the output is deterministic, running `generateCollectionFile` twice on the same definition produces identical bytes. This means the admin UI can safely overwrite a collection file without creating a spurious git diff when no changes were made.

Files are committed to git and owned by the developer's repository, not a CMS-internal directory. They appear in `git diff` on PRs. They can be viewed, understood, and discussed by developers who have never touched the CMS admin UI.

### 4. Drizzle schema generator and drizzle-kit integration

`drizzle-kit generate` requires a `drizzle.config.ts` that points to a schema file. The schema file exports Drizzle table objects. The integration works as follows:

1. `generateDrizzleSchema(collections)` produces TypeScript source code (a string) that exports Drizzle table objects for all collections. This string is written to a temp file (e.g., `node_modules/.cms/drizzle-schema.ts`) at startup and on every schema change.
2. `drizzle.config.ts` in the project root is generated by the CMS CLI and points `schema` at this temp file path. Developers do not write `drizzle.config.ts` manually — the CMS owns it.
3. `drizzle-kit generate` reads the schema from the temp file and produces SQL migration files in `db/migrations/`.
4. `drizzle-kit migrate` applies pending migrations.

Steps 3 and 4 are invoked via `child_process.exec` (or Bun's `Bun.spawn`) by the CMS dev watcher (U4). In prod, step 3 is invoked by `cms schema apply` (U5), which then computes the human-readable plan from the produced SQL before executing.

The temp schema file approach keeps `drizzle-kit` as an external CLI tool rather than requiring its internals to be imported. This is intentional — `drizzle-kit` internals are not a stable public API.

### 5. CUID2 vs UUID for generated IDs

CUID2 is chosen over UUID v4 for the following reasons:

- **Sortable by time of creation**: CUID2 IDs begin with a timestamp-derived prefix, making `ORDER BY id` a reasonable proxy for `ORDER BY createdAt` without a dedicated column index. This is a meaningful performance win for CMS list views.
- **URL-safe**: CUID2 uses lowercase alphanumeric characters only — no hyphens, no uppercase. Cleaner in REST URLs (`/api/articles/clx5...` vs `/api/articles/550e8400-e29b-...`).
- **Collision-resistant at edge scale**: CUID2 uses a counter + fingerprint + random component designed for distributed ID generation without coordination — exactly the model for a CMS running across multiple CF Worker instances.
- **Shorter**: 24 characters vs 36 characters for UUID v4 (with hyphens). Fits in `varchar(24)` vs `varchar(36)`.

UUID v4 is rejected because it is not time-sortable and produces URL-ugly strings. UUID v7 (time-sortable) is a reasonable alternative but `@paralleldrive/cuid2` is more established in the Hono/Drizzle ecosystem and has no external entropy dependency (unlike UUID v7's nanosecond timestamp requirement).

The `id` column is `varchar(24)` with a default value generated by `createId()` from `@paralleldrive/cuid2`, called in the Drizzle `$defaultFn`.

---

## High-Level Technical Design

## Research Insights

**Best Practices:**
- Preserve stable field identifiers independently from display labels so renames do not break data, relations, or generated types.
- Generate one canonical schema/contract output that other plans consume rather than rebuilding collection metadata independently.
- Keep migrations SQL-first and never allow runtime request-path auto-migration behavior in production.

**Performance Considerations:**
- Debounce watch-mode generation and write artifacts only when schema hashes change.
- Generate explicit indexes for list defaults, locale lookups, relation FKs, and join tables instead of assuming IDs sort well enough.

**Edge Cases:**
- Expand/contract rollout rules and backfill windows need to be part of migration safety, not just `--force` confirmation.
- Relation declarations need a registry pass or equivalent so cross-collection references are not sensitive to import order.

*This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Data flow: schema change in dev mode

```
Admin UI CT Builder
  │
  │ writes/updates
  ▼
cms/collections/articles.ts          ← committed TypeScript collection file
  │
  │ file-change event (Bun watcher)
  ▼
Schema Compiler (U7)
  │ imports file, calls defineCollection (U2)
  │ validates, injects system fields
  ▼
CollectionDefinition[]               ← in-memory compiled schema
  │
  ├─► generateDrizzleSchema (U3)     → writes node_modules/.cms/drizzle-schema.ts
  │       │
  │       │ drizzle-kit generate
  │       ▼
  │   db/migrations/NNNN_xxxx.sql
  │       │
  │       │ drizzle-kit migrate
  │       ▼
  │   Local dev DB (SQLite / Postgres)
  │
  ├─► Zod schema cache invalidated   → API validation uses new schemas
  ├─► Hono routes regenerated        → new/modified collection routes live
  └─► Admin forms rebuilt            → field list reflects new schema
```

### Data flow: prod schema change

```
Developer commits updated cms/collections/articles.ts
  │
  │ CI gate
  ▼
cms schema check --assert-clean      ← fails if DB != committed schema
  │
  │ passes in CI
  ▼
Developer runs locally:
  cms schema plan
  │
  │ cmsSchemaService.plan(collections, db)
  │ introspects live DB columns
  │ diffs against CollectionDefinition[]
  ▼
SchemaPlan {
  actions: [
    { type: 'add_column', collection: 'articles', field: 'publishedAt',
      columnType: 'timestamp', nullable: true, breaking: false }
  ]
}
  │ human-readable output printed to terminal
  │ developer reviews
  ▼
  cms schema apply
  │
  │ cmsSchemaService.apply(plan, db)
  │ generates SQL, executes against DB
  │ writes db/migrations/0002_add_published_at.sql
  ▼
Developer commits db/migrations/0002_add_published_at.sql
```

### Package dependency graph (within monorepo)

```
@hono-cms/schema          ← this plan (no monorepo deps)
        │
        ├── @hono-cms/core
        ├── @hono-cms/cli
        ├── @hono-cms/adapter-d1
        ├── @hono-cms/adapter-postgres
        ├── @hono-cms/adapter-turso
        └── apps/admin (admin SPA)
```

---

## Output Structure

```
packages/schema/
  package.json
  tsconfig.json
  build.config.ts              ← tsdown config
  vitest.config.ts
  src/
    index.ts                   ← package entry: re-exports all public API
    types/
      fields.ts                ← FieldDefinition discriminated union (all 20 types)
      collection.ts            ← CollectionDefinition, CMSSchema types
      system-fields.ts         ← SystemFieldKeys, system field shapes
      schema-plan.ts           ← SchemaPlan, SchemaAction types (prod plan/apply)
      zod-derivation.ts        ← fieldToZodSchema(), collectionToZodSchema()
    define-collection.ts       ← defineCollection() function
    drizzle-generator.ts       ← generateDrizzleSchema()
    dev-watcher.ts             ← startSchemaWatcher() for dev mode
    schema-service.ts          ← cmsSchemaService (plan / apply / check)
    file-writer.ts             ← generateCollectionFile()
    schema-compiler.ts         ← loadSchema(), SchemaCache
    constants.ts               ← RESERVED_FIELD_NAMES, SYSTEM_FIELD_KEYS
  __tests__/
    fields.test.ts
    define-collection.test.ts
    drizzle-generator.test.ts
    dev-watcher.test.ts
    schema-service.test.ts
    file-writer.test.ts
    schema-compiler.test.ts
```

---

## Implementation Units

### U1. FieldDefinition Type System

**Goal:** Define the complete TypeScript type system for all 20 field types, the `FieldDefinition` discriminated union, `CollectionDefinition`, and `CMSSchema`. Define how Zod validators are derived from field definitions. These types are the contract shared across every package in the monorepo.

**Requirements:** All field types listed in the design must be covered. The type system must make invalid configurations a TypeScript error (e.g., `max` on an `integer` field). Zod derivation must be deterministic and must match the runtime field constraints.

**Dependencies:** None.

**Files:**
- `packages/schema/src/types/fields.ts` — all FieldDefinition variants
- `packages/schema/src/types/collection.ts` — CollectionDefinition, CMSSchema, PermissionMatrix
- `packages/schema/src/types/system-fields.ts` — system field key constants and shapes
- `packages/schema/src/types/zod-derivation.ts` — `fieldToZodSchema`, `collectionToZodSchema`
- `packages/schema/src/constants.ts` — RESERVED_FIELD_NAMES, SYSTEM_FIELD_KEYS
- `packages/schema/__tests__/fields.test.ts`

**Approach:**

The `FieldDefinition` is a discriminated union on `type`. Each variant carries only the options that apply to that type — no shared optional bag. Examples of the discriminated shape (directional, not final signatures):

- `string`: `{ type: 'string'; required?: boolean; unique?: boolean; min?: number; max?: number; default?: string }`
- `text`: `{ type: 'text'; required?: boolean; max?: number }`
- `richtext`: `{ type: 'richtext'; required?: boolean }` — stored as `text` in DB; no length limit
- `integer`: `{ type: 'integer'; required?: boolean; min?: number; max?: number; default?: number }`
- `float`: `{ type: 'float'; required?: boolean; min?: number; max?: number }`
- `boolean`: `{ type: 'boolean'; required?: boolean; default?: boolean }`
- `datetime` / `date` / `time`: `{ type: 'datetime' | 'date' | 'time'; required?: boolean }`
- `json`: `{ type: 'json'; required?: boolean }`
- `email`: `{ type: 'email'; required?: boolean; unique?: boolean }`
- `url`: `{ type: 'url'; required?: boolean }`
- `password`: `{ type: 'password' }` — always required, always hashed; no `default`
- `uid`: `{ type: 'uid'; targetField: string }` — auto-generated slug from another field; `required` is always true
- `enumeration`: `{ type: 'enumeration'; values: [string, ...string[]]; required?: boolean; default?: string }`
- `media`: `{ type: 'media'; allowedTypes?: ('image' | 'video' | 'file')[]; multiple?: boolean }`
- `relation`: `{ type: 'relation'; target: string; cardinality: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many'; required?: boolean }`
- `component`: `{ type: 'component'; component: string; repeatable?: boolean; required?: boolean }` — references a named component definition
- `dynamiczone`: `{ type: 'dynamiczone'; components: string[] }` — polymorphic array of component references

`CollectionDefinition` wraps the field map with collection-level metadata:

```
{
  name: string                          — collection identifier (snake_case)
  draftAndPublish?: boolean
  localization?: boolean
  permissions: PermissionMatrix
  fieldPermissions?: Record<string, string[]>
  fields: Record<string, FieldDefinition>
  _systemFields: Record<string, FieldDefinition>  — injected by defineCollection, not user-set
}
```

`CMSSchema` is `CollectionDefinition[]`.

**Zod derivation (`fieldToZodSchema`):**

Maps each `FieldDefinition` variant to a Zod validator. The mapping is directional guidance:

| Field type | Zod schema |
|---|---|
| `string` | `z.string()` + `.min(n)` + `.max(n)` — chained only when options are set |
| `text` | `z.string()` + `.max(n)` if set |
| `richtext` | `z.string()` — content is plain string at API boundary |
| `integer` | `z.number().int()` + `.min(n)` + `.max(n)` if set |
| `float` | `z.number()` + `.min(n)` + `.max(n)` if set |
| `boolean` | `z.boolean()` |
| `datetime` | `z.string().datetime()` — ISO 8601 string at API boundary |
| `date` | `z.string().date()` |
| `time` | `z.string().time()` |
| `json` | `z.record(z.unknown())` |
| `email` | `z.string().email()` |
| `url` | `z.string().url()` |
| `password` | `z.string().min(8)` — validated as plain text on input; hashed before persistence |
| `uid` | `z.string().regex(/^[a-z0-9-]+$/)` — URL-slug format |
| `enumeration` | `z.enum([values[0], ...values.slice(1)])` |
| `media` | `z.string()` — ID reference to media record at API boundary |
| `relation` many-to-one / one-to-one | `z.string()` — CUID2 ID |
| `relation` one-to-many / many-to-many | `z.array(z.string())` |
| `component` (non-repeatable) | `z.object({...})` derived recursively from component's fields |
| `component` (repeatable) | `z.array(z.object({...}))` |
| `dynamiczone` | `z.array(z.discriminatedUnion('__component', [...]))` |

Fields with `required: false` or no `required` key are wrapped in `.optional()`. System fields are not included in the create/update Zod schemas (they are CMS-managed).

`collectionToZodSchema(collection)` returns `{ create: ZodObject, update: ZodObject }` — the create schema requires all required fields; the update schema makes all fields optional (partial update semantics).

**Test scenarios:**

- Given `{ type: 'string', required: true, max: 255 }`, `fieldToZodSchema` returns a Zod schema that passes `'hello'`, fails `''` (if `min` implicitly 1 for required), fails a 256-character string
- Given `{ type: 'string', required: false }`, schema wraps in `.optional()` — `undefined` passes, `null` fails
- Given `{ type: 'integer', min: 0, max: 100 }`, schema fails `-1`, fails `101`, fails `1.5`, passes `50`
- Given `{ type: 'float' }`, schema passes `1.5`, fails `'1.5'`
- Given `{ type: 'enumeration', values: ['draft', 'published'] }`, passes `'draft'`, fails `'archived'`
- Given `{ type: 'email' }`, passes `'a@b.com'`, fails `'notanemail'`
- Given `{ type: 'datetime' }`, passes `'2026-01-01T00:00:00Z'`, fails `'2026-01-01'`
- Given `{ type: 'relation', cardinality: 'many-to-many' }`, passes `['cuid1', 'cuid2']`, fails `'cuid1'` (not an array)
- Given `{ type: 'password' }`, passes `'Password1!'`, fails `'short'` (< 8 chars)
- `collectionToZodSchema` create schema: fails when a `required: true` field is missing
- `collectionToZodSchema` update schema: passes with only one field provided (all optional)
- TypeScript: attempting to set `max` on `{ type: 'integer' }` compiles — `min`/`max` are valid on integer. Attempting `{ type: 'boolean', max: 5 }` is a TypeScript error
- TypeScript: `enumeration` without `values` is a TypeScript error (at least one required)
- TypeScript: `relation` without `target` and `cardinality` is a TypeScript error

**Verification:** `tsc --noEmit` passes on the types file with no errors. All test scenarios pass in Vitest.

---

### U2. defineCollection Function

**Goal:** Implement the `defineCollection(input)` function that validates the collection definition at runtime, injects system fields, and returns a typed `CollectionDefinition` object. This function is called both by the admin UI (when generating a collection file) and by `createCMS` (when loading the compiled schema at startup).

**Requirements:** Must catch duplicate field names (between user fields and system field names), reserved field names (id, createdAt, etc.), invalid relation targets (forward references validated at compile time, not here — cross-collection validation happens in schema compiler U7), invalid enumeration values (empty array), invalid field name format (non-identifier characters). Must attach the correct system fields based on `draftAndPublish` and `localization` flags.

**Dependencies:** U1.

**Files:**
- `packages/schema/src/define-collection.ts`
- `packages/schema/src/constants.ts` (RESERVED_FIELD_NAMES, SYSTEM_FIELD_KEYS)
- `packages/schema/__tests__/define-collection.test.ts`

**Approach:**

`defineCollection` is a pure synchronous function — no I/O, no async. It:

1. Validates the collection `name` is a valid snake_case identifier matching `/^[a-z][a-z0-9_]*$/`
2. Validates each field name against `RESERVED_FIELD_NAMES` — throws `DefinitionError` if any user field matches a reserved name
3. Validates each field name is a valid identifier — throws `DefinitionError` for non-identifier characters
4. Validates field-type-specific constraints: `enumeration` must have at least one value; `uid.targetField` must reference an existing field in the same collection; `relation.target` is validated to be a non-empty string (cross-collection validation is deferred to the schema compiler)
5. Injects `_systemFields` based on flags:
   - Always: `id` (varchar 24, CUID2 default), `createdAt` (timestamp), `updatedAt` (timestamp), `createdBy` (varchar 24, FK to `users`), `updatedBy` (varchar 24, FK to `users`)
   - If `draftAndPublish: true`: `publishedAt` (timestamp, nullable), `status` ('draft' | 'published', default 'draft')
   - If `localization: true`: `locale` (varchar 10, default from CMS config)
6. Returns the validated `CollectionDefinition` with `_systemFields` attached

`RESERVED_FIELD_NAMES` constant: `['id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'publishedAt', 'status', 'locale', '__component', '__type']`

`DefinitionError` is a custom error class with a `code` field (e.g., `'RESERVED_FIELD_NAME'`, `'INVALID_FIELD_NAME'`, `'INVALID_COLLECTION_NAME'`, `'EMPTY_ENUM_VALUES'`, `'UNKNOWN_UID_TARGET'`) for programmatic handling in the admin UI.

**Test scenarios:**

- Happy path: `defineCollection({ name: 'articles', fields: { title: { type: 'string' } }, permissions: { public: { read: true } } })` returns a `CollectionDefinition` with `_systemFields` containing `id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`
- With `draftAndPublish: true`: `_systemFields` also contains `publishedAt` and `status`
- With `localization: true`: `_systemFields` also contains `locale`
- With both flags: all 9 system fields present
- Throws `DefinitionError` with code `'RESERVED_FIELD_NAME'` when a user field is named `id`
- Throws `DefinitionError` with code `'RESERVED_FIELD_NAME'` when a user field is named `createdAt`
- Throws `DefinitionError` with code `'INVALID_FIELD_NAME'` when a user field name contains a hyphen
- Throws `DefinitionError` with code `'INVALID_COLLECTION_NAME'` when `name` is `'My Articles'` (contains space)
- Throws `DefinitionError` with code `'EMPTY_ENUM_VALUES'` when `{ type: 'enumeration', values: [] }`
- Throws `DefinitionError` with code `'UNKNOWN_UID_TARGET'` when `uid.targetField` references a field not in the collection
- `fieldPermissions` referencing a field not in `fields` does not throw (field may be a system field) — validate this edge case
- The return value is structurally frozen (or at minimum not mutated by the caller — test that mutating the returned object's `fields` does not affect the internal state)
- TypeScript: the return type is `CollectionDefinition` — verify type inference works by calling `defineCollection` and checking that `result.name` is typed as `string`

**Verification:** All validation error cases produce the correct `DefinitionError` code. System field injection matches the flags. No I/O calls in the function.

---

### U3. Drizzle Table Generator

**Goal:** Implement `generateDrizzleSchema(collections: CollectionDefinition[]): string` — produces TypeScript source code that, when written to disk and imported by `drizzle-kit`, gives Drizzle a complete table schema for all collections. Maps each field type to the correct Drizzle column declaration. Generates join tables for `many-to-many` relations.

**Requirements:** Every field type must map to a correct Drizzle column. System fields must be included. Join tables must be generated with correct composite primary keys. The output must be valid TypeScript that imports from `drizzle-orm/sqlite-core` (default dialect; dialect parameterization is deferred to adapter packages). The output must be deterministic given the same input.

**Dependencies:** U1, U2.

**Files:**
- `packages/schema/src/drizzle-generator.ts`
- `packages/schema/__tests__/drizzle-generator.test.ts`

**Approach:**

`generateDrizzleSchema` builds a string of TypeScript source by iterating collections and their fields. It does not use a TS AST library — string building with well-tested snapshots is sufficient and avoids heavy dependencies. The generated file has this structure:

```
// AUTO-GENERATED — do not edit manually
// Generated by @hono-cms/schema on <timestamp>

import { sqliteTable, text, integer, real, blob, index, primaryKey } from 'drizzle-orm/sqlite-core'

export const articles = sqliteTable('articles', {
  id:         text('id', { length: 24 }).primaryKey().$defaultFn(() => createId()),
  title:      text('title', { length: 255 }).notNull(),
  body:       text('body'),
  ...
  createdAt:  integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:  integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// join table for articles ↔ tags (many-to-many)
export const articlesTags = sqliteTable('articles_tags', {
  articleId:  text('article_id').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  tagId:      text('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
}, (t) => ({ pk: primaryKey({ columns: [t.articleId, t.tagId] }) }))
```

**Field type → Drizzle column mapping** (sqlite-core dialect, directional):

| Field type | Drizzle column |
|---|---|
| `string` | `text('col', { length: max ?? 255 })` |
| `text` | `text('col')` |
| `richtext` | `text('col')` — stored as plain text or JSON string |
| `integer` | `integer('col')` |
| `float` | `real('col')` |
| `boolean` | `integer('col', { mode: 'boolean' })` |
| `datetime` | `integer('col', { mode: 'timestamp' })` |
| `date` | `text('col')` — stored as ISO date string `YYYY-MM-DD` |
| `time` | `text('col')` — stored as `HH:MM:SS` |
| `json` | `text('col', { mode: 'json' })` |
| `email` | `text('col', { length: 255 })` |
| `url` | `text('col', { length: 2048 })` |
| `password` | `text('col')` — hashed before insert; column is plain text |
| `uid` | `text('col', { length: 255 })` + unique index |
| `enumeration` | `text('col', { enum: values })` |
| `media` | `text('col_id', { length: 24 })` FK to `media.id` + `text('col_meta')` JSON sidecar for alt/dimensions |
| `relation` many-to-one | `text('col_id', { length: 24 })` FK to `target.id` |
| `relation` one-to-one | `text('col_id', { length: 24 })` FK + unique index |
| `relation` one-to-many | No column on this side — FK is on the target table (handled when generating the target) |
| `relation` many-to-many | No column on this table — generates a separate join table |
| `component` (non-repeatable) | `text('col', { mode: 'json' })` — component stored as inline JSON |
| `component` (repeatable) | `text('col', { mode: 'json' })` — array of component JSON |
| `dynamiczone` | `text('col', { mode: 'json' })` — array of `{ __component: string, ...fields }` JSON |

**System field columns** (always appended after user fields):
- `id`: `text('id', { length: 24 }).primaryKey().$defaultFn(() => createId())`
- `createdAt` / `updatedAt`: `integer('created_at', { mode: 'timestamp' }).notNull()`
- `createdBy` / `updatedBy`: `text('created_by', { length: 24 })` FK to `users.id`
- `publishedAt` (if draftAndPublish): `integer('published_at', { mode: 'timestamp' })`
- `status` (if draftAndPublish): `text('status', { enum: ['draft', 'published'] }).default('draft')`
- `locale` (if localization): `text('locale', { length: 10 })`

**Join table naming**: `{collectionA}_{collectionB}` where collection names are sorted alphabetically to ensure the join table name is deterministic regardless of which side declares the relation. The join table is generated once — the generator tracks which many-to-many pairs have already produced a join table to avoid duplicates.

**`required: true`** appends `.notNull()` to the column declaration.

**`unique: true`** appends `.unique()`.

**Default values** are appended as `.$defaultFn(() => value)` or `.default(value)` depending on whether the default is a function call (CUID2) or a literal.

The generator also produces the drizzle `relations` export for each table (used by Drizzle's relational query API — `cms.db.query.articles.findMany({ with: { author: true } })`).

**Test scenarios:**

- `string` field with `max: 255` generates `text('col', { length: 255 })`
- `string` field without `max` generates `text('col', { length: 255 })` (default)
- `integer` field generates `integer('col')`
- `float` field generates `real('col')`
- `boolean` field generates `integer('col', { mode: 'boolean' })`
- `datetime` field generates `integer('col', { mode: 'timestamp' })`
- `enumeration` field with `values: ['a', 'b']` generates `text('col', { enum: ['a', 'b'] })`
- `relation` many-to-one generates an FK column `text('author_id', { length: 24 })` on the source table
- `relation` many-to-many generates a separate join table with a composite primary key
- `relation` many-to-many between `articles` and `tags` generates table `articles_tags` — same name regardless of which collection declares the relation first
- Two collections each declaring a many-to-many to the same pair → join table generated exactly once
- Collection with `draftAndPublish: true` includes `published_at` and `status` columns
- Collection with `localization: true` includes `locale` column
- System field `id` is always first in the column list, `created_at` and `updated_at` are last
- Required field appends `.notNull()`; optional field does not
- Unique field appends `.unique()`
- The generated string is valid TypeScript — parse it with the TypeScript compiler (or Bun's `Bun.build`) in the test and assert no parse errors
- Snapshot test: a known collection definition produces a known stable string (use `toMatchSnapshot()`)
- `media` field generates two columns: `thumbnail_id` FK and `thumbnail_meta` JSON

**Verification:** Generated TypeScript source compiles without errors. Snapshot tests are stable across runs. Join table deduplication is confirmed by inspecting the generated string for duplicate `CREATE TABLE` statements.

---

### U4. Dev Mode Auto-Migration

**Goal:** Implement `startSchemaWatcher(options)` — a file watcher that runs in dev mode, detects changes to `cms/collections/*.ts` files, recompiles the schema, regenerates the Drizzle schema file, and triggers `drizzle-kit generate` + `drizzle-kit migrate` against the local dev DB. Migration must be idempotent: same schema content on re-save must not produce an empty migration file.

**Requirements:** Must debounce rapid successive saves (CT Builder may write multiple files in quick succession). Must handle migration failures gracefully (log the error, do not crash the CMS process). Must be no-op when the file content produces the same Drizzle schema as the current DB state. Must work with both Bun and Node.js runtimes in dev.

**Dependencies:** U1, U2, U3, U7.

**Files:**
- `packages/schema/src/dev-watcher.ts`
- `packages/schema/__tests__/dev-watcher.test.ts`

**Approach:**

The watcher uses Bun's native `fs.watch` API when running under Bun (zero-dependency, native inotify/FSEvents). Under Node.js, it falls back to the `chokidar` package. The runtime is detected by checking `typeof Bun !== 'undefined'`.

**Watcher lifecycle:**

1. On start, perform an initial schema compile + drizzle-kit run to ensure the DB is up-to-date with the committed collection files (handles the case where the developer pulled a branch with new collection files)
2. Watch `{schema.dir}/*.ts` for `add`, `change`, and `unlink` events
3. Debounce events with a 200ms window — multiple files changed in the same CT Builder operation are batched into one migration run
4. On trigger:
   a. Re-run schema compiler (U7) → updated `CollectionDefinition[]`
   b. Call `generateDrizzleSchema(collections)` → write to temp file
   c. Execute `drizzle-kit generate --config=<generated-config-path>` via `Bun.spawn` / `child_process.exec`
   d. Inspect the output: if `drizzle-kit generate` reports "No changes detected" or produces an empty migration, skip step (e)
   e. Execute `drizzle-kit migrate --config=<generated-config-path>`
   f. Invalidate the schema cache (U7) and notify `createCMS` listeners
5. On error (steps c–e fail), call the registered `onError` callback with the error details. The watcher continues running — the next file save retries.

**Idempotency mechanism**: `drizzle-kit generate` computes a hash of the current DB schema state and the new schema. If they match, it exits with "No changes" and writes no file. The watcher checks the stdout for this signal and skips `drizzle-kit migrate` accordingly. This is `drizzle-kit`'s built-in behavior — the watcher trusts it.

**Generated drizzle.config.ts content** (written to `node_modules/.cms/drizzle.config.ts`):

```
// directional — not final syntax
export default {
  schema: './node_modules/.cms/drizzle-schema.ts',
  out:    './db/migrations',
  dialect: 'sqlite',
  dbCredentials: { url: process.env.DATABASE_URL },
}
```

The config path is an option passed to `startSchemaWatcher` from `createCMS`.

**Test scenarios:**

- Watcher detects a new file in `cms/collections/` and triggers a migration run
- Watcher debounces: writing 3 files in 50ms results in exactly 1 migration run, not 3
- Re-saving the same file content (no change) does not trigger a drizzle-kit migrate call
- A schema validation error in the collection file (throws `DefinitionError`) calls `onError` and does not crash the watcher process
- A `drizzle-kit migrate` failure (e.g., schema constraint violation) calls `onError` with the stderr output and does not crash the watcher
- Deleting a collection file triggers a schema recompile (the collection is removed from the compiled schema)
- Watcher calls the registered `onSchemaChange` callback after a successful migration, with the updated `CollectionDefinition[]`
- The initial run at watcher start syncs the DB if a pending migration exists

**Note on testing the watcher:** Integration tests for the watcher use a temp directory with a real SQLite DB (via `better-sqlite3`) and real `drizzle-kit` invocations. Unit tests mock `Bun.spawn` / `child_process.exec` to test the debounce, error handling, and callback logic without file I/O.

**Verification:** Integration test: start watcher on a temp dir, write a collection file, assert migration ran (DB has the new column). Re-save same file, assert no new migration file created.

---

### U5. Prod Mode Plan/Apply/Check

**Goal:** Implement `cmsSchemaService` with three methods: `plan(collections, db)` → human-readable `SchemaPlan`; `apply(plan, db, options)` → executes the plan and writes the migration file; `check(collections, db)` → throws `SchemaDriftError` if the live DB has drifted from the committed schema (CI gate).

**Requirements:** `plan` must produce human-readable action descriptions, not raw SQL. `apply` must refuse breaking actions without `--force`. `check` must be deterministic and fast enough for CI (< 5 seconds on a 30-collection schema). Breaking action detection must cover: column drops, column renames (heuristic), column type narrowing, NOT NULL added to existing nullable column.

**Dependencies:** U1, U2, U3.

**Files:**
- `packages/schema/src/schema-service.ts`
- `packages/schema/src/types/schema-plan.ts` — `SchemaPlan`, `SchemaAction`, `SchemaDriftError`
- `packages/schema/__tests__/schema-service.test.ts`

**Approach:**

**`cmsSchemaService.plan(collections, db)`:**

1. Introspect the live DB schema using `drizzle-kit introspect` output (or direct SQLite `PRAGMA table_info(tableName)` / Postgres `information_schema.columns` queries via the Drizzle client)
2. Build a normalized representation of the current DB state: `{ [tableName]: { [columnName]: { type, nullable, default, unique } } }`
3. Generate the expected DB state from `collections` using `generateDrizzleSchema` and parsing the output (or calling a lower-level `collectionsToTableMap` helper that shares logic with U3 without the stringification step)
4. Diff the two maps, producing `SchemaAction[]`
5. Return `SchemaPlan { actions, breaking: boolean, summary: string }`

`SchemaAction` type variants (directional):
- `{ type: 'create_table', collection: string, breaking: false }`
- `{ type: 'drop_table', collection: string, breaking: true }`
- `{ type: 'add_column', collection: string, field: string, columnType: string, nullable: boolean, breaking: false }`
- `{ type: 'drop_column', collection: string, field: string, breaking: true }`
- `{ type: 'rename_column', collection: string, from: string, to: string, breaking: true }` — heuristic detection
- `{ type: 'modify_column', collection: string, field: string, change: string, breaking: boolean }` — breaking if narrowing or adding NOT NULL to existing column
- `{ type: 'create_join_table', tables: [string, string], breaking: false }`
- `{ type: 'drop_join_table', tables: [string, string], breaking: true }`

**Human-readable output format** (what `cms schema plan` prints to the terminal):

```
Schema Plan (2 actions, 0 breaking):

  ~ articles
    + Add optional column "publishedAt" (timestamp)           [safe]

  + Create table "newsletters"                                [safe]

No breaking changes. Run `cms schema apply` to apply.
```

Breaking output:

```
Schema Plan (1 action, 1 BREAKING):

  ~ employees
    - Drop column "salary" (real) — BREAKING: data will be permanently lost

BREAKING CHANGES DETECTED. Review carefully.
Run `cms schema apply --force` to apply (cannot be undone).
```

**`cmsSchemaService.apply(plan, db, opts)`:**

1. If `plan.breaking && !opts?.force`, throw `BreakingChangeError` with a message directing the user to `--force`
2. Translate each `SchemaAction` to SQL: `add_column` → `ALTER TABLE ADD COLUMN`, `create_table` → full `CREATE TABLE`, `drop_column` → `ALTER TABLE DROP COLUMN`, etc.
3. Execute each SQL statement against the DB in a transaction
4. Compute the migration file content (SQL statements with comments)
5. Write the migration to `db/migrations/<sequence>_<description>.sql` — sequence is zero-padded to 4 digits, description is kebab-cased from the action descriptions
6. Return `{ applied: number, migrationFile: string }`

**`cmsSchemaService.check(collections, db)`:**

Calls `plan(collections, db)` internally. If `plan.actions.length > 0`, throws `SchemaDriftError` with the plan summary as the error message. This makes CI output clear: the plan summary is the error, not a generic "schema drifted" message.

**Test scenarios:**

- `plan` with no changes returns `{ actions: [], breaking: false }` — "No changes"
- `plan` detecting a new column returns one `add_column` action with `breaking: false`
- `plan` detecting a missing column in the DB but present in the definition returns `add_column`
- `plan` detecting an extra column in the DB not in the definition returns `drop_column` with `breaking: true`
- `plan` detecting a simultaneous `drop + add` of the same type returns `rename_column` with `breaking: true`
- `plan` detecting a new collection returns `create_table`
- `plan` detecting a dropped collection returns `drop_table` with `breaking: true`
- `plan` detecting a new many-to-many relation returns `create_join_table`
- `apply` with breaking actions and no `--force` throws `BreakingChangeError`
- `apply` with breaking actions and `--force` executes and writes migration file
- `apply` with safe actions only executes without error; migration file is written to `db/migrations/`
- `apply` in a transaction: if the second SQL statement fails, the first is rolled back (DB state unchanged)
- `check` with no drift passes silently
- `check` with drift throws `SchemaDriftError` whose message contains the plan summary
- `plan` for `draftAndPublish` flip from false → true adds `publishedAt` and `status` columns
- `plan` for `localization` flip from false → true adds `locale` column
- Migration file naming: apply with an `add_column` action on `articles.publishedAt` writes `0002_add_articles_published_at.sql`

**Verification:** Integration tests run against a real SQLite DB using `better-sqlite3`. Apply + check cycle: apply a plan, then check → no drift. Modify the DB directly, then check → drift detected.

---

### U6. Schema File Writer

**Goal:** Implement `generateCollectionFile(collection: CollectionDefinition): string` — produces the TypeScript source string for a collection file. The output uses `defineCollection` and is idempotent (same `CollectionDefinition` → same string output). Used by the admin UI CT Builder to write/update collection files.

**Requirements:** Output must be valid TypeScript. Output must be deterministic (fields in canonical order). Output must be human-readable (not minified). Output should pass Prettier formatting. The function does not write to disk — it returns a string; the caller (admin UI or CLI) handles the write.

**Dependencies:** U1, U2.

**Files:**
- `packages/schema/src/file-writer.ts`
- `packages/schema/__tests__/file-writer.test.ts`

**Approach:**

The file writer builds the TypeScript source as a string using a small DSL helper (an `indent` utility and a `block` utility that handles nested objects). No external AST library. The generator:

1. Emits the file header comment (auto-generated warning, timestamp, generator version)
2. Emits `import { defineCollection } from '@hono-cms/schema'`
3. Emits `export const {name} = defineCollection({`
4. Emits `name:`, `draftAndPublish:`, `localization:` if truthy
5. Emits `permissions:` block — roles in canonical order (public, authenticated, editor, admin, then any custom roles alphabetically)
6. Emits `fieldPermissions:` block if present
7. Emits `fields:` block — fields in alphabetical order by key (excluding system fields, which are never emitted — they are re-injected by `defineCollection` at load time)
8. Closes the `defineCollection({})` call

**Canonical field order**: alphabetical by field name. This ensures that re-generating from the same definition produces the same ordering even if the admin UI builds the field map in insertion order.

**System fields are NOT emitted** — `_systemFields` is an internal CMS detail that `defineCollection` re-injects. The collection file only contains what the developer/admin UI specified.

**Field rendering** (each field is rendered as a minimal object literal with only the options that were specified — no `undefined` values):

```ts
// { type: 'string', required: true, max: 255 }  →
title: { type: 'string', required: true, max: 255 },

// { type: 'relation', target: 'authors', cardinality: 'many-to-one' }  →
author: { type: 'relation', target: 'authors', cardinality: 'many-to-one' },
```

**Idempotency**: guaranteed by canonical ordering + omitting `undefined` keys. The output is run through Prettier before being returned, using the project's Prettier config if one exists in the output directory, or the CMS's bundled default config (2-space indent, single quotes, no semicolons).

**Test scenarios:**

- A collection with fields `title` (string), `slug` (string, unique), `body` (richtext) produces a string containing `import { defineCollection } from '@hono-cms/schema'`
- The same collection run through `generateCollectionFile` twice produces identical strings (idempotency test)
- Fields are alphabetically ordered: `body`, `slug`, `title` — regardless of the input map order
- `draftAndPublish: true` appears in the output; `draftAndPublish: false` is omitted (falsy default)
- `_systemFields` does NOT appear in the output
- The output string can be parsed as valid TypeScript by the TS compiler (or Bun)
- A collection with `fieldPermissions` renders the `fieldPermissions` block
- A collection with `enumeration` renders the `values` array correctly
- A collection with `permissions: { public: { read: true }, admin: { read: true, create: true } }` renders permissions in canonical role order
- Optional fields (`required?: boolean`) are only rendered when `true` — `required: false` is omitted
- The output, when `eval`'d (or Bun `import`'d from a temp file), produces a `CollectionDefinition` that is deep-equal to the input (round-trip test)

**Verification:** Round-trip test: generate a file from a `CollectionDefinition`, write it to a temp file, `import` it dynamically, call `defineCollection` on the result, compare output to original definition. The generated file passes `tsc --noEmit`.

---

### U7. Schema Compilation and Caching

**Goal:** Implement `loadSchema(dir: string): Promise<CollectionDefinition[]>` and the `SchemaCache` singleton that `createCMS` uses at startup. The compiled schema is cached in memory and not reloaded per-request. In dev mode, the file watcher (U4) invalidates the cache and triggers recompilation. Provide TypeScript type inference so that `cms.db.query.articles.findMany` is correctly typed from the compiled schema.

**Requirements:** Schema loading must handle import errors gracefully (malformed collection file → `SchemaLoadError` with file path). Cross-collection validation must run at compile time (relation `target` must reference a collection in the schema). The schema must be available synchronously after the initial async load. Type inference for the compiled schema must work at TypeScript compile time (requires generic typing from the schema object, not runtime introspection).

**Dependencies:** U1, U2, U3.

**Files:**
- `packages/schema/src/schema-compiler.ts`
- `packages/schema/__tests__/schema-compiler.test.ts`

**Approach:**

**`loadSchema(dir)`:**

1. Reads all `*.ts` files in `dir` using `fs.readdir`
2. Dynamically imports each file using `await import(filePath)` — works under both Bun (native TS import) and Node.js (requires the Bun transpiler or ts-node/tsx in dev; in prod, files are pre-compiled by the CMS build step)
3. Extracts the default export or the first named export that is a `CollectionDefinition` (identified by the `__isCMSCollection: true` symbol marker attached by `defineCollection`)
4. Collects all `CollectionDefinition` objects into an array
5. Runs cross-collection validation: for each `relation` field, asserts that `field.target` references a `name` in the loaded collection array. Throws `SchemaLoadError` if a relation target is not found
6. Returns the validated `CollectionDefinition[]`

**`SchemaCache`:**

A singleton object wrapping the compiled schema:

```
{
  schema: CollectionDefinition[] | null
  load(dir): Promise<CollectionDefinition[]>  — loads and caches
  get(): CollectionDefinition[]               — returns cached (throws if not loaded)
  invalidate(): void                          — clears cache (called by dev watcher)
  onChange(fn): () => void                    — register listener, returns unsubscribe fn
}
```

`createCMS` calls `SchemaCache.load(options.schema.dir)` at startup. All subsequent operations call `SchemaCache.get()` synchronously.

**TypeScript type inference strategy:**

Full static type inference from a runtime-loaded schema is not possible in TypeScript without code generation. The approach for v1 is:

- `defineCollection` uses TypeScript generics to capture the field map type at call site: `defineCollection<F extends FieldMap>(input: CollectionInput<F>): CollectionDefinition<F>`
- The collection file exports a typed `CollectionDefinition<F>` object
- `createCMS` is called with the schema as a value: `schema: [articles, authors, tags]` — the generic type of the `createCMS` call captures the tuple type
- `createCMS` returns a `CMS<SchemaType>` where `SchemaType` is the inferred tuple
- `cms.db.query` is typed as `DrizzleSchema<SchemaType>` — a mapped type that projects each collection's field map to a Drizzle table type

This gives full type safety when the schema is imported and passed to `createCMS` inline. When the schema is loaded dynamically from disk (dev mode file watching), the types fall back to `CollectionDefinition` (unparameterized) — the trade-off is intentional and documented. The admin UI always operates via the dynamic schema; the typed path is for `createCMS` in user code.

**Cross-collection validation:**

- `relation` target must exist in the schema: `articles.author` → `target: 'authors'` → must find a collection with `name: 'authors'`
- `uid` target field must exist in the same collection (already validated in `defineCollection` U2)
- Circular `component` references: `defineCollection` allows components to reference each other; the compiler detects cycles and throws `SchemaLoadError` with cycle path

**`__isCMSCollection` marker:**

`defineCollection` attaches a non-enumerable symbol property to the returned object so that `loadSchema` can identify collection exports without relying on naming conventions:

```
const CMS_COLLECTION_SYMBOL = Symbol.for('@hono-cms/collection')
// defineCollection attaches: Object.defineProperty(result, CMS_COLLECTION_SYMBOL, { value: true })
```

**Test scenarios:**

- `loadSchema` with a directory containing two valid collection files returns two `CollectionDefinition` objects
- `loadSchema` with a collection file that throws during import wraps the error in `SchemaLoadError` with the file path
- `loadSchema` with a `relation` target that references a non-existent collection throws `SchemaLoadError` with a message naming the missing target
- `loadSchema` with two collections where A references B and B references A as components throws `SchemaLoadError` citing the cycle
- `SchemaCache.get()` before `load()` throws `Error` ("Schema not loaded")
- `SchemaCache.load()` populates the cache; subsequent `get()` returns the same array reference
- `SchemaCache.invalidate()` clears the cache; `get()` throws again after invalidation
- `SchemaCache.onChange()` listener is called after a successful `load()` with the new schema
- `SchemaCache.onChange()` unsubscribe function prevents further calls
- Loading a directory with 0 collection files returns an empty array (valid state for first run)
- Collection file with multiple exports: only exports marked with `CMS_COLLECTION_SYMBOL` are loaded; other exports are ignored

**Verification:** Integration test: write two collection files to a temp dir (one with a relation to the other), call `loadSchema`, assert both definitions are returned and the relation target is validated. Write a third file with an invalid relation target, assert `SchemaLoadError` is thrown.

---

## Risk Analysis

### R1: drizzle-kit CLI API stability

`drizzle-kit` is invoked as a CLI subprocess, not imported as a library. The CLI flags and output format may change across minor versions. Mitigation: pin `drizzle-kit` to an exact version in the `packages/schema/package.json`. Add a smoke test that runs `drizzle-kit --version` and asserts the expected version string. When upgrading `drizzle-kit`, run the full integration test suite before committing.

### R2: Bun vs Node.js TypeScript dynamic import behavior

`loadSchema` uses `await import(filePath)` for `.ts` files. Under Bun, this works natively. Under Node.js, `.ts` files cannot be natively imported without a loader (`tsx`, `ts-node`, or an `--experimental-loader`). In dev mode, `createCMS` is always run under Bun (developer toolchain). In prod, collection files are pre-compiled to JavaScript by the CMS build step before being deployed — the `import()` call loads `.js`, not `.ts`. The dev/prod distinction is documented clearly in `createCMS` setup guidance.

### R3: Schema drift in concurrent branch workflows

If two feature branches each add a collection, merging them creates a migration ordering conflict. The generated migration files from both branches will have the same sequence number prefix. Mitigation: the `cms schema plan` command always re-sequences migrations from the live DB state, not from the file sequence numbers. The sequence numbers in migration filenames are cosmetic. The `cms schema check --assert-clean` CI gate fails if the DB state does not match the committed schema, forcing the developer to re-run `cms schema apply` after the merge. This is documented as the expected workflow for parallel schema changes.

### R4: Component and dynamiczone stored as JSON — query limitations

`component` and `dynamiczone` fields are stored as JSON columns in SQLite. SQL-level filtering on nested component fields is not supported (no `WHERE fields->>'nestedField' = 'value'` in the public API query syntax v1). This is a known limitation accepted for v1. The content API's filter syntax applies only to top-level fields. Documented in scope boundaries.

### R5: Large schema bootstrap time

Importing many TypeScript collection files with `await import()` in serial could be slow for schemas with 50+ collections. Mitigation: `loadSchema` imports all files in parallel using `Promise.all`. Bun's native TypeScript transpiler is fast enough that 50 collection files import in < 200ms in benchmarks.

---

## Dependencies / Prerequisites

- `@paralleldrive/cuid2` — CUID2 generation (`createId()`)
- `drizzle-orm` — Drizzle column type utilities and relational query API
- `drizzle-kit` (dev dependency, exact version pinned) — `generate` and `migrate` CLI
- `zod` v4 — field validation schema derivation
- `prettier` (dev dependency) — used by `generateCollectionFile` for output formatting
- `chokidar` (optional peer dependency) — file watching under Node.js; not required under Bun
- `better-sqlite3` (dev dependency, test only) — integration tests for plan/apply

---

## Alternative Approaches Considered

### Alternative: JSON schema files instead of TypeScript (Strapi model)

Strapi stores content types as `schema.json` files, compiled at boot into internal type representations. The rejected reasons: JSON is not type-safe; errors surface at runtime rather than in the editor; JSON cannot express default functions (CUID2 `$defaultFn`); JSON requires a separate compiler step before Drizzle or Zod can use the definitions. TypeScript objects eliminate all three limitations at the cost of requiring a TypeScript-aware import mechanism at load time — a cost already accepted by the monorepo's Bun toolchain.

### Alternative: Use drizzle-kit's programmatic API instead of CLI subprocess

`drizzle-kit` exposes some internal utilities that could theoretically be imported directly. This approach was rejected because drizzle-kit's programmatic API is not a stable public surface — it is internal implementation that changes without semver guarantees. The CLI is the stable interface. Shelling out to the CLI with a pinned version is more maintainable than importing internals that break on patch upgrades.

### Alternative: Custom SQL migration engine instead of drizzle-kit

Writing a custom differ + SQL generator eliminates the drizzle-kit dependency. Rejected: the maintenance burden of a correct SQL migration engine (handling all edge cases of SQLite, Postgres, MySQL schema introspection and ALTER TABLE semantics) is substantial. drizzle-kit already solves this problem well. The `cmsSchemaService` in U5 wraps drizzle-kit's output in a human-readable layer — it does not replace the underlying engine.

### Alternative: UUID v7 instead of CUID2

UUID v7 is time-sortable and standardized (RFC 9562). CUID2 is chosen over UUID v7 because: CUID2 is URL-safe without hyphens; CUID2 has established usage in the Drizzle + Hono community; UUID v7 requires careful attention to monotonicity in distributed systems that CUID2's counter/fingerprint approach handles by design. UUID v7 is a valid future alternative if cross-system ID interoperability becomes a requirement.

---

## Phased Delivery

**Phase 1 — Type foundation (U1, U2):** Build the `FieldDefinition` type system and `defineCollection` function. No I/O, no external tooling. Unlocks all other units.

**Phase 2 — Drizzle generation (U3):** Implement `generateDrizzleSchema`. Can be developed and tested with snapshot tests before any migration tooling is connected.

**Phase 3 — Schema compilation (U7):** Implement `loadSchema` and `SchemaCache`. Integration-tests against real collection files. Unlocks U4 and U5.

**Phase 4 — Dev watcher (U4) and file writer (U6):** Develop in parallel. U4 requires U3 and U7; U6 requires U1 and U2 only. These can be assigned to separate implementers.

**Phase 5 — Prod plan/apply (U5):** Implement `cmsSchemaService`. Requires U3 for table map generation. Integration tests require real SQLite DB.

Phases 1 and 2 are prerequisites for every subsequent package in the monorepo. Phase 3 is required before `@hono-cms/core` can bootstrap. Phases 4 and 5 can be completed after core bootstraps.

---

## System-Wide Impact

`@hono-cms/schema` has no upstream monorepo dependencies. Every other package depends on it. Changes to the public exports of this package (types, function signatures) are breaking changes for the entire monorepo. The package's public API must be treated as a versioned contract from the first commit.

**Packages that import `@hono-cms/schema`:**
- `@hono-cms/core` — imports `CollectionDefinition`, `CMSSchema`, `SchemaCache`, `startSchemaWatcher`, `cmsSchemaService`
- `@hono-cms/cli` — imports `cmsSchemaService`, `generateCollectionFile`
- `@hono-cms/adapter-*` — imports `CollectionDefinition`, `generateDrizzleSchema` (with dialect override)
- `apps/admin` — imports `CollectionDefinition` type for the CT Builder UI forms

**Admin SPA impact:** The CT Builder in the admin SPA calls `generateCollectionFile` (via the CMS REST API) when the developer saves a collection definition. The file writer (U6) is the backend of that API call. Changes to the generated file format affect the CT Builder's preview and diff display.

**CLI impact:** `cms schema plan`, `cms schema apply`, and `cms schema check` are thin wrappers around `cmsSchemaService` from this package. The CLI plan (Plan 006) depends on U5 being complete.

---

## Deferred Implementation Notes

- Dialect parameterization in `generateDrizzleSchema` — the current implementation targets `drizzle-orm/sqlite-core`. Postgres and MySQL dialects require different column types (e.g., `serial` for integer PK, `jsonb` for JSON). This is deferred to the adapter packages which will call a `generateDrizzleSchema(collections, { dialect })` overload.
- The `component` field type — components are named reusable field groups. The schema system must eventually support a `components/` directory alongside `collections/`. For v1, components are defined inline as nested field maps within a collection; the component registry is deferred to Plan 006 (CLI) which will introduce the `components/` convention.
- `dynamiczone` full polymorphic typing — the Zod discriminated union for `dynamiczone` requires all component types to be registered. For v1, `dynamiczone` stores JSON without strict Zod validation at the API boundary. Strict validation deferred post-v1.
- Prettier integration in `generateCollectionFile` — the implementation should attempt `prettier.format()` and fall back gracefully if Prettier is not installed or throws. The fallback is the manually indented string. This avoids making Prettier a hard runtime dependency.
