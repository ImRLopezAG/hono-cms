---
title: "feat: Draft/Publish State Machine — Opt-In Lifecycle, Preview Tokens, Scheduled Publishing"
date: 2026-05-16
type: feat
status: active
depth: deep
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
ideation-ideas: ["#10 Draft & Publish — Opt-In Content State Machine Per Collection"]
---

# feat: Draft/Publish State Machine — Opt-In Lifecycle, Preview Tokens, Scheduled Publishing

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 2
**Research inputs used:** skill review, architecture review, security review, flow review

### Key Improvements

1. Clarify lifecycle transition rules around `published_at`, unschedule, and unpublish behavior.
2. Tighten preview-token defaults and auditability.
3. Surface scheduling timezone and conflict rules before implementation begins.

## Summary

This plan implements the complete draft/publish lifecycle for `@hono-cms`: an opt-in per-collection state machine that adds CMS-managed `status` and `published_at` columns, enforce public-API filtering, enable preview token bypasses, and coordinate with the scheduled publishing cron job from Plan 010. It is Plan 016 of 18 and covers seven implementation units spanning schema extension (U1), publish/unpublish operations (U2), public API filtering (U3), preview token generation and verification (U4), scheduled publishing integration (U5), the admin publish UI panel (U6), and status filtering on populated relations (U7).

The feature mirrors what Strapi's Document Service provides as a core primitive, but makes three deliberate structural improvements: the `status` field is CMS-managed and cannot be overridden by user-defined fields; the public-filter is applied unconditionally at the query layer (not in application code the developer writes); and preview tokens are stored in Redis with TTL rather than being signed JWTs, enabling explicit revocation without coordination.

---

## Problem Frame

Strapi v5's Document Service treats draft/publish as a first-class collection property, and it is one of the most-used CMS features — virtually every editorial workflow requires a separation between in-progress content and live content. The new CMS must match this capability while avoiding Strapi's two recurring pain points: the `status` field is user-reachable in the Strapi REST API (you can pass `status: 'published'` on a create request to bypass the default 'draft' state), and the published filter is not automatically applied to nested populated relations (a published article with a draft author still returns the draft author data to public callers in some Strapi configurations).

This plan closes both gaps and adds first-class scheduled publishing, which Strapi gates behind a plugin.

