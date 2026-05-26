---
title: "feat: Audit Log — Core Mutation Trail with Diff Storage and Admin Viewer"
date: 2026-05-16
type: feat
status: active
depth: deep
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
ideation-ideas: ["#21 Audit Log — Core Feature, Not Enterprise-Gated"]
plan-series: "014 of 018"
---

# feat: Audit Log — Core Mutation Trail with Diff Storage and Admin Viewer

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 2
**Research inputs used:** skill review, architecture review, security review

### Key Improvements

1. Strengthen audit event shape and cross-feature correlation expectations.
2. Add stronger default redaction and operational-alert guidance.
3. Clarify where audit writes fit in the broader mutation/event lifecycle.

## Summary

Plan 014 implements the audit log — a core (never enterprise-gated) feature of `@hono-cms` that records every content mutation with full before/after field-level diffs. Every `create`, `update`, `delete`, `publish`, `unpublish`, and `schema_change` operation writes a row to the `audit_log` table in the same database as content. The diff is computed in-process in the request path, stored as structured JSON, and viewable in the admin Settings panel with filtering, row-level diff expansion, and CSV/JSON export.

The audit log is powered by the same event pipeline as webhooks (Plan 013): a content mutation fires a structured event, and the audit middleware intercepts it synchronously to write the row before the HTTP response is returned to the caller. Retention is configurable via `auditLog.retentionDays` in `createCMS` config; daily cleanup runs via the background-jobs mechanism introduced in Plan 010.

Making this a core feature — not an enterprise gate — is the plan's primary competitive statement. Strapi charges enterprise pricing for audit trail visibility. `@hono-cms` ships it unconditionally to every deployment, at every tier, for free. (see origin: `docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md`, Idea #21)

---

## Problem Frame

Strapi's audit log is enterprise-only. The community has requested it as a free feature for years. Every content-management workflow that involves more than one editor — agencies, multi-author publications, regulated industries, any team that has had a "who deleted that?" incident — needs mutation history. Gating it is a business decision that the ideation explicitly rejected for `@hono-cms`.

The technical challenge is not the audit trail concept itself — it is correctness and storage control:

- **Correctness:** The diff must reflect exactly what changed, not a full document snapshot per mutation. Before-state must be captured before the mutation touches the DB — not reconstructed afterward from an incomplete picture.
- **Storage control:** Richtext `body` fields and other large JSON blobs can grow an `audit_log` table to gigabytes within weeks on active collections. A configurable exclusion list and truncation threshold are first-class constraints, not afterthoughts.
- **Failure isolation:** A slow or failing audit write must never fail the content mutation that caused it. The audit log is a record of events — not a transactional guarantee over the event itself.
- **Latency awareness:** Audit writes are synchronous (before response is returned), so they add real per-request latency. The plan accepts this cost explicitly and documents it as a trade-off (see KTD-1).

---

## Scope Boundaries

### In Scope

- `audit_log` Drizzle table definition, indexes, and TypeScript types
- `AuditLogConfig` type added to `CMSConfig` with `retentionDays` and `excludeFields`
- `createAuditMiddleware` — Hono middleware wiring pre-mutation snapshot, diff computation, and audit row write
- `computeDiff` — pure function computing field-level diffs between before/after document states
- `excludeFields` stripping and large-field truncation (> 10 KB → `{ truncated: true, length: N }` marker)
- `GET /cms/audit-log` admin API with cursor-based pagination and full filter set
- `GET /cms/audit-log?format=csv` and `?format=json` streaming export (admin-only, rate-limited)
- Admin SPA page at `/settings/audit-log` with TanStack Table, TanStack Query, diff viewer, and Export CSV button
- `auditLogCleanupJob` — batched DELETE job integrated with Plan 010 background jobs, runs daily

### Deferred to Follow-Up Work

- Audit log webhook (fire a webhook when an audit row is written — e.g., for real-time compliance integrations): defer to webhook plan (Plan 013) follow-up
- Audit log for schema changes (`schema_change` operation type declared in the table but write logic for it lives in the schema plan — Plan 005 — which fires the appropriate event)
- Per-collection audit enable/disable toggle (all collections are audited by default; selective disable is a potential follow-up config key)
- Immutable audit log mode (write to append-only storage with WORM guarantees) — enterprise edge case; not v1

### Outside This Product's Identity

- Providing a managed audit log service (the audit log always lives in the same DB as content — no external log sink by default)
- Real-time audit log streaming to the browser (admin viewer is polled, not push-based)
- Compliance certifications (SOC 2, HIPAA) that depend on the audit log — those are deployment-level concerns, not CMS-library concerns

---

## Key Technical Decisions

## Research Insights

**Best Practices:**
- Include actor, request ID, organization scope, action, resource type/id, and bounded before/after summaries in every event.
- Consider introducing a canonical post-commit event/outbox model so audit, cache invalidation, webhooks, and translation jobs consume the same mutation result.
- Keep bulk actions traceable at both batch and item level.

**Security Considerations:**
- Add default redaction rules for tokens, secrets, cookies, auth headers, internal notes, and oversized sensitive blobs.
- Raise health/admin-visible alerts when audit writes fail instead of relying only on logs.

**Edge Cases:**
- Export flows should remain rate-limited even when cache infrastructure is absent or degraded.
- Decide explicitly how failed authorization attempts and partial downstream failures appear in the audit trail.

### KTD-1: Synchronous write — why, and why failure must not propagate

**Decision:** The audit row is written synchronously in the request path — after the mutation succeeds, before the HTTP response is returned. If the audit write fails, the error is logged but the response is still returned successfully to the caller (fire-and-forget error handling, not transactional rollback).

**Rationale for synchronous:** An async/queued write (write to a queue, drain in background) would mean the audit log reflects mutations with a delay. During that delay, an admin viewing the log would see a mutation that appears un-audited. The delay also creates a failure class where queue drain fails and the mutation is never audited at all, with no indication to the operator. Synchronous write gives a strong "row exists immediately after mutation" guarantee that async cannot provide without significantly more infrastructure (durable queues, dead-letter handling).

Synchronous write is also simpler: no queue, no background drain worker, no queue-specific provider dependency. The trade-off is added per-request latency — typically 1–5 ms for a DB insert on the same connection. This is documented, accepted, and the right trade for v1. High-throughput deployments that cannot tolerate this can disable the audit log entirely via `auditLog: false`.

**Rationale for non-propagating failure:** The audit log records events. It is not a transactional participant in the mutation itself. If the `audit_log` table is temporarily unavailable (disk full, connection error), the correct behavior is: the content mutation completes, the error is logged at WARN/ERROR level for operator visibility, and no error is surfaced to the API caller. Surfacing an audit write failure as an HTTP 500 would mean a `audit_log` table issue takes down content writes — inverting the priority relationship. The content is the source of truth; the audit log is a derived record.

### KTD-2: Pre-mutation snapshot via SELECT — not a DB trigger

**Decision:** The pre-mutation document state is captured by a `SELECT * FROM <collection> WHERE id = ?` query executed by the audit middleware before the mutation handler runs. This snapshot is stored in Hono context variables and consumed post-mutation to compute the diff.

**Why not DB triggers:** DB triggers would be the most reliable mechanism for before/after snapshots — they execute atomically with the mutation and cannot be bypassed. However:

1. **Multi-database portability:** The `@hono-cms` adapter model supports D1, Turso, Neon, Postgres, and Convex. Trigger syntax and capabilities differ across all of them; D1 and Turso SQLite have limited trigger support; Convex has no SQL triggers at all. A trigger-based approach would require adapter-specific trigger creation in every migration and could not cover Convex at all.
2. **Visibility and debuggability:** A trigger that writes to `audit_log` is invisible to the application layer. When it fails, the error appears in DB logs, not application logs. The SELECT-based approach keeps all audit logic in TypeScript, fully observable, testable in Vitest without a real DB, and debuggable with standard tooling.
3. **Schema evolution:** Triggers reference column names. When a collection field is renamed or removed, the trigger must be updated in lockstep. The SELECT approach reads `*` and handles missing fields gracefully — if a field is removed from the collection schema, it simply no longer appears in future diff snapshots.

The trade-off: the SELECT runs in the same request as the mutation, adding one extra DB round-trip. For `update`, this is one additional SELECT before the UPDATE. For `create` and `delete`, the snapshot is trivially `null` or the existing document respectively.

### KTD-3: `user_email` denormalized — audit permanence requires it

**Decision:** `user_email` is stored as a TEXT column directly on every `audit_log` row, denormalized from the users table. It is populated at write time from the current session's `c.get('user').email`.

**Rationale:** If `user_email` were a foreign key to the users table, deleting a user would either cascade-delete their audit history (catastrophically wrong) or leave an orphaned `user_id` that cannot be joined to a human-readable identity (operationally useless). Denormalization is the correct choice for audit records because:

- Audit records are historical facts. They describe what happened at a point in time by a specific person. That person's email at the time of the mutation is the historically accurate identifier.
- If the user later changes their email, the old audit rows correctly reflect the email they used when they performed the action.
- If the user is deleted, the audit rows remain intact and fully readable — the email field explains who performed the action without a join.

The `user_id` column is retained alongside `user_email` for programmatic queries (filter by user, group by user) but should never be treated as a reliable join key. `user_email` is the human-readable permanent record.

### KTD-4: Storage growth — excludeFields + large-field truncation

**Decision:** Two complementary mechanisms control `audit_log` storage growth:

1. **`excludeFields` config** — fields listed in `auditLog.excludeFields` are stripped from both `before` and `after` diffs before the row is written. The diff JSON does not contain them at all. This is the right mechanism for large richtext fields like `body` or `description` where the operator explicitly decides "I don't need field-level change tracking for this column."

2. **Large-field truncation** — any individual field value in the diff that exceeds 10 KB (serialized) is replaced with `{ truncated: true, length: N }` where `N` is the byte count of the original value. This is a safety net for fields not in `excludeFields` that happen to contain large values (e.g., a `json` field with a large nested object). The truncation is applied after exclusion — `excludeFields` fields never reach the truncation check.

Both mechanisms run inside `computeDiff` before the row is written. The `diff` column always contains the processed result — there is no unprocessed diff anywhere.

Retention (`retentionDays`) is the third lever: rows older than N days are deleted by the cleanup job (U7). The three levers together give operators full control over storage growth without requiring schema changes.

### KTD-5: Core, not enterprise-gated — the competitive rationale

**Decision:** The audit log ships unconditionally to every `@hono-cms` deployment. There is no feature flag, license check, or enterprise tier required to access it. It can be disabled (via `auditLog: false` in config) but it cannot be "unlocked" because it is never locked.

**Rationale:** Strapi's audit log is one of the most-cited reasons for enterprise-tier upsell frustration in the Strapi community. Development teams working on projects that genuinely need audit trails (agencies, fintech, healthcare, regulated industries) are forced onto Strapi Enterprise at $450/month or more for a feature that is not architecturally complex and that competes directly with free alternatives (Directus, Payload). By shipping this as a core feature, `@hono-cms` removes the audit trail from the enterprise upsell equation entirely and makes it a baseline expectation.

The implementation complexity of the audit log (one table, one middleware, one diff function) does not justify enterprise gating. The only argument for gating it would be business model reasons — which `@hono-cms` does not have (it is an open-source library, not a hosted service).

---

## High-Level Technical Design

*This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Audit write flow (per content mutation request)

```
Incoming mutation request (POST /api/articles, PUT /api/articles/:id, DELETE ...)
  │
  ├─ RBAC middleware (Plan 006) — verifies role/permission
  │
  ├─ Audit middleware — PRE-MUTATION PHASE
  │    ├─ Reads collection name + document ID from route params
  │    ├─ For update/delete: SELECT current doc state → stores in c.set('auditSnapshot', ...)
  │    ├─ For create: stores c.set('auditSnapshot', null)
  │    └─ Calls next() — mutation handler runs
  │
  ├─ Content route handler (Plan 008)
  │    ├─ Writes mutation to DB
  │    ├─ Fires content event (shared with webhooks, Plan 013)
  │    └─ Sets c.set('auditResult', { operation, after: resultDoc })
  │
  └─ Audit middleware — POST-MUTATION PHASE (executes after next() returns)
       ├─ Reads auditSnapshot (before) and auditResult (after, operation)
       ├─ Calls computeDiff(before, after, config) → diff object
       ├─ Writes audit_log row (INSERT ... )
       │    [if INSERT fails → log error at WARN, do NOT throw, do NOT modify response]
       └─ Returns response to caller
```

### Diff computation model

```
computeDiff(before, after, config)
  │
  ├─ Strip excludeFields from both before and after
  ├─ Find changed keys: union of all keys; include key if before[k] !== after[k] (deep equal)
  ├─ For each changed key:
  │    ├─ Serialize value to JSON string
  │    ├─ If len > 10 KB → replace with { truncated: true, length: N }
  │    └─ Otherwise include verbatim
  ├─ Return { before: { changedKey: oldVal, ... }, after: { changedKey: newVal, ... } }
  │
  Special cases:
  ├─ create: before = null, after = full new document (minus excludeFields + truncation)
  ├─ delete: before = full deleted document (minus excludeFields + truncation), after = null
  └─ publish/unpublish: before = { status: 'draft' }, after = { status: 'published' }
                        (or reverse — only the status field changes)
```