(see origin: `docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md`, Idea #10)

---

## Scope Boundaries

### In scope

- `draftAndPublish: true` flag on `defineCollection` adds `status` and `published_at` schema columns
- `status` field is CMS-managed and fully hidden from user-facing forms and API inputs
- `publishDocument` and `unpublishDocument` service functions with idempotency guarantees
- Automatic `WHERE status = 'published'` filter on all public `findMany`/`findOne` queries
- Admin/editor bypass: no status filter for authenticated admin or editor roles
- Preview token API: `POST /api/preview-tokens`, Redis-backed, 1-hour TTL
- Preview token bypass: single-document draft access for token holders
- Cursor pagination encoding that accounts for admin vs. public status visibility
- Scheduled publish job integration (calls `publishDocument` for documents where `published_at <= NOW()`)
- Admin SPA publish panel: status badge, Publish/Unpublish buttons, schedule date picker, preview link copy
- Status filter on populated relations: public callers cannot access draft-status related documents

### Deferred to Follow-Up Work

- Multi-step editorial workflows (draft → review → approved → published) — post-v1 plugin surface
- Version history / document snapshots — planned separately
- Per-locale draft/publish state — intersects with Plan 019 (i18n); deferred to that plan
- Collaborative real-time draft editing (SSE, WebSocket) — post-v1
- Draft-only relations: allowing a draft document to have relations to other draft documents with special access — deferred; current behavior is uniform status filtering on all relations

### Outside this product's identity

- Strapi's "two-version" model where draft and published are separate DB rows — this plan uses a single row with a `status` column; no row duplication
- Full document versioning / revision history — this is an audit concern (Plan 021), not a publish-lifecycle concern
- Multi-environment promotion (staging → production publish) — out of scope for v1

---

## Key Technical Decisions

## Research Insights

**Best Practices:**
- Model transition rules explicitly for draft, scheduled, published, unpublished, and previewable states instead of relying on `published_at` inference alone.
- Treat preview tokens as revocable credentials with shorter default TTLs, audit visibility, and optional single-use or audience binding.
- Keep publish side effects consistent across cache invalidation, audit events, webhooks, and scheduled job execution.

**Performance Considerations:**
- Scheduled publish queries should rely on bounded batches plus status/time indexes instead of broad periodic scans.
- Avoid re-running expensive relation/cache side effects when retries or duplicate schedule triggers occur.

**Edge Cases:**
- Define what unpublish does to `published_at`, how unschedule works, and how past dates are validated.
- Lock a canonical UTC/local-time contract now; scheduling behavior should not be deferred to the implementer.

### 1. Why `status` is CMS-managed, not user-defined

If `status` were a regular user-defined field, a developer could:

- Pass `status: 'published'` in a `POST /api/articles` body and bypass the draft-first invariant
- Define `fieldPermissions: { status: ['admin'] }` and accidentally lock editors out of the publish button
- Rename it (e.g., `publishStatus`) and break the public filter, which would look for `status = 'published'` and find nothing

By injecting `status` as a system field inside `defineCollection` — exactly like `id`, `createdAt`, and `updatedAt` — the CMS makes these mistakes structurally impossible. The `RESERVED_FIELD_NAMES` list already includes `status` (Plan 005, U2), so a user attempting `fields: { status: { type: 'string' } }` receives a `DefinitionError` at definition time. The CMS owns the field, controls its values, and applies its filter unconditionally.

This mirrors the same reasoning that justifies CMS-owned `id` and `createdAt`: correctness through unavailability, not through documentation.

### 2. Preview token in Redis vs. signed JWT

A signed JWT for preview access requires no server-side state, which is appealing. However:

- **Revocation**: if an admin shares a preview link and later wants to invalidate it before the expiry, a signed JWT cannot be revoked without a blocklist (which requires server state anyway). Redis TTL-based tokens can be explicitly deleted: `DEL preview:{token}`.
- **Audit**: Redis allows inspecting active tokens (`SCAN preview:*`) for debugging and administrative visibility. Signed JWTs are opaque once issued.
- **Complexity parity**: generating a 32-byte random hex token and storing it in Redis is no more complex than signing and verifying a JWT. Both require a secret; both expire. Redis removes the JWT signature-verification failure mode entirely.
- **Plan 009 integration**: the cache layer is already required for session caching and content response caching. Adding preview tokens to the same Redis instance is zero marginal infrastructure.

Redis TTL handles cleanup automatically — no cron job, no expired-token accumulation. This is the canonical Redis pattern.

### 3. Status filter with cursor pagination

Public callers can only see `status = 'published'` documents. Admin callers see all. This creates a cursor encoding problem: if the cursor is an opaque `id` value, an admin paginating through `[draft, published, draft, published]` produces a cursor that points to a `draft` document. If a public caller submits that cursor, the keyset scan starting from the draft document's `id` is technically valid but the public caller cannot access the draft document — the filter skips it and returns the next published document. This is correct behavior, but only if the cursor encodes the `id` (not a `(status, id)` pair).

The correct approach: cursors encode only the `id` (a CUID2 string). The status filter is applied as an independent `WHERE` clause. An admin cursor submitted by a public caller simply starts the keyset scan from the given `id` and applies `WHERE status = 'published'` — some documents are skipped, the next published document is returned. No information leak occurs because the public caller never receives draft document data; they only receive a cursor that happens to be positioned at a draft document's `id`.

This means public callers may observe non-sequential gaps in paginated results (fewer records per page than `pageSize` when many drafts exist between published documents). This is acceptable and documented behavior — it is the correct tradeoff between cursor portability and result density.

For the admin: no status filter is applied, so the cursor is always accurate to position. No special cursor encoding is required.

### 4. Why scheduled publishing is a job, not a DB trigger

DB triggers (Postgres `pg_notify`, `AFTER UPDATE` triggers, `pg_cron`) would be the "zero-infrastructure" option for firing a publish when `published_at <= NOW()`. They are rejected for three reasons:

- **Portability**: the CMS targets D1, Turso/libSQL, and SQLite in addition to Postgres. None of these databases have a first-class equivalent to Postgres `pg_notify` or `pg_cron`. A trigger-based implementation would be adapter-specific and would require a feature flag or conditional per adapter.
- **Event system integration**: `publishDocument()` fires the `{collection}.publish` event (for webhooks, audit log, cache invalidation). DB triggers cannot call external HTTP endpoints or Hono event emitters — they are constrained to DB-side logic. The job model calls `publishDocument()` directly, reusing the same code path as a manual publish action.
- **Testability**: a scheduled job called via HTTP is straightforwardly testable with a mock HTTP call. A DB trigger requires trigger-aware test infrastructure.

The job model from Plan 010 (`/cms/jobs/scheduled-publish`) is the right abstraction: a normal Hono route handler called by QStash, Vercel Cron, or Cloudflare Scheduled on a 1-minute interval. It is portable, testable, and integrates with the event system.

### 5. Transaction safety for publish operation and event fire

The `publishDocument` function must:
1. Verify current status (read from DB)
2. Update `status` to `'published'` and `published_at` to `NOW()` (write to DB)
3. Fire the `{collection}.publish` event (call event emitters: webhook delivery, audit log write, cache invalidation)

Steps 1–2 can run in a single DB transaction. Step 3 (event fire) is outside the DB transaction boundary — most event side effects (HTTP webhook delivery, Redis invalidation) are not transactional with the DB write. The approach is:

- Wrap steps 1–2 in a `db.transaction()` block
- Fire events after the transaction commits successfully
- If the transaction rolls back (e.g., optimistic concurrency failure), events are not fired — correct behavior
- If events fail after a successful DB commit: the document is published in the DB regardless. Event delivery is best-effort (webhook retry logic from Plan 010 handles retries). This is the standard pattern for distributed systems with no two-phase commit.

The `idempotency` invariant (publishing an already-published document is a no-op) prevents double-publishing if `publishDocument` is called twice concurrently on the same document. The idempotency check reads the current status inside the transaction; if status is already `'published'`, the transaction returns early without updating and without firing events.

---

## High-Level Technical Design

> This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

### State machine

```
 ┌──────────────────────────────────────────────────────────────┐
 │                     Document lifecycle                       │
 │                                                              │
 │  CREATE ──────────────────────────────────► DRAFT            │
 │                                              │               │
 │                         publishDocument()    │               │
 │                    ┌────────────────────────►│               │
 │                    │                         ▼               │
 │                 DRAFT ◄──────────── PUBLISHED                │
 │                          unpublishDocument()                 │
 │                                                              │
 │  scheduledPublishJob():                                      │
 │    finds DRAFT where published_at <= NOW()                   │
 │    calls publishDocument() for each                          │
 └──────────────────────────────────────────────────────────────┘
```

### Public API filter decision tree

```
Incoming request to /api/{collection}
          │
          ▼
  Is collection draftAndPublish?
          │
     No ──┴── Yes
     │         │
     │         ▼
     │   ?preview=TOKEN present?
     │         │
     │    No ──┴── Yes → verifyPreviewToken(token)
     │    │              │
     │    │         Invalid ──► treat as no preview
     │    │         Valid   ──► bypass status filter for that documentId only
     │    │
     │    ▼
     │   user role == admin|editor?
     │         │
     │    Yes ─┴─ No
     │    │        │
     │    │        ▼
     │    │   Add WHERE status = 'published'
     │    │
     ▼    ▼
  Execute DB query
```

### Package integration map

```
packages/core/src/content/publish.ts    ← U2: publishDocument, unpublishDocument
packages/core/src/content/preview.ts    ← U4: generatePreviewToken, verifyPreviewToken
packages/core/src/content/query.ts      ← U3: applyStatusFilter (extends Plan 006 query logic)
packages/core/src/jobs/scheduled-publish.ts ← U5: scheduledPublishJob
apps/admin/src/components/publish/      ← U6: publish panel UI components

Integrations:
  packages/cache/   ← U4 preview token storage (Plan 009)
  packages/jobs/    ← U5 scheduled cron registration (Plan 010)
  packages/schema/  ← U1 schema extension (Plan 005)
```

### Cursor encoding for mixed-status admin views

```
Admin cursor (no status filter):
  cursor = base64url(id)

Public cursor (status = 'published' filter applied):
  cursor = base64url(id)   ← same encoding; filter is applied independently
  A cursor pointing to a draft id simply skips to the next published document.
  No information leak; no special encoding needed.
```

---

## Output Structure

```
packages/core/src/content/
  publish.ts          ← publishDocument, unpublishDocument (U2)
  preview.ts          ← generatePreviewToken, verifyPreviewToken (U4)
packages/core/src/jobs/
  scheduled-publish.ts ← scheduledPublishJob (U5)
packages/core/src/__tests__/content/
  publish.test.ts
  preview.test.ts
packages/core/src/__tests__/jobs/
  scheduled-publish.test.ts

apps/admin/src/components/publish/
  PublishPanel.tsx     ← status badge + action buttons (U6)
  SchedulePicker.tsx   ← date picker for published_at (U6)
  PreviewLinkButton.tsx ← calls POST /api/preview-tokens, copies URL (U6)
apps/admin/src/__tests__/components/publish/
  PublishPanel.test.tsx
```

---

## Implementation Units

### U1. draftAndPublish Schema Extension

**Goal:** Extend the Drizzle schema generator (Plan 005, U3) to detect `draftAndPublish: true` on a `CollectionDefinition` and emit two additional columns — `status` and `published_at` — along with a composite index on `(status, id)`. Ensure the `status` field is classified as a system field (hidden from content forms, not writable via the public API).

**Requirements:**
- `status TEXT NOT NULL DEFAULT 'draft'` column added when `draftAndPublish: true`
- `published_at TIMESTAMP` (nullable) column added when `draftAndPublish: true`
- Composite index `idx_{collection}_status_id ON (status, id)` emitted for efficient `WHERE status = 'published' ORDER BY id` queries
- `status` and `published_at` injected into `_systemFields` by `defineCollection` — already partially covered by Plan 005 U2 which listed `publishedAt` and `status` in `RESERVED_FIELD_NAMES`; this unit verifies the Drizzle column output is correct
- Admin content forms render `status` as a read-only badge indicator, not as an editable select input; `published_at` is rendered as the schedule picker (U6), not as a raw datetime field
- API create/update routes strip `status` and `published_at` from the request body before reaching the adapter — they cannot be set by the caller

**Dependencies:** Plan 005 U1 (FieldDefinition types), Plan 005 U2 (defineCollection with system field injection), Plan 005 U3 (Drizzle table generator).

**Files:**
- `packages/schema/src/drizzle-generator.ts` — add `status` and `published_at` column emission and index declaration when `draftAndPublish: true`
- `packages/schema/src/define-collection.ts` — verify system field injection already handles `status` and `publishedAt`; add column-level metadata indicating `hidden: true` for the form layer
- `packages/schema/src/types/system-fields.ts` — add `DraftPublishSystemFields` type variant
- `packages/schema/__tests__/drizzle-generator.test.ts` — add test cases for draftAndPublish columns and index
- `packages/core/src/routes/collection-router.ts` — strip `status` and `published_at` from create/update request body validation

**Approach:**

The `generateDrizzleSchema` function already conditionally emits `published_at` and `status` columns when `collection.draftAndPublish === true` (per Plan 005 U3 system field mapping). This unit verifies the exact column definitions are correct for the query pattern:

- `status`: `text('status', { enum: ['draft', 'published'] }).notNull().default('draft')` — not nullable, not null-able via the adapter
- `published_at`: `integer('published_at', { mode: 'timestamp' })` — nullable; absence means no scheduled publish date

Index generation: after the table declaration, the generator emits an index expression. Drizzle's `index()` API: `index('idx_{name}_status_id').on(table.status, table.id)`. This index supports the most common public query pattern: `WHERE status = 'published' ORDER BY id LIMIT n`.

The `_systemFields` entry for `status` carries an additional `formBehavior: 'status-badge'` metadata key; the entry for `publishedAt` carries `formBehavior: 'schedule-picker'`. The admin SPA reads these keys to determine how to render the field — as a status badge widget or as the schedule date picker — rather than as a generic editable input. This avoids hardcoding field names in the admin form renderer.

The create/update route handlers (Plan 006, U1) already apply Zod schema validation to the request body using `collectionToZodSchema(collection)`. Since `status` and `publishedAt` are in `_systemFields` and not in `fields`, they are absent from the Zod create/update schema. Any request body that includes them is silently stripped by Zod's `.strip()` mode (the default). No additional logic is required in the route handler.

**Technical design (directional):**

```
// In generateDrizzleSchema, when collection.draftAndPublish === true:
// System column declarations (added after user fields, before createdAt/updatedAt):
//   text('status', { enum: ['draft', 'published'] }).notNull().default('draft')
//   integer('published_at', { mode: 'timestamp' })   ← nullable, no .notNull()
//
// Index declaration (emitted after table closing brace):
//   export const {name}StatusIdx = index('idx_{name}_status_id')
//     .on({name}Table.status, {name}Table.id)
```

**Test scenarios:**

- A collection with `draftAndPublish: true` produces a Drizzle schema string containing `text('status', { enum: ['draft', 'published'] }).notNull().default('draft')`
- The same collection produces `integer('published_at', { mode: 'timestamp' })` without `.notNull()`
- The schema string contains an `index('idx_{name}_status_id')` declaration referencing both `status` and `id` columns
- A collection with `draftAndPublish: false` (or omitted) does NOT include `status`, `published_at`, or the index
- `defineCollection({ draftAndPublish: true, fields: { status: { type: 'string' } } })` throws `DefinitionError` with code `'RESERVED_FIELD_NAME'`
- `defineCollection({ draftAndPublish: true, fields: { publishedAt: { type: 'datetime' } } })` throws `DefinitionError` with code `'RESERVED_FIELD_NAME'`
- `_systemFields` on a `draftAndPublish: true` collection contains exactly `{ status, publishedAt, id, createdAt, updatedAt, createdBy, updatedBy }` (7 fields)
- A POST request to `/api/articles` with body `{ title: 'hello', status: 'published' }` results in the status being stripped; the created document has `status: 'draft'`
- A PATCH request to `/api/articles/{id}` with body `{ status: 'published' }` does not change the document's status; only `publishDocument()` transitions status

**Verification:** Drizzle schema snapshot tests are stable. Integration test: create a document via the REST API with `status: 'published'` in the body; verify the persisted `status` is `'draft'`.

---

### U2. Publish and Unpublish Operations

**Goal:** Implement `publishDocument(collection, id, db, events)` and `unpublishDocument(collection, id, db, events)` in `packages/core/src/content/publish.ts`. These are the only two code paths that transition document status — all UI actions, API routes, and the scheduled job call them.

**Requirements:**
- `publishDocument`: reads current status; if already `'published'`, returns early (no-op, not an error); updates `status → 'published'` and `published_at → NOW()` inside a DB transaction; fires `{collection}.publish` event after commit
- `unpublishDocument`: reads current status; if already `'draft'`, returns early; updates `status → 'draft'` and `published_at → NULL` inside a DB transaction; fires `{collection}.unpublish` event after commit
- Both functions throw `DocumentNotFoundError` if the document does not exist
- Both functions throw `CollectionNotDraftPublishError` if the collection does not have `draftAndPublish: true`
- Status read and status update are in the same transaction to prevent TOCTOU race
- Event fire happens after successful transaction commit; if event fire fails, the status change is NOT rolled back (events are best-effort)

**Dependencies:** U1 (schema columns must exist), Plan 005 U2 (defineCollection), Plan 006 U1 (route factory provides the collection definition), Plan 004 (auth context for event metadata).

**Files:**
- `packages/core/src/content/publish.ts` — `publishDocument`, `unpublishDocument`, `PublishResult`, error types
- `packages/core/src/routes/collection-router.ts` — add `POST /:id/publish` and `POST /:id/unpublish` routes that call these functions
- `packages/core/src/__tests__/content/publish.test.ts`

**Approach:**

Both functions share a common shape. The implementation uses Drizzle's `db.transaction()` to ensure the read-then-write is atomic:

```
publishDocument(collection, id, db, events):
  1. Assert collection.draftAndPublish === true, else throw CollectionNotDraftPublishError
  2. db.transaction(async (tx) => {
       const doc = await tx.select({ status }).from(table).where(eq(id_col, id)).for('update')
       if (!doc) throw DocumentNotFoundError
       if (doc.status === 'published') return { alreadyPublished: true }  // idempotent no-op
       await tx.update(table)
         .set({ status: 'published', publishedAt: new Date() })
         .where(eq(id_col, id))
     })
  3. await events.emit(`${collection.name}.publish`, { id, collection: collection.name, publishedAt })
  4. return { published: true, publishedAt }
```

The `for('update')` row-level lock (SQLite: serialized transactions handle this implicitly; Postgres: `SELECT ... FOR UPDATE`) prevents two concurrent `publishDocument` calls on the same document from both reading `status: 'draft'` and both proceeding to update. The second one reads `status: 'published'` after the first commits and short-circuits.

For SQLite and D1 (which do not support `SELECT FOR UPDATE`): Drizzle transactions on SQLite are serialized at the connection level. The transaction wrapping is still correct — concurrent writes are serialized by the SQLite write lock. No special handling is needed.

The API routes:

- `POST /api/{collection}/{id}/publish` — requires admin or editor role (Plan 006 RBAC middleware); calls `publishDocument`; returns `{ data: { id, status: 'published', publishedAt } }`
- `POST /api/{collection}/{id}/unpublish` — same auth requirement; calls `unpublishDocument`; returns `{ data: { id, status: 'draft', publishedAt: null } }`

These routes are only registered when `collection.draftAndPublish === true`. The route factory skips them for collections without the flag.

**Test scenarios:**

- `publishDocument` on a `status: 'draft'` document: DB row transitions to `status: 'published'`; `published_at` is set to a timestamp approximately equal to `NOW()`; the `articles.publish` event is emitted with the document id
- `publishDocument` on a `status: 'published'` document: returns `{ alreadyPublished: true }`; no DB write occurs (verify with a spy on the DB update function); no event is emitted
- `unpublishDocument` on a `status: 'published'` document: DB row transitions to `status: 'draft'`; `published_at` is set to `null`; the `articles.unpublish` event is emitted
- `unpublishDocument` on a `status: 'draft'` document: returns `{ alreadyDraft: true }`; no DB write; no event
- `publishDocument` on a non-existent `id`: throws `DocumentNotFoundError`
- `publishDocument` on a collection with `draftAndPublish: false`: throws `CollectionNotDraftPublishError`
- Concurrent publish race: two calls to `publishDocument` with the same id run concurrently; exactly one event fires (idempotency under concurrency — test with `Promise.all` and a mock DB that introduces a delay)
- Event fire failure after successful DB commit: the status remains `'published'` in the DB; the error from the event system is logged but not re-thrown (document is not rolled back)
- `POST /api/articles/{id}/publish` with `public` role: returns `403 Forbidden`
- `POST /api/articles/{id}/publish` with `editor` role: returns `200 OK` with the updated document
- A collection without `draftAndPublish: true` does NOT have `/publish` and `/unpublish` routes registered (404 response)

**Verification:** Integration test: create a document, call the publish route, query the document directly from the DB, assert `status === 'published'`. Call publish again, assert the event was NOT fired a second time.

---

### U3. Public API Status Filtering

**Goal:** Extend `findMany` and `findOne` route handlers to apply `WHERE status = 'published'` automatically for unauthenticated and public-role callers. Admin and editor role callers see all documents. Preview token holders bypass the filter for a single specific document. Cursor pagination works correctly across both admin and public filter modes.

**Requirements:**
- Filter applies only to collections with `draftAndPublish: true`; collections without the flag are unaffected
- Auth context is read from `c.get('user')` (set by Plan 004 auth middleware)
- Role `null`, `'public'`, or `'authenticated'`: add `WHERE status = 'published'`
- Role `'admin'` or `'editor'`: no status filter
- `?preview=TOKEN`: verify token via `verifyPreviewToken`; if valid, bypass filter for the specific `documentId` embedded in the token; if invalid or absent, fall through to role-based logic
- Preview bypass applies only to `findOne` (by definition — the token encodes a specific documentId)
- For `findMany` with a valid preview token: still apply the published filter (the token is not a blanket bypass for the entire collection)
- Cursor pagination is not affected by filter mode — cursors encode only `id`; the status filter is applied as an independent `WHERE` clause

**Dependencies:** U1 (status column exists), U4 (preview token verification), Plan 006 U2 (query parser and filter application layer).

**Files:**
- `packages/core/src/content/query.ts` — `buildStatusFilter(collection, ctx, previewToken?)` function
- `packages/core/src/routes/collection-router.ts` — integrate `buildStatusFilter` into `findMany` and `findOne` handlers
- `packages/core/src/__tests__/content/query.test.ts` — status filter unit tests

**Approach:**

A `buildStatusFilter` function encapsulates the decision tree described in the High-Level Technical Design. It returns a Drizzle `where` condition (or `undefined` for no filter) to be composed with the existing query conditions:

```
buildStatusFilter(collection, userRole, previewDocumentId?):
  if !collection.draftAndPublish: return undefined
  if userRole === 'admin' || userRole === 'editor': return undefined
  if previewDocumentId: return eq(table.id, previewDocumentId)  // bypass for this doc only
  return eq(table.status, 'published')
```

For `findOne`:

```
findOne handler:
  const previewToken = c.req.query('preview')
  let previewDocumentId: string | undefined
  if (previewToken) {
    const result = await verifyPreviewToken(previewToken, cache)
    if (result && result.documentId === params.id && result.collection === collection.name) {
      previewDocumentId = result.documentId
    }
  }
  const statusFilter = buildStatusFilter(collection, userRole, previewDocumentId)
  const doc = await adapter.findOne(collection, params.id, { ...queryParams, where: statusFilter })
  if (!doc) return c.json({ error: 'Not found' }, 404)
```

For `findMany`:

```
findMany handler:
  const statusFilter = buildStatusFilter(collection, userRole)  // no preview bypass for list
  const result = await adapter.findMany(collection, { ...queryParams, where: statusFilter })
```

The preview token check for `findOne` validates three things: the token is valid (Redis GET succeeds), the `documentId` in the token matches the requested `id`, and the `collection` in the token matches the current collection. A token for a different document or collection is treated as invalid and falls through to role-based filtering.

**Cursor pagination interaction:**

The query parser (Plan 006) produces a cursor condition like `WHERE id > {cursor_id}`. This is composed with `AND status = 'published'` using Drizzle's `and()` combinator. Both conditions apply independently. A public caller paginating through published-only results receives a cursor that may internally point to a position adjacent to draft documents — on the next page request, the draft documents are simply filtered out. This produces correct results; page sizes may vary slightly when many drafts exist in the cursor range.

No special cursor encoding is needed. The cursor is portable across admin and public sessions.

**Test scenarios:**

- Unauthenticated `GET /api/articles`: only published documents returned; draft documents absent from results
- `GET /api/articles` with admin session: all documents (draft and published) returned
- `GET /api/articles` with editor session: all documents returned
- `GET /api/articles/{id}` where document is `status: 'draft'` and caller is unauthenticated: returns `404 Not Found`
- `GET /api/articles/{id}` where document is `status: 'draft'` and caller is admin: returns the document
- `GET /api/articles/{id}?preview={validToken}` where token encodes `{ documentId: id, collection: 'articles' }`: returns the draft document to an unauthenticated caller
- `GET /api/articles/{id}?preview={tokenForDifferentId}`: token validation fails (documentId mismatch); falls through to role-based filter; unauthenticated caller gets `404`
- `GET /api/articles/{id}?preview={expiredToken}` (Redis key absent): falls through to role-based filter; `404`
- `GET /api/articles?preview={validToken}`: preview token is present but `findMany` ignores it; published filter still applies; draft documents absent
- Cursor pagination for public caller: page 1 returns 10 published documents; cursor from page 1 submitted for page 2 correctly returns the next 10 published documents even if draft documents exist between them
- Collection without `draftAndPublish: true`: no status filter applied regardless of caller role; all documents returned
- `buildStatusFilter` with `draftAndPublish: true`, role `null`: returns `eq(table.status, 'published')`
- `buildStatusFilter` with `draftAndPublish: true`, role `'admin'`: returns `undefined`
- `buildStatusFilter` with `draftAndPublish: false`, any role: returns `undefined`

**Verification:** Integration test against a real SQLite DB with a mix of draft and published documents: assert that public API calls return only published, admin calls return all, and preview tokens work for single-document bypass.

---

### U4. Preview Token Generation and Verification

**Goal:** Implement `generatePreviewToken(documentId, collection, cache)` and `verifyPreviewToken(token, cache)` in `packages/core/src/content/preview.ts`, and wire `POST /api/preview-tokens` as an admin-only route. Tokens are stored in Redis (Plan 009 cache layer) with a 1-hour TTL.

**Requirements:**
- Token is a cryptographically random 32-byte value encoded as a 64-character lowercase hex string
- Redis key: `preview:{token}` → JSON `{ documentId, collection, createdAt }`, TTL 3600 seconds
- `POST /api/preview-tokens` body: `{ documentId: string, collection: string }` — admin/editor role required
- Response: `{ token, expiresAt, previewUrl }` where `previewUrl` is the configured frontend preview URL with `?preview={token}` appended
- `verifyPreviewToken(token, cache)`: Redis GET on `preview:{token}`; if miss or parse error, returns `null`; if hit, returns `{ documentId, collection }`
- Token is NOT refreshed on access — TTL is set once at creation; verifying a token does not reset its expiry
- No cleanup job needed — Redis TTL handles expiry automatically

**Dependencies:** Plan 009 (cache adapter interface with `get`, `set` with TTL), U1 (collection must have `draftAndPublish: true` to issue a preview token for it).

**Files:**
- `packages/core/src/content/preview.ts` — `generatePreviewToken`, `verifyPreviewToken`, `PreviewTokenPayload` type
- `packages/core/src/routes/preview-router.ts` — `POST /api/preview-tokens` route handler
- `packages/core/src/__tests__/content/preview.test.ts`

**Approach:**

Token generation uses `crypto.getRandomValues` (Web Crypto API, available in all target runtimes including Cloudflare Workers and Node.js 20+) to fill a 32-byte `Uint8Array`, then converts to lowercase hex:

```
generatePreviewToken(documentId, collection, cache):
  1. Assert collection.draftAndPublish === true, else throw error
  2. const bytes = new Uint8Array(32)
     crypto.getRandomValues(bytes)
     const token = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  3. const payload = { documentId, collection, createdAt: new Date().toISOString() }
  4. await cache.set(`preview:${token}`, JSON.stringify(payload), { ex: 3600 })
  5. const expiresAt = new Date(Date.now() + 3600_000).toISOString()
  6. return { token, expiresAt }
```

The `POST /api/preview-tokens` route handler:

```
POST /api/preview-tokens:
  body: { documentId: string, collection: string }
  1. Validate body with Zod
  2. Look up collection definition from SchemaCache
  3. Assert collection.draftAndPublish === true
  4. Assert document exists (optional DB lookup — prevents issuing tokens for non-existent docs)
  5. const { token, expiresAt } = await generatePreviewToken(documentId, collection, cache)
  6. const previewUrl = `${config.previewUrl}?preview=${token}`
  7. return c.json({ token, expiresAt, previewUrl })
```

The `config.previewUrl` is a `createCMS` config option: `previewUrl: string` — the base URL of the developer's frontend. It defaults to `'http://localhost:3000'` for local dev. This is the URL that the frontend receives and opens in a new tab to show the draft preview.

`verifyPreviewToken(token, cache)`:

```
1. if (!token || token.length !== 64) return null  // fast-path invalid format
2. const raw = await cache.get(`preview:${token}`)
3. if (!raw) return null
4. try { return JSON.parse(raw) as PreviewTokenPayload }
5. catch { return null }
```

**Test scenarios:**

- `generatePreviewToken` produces a 64-character lowercase hex string
- Two calls to `generatePreviewToken` produce different tokens (probabilistic — check they are not equal)
- The generated token is stored in Redis under `preview:{token}` with TTL 3600s (verify via `cache.get` and a mock that captures the TTL option)
- `verifyPreviewToken` with a valid token (stored in mock Redis): returns `{ documentId, collection, createdAt }`
- `verifyPreviewToken` with an unknown token (not in Redis): returns `null`
- `verifyPreviewToken` with a malformed token (length != 64): returns `null` immediately without a Redis call
- `verifyPreviewToken` with corrupted Redis value (not valid JSON): returns `null`
- `POST /api/preview-tokens` with admin role, valid `{ documentId, collection }`: returns `{ token, expiresAt, previewUrl }` where `previewUrl` ends with `?preview={token}`
- `POST /api/preview-tokens` with `public` role: returns `403 Forbidden`
- `POST /api/preview-tokens` for a collection without `draftAndPublish: true`: returns `400 Bad Request` with an appropriate error message
- `POST /api/preview-tokens` with missing `documentId`: Zod validation fails; returns `422 Unprocessable Entity`
- Token is not refreshed by `verifyPreviewToken` — TTL does not reset on verification (verify mock Redis was not called with `SET` during verification)
- Latency: `verifyPreviewToken` requires exactly one Redis GET call (assert mock was called once)

**Verification:** Integration test with a real Upstash Redis instance (or an in-memory cache mock that respects TTL): generate a token, verify immediately (success), wait for TTL expiry in a fast-forward test, verify again (null). Admin-only route gate confirmed via role-restricted test requests.

---

### U5. Scheduled Publishing Job

**Goal:** Implement `scheduledPublishJob(db, schema, events)` in `packages/core/src/jobs/scheduled-publish.ts`. This function finds all `draftAndPublish: true` collection documents where `status = 'draft'` AND `published_at <= NOW()`, then publishes each using `publishDocument()`. It is called by the Plan 010 cron system via `POST /cms/jobs/scheduled-publish` on a 1-minute interval.

**Requirements:**
- Query across ALL collections that have `draftAndPublish: true` in the loaded schema
- Find at most 100 documents per run (batch size limit to prevent timeout)
- Call `publishDocument()` for each, reusing the same idempotency and event-firing logic
- Idempotent: if `publishDocument()` returns `{ alreadyPublished: true }`, skip without error
- Log the count of published documents per run (structured log entry)
- Job endpoint is authenticated by the cron provider's signature verification (Plan 010) — not by better-auth session

**Dependencies:** U1 (schema columns), U2 (`publishDocument`), Plan 010 (job registration and cron provider), Plan 005 U7 (SchemaCache to get current collection definitions).

**Files:**
- `packages/core/src/jobs/scheduled-publish.ts` — `scheduledPublishJob` function
- `packages/core/src/routes/jobs-router.ts` — `POST /cms/jobs/scheduled-publish` route (from Plan 010 — this unit extends it)
- `packages/core/src/__tests__/jobs/scheduled-publish.test.ts`

**Approach:**

The job function is a pure async function that accepts injected dependencies (no module-level singletons):

```
scheduledPublishJob(db, schema, events):
  const BATCH_SIZE = 100
  const now = new Date()

  // Find all draftAndPublish collections in the loaded schema
  const dpCollections = schema.filter(c => c.draftAndPublish === true)

  let totalPublished = 0

  for (const collection of dpCollections) {
    const table = getTableForCollection(collection)
    // Find draft documents with a past/present published_at timestamp
    const candidates = await db
      .select({ id: table.id })
      .from(table)
      .where(and(
        eq(table.status, 'draft'),
        lte(table.publishedAt, now)
      ))
      .limit(BATCH_SIZE)

    for (const { id } of candidates) {
      const result = await publishDocument(collection, id, db, events)
      if (result.published) totalPublished++
      // result.alreadyPublished means a concurrent publish happened — skip silently
    }
  }

  return { published: totalPublished, at: now.toISOString() }
```

The 100-document batch limit is per-run across all collections. If a single collection has 200 documents due for publish, the first 100 are processed and the remainder are handled in the next cron tick (1 minute later). This prevents long-running job timeouts on Cloudflare Workers (30-second CPU limit) and Vercel Edge Functions.

The `for` loop over candidates is sequential (not `Promise.all`) to avoid overwhelming the DB with parallel writes and to keep event ordering deterministic. For most real-world deployments, scheduled publishes are infrequent enough that sequential processing at batch=100 is fast enough.

The cron route `POST /cms/jobs/scheduled-publish`:

```
POST /cms/jobs/scheduled-publish:
  1. Verify cron provider signature (Plan 010 middleware)
  2. const schema = SchemaCache.get()
  3. const result = await scheduledPublishJob(db, schema, events)
  4. log.info('scheduled-publish', result)
  5. return c.json(result)
```

**Test scenarios:**

- Job with no `draftAndPublish` collections: returns `{ published: 0 }`
- Job with one collection containing 3 draft documents with `published_at` in the past: publishes all 3; `articles.publish` event fires 3 times
- Job with one collection containing 2 draft documents with `published_at` in the future: publishes 0; no events fired
- Job with one collection containing 150 draft documents with past `published_at`: publishes exactly 100 (batch limit); remaining 50 are processed in the next run
- Already-published documents (idempotency): if a document was manually published between when the job queried candidates and when `publishDocument` runs, `publishDocument` returns `{ alreadyPublished: true }`; no duplicate event fired; job continues without error
- Mixed collection: one collection with past `published_at`, one without — only the eligible collection's documents are published
- `POST /cms/jobs/scheduled-publish` without cron provider signature: returns `401 Unauthorized` (Plan 010 middleware)
- `POST /cms/jobs/scheduled-publish` with valid signature: returns `200 OK` with `{ published: N, at: ISO-timestamp }`
- Error in `publishDocument` for one document: job logs the error and continues to the next document (resilient iteration — one failure does not abort the batch)

**Verification:** Integration test: seed a SQLite DB with 5 draft articles with `published_at` set to 1 hour ago; call `scheduledPublishJob`; assert all 5 are now `status: 'published'` and 5 publish events were emitted. Add one article with `published_at` in the future; assert it is NOT published.

---

### U6. Admin Publish UI Panel

**Goal:** Implement the publish control panel in the admin SPA content edit form. The panel shows the current status badge, Publish/Unpublish action buttons, a schedule publish date picker for `published_at`, and a "Copy preview link" button. The Publish button is disabled when there are unsaved changes (TanStack Pacer auto-save must complete first). All state transitions are optimistic via TanStack Query mutations.

**Requirements:**
- Status badge: `DRAFT` (yellow) or `PUBLISHED` (green) — reflects current `status` field value
- Publish button: calls `POST /api/{collection}/{id}/publish`; disabled when `hasUnsavedChanges` (Jotai atom) is true
- Unpublish button: calls `POST /api/{collection}/{id}/unpublish`; always enabled when document is published
- Schedule picker: a datetime input bound to the `published_at` field; saving the form with a future `published_at` schedules auto-publish; clearing it removes the scheduled time
- Copy preview link button: calls `POST /api/preview-tokens` with the current document's id and collection; on success, copies the returned `previewUrl` to the clipboard via `navigator.clipboard.writeText`
- Optimistic update: after a publish mutation, TanStack Query invalidates `['articles', id]` query; the document refetches; status badge updates to reflect the new state
- Publish panel only renders when the collection has `draftAndPublish: true` (checked from the collection definition returned by the schema API)

**Dependencies:** U2 (publish/unpublish API routes), U3 (status is visible in document fetch response for admins), U4 (preview token API), Plan 005 (collection definition includes `draftAndPublish` flag), Plan 007 (admin SPA content edit form structure).

**Files:**
- `apps/admin/src/components/publish/PublishPanel.tsx` — parent panel component
- `apps/admin/src/components/publish/SchedulePicker.tsx` — datetime input for `published_at`
- `apps/admin/src/components/publish/PreviewLinkButton.tsx` — copy-to-clipboard preview link
- `apps/admin/src/hooks/usePublishMutation.ts` — TanStack Query mutation hooks for publish/unpublish
- `apps/admin/src/hooks/usePreviewToken.ts` — TanStack Query mutation for token generation
- `apps/admin/src/__tests__/components/publish/PublishPanel.test.tsx`

**Approach:**

`PublishPanel` receives the current document (fetched by TanStack Query from the content edit form) and the collection definition as props. It reads `hasUnsavedChanges` from a Jotai atom managed by the TanStack Pacer auto-save hook:

```
PublishPanel({ document, collection }):
  const hasUnsavedChanges = useAtomValue(unsavedChangesAtom)
  const { mutate: publish, isPending: isPublishing } = usePublishMutation(collection, document.id)
  const { mutate: unpublish, isPending: isUnpublishing } = useUnpublishMutation(collection, document.id)

  if (!collection.draftAndPublish) return null

  return (
    <div>
      <StatusBadge status={document.status} />
      <Publish button (disabled if hasUnsavedChanges || isPublishing) />
      <Unpublish button (disabled if isUnpublishing) />
      <SchedulePicker publishedAt={document.publishedAt} onChange={...} />
      <PreviewLinkButton documentId={document.id} collection={collection.name} />
    </div>
  )
```

`usePublishMutation`:

```
usePublishMutation(collection, id):
  return useMutation({
    mutationFn: () => client[collection][id].publish.$post(),  // Hono RPC typed call
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [collection, id] })
    },
    onError: (err) => {
      toast.error(`Publish failed: ${err.message}`)
    }
  })
```

The optimistic update pattern: after a successful publish, TanStack Query's `invalidateQueries` triggers a background refetch of the document. The status badge updates when the refetch completes. This is not a fully optimistic update (no local state mutation before server response) — the publish transition is meaningful enough that the server confirmation should be the source of truth. `isPending` shows a loading state during the request.

`SchedulePicker` is a controlled datetime-local input. When the user selects a future date and saves the form (via TanStack Pacer auto-save), the `published_at` value is sent to `PATCH /api/{collection}/{id}` with the datetime value. The publish route and the `published_at` field are independent — setting `published_at` does not immediately publish the document; the scheduled job (U5) handles the actual transition.

`PreviewLinkButton`:

```
PreviewLinkButton({ documentId, collection }):
  const { mutate: generateToken, isPending } = useMutation({
    mutationFn: () => client.previewTokens.$post({ json: { documentId, collection } }),
    onSuccess: ({ previewUrl }) => {
      navigator.clipboard.writeText(previewUrl)
      toast.success('Preview link copied to clipboard')
    }
  })
  return <button onClick={generateToken} disabled={isPending}>Copy preview link</button>
```

**Test scenarios:**

- `PublishPanel` renders `null` when `collection.draftAndPublish === false`
- Status badge renders `DRAFT` label when `document.status === 'draft'`
- Status badge renders `PUBLISHED` label when `document.status === 'published'`
- Publish button is disabled when `hasUnsavedChanges === true` (set via mock Jotai atom)
- Publish button is enabled when `hasUnsavedChanges === false` and `document.status === 'draft'`
- Clicking Publish button calls the publish mutation; on success, invalidates the document query
- Clicking Publish button when already published: the button should not be rendered (only show Publish when draft, Unpublish when published — one action visible at a time)
- Clicking Unpublish button calls unpublish mutation
- `PreviewLinkButton` click: calls `POST /api/preview-tokens`; on success, `navigator.clipboard.writeText` is called with the `previewUrl`; success toast is shown
- `PreviewLinkButton` during pending state: button is disabled
- Error from publish mutation: error toast is shown; status badge does not change
- `SchedulePicker` renders a datetime-local input with the current `publishedAt` value
- Clearing the schedule picker date sets `publishedAt` to `null` in the form state

**Verification:** Component tests with Vitest + Testing Library + jsdom. Mock the Hono RPC `hc` client and TanStack Query. Assert that: status badge reflects document status, publish button disabled on unsaved changes, clipboard API is called on successful token generation. Integration test: full publish flow from admin SPA against a test API server.

---

### U7. draftAndPublish and Populated Relations

**Goal:** Ensure that when `findMany` or `findOne` is called with `?populate=fieldName` and the related collection has `draftAndPublish: true`, the status filter is applied to the related documents according to the same role-based rules as the primary query. Public callers cannot see draft-status related documents even when they are referenced by a published primary document.

**Requirements:**
- Populate resolution (Plan 006, U5) must accept a `statusFilter` option and apply it when fetching related documents
- The status filter for relations uses the same `userRole` as the primary query — not re-derived per relation
- Relations to collections without `draftAndPublish: true` are unaffected (no filter added)
- For a `many-to-one` relation (e.g., `article.author` where `author` has `draftAndPublish: true`): if the author is `status: 'draft'` and the caller is public, the `author` field in the response is `null` (not an error — the field is simply absent/null)
- For a `one-to-many` or `many-to-many` relation (e.g., `article.tags`): only published tags are included in the array for public callers; draft tags are silently filtered out of the array
- Admin callers receive all related documents regardless of status

**Dependencies:** U3 (buildStatusFilter function), Plan 006 U5 (relation population logic), U1 (status column on related collections).

**Files:**
- `packages/core/src/content/query.ts` — extend `buildStatusFilter` to accept relation context; add `applyRelationStatusFilter` helper
- `packages/core/src/content/populate.ts` (or the relevant file from Plan 006) — integrate status filter into relation resolution
- `packages/core/src/__tests__/content/query.test.ts` — relation status filter test cases

**Approach:**

The populate resolution function (Plan 006 U5) fetches related documents using the DB adapter. It already accepts `whereConditions` for filtering relations. This unit adds status filter injection to that mechanism.

When resolving a `many-to-one` relation:

```
resolveRelation(field, relatedIds, userRole, cache):
  const relatedCollection = schema.find(c => c.name === field.target)
  const statusFilter = buildStatusFilter(relatedCollection, userRole)  // same logic as primary

  const relatedDocs = await db
    .select()
    .from(relatedTable)
    .where(and(
      inArray(relatedTable.id, relatedIds),
      statusFilter  // undefined if no filter needed
    ))

  // For many-to-one: if relatedDocs is empty (draft was filtered out), return null
  // For one-to-many / many-to-many: return only the docs that passed the filter
```

The behavior for `null` on `many-to-one` is intentional: a public API caller accessing an article with a draft author receives `{ id: '...', title: '...', author: null }`. This is not an error — it is the correct behavior analogous to a published article that has no author at all. Clients should handle nullable relation fields.

The behavior for arrays is also intentional: `{ id: '...', title: '...', tags: [] }` when all tags are drafts. The array is empty rather than absent.

Preview token bypass does NOT propagate to relations. A preview token grants access to a single specific document (the one whose id matches the token's `documentId`). The related documents of that document are still subject to normal role-based status filtering. This prevents a preview token for an article from granting access to all of its draft related content.

**Test scenarios:**

- `GET /api/articles/{id}?populate=author` where `author` has `draftAndPublish: true` and `author.status === 'draft'`, caller is public: `author` field in response is `null`
- Same request with admin caller: `author` field is the full draft author object
- `GET /api/articles?populate=tags` where 2 tags are published and 1 is draft, caller is public: `tags` array contains only the 2 published tags
- Same request with admin caller: `tags` array contains all 3 tags (published + draft)
- `GET /api/articles?populate=author` where related `authors` collection does NOT have `draftAndPublish: true`: all authors returned regardless of caller role (no filter applied)
- `GET /api/articles/{id}?preview={validToken}&populate=author` where article is draft (bypassed by token) and author is also draft: article is returned (token bypass); author is `null` (preview bypass does NOT propagate to relations)
- Deeply nested populate (if supported): `?populate[author][populate]=profile` where `profile` also has `draftAndPublish: true`: status filter applies at each depth level independently
- `GET /api/articles` without `?populate`: status filter on relations is not invoked (no relation resolution occurs)

**Verification:** Integration test with a multi-collection SQLite DB: create a published article with a draft author; assert that public `GET /api/articles/{id}?populate=author` returns `author: null`; assert that admin `GET /api/articles/{id}?populate=author` returns the full draft author object. Confirm array filtering for many-to-many.

---

## Risk Analysis

### R1: SQLite/D1 transaction semantics for concurrent publish

SQLite serializes all writes at the connection level — `SELECT FOR UPDATE` does not exist. For the single-writer model that most edge deployments use (one Worker instance or one Turso connection), this is safe. For distributed Node.js deployments with multiple worker processes sharing a Postgres DB, the `SELECT ... FOR UPDATE` lock inside `publishDocument`'s transaction prevents double-publish races.

For Cloudflare D1 specifically: D1 uses a Durable Object-backed SQLite instance, and writes are serialized through the DO. The transaction wrapping remains correct — there is no race condition even without explicit locking. However, the `publishDocument` idempotency check is the primary safety net regardless of DB backend.

**Mitigation:** Document the transaction behavior difference per adapter. Add an integration test that runs 10 concurrent `publishDocument` calls on the same document and asserts exactly 1 publish event was emitted.

### R2: Redis unavailability breaks preview token verification

If Upstash Redis is unavailable, `verifyPreviewToken` throws (or returns `null` depending on error handling). This means preview access fails, but the public API continues to serve published content normally — the Redis failure degrades preview tokens only, not the primary content API.

**Mitigation:** `verifyPreviewToken` wraps the Redis GET in a try-catch; on Redis error, it returns `null` (fail-closed). The preview link button in the admin SPA shows an error toast if token generation fails. Documented in operational notes.

### R3: Scheduled publish job timeout on large backlogs

If the cron does not run for an extended period (e.g., deployment gap, Redis/QStash outage), a large backlog of documents with past `published_at` may accumulate. The 100-document batch limit means clearing the backlog takes multiple cron ticks. Documents with a `published_at` of 1 hour ago may not be published until the 2nd or 3rd cron tick after recovery.

**Mitigation:** The 100-document limit is intentional and acceptable. The job is idempotent — re-running it after failure is safe. Operators can trigger a manual run of `POST /cms/jobs/scheduled-publish` to catch up faster. Document the SLA: "scheduled publishing has a maximum delay equal to one cron interval (1 minute) under normal conditions."

### R4: Preview URL configuration in multi-environment deployments

The `previewUrl` config option determines the base URL embedded in preview links. In staging vs. production environments, the frontend URL differs. Misconfiguration generates preview links that point to the wrong environment.

**Mitigation:** Validate `previewUrl` at `createCMS` startup: if it is the default `localhost` value in a non-development environment (detected by `NODE_ENV !== 'development'`), emit a console warning: "previewUrl is set to localhost but NODE_ENV is production. Set previewUrl in your createCMS config to your frontend's production URL." This is a warning, not an error — development environments legitimately use localhost.

### R5: `published_at` NULL vs. unset semantics

A document without a `published_at` is different from a document with `published_at` in the future. The scheduled job query is `status = 'draft' AND published_at <= NOW()`. A `NULL` `published_at` evaluates to `false` in SQL `<=` comparisons — `NULL <= NOW()` is `NULL` (falsy in SQL WHERE). This means documents with `published_at = NULL` are correctly excluded from scheduled publishing. Only documents where `published_at IS NOT NULL AND published_at <= NOW()` are picked up.

**Mitigation:** Verify this behavior with an explicit test case: seed a document with `published_at: null`; run the job; assert it is NOT published. Drizzle's ORM query correctly generates `WHERE published_at <= $now` which SQL evaluates as `NULL` for null values, filtering them out.

---

## Dependencies / Prerequisites

| Plan | Dependency | What this plan needs |
|---|---|---|
| Plan 005 | Schema system | `defineCollection` with `draftAndPublish` flag, `RESERVED_FIELD_NAMES` including `status` and `publishedAt`, `drizzle-generator.ts` system field handling |
| Plan 006 | Content API and RBAC | Route factory, `findMany`/`findOne` handlers, query parser, role extraction from auth context (`c.get('user')`) |
| Plan 004 | Auth integration | `c.get('user')` populated by auth middleware; admin/editor role available |
| Plan 009 | Cache adapter | `cache.get`, `cache.set` with TTL for preview token storage |
| Plan 010 | Jobs/cron system | `/cms/jobs/scheduled-publish` route registration and cron provider authentication |
| Plan 007 | Admin SPA form | Content edit form structure that `PublishPanel` slots into |

---

## Alternative Approaches Considered

### Alternative: Single-row dual-version model (Strapi v5 approach)

Strapi v5 stores a `draft` and a `published` version as two separate rows in the DB, linked by a `documentId` (a UUID shared between versions). This allows truly independent draft and published content: you can edit the draft freely without affecting the published version until you explicitly publish.

**Rejected because:** the single-row model (this plan) is simpler to implement, simpler to query, and sufficient for the use cases `@hono-cms` targets. The dual-row model requires: join logic to find "the published version of this document", complex migrate-to-dual-row handling for existing collections, and careful handling of relations (which version's relations are used?). The single-row model means every edit to a published document immediately goes to the published version — which is the desired behavior for most CMS use cases. Editorial review workflows that need a true "draft that doesn't affect published" are deferred to a plugin (multi-step editorial workflow plugin, post-v1).

### Alternative: `published_at` as the status column (timestamp-as-status)

Instead of a `status` enum column, use the presence/absence of `published_at` to infer status: `published_at IS NULL → draft`, `published_at IS NOT NULL → published`. This eliminates one column.

**Rejected because:** it conflates two distinct concepts. `published_at` is a timestamp used for scheduling (set to a future date to schedule publishing). After the scheduled job runs, `published_at` remains as a historical record of when the document was published. A document that was published and then unpublished would have `published_at IS NOT NULL` but should be treated as draft. Using a separate `status` enum column makes both concepts explicit: `status` is the current state; `published_at` is the scheduling timestamp and historical record. The `WHERE status = 'published'` filter clause is also more readable and more indexable than `WHERE published_at IS NOT NULL`.

---

## Phased Delivery

**Phase 1 — Schema extension and operations (U1, U2):** Foundational — no API filtering or UI possible until `status` columns exist and `publishDocument`/`unpublishDocument` are implemented.

**Phase 2 — Public API filtering (U3):** Depends on U1. The core correctness guarantee. Must land before any content can be made public on a `draftAndPublish` collection.

**Phase 3 — Preview tokens (U4):** Depends on Plan 009 (cache). Can be implemented in parallel with U3 once U1 is done. No dependency on U3.

**Phase 4 — Scheduled publishing (U5):** Depends on U1, U2, Plan 010 (cron). Can be implemented in parallel with U3 and U4.

**Phase 5 — Relations filter (U7):** Depends on U3. Extends the filter logic to populate resolution. Should be implemented alongside or immediately after U3.

**Phase 6 — Admin UI (U6):** Depends on U2, U3, U4, Plan 007 (admin SPA structure). Last to implement — requires the backend to be complete and testable first.

---

## System-Wide Impact

**`packages/core/src/content/`:** The new `publish.ts` and `preview.ts` files are consumed by the route factory (Plan 006) and by the jobs router (Plan 010). Any change to the `publishDocument` function signature affects both consumers.

**`packages/schema/src/`:** The `drizzle-generator.ts` and `define-collection.ts` changes in U1 affect every collection schema that uses `draftAndPublish`. The `RESERVED_FIELD_NAMES` export (already includes `status` and `publishedAt` from Plan 005) must be verified — no additional exports are added.

**Plan 006 route factory:** The `POST /:id/publish` and `POST /:id/unpublish` routes are conditionally registered by the route factory. The factory must check `collection.draftAndPublish` before registering these routes. This is a new condition in the factory's route registration loop.

**Plan 009 cache adapter:** `verifyPreviewToken` and `generatePreviewToken` depend on the cache adapter's `get` and `set` interface. Any breaking change to the cache interface affects preview tokens.

**Plan 010 cron system:** The `scheduledPublishJob` is called by the jobs router. If Plan 010 changes the job handler signature or authentication mechanism, U5 must be updated.

**Admin SPA:** The `PublishPanel` component integrates into the content edit form. The admin SPA's form structure (from Plan 007) must have a designated slot for the publish panel — likely a sidebar or a floating action area in the form layout. No changes to the form's core rendering logic are required; `PublishPanel` is a self-contained component that reads from the document query.

**OpenAPI spec (Plan 018):** The `POST /api/{collection}/{id}/publish` and `POST /api/{collection}/{id}/unpublish` routes must appear in the auto-generated OpenAPI spec. Plan 018's spec generator must handle the conditional route registration (only for `draftAndPublish` collections).

---

## Deferred Implementation Notes

- The `previewUrl` config option — the implementing agent should decide whether this is required or has a sensible default (e.g., constructed from the request `Origin` header if not set). Making it required adds DX friction; making it optional requires a fallback strategy.
- The `forUpdate` lock in `publishDocument` for Postgres: the Drizzle Postgres adapter's locking syntax differs from SQLite. The implementing agent should verify that `db.select().from(table).where(...).for('update')` is the correct Drizzle API for the Postgres adapter, or use an optimistic concurrency approach (compare-and-swap via a `version` column) if locking is not cleanly supported across adapters.
- Relation population depth for status filtering (U7): the plan covers one level of populate. If the admin SPA or API supports recursive populate (`?populate[author][populate]=posts`), the status filter must be applied at each depth. The implementing agent should assess whether recursive populate is in scope for Plan 006 and, if so, ensure `applyRelationStatusFilter` is called recursively.
- `SchedulePicker` timezone handling: the `published_at` field stores UTC timestamps. The admin SPA's datetime-local input uses the browser's local timezone. The implementing agent must ensure the value submitted to the API is correctly converted to UTC, not sent as a local time string.