### Admin API query flow

```
GET /cms/audit-log
  ?collection=articles
  &userId=user_abc123
  &operation=update
  &from=2026-01-01&to=2026-05-16
  &documentId=doc_xyz
  &cursor=<opaque>
  &pageSize=50
  &format=json (default) | csv

  └─ requireAdmin middleware (RBAC check: role === 'admin')
       └─ buildAuditQuery(params, db)
            ├─ WHERE clauses for each filter param
            ├─ Cursor: WHERE created_at < :cursor_ts AND id < :cursor_id (for stable pagination)
            ├─ ORDER BY created_at DESC, id DESC
            └─ LIMIT pageSize + 1 (to detect next page)

  format=json → { data: AuditLogEntry[], meta: { pagination: { nextCursor, hasMore } } }
  format=csv  → streaming CSV response (Content-Type: text/csv, Content-Disposition: attachment)
```

---

## Output Structure

```
packages/core/src/audit/
├── schema.ts                    # Drizzle table definition + TypeScript types
├── middleware.ts                # createAuditMiddleware — Hono middleware
├── diff.ts                     # computeDiff pure function
├── query.ts                    # buildAuditQuery — query builder for the admin API
├── export.ts                   # CSV/JSON streaming export logic
├── cleanup.ts                  # auditLogCleanupJob — batched DELETE
└── index.ts                    # barrel export

packages/core/src/routes/
└── audit-log.ts                # GET /cms/audit-log route handler (mounts query + export)

packages/core/test/audit/
├── schema.test-d.ts            # type-level tests for AuditLogEntry, AuditLogConfig
├── middleware.test.ts           # audit middleware unit tests
├── diff.test.ts                 # computeDiff unit tests (comprehensive)
├── query.test.ts                # query builder unit tests
├── export.test.ts               # CSV/JSON export tests
└── cleanup.test.ts              # cleanup job unit tests

apps/admin/src/pages/settings/
└── audit-log/
    ├── AuditLogPage.tsx         # page root, TanStack Query provider
    ├── AuditLogTable.tsx        # TanStack Table instance
    ├── AuditLogFilters.tsx      # filter bar — user, collection, operation, date range
    ├── DiffViewer.tsx           # before/after field diff (row expansion)
    └── audit-log.test.tsx       # component tests
```

---

## Implementation Units

### U1. `audit_log` table schema, Drizzle definition, and TypeScript types

**Goal:** Define the `audit_log` Drizzle table, its three composite indexes, the `AuditLogEntry` TypeScript type, and the `AuditLogConfig` sub-type that extends `CMSConfig`. The table is included in the CMS core Drizzle schema so it is auto-migrated by `createCMS` alongside content tables — the user never writes or manages this table manually.

**Requirements:**
- Table schema matches the design spec exactly: `id` (CUID2 primary key), `user_id` (nullable TEXT), `user_email` (nullable TEXT), `collection` (NOT NULL), `document_id` (NOT NULL), `operation` (CHECK constraint on six values), `diff` (JSONB), `metadata` (JSONB for `ip` and `userAgent`), `created_at` (NOT NULL DEFAULT NOW())
- Three composite indexes: `(collection, document_id)`, `(user_id, created_at)`, `(collection, operation, created_at)`
- `AuditLogEntry` TypeScript type inferred from the Drizzle table definition (not hand-written)
- `AuditLogConfig` type: `{ retentionDays?: number; excludeFields?: string[]; }` — both fields optional with defaults (`retentionDays: 90`, `excludeFields: []`)
- `CMSConfig['auditLog']` extended to accept `AuditLogConfig | false` — `false` disables the feature entirely
- `auditLog` key in `CMSConfig` is optional (default behavior: enabled, 90-day retention, no excluded fields)
- The `audit_log` table Drizzle definition is imported by the core schema barrel and therefore included in every adapter's schema object — migrations pick it up automatically

**Dependencies:** U-none (this is the foundational data layer for all other units)

**Files:**
- `packages/core/src/audit/schema.ts` — Drizzle table definition, indexes, exported types
- `packages/core/src/types/config.ts` — add `auditLog?: AuditLogConfig | false` to `CMSConfig`
- `packages/core/test/audit/schema.test-d.ts` — type-level assertions

**Approach:**

Use the Drizzle `sqliteTable` (or `pgTable`, resolved per adapter dialect) declaration. The `operation` column is a `text` with a Drizzle `check` constraint covering the six allowed values. The `diff` and `metadata` columns use Drizzle's `text` column with a custom `$type<JsonType>()` annotation (JSONB is PostgreSQL-native; on SQLite/D1/Turso, it stores as serialized JSON text — the application layer handles serialization/deserialization consistently).

Indexes are declared as Drizzle `index(...)` calls on the table — not raw SQL. This ensures they are included in migration files generated by `drizzle-kit generate`.

The table is added to the core Drizzle schema object that all adapter packages import. The existing schema barrel in `packages/core/src/db/schema.ts` (or equivalent) exports it alongside content tables. No adapter-specific code change is needed — the adapter factories already build their Drizzle instance from the full schema object.

`AuditLogConfig` is a plain TypeScript interface, not a Zod schema (Zod validation of CMS config happens at the `createCMS` call site, not per sub-type). The defaults (`retentionDays: 90`) are applied in the `createCMS` bootstrap function when `auditLog` is `undefined` or `true`.

**Test scenarios:**
- Type test: `AuditLogEntry` has all expected fields typed correctly (id: string, user_id: string | null, operation is a union of six literals)
- Type test: `CMSConfig` with `auditLog: false` is valid TypeScript
- Type test: `CMSConfig` with `auditLog: { retentionDays: 30, excludeFields: ['body'] }` is valid TypeScript
- Type test: `CMSConfig` with `auditLog: { retentionDays: 'forever' }` is a TypeScript error
- Type test: `CMSConfig` without `auditLog` key is valid (defaults apply)
- Type test: `AuditLogEntry['operation']` is assignable from `'create'` but not from `'archive'`

**Verification:** Drizzle-kit generates correct CREATE TABLE and CREATE INDEX SQL from the table definition. `AuditLogEntry` inferred type matches the expected shape in a `test-d.ts` file. `CMSConfig` accepts and rejects the expected `auditLog` values at the type level.

---

### U2. Audit middleware — `createAuditMiddleware`

**Goal:** Implement the Hono middleware that (a) captures the pre-mutation document snapshot before the content handler runs, and (b) computes the diff and writes the audit row after the handler completes successfully. Audit write failure must not propagate to the HTTP response.

**Requirements:**
- Exported as `createAuditMiddleware(config: ResolvedAuditLogConfig, db: DatabaseAdapter): MiddlewareHandler`
- Pre-mutation phase: reads `collection` and `documentId` from Hono route params; issues a SELECT to get the current document state; stores snapshot in `c.set('cms.auditSnapshot', snapshot)` using a typed Hono context variable key
- Post-mutation phase: reads `c.get('cms.auditSnapshot')` (before) and `c.get('cms.auditResult')` (after + operation) set by the content route handler; calls `computeDiff`; writes `audit_log` row
- If the route is a CREATE, the pre-mutation snapshot is stored as `null` (no SELECT issued)
- If the route is a DELETE, the pre-mutation snapshot IS the deleted document (SELECT before handler); after is `null`
- The `metadata` column is populated from the request: `ip` from `c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown'`; `userAgent` from `c.req.header('user-agent')`
- If `config === false` (audit log disabled), the middleware is a no-op pass-through — no SELECT, no write
- Audit `INSERT` failure: caught in a `try/catch`; error logged via the CMS logger at `WARN` level; response returned normally
- `user_id` and `user_email` read from `c.get('user')` (populated by the auth middleware from Plan 004)
- The middleware is applied to content mutation routes only (POST, PUT, PATCH, DELETE on `/api/:collection` and `/api/:collection/:id`), not to GET or audit-log admin routes

**Dependencies:** U1 (schema + types), Plan 004 (auth middleware that populates `c.get('user')`), Plan 006 (RBAC middleware runs before this), Plan 008 (content route handlers that set `c.set('cms.auditResult', ...)`)

**Files:**
- `packages/core/src/audit/middleware.ts` — `createAuditMiddleware` implementation
- `packages/core/src/middleware/inject-services.ts` — add `cms.auditSnapshot` and `cms.auditResult` to the Hono env type variable map
- `packages/core/src/routes/content.ts` — mount `createAuditMiddleware` on mutation routes
- `packages/core/test/audit/middleware.test.ts` — unit + integration tests

**Approach:**

The middleware uses Hono's `next()` composition pattern — run pre-mutation logic before `await next()`, run post-mutation logic after it returns. The content route handler is responsible for setting `c.set('cms.auditResult', { operation, after: resultDoc })` before returning. The audit middleware reads this after `next()` resolves.

The Hono `HonoEnv` variables type (defined in `packages/core/src/types/instance.ts`) is extended with:

```
'cms.auditSnapshot': Record<string, unknown> | null
'cms.auditResult': { operation: AuditOperation; after: Record<string, unknown> | null } | undefined
```

This makes `c.get('cms.auditSnapshot')` and `c.get('cms.auditResult')` type-safe in all handlers.

The pre-mutation SELECT uses the `DatabaseAdapter.query` method — it does not use raw SQL. The adapter's collection query interface (Plan 008) is used to fetch the document by ID. If the document does not exist (e.g., `DELETE` on a non-existent ID), the snapshot is stored as `null` and the audit row records `before: null`.

The INSERT into `audit_log` wraps the Drizzle `.insert()` call in a `try/catch`. On catch: `logger.warn('audit log write failed', { error, collection, operation })`. The response is returned regardless.

**Execution note:** Implement test-first. Write the middleware test file with all scenarios first (using a mock DB adapter), then implement the middleware to make them pass.

**Test scenarios:**
- Happy path: `PUT /api/articles/123` — middleware issues SELECT before handler, audit row is written after handler with correct `before`/`after` diff
- Happy path: `POST /api/articles` — no pre-mutation SELECT issued; audit row has `before: null` in diff
- Happy path: `DELETE /api/articles/123` — pre-mutation SELECT captures document; audit row has `after: null` in diff
- `GET /api/articles` — middleware is not applied; no SELECT, no write
- Audit INSERT fails (mock DB throws on INSERT): handler response is 200, error is logged, no exception propagates to the test's `Response` assertion
- Auth context: `user_id` and `user_email` on the audit row match `c.get('user')` values from the auth middleware
- `metadata` contains `ip` from `x-forwarded-for` header; `userAgent` from `user-agent` header
- Config `auditLog: false`: middleware is a no-op; no DB calls made; handler response unaffected
- `cms.auditResult` not set by handler (handler errored before setting it): middleware skips audit write gracefully; no uncaught exception

**Verification:** Unit tests pass with a mock database adapter. Integration test with an in-memory SQLite database confirms an audit row appears in the `audit_log` table after a successful mutation. Error test confirms no audit row appears after a failed mutation (handler returned 4xx/5xx) without throwing.

---

### U3. Diff computation — `computeDiff`

**Goal:** Implement a pure function that computes the field-level diff between two document states, applying field exclusions and large-field truncation. The function is the core correctness unit of the audit log — all other units depend on it being accurate.

**Requirements:**
- Signature: `computeDiff(before: Record<string, unknown> | null, after: Record<string, unknown> | null, options: { excludeFields: string[] }): AuditDiff`
- Return type: `AuditDiff = { before: Record<string, unknown> | null; after: Record<string, unknown> | null }`
- For `create` (before is null): return `{ before: null, after: processedAfter }` — `after` contains all fields from the new document minus excluded fields, with large-field truncation applied
- For `delete` (after is null): return `{ before: processedBefore, after: null }` — symmetric to create
- For `update`: compute symmetric diff — only fields where `deepEqual(before[k], after[k])` is false are included in either side. Fields that did not change are omitted from both sides
- `excludeFields` stripping: before and after objects both have excluded keys deleted before any other processing; excluded fields never appear in the output diff
- Large-field truncation: for each field value included in the diff, serialize to JSON string; if `JSON.stringify(value).length > 10240` (10 KB), replace with `{ __truncated: true, length: N }` where `N` is the byte count of the original serialized value
- Handles nested objects (components, JSON fields): deep equality for change detection; nested objects are included as the full value (not recursively diffed at the nested key level) — field-level granularity is at the top-level document field, not sub-keys within a JSON field
- The function is pure and side-effect free — no DB access, no logging, no external calls
- The `deepEqual` comparison must handle: null vs undefined (treat as different), arrays (order-sensitive equality), dates serialized as ISO strings, numbers (NaN equality is false), nested objects

**Dependencies:** U1 (for `AuditDiff` type)

**Files:**
- `packages/core/src/audit/diff.ts` — `computeDiff` implementation
- `packages/core/test/audit/diff.test.ts` — comprehensive unit tests

**Approach:**

The deep equality check uses a purpose-built recursive comparison rather than `JSON.stringify` equality, because `JSON.stringify` is not stable for objects (key ordering may differ across DB reads) and does not correctly compare `undefined` vs missing keys. The comparison function walks both objects' keys, short-circuits on primitive inequality, and recurses for object values.

The 10 KB truncation threshold is applied per-field after all other processing. The `__truncated` marker uses a double-underscore prefix to avoid collision with real field names (`truncated` alone could be a real field name).

Exclusion is applied first (strip the keys), then changed-field detection, then truncation. This ordering means: excluded fields never trigger a "changed field" entry, and truncation applies only to fields that actually changed and will be stored.

For the `publish/unpublish` operation case: the content handler sets `cms.auditResult.after` to `{ status: 'published' }` (or `'draft'`) and the snapshot `before` was the full document. `computeDiff` correctly identifies that only `status` changed and produces a minimal diff.

**Test scenarios:**
- Update with one changed scalar field: diff contains only that field in both `before` and `after`
- Update with no changes (identical before/after): diff returns `{ before: {}, after: {} }` — empty changed-fields sets
- Update with nested JSON field change: the entire field value is included (not sub-keys)
- Update where excluded field changes: excluded field does not appear in diff; other changed fields do
- Create: `before` is null; `after` contains all non-excluded fields with truncation applied
- Delete: `after` is null; `before` contains all non-excluded fields with truncation applied
- Large field truncation: field with 12 KB string value → `{ __truncated: true, length: 12288 }` in diff
- Large field truncation: field with 9 KB string value → included verbatim (under 10 KB threshold)
- Field at exactly 10240 bytes: included verbatim (boundary: strictly greater than 10 KB triggers truncation)
- Excluded field that is also a large field: excluded takes precedence — field not in diff, truncation never evaluated
- Array field change: array value comparison is order-sensitive (`[1, 2]` vs `[2, 1]` → changed)
- Null vs undefined: `before[k] = null`, `after[k] = undefined` → treated as changed
- Nested object field with sub-key change: top-level field appears in diff; entire old object in `before`, entire new object in `after`
- `publish`: `before` has `{ status: 'draft', title: 'Foo' }`, `after` has `{ status: 'published', title: 'Foo' }` → diff is `{ before: { status: 'draft' }, after: { status: 'published' } }`
- Multiple excluded fields in `excludeFields` array: all excluded; only changed non-excluded fields in diff

**Verification:** All test scenarios pass in Vitest without any DB or external dependencies. Edge case scenarios (null/undefined, empty objects, large fields, empty excludeFields array) all produce correct output. The function is deterministic — same inputs always produce same output.

---

### U4. Audit log query API — `GET /cms/audit-log`

**Goal:** Implement the admin-only REST endpoint that returns paginated, filterable audit log entries as JSON. This is the data source for the admin SPA viewer (U6) and direct API consumers.

**Requirements:**
- Route: `GET /cms/audit-log` — mounted in the CMS route composition
- Admin-only: guarded by RBAC middleware requiring `role === 'admin'` (same pattern as other `/cms/*` admin routes, Plan 006)
- Query parameters (all optional):
  - `?collection=articles` — filter by collection name (exact match)
  - `?userId=<id>` — filter by `user_id`
  - `?operation=update` — filter by operation (one of the six valid values)
  - `?from=2026-01-01` — filter entries created on or after this date (ISO 8601)
  - `?to=2026-05-16` — filter entries created on or before this date (ISO 8601, inclusive: end of day)
  - `?documentId=<id>` — filter by `document_id`
  - `?cursor=<opaque>` — cursor for next-page navigation
  - `?pageSize=50` — entries per page (default 50, max 200)
  - `?format=json` — explicit JSON format (default; `format=csv` routes to U5 export handler)
- Response shape: `{ data: AuditLogEntry[], meta: { pagination: { nextCursor: string | null, hasMore: boolean, pageSize: number } } }`
- Cursor-based pagination (same mechanism as content API, Plan 008): cursor encodes `(created_at, id)` as a base64 opaque string; query uses `WHERE (created_at, id) < (:cursor_ts, :cursor_id)` for stable backward-in-time paging
- `data` ordered `created_at DESC, id DESC` (most recent first)
- Invalid `operation` query param → 400 with descriptive error message
- Invalid date formats → 400 with descriptive error message
- `pageSize` clamped to max 200; values above 200 silently clamped (not an error)

**Dependencies:** U1 (table + types), U2 (middleware must be excluded from this route — it is a read-only admin route, not a mutation), Plan 006 (RBAC middleware), Plan 008 (cursor pagination pattern to follow)

**Files:**
- `packages/core/src/audit/query.ts` — `buildAuditQuery(params, db)` query builder
- `packages/core/src/routes/audit-log.ts` — Hono route handler mounting query + export
- `packages/core/test/audit/query.test.ts` — unit tests for query builder + route handler

**Approach:**

The route handler delegates filter parsing and query construction to `buildAuditQuery`. Validation of query params (allowed `operation` values, date parse) happens in the route handler before calling the query builder — invalid params return early with `c.json({ error: '...' }, 400)`.

The Drizzle query uses `db.query.auditLog.findMany({ where: and(...conditions), orderBy: [desc(auditLog.createdAt), desc(auditLog.id)], limit: pageSize + 1 })`. The `+ 1` technique detects whether a next page exists: if the result length is `pageSize + 1`, `hasMore` is true and the last element is stripped before returning. The `nextCursor` is derived from the `(createdAt, id)` of the last included item.

The cursor is encoded as `base64(JSON.stringify({ ts: created_at.toISOString(), id }))`. Decoding and validating the cursor happens in `buildAuditQuery`; a malformed cursor returns an empty result with `hasMore: false` rather than an error (graceful degradation).

The RBAC check pattern follows the existing admin route convention from Plan 006: `requireAdmin` middleware applied as the first middleware on the route group, before query parsing.

**Test scenarios:**
- No filters: returns most recent 50 entries ordered by `created_at DESC`
- Filter by `collection=articles`: only articles entries returned
- Filter by `operation=update`: only update operations returned
- Filter by `from` + `to`: entries outside the date range excluded; boundary dates (inclusive) included
- Filter by `userId`: only entries for that user returned
- Filter by `documentId`: only entries for that document returned
- Combined filters (`collection=articles&operation=update&from=...`): all filters applied as AND conditions
- `pageSize=10`: returns 10 entries; `hasMore` true if more exist
- Cursor pagination: fetching page 2 with `cursor` from page 1 response returns correct continuation
- `pageSize` above 200: clamped to 200, no error
- Invalid `operation` value: 400 response with error message
- Invalid `from` date (not ISO 8601): 400 response
- Non-admin caller (user role): 403 response — RBAC middleware blocks before query runs
- Unauthenticated request (no session): 401 response
- Empty table: returns `{ data: [], meta: { pagination: { nextCursor: null, hasMore: false } } }`
- `format=csv` query param: routes to CSV export handler (U5), not JSON response

**Verification:** Unit tests pass for all filter combinations using an in-memory SQLite database. Route handler returns correct HTTP status codes for auth, validation, and pagination scenarios. Cursor from a page-1 response can be used to retrieve page 2 with no duplicate or missing entries.

---

### U5. CSV/JSON streaming export — `GET /cms/audit-log?format=csv`

**Goal:** Implement streaming CSV and JSON export for the audit log, allowing operators to download complete filtered log exports without loading all rows into memory. Admin-only, rate-limited.

**Requirements:**
- `?format=csv`: response with `Content-Type: text/csv`, `Content-Disposition: attachment; filename="audit-log-<date>.csv"`, streaming body
- `?format=json`: same as the regular paginated endpoint but without pagination — streams all matching rows as a JSON array (may be large); use `Content-Type: application/json`
- Both export formats accept the same filter params as the paginated query (U4): `collection`, `userId`, `operation`, `from`, `to`, `documentId`
- Exports do NOT use cursor pagination — they return all matching rows in one streaming response
- Streaming: rows are fetched from the DB in batches of 500 using `OFFSET`-based iteration (or Drizzle streaming cursor if the adapter supports it), written to the response stream incrementally. No full result set is loaded into memory
- CSV columns: `id`, `created_at`, `user_id`, `user_email`, `collection`, `document_id`, `operation`, `diff_before` (JSON-stringified), `diff_after` (JSON-stringified), `metadata_ip`, `metadata_user_agent`
- CSV escaping: double-quote wrapping for all string fields; double-double-quote for embedded quotes; standard RFC 4180 compliance
- Rate limiting: max 10 export requests per admin user per hour (simple token-bucket counter stored in the cache adapter, Plan 009; if no cache is configured, rate limiting is skipped with a warning log)
- Admin-only: same `requireAdmin` guard as U4
- If no matching rows: CSV response with header row only (valid empty CSV); JSON response with `[]`
- Export is capped at 100,000 rows maximum; if the result would exceed this, the response includes a `X-CMS-Export-Truncated: true` header and a `X-CMS-Export-Row-Count: 100000` header

**Dependencies:** U1, U4 (shares filter logic), Plan 009 (cache adapter for rate limit counter)

**Files:**
- `packages/core/src/audit/export.ts` — streaming export implementation (CSV row builder, batch fetcher, rate limit check)
- `packages/core/src/routes/audit-log.ts` — format routing (`format=csv` → export, else → paginated query)
- `packages/core/test/audit/export.test.ts` — unit + integration tests

**Approach:**

The streaming mechanism uses the Web Streams API (`ReadableStream`, `TransformStream`) which is native to WinterTC runtimes and supported in Node.js 18+. The response is constructed with `new Response(stream, { headers: {...} })` and returned from the Hono handler. This is compatible with all adapters (D1, Postgres, Turso, Node.js).

Batch fetching: `SELECT ... WHERE <filters> ORDER BY created_at DESC, id DESC LIMIT 500 OFFSET :offset`. Each batch of 500 rows is serialized and pushed to the stream. `offset` increments by 500 per batch. The loop exits when a batch returns fewer than 500 rows (last page) or when the 100,000-row cap is reached. The stream controller is closed after the last batch.

CSV row builder: a small pure function `toCSVRow(entry: AuditLogEntry): string` that formats all fields per RFC 4180. `diff.before` and `diff.after` are `JSON.stringify`'d and quoted. Newline in the `metadata.userAgent` field is escaped as a space.

Rate limit key: `audit-export-ratelimit:<userId>`. The counter is incremented on each export request and expires after 3600 seconds. If the counter exceeds 10, the handler returns 429 with a `Retry-After` header.

The 100,000-row cap is a safety net against accidentally streaming a 50 GB response. Operators who need full exports beyond this should query the database directly.

**Test scenarios:**
- CSV export with no filters: all rows streamed as valid CSV; header row present; RFC 4180 compliant
- CSV export with `collection=articles` filter: only articles rows in output
- JSON export (`format=json`): valid JSON array with all matching entries
- `diff` fields correctly JSON-stringified in CSV columns (no broken quoting)
- `diff.before` containing double-quote characters: properly escaped in CSV (`""` inside quoted field)
- Empty result: CSV with header row only; JSON with `[]`
- Rate limit: 10th request in an hour succeeds; 11th returns 429 with `Retry-After` header
- Rate limit: different users have independent counters (user A at 10 does not block user B)
- 100,001-row dataset: response is capped at 100,000 rows; `X-CMS-Export-Truncated: true` header present
- Non-admin caller: 403 response
- Streaming: response body begins arriving before all rows are fetched (streaming, not buffered) — verified by checking response has started while batch 2 is still pending in the mock

**Verification:** Integration test with 1,500 mock rows confirms batching occurs (3 batches of 500) and all rows appear in the output. CSV output is parsed by a standard CSV parser without errors. JSON output is valid JSON. Rate-limit test confirms 429 on the 11th request within the window.

---

### U6. Admin audit log viewer — `/settings/audit-log`

**Goal:** Implement the admin SPA page that displays the audit log with filters, cursor-based infinite scroll / pagination, row-level diff expansion, and a CSV export button.

**Requirements:**
- Route: `/settings/audit-log` in the admin SPA (registered in Plan 007's settings navigation)
- TanStack Table for the log entries table
- TanStack Query for data fetching with cursor-based infinite scroll (matches U4's pagination API)
- Filter bar: user dropdown (populated from `/cms/users` list), collection dropdown (populated from the schema), operation multi-select (fixed list: create / update / delete / publish / unpublish / schema_change), date range picker (from/to)
- Filter state lives in URL search params (shareable, bookmarkable filters)
- Row expansion: clicking a row reveals the diff viewer (U6 sub-component) — before/after field values, color-coded (green for added/new value, red for removed/old value, yellow for changed)
- Truncated fields (`{ __truncated: true, length: N }`) displayed as `[truncated — N bytes]` in the diff viewer
- "Export CSV" button: fires `GET /cms/audit-log?format=csv` with current filter params; browser download triggered via `window.location.href` assignment or `<a href download>` pattern (avoids needing to stream the response through fetch)
- Loading states: skeleton rows while initial data loads; spinner on page transitions
- Empty state: friendly message when no audit log entries match the current filters
- Admin-only page: if the current user does not have the admin role, redirect to `/` (handled by the admin SPA route guard, Plan 007)

**Dependencies:** U1 (types for `AuditLogEntry`), U4 (query API), U5 (export endpoint), Plan 007 (admin SPA routing and settings navigation structure)

**Files:**
- `apps/admin/src/pages/settings/audit-log/AuditLogPage.tsx` — page root
- `apps/admin/src/pages/settings/audit-log/AuditLogTable.tsx` — TanStack Table instance
- `apps/admin/src/pages/settings/audit-log/AuditLogFilters.tsx` — filter bar
- `apps/admin/src/pages/settings/audit-log/DiffViewer.tsx` — before/after diff display
- `apps/admin/src/pages/settings/audit-log/audit-log.test.tsx` — component tests
- `apps/admin/src/lib/api/audit-log.ts` — TanStack Query hooks (`useAuditLog`, `useAuditLogInfinite`)

**Approach:**

The TanStack Table column definitions: `created_at` (formatted relative time + absolute on hover), `user_email`, `collection`, `document_id` (truncated with full value on hover), `operation` (colored badge), expand icon. Columns are fixed — the table is not user-configurable in v1.

TanStack Query's `useInfiniteQuery` hook fetches with the cursor from U4. The `getNextPageParam` extracts `nextCursor` from the response meta. The table renders all fetched pages as one flat list. A "Load more" button (or intersection observer trigger) fires `fetchNextPage()`.

Filter state: `useSearchParams` (React Router v6 or TanStack Router, matching Plan 007's router choice) to read/write filters. Changing a filter resets the cursor to page 1. URL example: `/settings/audit-log?collection=articles&operation=update&from=2026-01-01`.

Diff viewer: receives `entry.diff` (`{ before, after }`). Builds a list of field keys (union of `Object.keys(before ?? {})` and `Object.keys(after ?? {})`). For each key, renders a two-column row: left = before value, right = after value. Color coding via CSS classes: `diff-added` (key only in after), `diff-removed` (key only in before), `diff-changed` (key in both, different values). Uses `<pre>` for multi-line JSON values. Truncation marker displayed as styled badge.

The "Export CSV" button constructs the URL from current filter state: `?format=csv&collection=...&from=...` etc. Uses `<a href="..." download>` pattern — browser handles the download, no fetch streaming needed.

**Test scenarios:**
- `AuditLogPage` renders table with mock entries from TanStack Query mock
- Filter by collection: query params updated in URL; fetch called with `collection` param
- Filter by date range: `from` and `to` params in URL; correct API call
- Load more: `fetchNextPage` called when "Load more" clicked; new rows appended to table
- Row expansion: clicking a row renders `DiffViewer` with the entry's diff
- `DiffViewer` with update diff: changed fields shown in yellow; unchanged fields not shown
- `DiffViewer` with create diff: `before` is null; all `after` fields shown in green
- `DiffViewer` with truncated field: displays `[truncated — 12288 bytes]` badge
- Empty state: message rendered when query returns `{ data: [], meta: { pagination: { hasMore: false } } }`
- Export CSV button: `<a>` href contains correct format and filter params
- Loading state: skeleton rows rendered while `isLoading` is true

**Verification:** All component tests pass in Vitest (jsdom environment). The filters correctly update URL search params on change. Diff viewer correctly color-codes added/removed/changed fields. The page renders without errors on empty data. Export link correctly encodes current filter state.

---

### U7. Retention cleanup job — `auditLogCleanupJob`

**Goal:** Implement the daily cleanup job that deletes audit log rows older than the configured `retentionDays`, integrated with the background-jobs system from Plan 010. Uses batched deletion to avoid long-running DB transactions on large tables.

**Requirements:**
- Exported as `auditLogCleanupJob(retentionDays: number, db: DatabaseAdapter): Promise<{ deletedCount: number }>`
- Deletes rows where `created_at < NOW() - (retentionDays * 24 * 60 * 60 * 1000)` (milliseconds)
- Batched: deletes in batches of 1000 rows per transaction; waits 100 ms between batches (via `setTimeout` / `scheduler.wait` — deferred to implementation to pick the correct WinterTC-compatible sleep primitive)
- Loop continues until a batch returns fewer than 1000 deleted rows (final batch)
- Returns `{ deletedCount: number }` — sum of all batches; caller (the job runner from Plan 010) logs this count at INFO level: `"audit log cleanup: deleted ${deletedCount} rows older than ${retentionDays} days"`
- If `retentionDays` is 0 or negative: no deletion performed; returns `{ deletedCount: 0 }` with a WARN log
- If the first batch deletes 0 rows: returns immediately with `{ deletedCount: 0 }` (no-op, no further batches)
- Registered as a daily job in Plan 010's job registry at startup: `jobs.register('audit-log-cleanup', { schedule: 'daily', handler: () => auditLogCleanupJob(config.auditLog.retentionDays, db) })`
- If `auditLog` is `false`: the job is not registered (no-op at startup)
- The job function is pure enough to be invoked directly in tests without the full jobs system — it accepts `retentionDays` and `db` directly

**Dependencies:** U1 (table definition for the DELETE query), Plan 010 (background jobs registry where the job is registered at `createCMS` startup)

**Files:**
- `packages/core/src/audit/cleanup.ts` — `auditLogCleanupJob` implementation
- `packages/core/src/create-cms.ts` — register the job in the jobs system at startup (conditional on `auditLog !== false`)
- `packages/core/test/audit/cleanup.test.ts` — unit tests

**Approach:**

The batched DELETE uses `DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at < :cutoff ORDER BY created_at ASC LIMIT 1000)`. This subquery-based pattern is compatible with SQLite (D1, Turso) which does not support `DELETE ... LIMIT` directly without enabling the `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` compile-time option (not available on D1). The subquery approach works on all adapters.

On Postgres (Neon), the equivalent `DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at < :cutoff LIMIT 1000)` is used — same pattern, Postgres supports it natively.

The 100 ms sleep between batches prevents holding a long DB transaction and allows other concurrent operations to proceed. On edge runtimes (CF Workers), `scheduler.wait(100)` is the correct primitive; on Node.js, `new Promise(r => setTimeout(r, 100))` is equivalent. The implementation uses a runtime-neutral wrapper that the adapter can override — deferred to implementation.

The cutoff timestamp is computed once at the start of the job call (not per-batch) to ensure a consistent boundary across all batches.

**Test scenarios:**
- 2,500 rows older than retention threshold: job deletes in 3 batches (1000 + 1000 + 500); returns `{ deletedCount: 2500 }`
- 0 rows older than threshold: returns `{ deletedCount: 0 }` immediately, no DB DELETE issued
- Exactly 1000 rows to delete: deletes 1 batch of 1000, then issues a 2nd batch that returns 0, exits; `deletedCount: 1000`
- Mixed table: rows older than threshold deleted; rows newer than threshold not deleted; verify newer rows remain
- `retentionDays: 0`: no deletion, WARN logged, returns `{ deletedCount: 0 }`
- `retentionDays: -1`: no deletion, WARN logged, returns `{ deletedCount: 0 }`
- `retentionDays: 90`: cutoff is exactly `NOW() - 90 days`; row at 89 days old is NOT deleted; row at 91 days old IS deleted
- Batch boundary: row at exactly the cutoff timestamp: included in deletion (created_at < cutoff, so at-cutoff row is NOT deleted — strictly less than)
- Job registered conditionally: with `auditLog: false`, job is not in the Plan 010 registry (verified in `create-cms.test.ts`, not this test file)

**Verification:** All unit tests pass with an in-memory SQLite database (Drizzle + better-sqlite3 in test environment). The `deletedCount` return value matches the actual count of rows removed. Rows newer than the cutoff remain in the table after job completes. The batching pattern confirms that exactly 3 DB DELETE calls occur for a 2,500-row deletion scenario (verified with a spy on the `db.delete` method).

---

## Dependencies and Sequencing

```
U1 (schema + types)
  ↓
U2 (middleware)    U3 (diff computation)    U7 (cleanup job)
  ↓   ↓
  U4 (query API)
  ↓
  U5 (CSV/JSON export)
  ↓
  U6 (admin viewer)
```

U3 is a dependency of U2 (the middleware calls `computeDiff`) but U3 has no dependencies beyond U1's types — it can be implemented in parallel with U2 once U1 is done.

U7 depends on U1 only (the Drizzle table definition for the DELETE query) and can be implemented in parallel with U2–U5.

U6 (admin viewer) depends on U4 and U5 being complete (it calls both APIs) and on Plan 007 (admin SPA routing) — it is the last unit to implement.

---

## System-Wide Impact

| Affected area | Impact |
|---|---|
| `CMSConfig` type | New optional `auditLog` key; existing consumers unaffected (optional) |
| Content mutation routes | Audit middleware added to POST/PUT/PATCH/DELETE handlers; adds ~1–5 ms per request (synchronous DB write) |
| Admin SPA settings nav | New `/settings/audit-log` entry added to settings sidebar |
| Drizzle schema / migrations | `audit_log` table + 3 indexes added to core schema; all consumers pick it up in next `cms schema plan/apply` run |
| Background jobs registry | `audit-log-cleanup` job registered daily; Plan 010 job runner manages it |
| Cache adapter | Rate limiting in U5 uses the cache; if no cache is configured, rate limiting is skipped |
| Plan 013 (webhooks) | Both audit and webhooks respond to the same content event bus — the event system must fire before the audit middleware post-mutation phase completes |

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Audit write latency degrades P99 content mutation response time | Medium | Audit writes use the same DB connection pool as content writes — no separate connection overhead. Measure in integration benchmarks. If unacceptable, provide `auditLog: false` opt-out. |
| `diff` column storage growth exhausts DB disk | Medium | `excludeFields` config, 10 KB truncation, and `retentionDays` are all in place. Document default settings clearly. Monitor storage in operational docs. |
| SQLite `DELETE ... LIMIT` incompatibility | High (known) | U7 explicitly uses subquery pattern for batched deletion, which works on all adapters including D1. |
| Pre-mutation SELECT race condition (another request mutates the document between the SELECT and the mutation) | Low | The SELECT captures state at a point in time. If another request mutates between SELECT and UPDATE, the diff reflects the pre-audit-SELECT state, not the pre-mutation state strictly. This is an inherent limitation of the SELECT-before-trigger approach and is documented as acceptable for v1. A transaction wrapper would fix it at the cost of transaction isolation overhead on all mutation routes. |
| CSV export memory exhaustion on very large tables | Low | Streaming batch pattern (U5) prevents full result set loading. 100,000-row cap prevents infinite streams. |
| Rate limit bypass if cache is not configured | Low | Rate limiting is a best-effort feature; the WARN log makes the degraded state visible. Document that configuring a cache adapter is strongly recommended for production. |

---

## Deferred Implementation Notes

- The exact sleep primitive for U7's inter-batch pause is deferred to implementation — pick `scheduler.wait` on CF Workers, `setTimeout` on Node.js, or a shared adapter utility if Plan 010 provides one.
- The Drizzle column type for `diff` and `metadata` (JSONB vs text-with-JSON) is parameterized per dialect — the adapter packages resolve the exact column declaration; `packages/core/src/audit/schema.ts` uses the generic Drizzle `json()` type and lets the adapter override it.
- The exact TanStack Router vs React Router version used in the admin SPA is resolved in Plan 007 — U6 follows that plan's router choice without reopening it.
- Intersection observer (infinite scroll) vs explicit "Load more" button for the audit log table — deferred to U6 implementation; either is acceptable for v1.

---

## Alternative Approaches Considered

### Alternative: Async write via the event queue

Write the audit row asynchronously via the same event queue as webhooks — the content handler fires an event, both the webhook delivery and the audit write are consumers of that event, and both run asynchronously after the HTTP response is returned.

**Why rejected:** The async path means the audit log row does not exist at the moment the HTTP 200 is returned to the API caller. An API consumer that immediately queries the audit log after a successful mutation would miss the entry. This creates a consistency window that is especially problematic in test environments. Synchronous write gives a stronger guarantee at the cost of latency — and the latency cost (1–5 ms per mutation) is acceptable for a content management system that is not a high-throughput transactional system.

### Alternative: DB triggers for before/after snapshot capture

Use SQLite AFTER UPDATE / AFTER DELETE triggers to write `audit_log` rows atomically with the mutation.

**Why rejected:** See KTD-2 in detail. Summary: trigger syntax is adapter-specific, D1/Turso trigger support is limited, Convex has no SQL triggers, triggers are invisible to the application layer and hard to test, and they cannot be managed through `drizzle-kit generate` migrations consistently across all adapters.

### Alternative: Event sourcing — store intent, not diff

Store the mutation intent (`{ operation: 'update', patch: { title: 'New Title' } }`) rather than before/after state. Reconstruct document history by replaying events.

**Why rejected:** Event sourcing is a powerful pattern for audit but requires the entire content storage layer to be built around it (Convex naturally supports this; SQL does not). Adopting event sourcing for audit only — while the rest of the content layer uses a mutable SQL table — creates two sources of truth that can diverge. The simpler snapshot-diff approach is correct for v1 and for a CMS that targets SQL databases as its primary backend.

---

## References

- Ideation source: `docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md`, Idea #21
- Background jobs plan (Plan 010) — `auditLogCleanupJob` registration
- RBAC plan (Plan 006) — `requireAdmin` middleware used by U4 and U5
- Auth plan (Plan 004) — session context variables (`c.get('user')`) used by U2
- Webhooks plan (Plan 013) — shared content event system
- Content routes plan (Plan 008) — cursor-based pagination pattern used by U4; `cms.auditResult` context variable set by handlers
- Cache plan (Plan 009) — rate-limit counter storage used by U5
- Admin SPA plan (Plan 007) — settings navigation and routing used by U6
- Schema plan (Plan 005) — `schema_change` operation type (write logic deferred to Plan 005 follow-up)
