---
title: "feat: Webhooks — Static Config + UI-Managed, HMAC Delivery, Retry Log"
date: 2026-05-16
type: feat
status: active
depth: deep
plan-series: "015 of 018"
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
ideation-ideas: ["#13 UI-Managed Webhooks + Static Config for System Hooks"]
---

# feat: Webhooks — Static Config + UI-Managed, HMAC Delivery, Retry Log

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 2
**Research inputs used:** skill review, architecture review, performance review, security review, flow review

### Key Improvements

1. Tighten retry, delivery-ID, and receiver dedupe requirements.
2. Add stronger audit-history preservation and redaction expectations.
3. Surface the retry-contract mismatch with the jobs plan so it is resolved before implementation.

## Summary

This plan implements the two-layer webhook system for `@hono-cms`: **static config webhooks** declared in `createCMS` (version-controlled, not editable via admin UI) and **UI-managed webhooks** stored in the database and editable by operators without a redeploy. Both layers share the same delivery engine: typed JSON POST payloads, optional HMAC signature headers, a 10-second delivery timeout, and a three-attempt retry schedule backed by QStash (Plan 010).

The work spans seven implementation units: database schema and type definitions (U1), the `WebhookDispatcher` class that fans out events to matching webhooks (U2), the HTTP delivery function with HMAC signing and response recording (U3), QStash-backed retry logic (U4), the admin CRUD API for UI-managed webhooks (U5), the admin SPA settings page and delivery log UI (U6), and the synchronous test-delivery endpoint (U7).

**Problem frame:** Operators need to integrate the CMS with external systems (Algolia reindex, Slack notifications, Zapier, deploy pipelines) without touching code. Developers need to wire system-level hooks (cache purge, CDN invalidation, CI rebuild) in version-controlled config that operators cannot accidentally break. Both needs must be served from a single, unified delivery engine that is reliable, debuggable, and auditable. (see origin: `docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md`, Idea #13)

---

## Problem Frame

Strapi's webhook system is entirely UI-managed — any admin-role operator can add, modify, or delete any webhook, including system-critical hooks like cache purge and deploy triggers. This creates operational risk: a misclick can silently disconnect a CDN invalidation hook from a production publish event, with no git trail and no review process.

The `@hono-cms` webhook system addresses this with a two-layer model. Static config webhooks are declared alongside the schema, auth, and storage config in `createCMS` — they are code, so they are reviewed in PRs, reverted with `git revert`, and deployed with the application. UI-managed webhooks live in the database and are operated through the admin settings panel — they are for the class of integrations that operators legitimately need to change (Zapier webhook URL updates, Slack channel changes, Algolia index reconnections) without involving a developer or a deploy.

Both layers deliver to the same typed HTTP POST contract and share the same retry, logging, and HMAC verification infrastructure.

---

## Scope Boundaries

### In Scope

- Drizzle table definitions for `webhooks` and `webhook_deliveries` as part of the CMS core schema
- TypeScript types: `WebhookConfig` (static), `WebhookRecord` (DB-stored), `WebhookDelivery`, `WebhookPayload`
- Glob-style event pattern matching (`*.publish` matches `articles.publish`) without full regex
- `WebhookDispatcher` class with `dispatch(event, payload)` integrating into the content mutation lifecycle
- `deliverWebhook` function with 10-second timeout, JSON POST, and HMAC header generation
- `createHmacSignature(secret, body)` utility using Node.js `crypto` / Web Crypto API
- QStash-backed retry: attempt 1 immediate, attempt 2 at 30s delay, attempt 3 at 5min delay; max 3 automatic attempts
- `POST /cms/jobs/webhook-retry` job handler (integrating with Plan 010's job routing)
- Admin CRUD API: list, create, update, delete, test, and delivery log endpoints (admin role required)
- Secret masking — secrets are write-only; returned as `****` after creation
- Admin SPA settings page at `/settings/webhooks` with create/edit form, delivery log modal, test button
- Delivery success rate calculation per webhook (last 30 deliveries)
- `POST /cms/settings/webhooks/{id}/test` — synchronous, returns HTTP status + response body to UI immediately

### Deferred to Follow-Up Work

- Webhook event subscriptions for GraphQL mutations (Plan 009 covers GraphQL; webhook integration with GraphQL mutations is a follow-up once both are stable)
- Webhook payload signing key rotation (operators must delete and recreate the webhook to rotate the secret — acceptable for v1)
- Bulk retry of all failed deliveries for a webhook (manual per-delivery retry via the UI covers the v1 requirement; bulk retry is a v2 UX improvement)
- Delivery log pruning / retention policy (keeping all delivery records permanently for v1; TTL-based pruning is a v2 operational concern handled by a background job)
- Webhook subscription to audit log events (`audit_log.create` as a triggerable event — deferred until Plan 016 audit log is complete)
- Per-webhook rate limiting (protecting external endpoints from delivery storms during bulk publish operations)

### Outside This Product's Identity

- A webhook marketplace or directory of pre-built integrations
- Guaranteed exactly-once delivery (at-least-once with idempotency keys on the receiver is the correct model for HTTP webhooks; exactly-once requires two-phase coordination the receiver must implement)
- Real-time WebSocket push as an alternative to webhooks (that is a separate channel, not a webhook concern)

---

## Key Technical Decisions

## Research Insights

**Best Practices:**
- Follow the mature outbound-webhook playbook: HMAC signatures, timestamped replay protection, delivery IDs, and at-least-once semantics with receiver dedupe.
- Treat the retry schedule and terminal-status model as a shared contract with Plan 010, not a separate implementation detail.
- Expose retry policy, signature format, and idempotency guidance in docs from day one.

**Performance Considerations:**
- Add `next_attempt_at` and composite indexes for retry scans, newest-first history, and latest-delivery lookups.
- Consider the enqueue-repair path part of baseline reliability, not only a later convenience.

**Security Considerations:**
- Preserve delivery history even if a webhook is disabled or deleted; do not treat historical evidence as cascade-deletable data.
- Redact receiver response bodies before persisting or returning them from synchronous test flows.

### KTD-1: Two-Layer Model — Why Static Config and UI-Managed Coexist

**Decision:** System-level hooks (schema change notifications, CDN cache invalidation, CI/CD pipeline triggers) are declared in `createCMS` alongside `db`, `storage`, and `auth` config. Operator-managed integrations (Algolia, Slack, Zapier) live in the `webhooks` database table and are managed through the admin UI.

**Rationale:** The distinction maps directly to the actor who legitimately changes each layer. A CI/CD pipeline webhook URL that triggers a production redeploy on `schema.change` should require a PR review to change — not a click in the admin settings. Mixing it with operator-managed webhooks removes that protection. Conversely, requiring a code deploy to update a Zapier webhook URL when the Zap endpoint rotates is developer friction with no security benefit. The two-layer model gives each actor the right interface without compromising the other.

**Implications:** The `WebhookDispatcher` loads both layers at dispatch time — static config from the in-memory `CMSConfig` object (no DB round-trip), UI-managed webhooks from the DB (filtered to `enabled = true` and matching the event pattern). Static config webhooks are never shown in the admin UI's webhook list; they are invisible to operators by design. There is no overlap or deduplication between layers.

### KTD-2: Synchronous Delivery (Attempt 1) vs. Always-Async Queue

**Decision:** The first delivery attempt is synchronous — fired immediately as part of the content mutation request lifecycle, before the HTTP response is returned to the caller. Failure queues a retry via QStash with a delay. Retry attempts 2 and 3 are fully async (QStash → `/cms/jobs/webhook-retry`).

**Rationale:** Fully async delivery (queue everything, deliver nothing synchronously) guarantees lower mutation latency but introduces a delivery delay: operators expecting real-time Algolia reindex on publish would see a gap. Synchronous attempt 1 delivers in the same request window for the common case (endpoint is healthy and responds quickly). The 10-second timeout bounds the worst case. If attempt 1 fails, the operator sees the failure in the delivery log immediately — not minutes later when QStash fires. The latency cost (up to 10 seconds in the worst case for a hanging endpoint) is bounded and acceptable for a CMS mutation; content management operations are not latency-sensitive in the way API reads are.

**Implication:** The mutation returns a 200 after the write and attempt 1 delivery regardless of webhook delivery outcome. Webhook failure is recorded but does not cause the mutation to fail. The admin UI shows the delivery status for debugging without blocking the content workflow.

### KTD-3: HMAC Over HTTPS — Why Both Are Needed

**Decision:** Webhook payloads include an `X-CMS-Signature: sha256=<hmac>` header when the webhook has a `secret` configured. Receivers should verify this signature even when the endpoint is HTTPS-only.

**Rationale:** HTTPS protects against network-level interception but does not protect against a compromised or misconfigured webhook endpoint that is hit by arbitrary POST requests. An attacker who discovers a webhook endpoint URL can send spoofed payloads triggering `articles.publish` events. HMAC verification ensures the payload was sent by the CMS instance holding the secret, regardless of transport. This is the standard verification model used by GitHub, Stripe, and Shopify webhooks. The receiver's verification is documented in the plan and shipped as an importable utility in the CMS SDK (Plan 011).

**Implication:** Secrets are optional — webhooks without a secret are delivered unsigned. The admin UI labels unsigned webhooks with a visual warning. The `X-CMS-Signature` header is absent (not empty) when no secret is configured, so receivers can detect the distinction.

### KTD-4: Delivery Log Is Permanent (No TTL Deletion by Default)

**Decision:** `webhook_deliveries` rows are kept indefinitely. There is no automatic pruning in v1.

**Rationale:** Operators debugging a failed Algolia reindex need to see all failed delivery attempts, including ones from two weeks ago during a partial outage. TTL-based pruning (e.g., delete after 30 days) is operationally useful but introduces a class of edge cases: what is the right retention period? Does it reset on a new attempt? What happens to the delivery log for a webhook that is disabled and then re-enabled? Deferring this to v2 (as a configurable background job using the Plan 010 cron mechanism) keeps v1 correct-by-default. Storage cost for delivery records is low: each row is a few KB at most (payload is JSONB; response body is truncated to 2KB).

**Implication:** The `GET /cms/settings/webhooks/{id}/deliveries` endpoint paginates results (cursor-based, newest first, page size 50). The admin UI shows the last 50 deliveries by default with a "load more" button.

### KTD-5: Secret Masking After Creation — Security vs. Usability

**Decision:** When a webhook secret is created or updated, the API returns the full secret exactly once (in the creation/update response). All subsequent reads return `"secret": "****"` (masked). The secret is stored as plaintext in the database (not hashed) to enable HMAC computation at delivery time.

**Rationale:** Hashing the secret (like a password) would require the operator to re-enter it on every reconfiguration — there would be no way for the CMS to verify delivery without the plaintext. Storing plaintext and masking in the API is the correct model for webhook secrets: GitHub, Stripe, and Shopify all use this pattern. The masking prevents the secret from being casually visible in the admin UI or in API response logs. If the secret is lost (operator didn't record it at creation time), the correct recovery path is delete and recreate the webhook — not retrieve the existing secret. This is documented in the admin UI with a "Save this secret — it won't be shown again" notice at creation time.

**Implication:** The `WebhookRecord` type has a `secret: string | null` field internally. The API serialization layer transforms `secret` to `'****'` when non-null on GET/list responses. The POST (create) and PUT (update) responses return the full `secret` value exactly once. The admin form's secret field is a password-type input with a "Rotate secret" button that clears the masked display and allows entering a new value.

---

## High-Level Technical Design

*This diagram illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Event Dispatch Flow

```
Content Mutation
      │
      ▼
  Successful DB write
      │
      ▼
 WebhookDispatcher.dispatch(event, payload)
      │
      ├─── Load static config webhooks (in-memory, no DB)
      │         matching event pattern
      │
      └─── Load DB webhooks WHERE enabled=true
                matching event pattern (SQL LIKE or in-app filter)
                    │
                    ▼
           Fan out to each matched webhook
                    │
                    ├─── deliverWebhook(webhook, event, payload)
                    │         ├── Build JSON body
                    │         ├── Compute HMAC if secret present
                    │         ├── POST with 10s timeout
                    │         └── Record response → webhook_deliveries row
                    │
                    └─── On failure: enqueue to QStash with delay
                              (attempt 1 failed → 30s delay)
                              (attempt 2 failed → 5min delay)
                              (attempt 3 failed → status: 'failed', stop)
      │
      ▼
  Audit log write (Plan 016)
      │
      ▼
  Return mutation response to caller
```

### Two-Layer Webhook Resolution

```
┌─────────────────────────────────┐   ┌──────────────────────────────────┐
│     Static Config Webhooks      │   │     UI-Managed Webhooks (DB)     │
│   (from CMSConfig.webhooks[])   │   │     webhooks WHERE enabled=true  │
│                                 │   │                                  │
│  { url, events, secret? }       │   │  { id, name, url, events,        │
│  Loaded from in-memory config   │   │    secret, enabled, created_at } │
│  Not stored in DB               │   │  Loaded per-dispatch from DB     │
│  Not visible in admin UI        │   │  Visible in admin settings       │
└─────────────────────────────────┘   └──────────────────────────────────┘
                    │                                   │
                    └──────────────┬────────────────────┘
                                   │
                            Pattern matching
                      matchesPattern(event, pattern[])
                      "articles.publish" ← "*.publish" ✓
                      "articles.publish" ← "articles.*" ✓
                      "articles.publish" ← "articles.publish" ✓
                      "articles.create"  ← "*.publish" ✗
                                   │
                            Unified delivery
                         deliverWebhook(resolved, event, payload)
```

### Retry State Machine

```
                  ┌──────────┐
                  │ pending  │  (row created before attempt)
                  └────┬─────┘
                       │ attempt 1 (immediate)
               ┌───────┴────────┐
         2xx   │                │ non-2xx / timeout / error
               ▼                ▼
          ┌─────────┐     ┌──────────┐
          │ success │     │ retrying │  attempt=1, enqueue 30s delay
          └─────────┘     └────┬─────┘
                               │ attempt 2 (QStash, +30s)
                       ┌───────┴────────┐
                 2xx   │                │ failure
                       ▼                ▼
                  ┌─────────┐     ┌──────────┐
                  │ success │     │ retrying │  attempt=2, enqueue 5min delay
                  └─────────┘     └────┬─────┘
                                       │ attempt 3 (QStash, +5min)
                               ┌───────┴────────┐
                         2xx   │                │ failure
                               ▼                ▼
                          ┌─────────┐     ┌────────┐
                          │ success │     │ failed │  no more automatic retries
                          └─────────┘     └────────┘
                                               │
                                      Admin UI "Retry" button
                                      → attempt 4 (immediate, synchronous)
                                      → resets to pending/success/retrying
```

---

## Output Structure

```
packages/core/src/
└── webhooks/
    ├── index.ts                    # Public exports for the webhooks module
    ├── schema.ts                   # Drizzle table definitions: webhooks, webhook_deliveries
    ├── types.ts                    # WebhookConfig, WebhookRecord, WebhookDelivery, WebhookPayload
    ├── patterns.ts                 # matchesPattern() — glob-style event matching
    ├── dispatcher.ts               # WebhookDispatcher class
    ├── deliver.ts                  # deliverWebhook(), createHmacSignature()
    ├── retry.ts                    # enqueueRetry(), retryJobHandler()
    └── __tests__/
        ├── patterns.test.ts
        ├── dispatcher.test.ts
        ├── deliver.test.ts
        └── retry.test.ts

packages/core/src/routes/
└── settings/
    └── webhooks.ts                 # Hono router: CRUD + test + delivery log endpoints

packages/core/src/routes/
└── jobs/
    └── webhook-retry.ts            # POST /cms/jobs/webhook-retry handler

apps/admin/src/
└── routes/
    └── settings/
        └── webhooks/
            ├── index.tsx           # Webhook list page
            ├── create.tsx          # Create webhook form
            ├── edit.$id.tsx        # Edit webhook form
            └── deliveries.$id.tsx  # Delivery log modal / page
```

---

## Implementation Units

### U1. Webhook Tables and Types

**Goal:** Define the Drizzle table schemas for `webhooks` and `webhook_deliveries`, create all TypeScript types used by both layers, and implement the glob-style event pattern matching utility.

**Requirements:** Establishes the data model used by U2 (dispatcher), U3 (delivery), U4 (retry), and U5 (CRUD API). Must cover all fields defined in the design spec including the `status` enum constraint and the JSONB `events` column.

**Dependencies:** None (foundational unit). Requires the Drizzle core package already established in Plan 003.

**Files:**
- `packages/core/src/webhooks/schema.ts` — Drizzle table definitions
- `packages/core/src/webhooks/types.ts` — TypeScript types
- `packages/core/src/webhooks/patterns.ts` — pattern matching
- `packages/core/src/webhooks/__tests__/patterns.test.ts`

**Approach:**

*Drizzle table definitions* (`packages/core/src/webhooks/schema.ts`):

The `webhooks` table uses `text('id').primaryKey().$defaultFn(() => createId())` (CUID2, consistent with the rest of the CMS core schema from Plan 005). The `events` column is stored as JSONB (Postgres) or text with JSON serialization (SQLite/D1) — use Drizzle's `$type<string[]>()` modifier on a `text` column with a JSON mode for the SQLite adapter, and `jsonb` for the Postgres adapter. The `enabled` column is a boolean with `default(true)`. Include `createdAt` and `updatedAt` as `timestamp` with `defaultNow()` and a `.$onUpdate(() => new Date())`.

The `webhook_deliveries` table references `webhooks.id` with `ON DELETE CASCADE` so that deleting a webhook removes all its delivery history. The `status` column uses a Drizzle check constraint with the four allowed values: `'pending'`, `'success'`, `'failed'`, `'retrying'`. The `payload` column stores the full JSON payload (JSONB / text JSON). The `responseBody` column is stored as plain text, truncated at write time to 2048 characters.

*Indexes:*
- `webhooks`: index on `enabled` (for the "load all active webhooks" query in dispatcher)
- `webhook_deliveries`: index on `webhookId` (for the delivery log endpoint), composite index on `(webhookId, createdAt DESC)` (for paginated log queries newest-first), index on `status` (for the retry job to scan for `retrying` rows)

*TypeScript types* (`packages/core/src/webhooks/types.ts`):

```
// Directional guidance only — not implementation specification

WebhookConfig — used in CMSConfig.webhooks[]:
  url: string
  events: string[]   // pattern strings: 'articles.create', '*.publish'
  secret?: string    // optional HMAC key

WebhookRecord — the DB row shape (mirrors Drizzle inferred type):
  id, name, url, events: string[], secret: string | null,
  enabled, createdAt, updatedAt

WebhookDelivery — the webhook_deliveries DB row shape:
  id, webhookId, event, payload: WebhookPayload,
  responseStatus: number | null, responseBody: string | null,
  attempt: number, status: 'pending' | 'success' | 'failed' | 'retrying',
  attemptedAt: Date | null, createdAt: Date

WebhookPayload — the JSON body sent to the receiver:
  event: string
  timestamp: string  (ISO 8601)
  collection: string | null  (null for system events like schema.change)
  documentId: string | null
  data: Record<string, unknown> | null
  meta: { cms_version: string }

DeliveryResult — returned by deliverWebhook():
  success: boolean
  statusCode: number
  error?: string
  durationMs: number
```

*Event pattern matching* (`packages/core/src/webhooks/patterns.ts`):

Implement `matchesPattern(event: string, pattern: string): boolean` using simple string comparison, not regex. Rules:
1. If `pattern === event`, return `true` (exact match)
2. Split both on `.`: if pattern has exactly two segments where segment[0] is `'*'` and segment[1] equals `event.split('.')[1]`, return `true` (wildcard collection: `*.publish` matches `articles.publish`)
3. If segment[1] is `'*'` and segment[0] equals `event.split('.')[0]`, return `true` (wildcard operation: `articles.*` matches `articles.create`)
4. If both segments are `'*'`, return `true` (matches everything)
5. Otherwise return `false`

Implement `matchesAnyPattern(event: string, patterns: string[]): boolean` as `patterns.some(p => matchesPattern(event, p))`.

No regex, no globbing library. The pattern space is intentionally constrained to the `{collection}.{operation}` two-part structure. Document this constraint explicitly: patterns with more than one `.` are not supported and return `false` after logging a warning.

**Test scenarios:**

- `matchesPattern('articles.publish', '*.publish')` → `true`
- `matchesPattern('articles.publish', 'articles.publish')` → `true` (exact match)
- `matchesPattern('articles.publish', 'articles.*')` → `true` (wildcard operation)
- `matchesPattern('articles.publish', '*.*')` → `true` (match all)
- `matchesPattern('articles.create', '*.publish')` → `false` (operation mismatch)
- `matchesPattern('articles.publish', 'pages.publish')` → `false` (collection mismatch)
- `matchesPattern('schema.change', 'schema.change')` → `true` (system event exact match)
- `matchesPattern('schema.change', '*.change')` → `true` (wildcard on system event)
- `matchesPattern('cms.startup', '*.publish')` → `false`
- Pattern with three segments (`'a.b.c'` against `'*.b'`) → `false`, no error thrown
- `matchesAnyPattern('articles.publish', ['*.create', '*.publish', 'schema.change'])` → `true`
- `matchesAnyPattern('articles.delete', ['*.publish', 'pages.*'])` → `false`
- Empty patterns array → `false`

**Verification:** Pattern matching unit tests pass. TypeScript types compile with no errors. Drizzle table definitions generate valid SQL via `drizzle-kit generate` against both SQLite and Postgres dialects.

---

### U2. Event Dispatcher

**Goal:** Implement `WebhookDispatcher` — the class that receives a CMS event, resolves all matching webhooks (from both static config and the DB), fans out HTTP delivery calls, and queues retries for failures.

**Requirements:** Integrates with the content mutation lifecycle (called after successful DB write, before audit log entry). Must load both static config webhooks and DB-active webhooks. Must not throw or propagate exceptions — webhook delivery failures are logged and queued, never fatal.

**Dependencies:** U1 (types, schema, pattern matching), U3 (delivery function), U4 (retry enqueue)

**Files:**
- `packages/core/src/webhooks/dispatcher.ts`
- `packages/core/src/webhooks/__tests__/dispatcher.test.ts`

**Approach:**

`WebhookDispatcher` is a class instantiated once during `createCMS` bootstrap and held on the CMS instance internals. Constructor receives:
- `staticWebhooks: WebhookConfig[]` — from `CMSConfig.webhooks` (can be empty)
- `db: DrizzleInstance` — the shared Drizzle client from Plan 003
- `qstashClient: QStashClient | null` — from Plan 010 crons config; null when crons are disabled

The core method is `async dispatch(event: string, payload: WebhookPayload): Promise<void>`:

1. **Resolve matching webhooks:** Call `matchesAnyPattern(event, webhook.events)` on each static config entry (in-memory, no I/O). Then query the DB for all `webhooks` rows where `enabled = true`. Apply `matchesAnyPattern` in application code on the JS side (not in SQL, because the `events` column is a JSON array and SQL JSONB pattern matching is dialect-specific). The in-memory filter keeps the query simple: `SELECT * FROM webhooks WHERE enabled = true`. For typical deployments with fewer than 100 UI-managed webhooks, this is acceptable. If scaling beyond 100 becomes a concern, add a SQL-side `events @> '[event]'` for Postgres in a follow-up.

2. **Fan out deliveries concurrently:** Use `Promise.allSettled` to fire all deliveries without one failure blocking others. For each matched webhook:
   - Create a `webhook_deliveries` row with `status: 'pending'`, `attempt: 1`
   - Call `deliverWebhook(webhook, event, payload, deliveryId)` (U3)
   - Update the delivery row: `status: 'success'` on 2xx, or `status: 'retrying'` on failure + enqueue retry (U4)

3. **Error containment:** Wrap the entire dispatch in a try/catch. Errors in dispatch (DB unavailable, all webhooks down) are logged but never propagate to the mutation caller. The content write has already succeeded; webhook delivery is best-effort from the mutation's perspective.

4. **Integration with content mutation lifecycle:** The dispatcher is called in the content service layer (Plan 003 content routes) after a successful `db.insert` / `db.update` / `db.delete` and before the response is serialized. The calling code uses `await dispatcher.dispatch(event, payload)` — this is synchronous from the caller's perspective (awaited) but the dispatcher handles its own internal concurrency via `Promise.allSettled`. The mutation response is not returned until all attempt-1 deliveries have completed (succeeded, failed, or timed out). This is the latency tradeoff described in KTD-2.

5. **Static config webhooks and DB webhooks are treated identically by the delivery layer.** The dispatcher normalizes both into a unified `ResolvedWebhook` interface before passing to `deliverWebhook`:
```
ResolvedWebhook:
  url: string
  secret: string | null
  // For UI-managed: id is the DB webhook ID
  // For static config: id is null (no DB row to update)
  webhookId: string | null
```

For static config webhooks, delivery records are still written to `webhook_deliveries` (with `webhookId: null`) so that failures are visible to developers inspecting the delivery log at the DB level. These do not appear in the admin UI webhook list but are available in raw DB queries for debugging.

**Test scenarios:**

- Dispatch `articles.publish` with one static config webhook matching `*.publish` → `deliverWebhook` called once, delivery row created with `status: 'pending'`
- Dispatch `articles.publish` with matching UI webhook (enabled=true) → delivery row written, `deliverWebhook` called
- Dispatch `articles.publish` with non-matching UI webhook (`events: ['articles.create']`) → `deliverWebhook` not called for that webhook
- Dispatch `articles.publish` with UI webhook where `enabled = false` → not dispatched
- Both static config and UI webhook match the same event → two separate deliveries, two delivery rows
- `deliverWebhook` succeeds (mocked 200) → delivery row updated to `status: 'success'`
- `deliverWebhook` fails (mocked 503) → delivery row updated to `status: 'retrying'`, retry enqueued (U4 mocked)
- Dispatch throws internally (DB unavailable) → exception is caught and logged, mutation caller does not receive an error
- `Promise.allSettled` semantics: first webhook succeeds, second fails → both rows updated independently, no cross-contamination
- Static config webhook with matching event pattern dispatches correctly
- Wildcard pattern `*.*` in static config matches any event

**Verification:** Dispatcher unit tests pass with mocked `deliverWebhook` and mocked DB. Integration test with a real in-memory SQLite DB (Drizzle + libSQL) verifies that delivery rows are written correctly. No unhandled promise rejections.

---

### U3. HTTP Delivery and HMAC Signing

**Goal:** Implement `deliverWebhook` — the function that constructs and fires the HTTP POST to the receiver endpoint — and `createHmacSignature` for HMAC-SHA256 signing.

**Requirements:** 10-second delivery timeout (do not block mutations indefinitely). Response body truncated to 2KB. Returns `DeliveryResult` for the caller to record. HMAC signing uses the Web Crypto API (edge-compatible, no Node.js `crypto` module) or falls back to Node.js `crypto` in Node.js environments via the same unified import from Hono's `hono/utils` or a `?worker` conditional export.

**Dependencies:** U1 (types)

**Files:**
- `packages/core/src/webhooks/deliver.ts`
- `packages/core/src/webhooks/__tests__/deliver.test.ts`

**Approach:**

`createHmacSignature(secret: string, body: string): Promise<string>`:

Use the Web Crypto API (`crypto.subtle`) for edge compatibility:
1. `TextEncoder` to encode secret and body as `Uint8Array`
2. `crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])`
3. `crypto.subtle.sign('HMAC', key, bodyBytes)` → `ArrayBuffer`
4. Convert to hex string: `Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')`
5. Return `sha256=${hexString}`

This is async (Web Crypto is async) but adds microseconds of overhead — negligible vs. the network round-trip.

`deliverWebhook(webhook: ResolvedWebhook, event: string, payload: WebhookPayload, deliveryId: string): Promise<DeliveryResult>`:

1. Serialize `payload` to JSON string (`body`)
2. Build headers:
   - `Content-Type: application/json`
   - `X-CMS-Event: <event>`
   - `X-CMS-Delivery: <deliveryId>` (the CUID2 from the `webhook_deliveries` row)
   - `X-CMS-Signature: <createHmacSignature(secret, body)>` if `webhook.secret` is non-null
3. Fire `fetch(webhook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) })`
4. Read response: `statusCode = response.status`, `responseText = await response.text()`
5. Truncate `responseText` to 2048 characters
6. Record `durationMs` from `performance.now()` before and after the fetch
7. Return `{ success: statusCode >= 200 && statusCode < 300, statusCode, durationMs, error: undefined }` on HTTP response (even 4xx/5xx — the request completed)
8. On `AbortError` (timeout): return `{ success: false, statusCode: 0, durationMs: 10_000, error: 'timeout' }`
9. On other network error (DNS failure, connection refused): return `{ success: false, statusCode: 0, durationMs, error: error.message }`

The function does not write to the DB — it returns a result. The caller (dispatcher in U2 or retry handler in U4) is responsible for updating the `webhook_deliveries` row.

`AbortSignal.timeout(10_000)` is available in Cloudflare Workers (since Workers runtime 2023-03-01), Deno, Node.js 18+, and all modern browsers. It is the correct edge-compatible timeout mechanism — no `setTimeout` + `clearTimeout` pattern needed.

**Test scenarios (using `msw` or direct `fetch` mock):**

- Happy path: receiver returns 200 → `{ success: true, statusCode: 200, durationMs > 0 }`
- 201 Created → success (`>= 200 && < 300`)
- 400 Bad Request → `{ success: false, statusCode: 400 }` (request completed, not a network error)
- 500 Internal Server Error → `{ success: false, statusCode: 500 }`
- Network timeout (mocked AbortError) → `{ success: false, statusCode: 0, error: 'timeout' }`
- Connection refused (mocked TypeError) → `{ success: false, statusCode: 0, error contains 'fetch' }`
- HMAC signature present when secret is non-null → `X-CMS-Signature` header is set with `sha256=` prefix
- HMAC signature absent when secret is null → `X-CMS-Signature` header not present in request
- `X-CMS-Delivery` header equals the `deliveryId` argument
- `X-CMS-Event` header equals the `event` argument
- Response body truncated to exactly 2048 characters when receiver returns a large body
- `createHmacSignature` with known secret + body produces correct SHA-256 HMAC hex (verified against a known-correct reference value)
- HMAC verification: receiver using the standard verification pattern (`timingSafeEqual`) accepts the generated signature

**Verification:** All delivery tests pass. `createHmacSignature` output matches reference HMAC computed with Node.js `crypto.createHmac`. Tests run in both a Node.js environment and a simulated edge environment (via Vitest's `environment: 'edge-runtime'` or equivalent).

---

### U4. Retry via QStash

**Goal:** Implement the retry scheduling logic — enqueue failed deliveries to QStash with appropriate delays — and the `POST /cms/jobs/webhook-retry` job handler that re-attempts delivery.

**Requirements:** Max 3 total attempts. Attempt 1 (U2) is immediate. Attempt 2 is 30 seconds after attempt 1 failure. Attempt 3 is 5 minutes after attempt 2 failure. After 3 failures: `status: 'failed'`, no more automatic retries. The job handler must be idempotent (safe to call twice for the same delivery ID).

**Dependencies:** U1 (types, schema), U2 (dispatcher writes the delivery row), U3 (deliverWebhook), Plan 010 (QStash client and job router)

**Files:**
- `packages/core/src/webhooks/retry.ts`
- `packages/core/src/routes/jobs/webhook-retry.ts`
- `packages/core/src/webhooks/__tests__/retry.test.ts`

**Approach:**

`enqueueRetry(deliveryId: string, attempt: number, qstash: QStashClient): Promise<void>`:

- `attempt` is the attempt number that just failed (1 or 2)
- Delay mapping: `attempt === 1` → 30 seconds; `attempt === 2` → 5 minutes (300 seconds)
- Call QStash's publish API: `POST https://qstash.upstash.io/v2/publish/<encoded-target-url>` with headers `Upstash-Delay: <N>s` and body `{ deliveryId }`
- The target URL is the CMS's own `/cms/jobs/webhook-retry` endpoint (configured as part of QStash setup; the full URL is resolved from `CMSConfig.crons.baseUrl` or equivalent — see Plan 010)
- Log the QStash message ID for debugging

`POST /cms/jobs/webhook-retry` handler (in `packages/core/src/routes/jobs/webhook-retry.ts`):

This route is part of the job router defined in Plan 010. The handler:
1. Validates the QStash signature (Plan 010 handles this via middleware — the handler runs after signature verification)
2. Parses `deliveryId` from the JSON body
3. Loads the `webhook_deliveries` row by `deliveryId`
4. Guards: if `status` is already `'success'` or `'failed'`, return 200 and stop (idempotency)
5. Loads the corresponding `webhooks` row via `webhookId`
6. If `webhookId` is null (static config webhook delivery): reconstruct the `ResolvedWebhook` from the `payload` stored in the delivery row (`payload.meta.webhookUrl` — the dispatcher stores the target URL in the meta for static webhooks). This avoids the need to scan `CMSConfig` at job time.
7. Calls `deliverWebhook(resolvedWebhook, delivery.event, delivery.payload, deliveryId)`
8. Updates the `webhook_deliveries` row:
   - On success: `status: 'success'`, `responseStatus`, `responseBody`, `attemptedAt: now()`, `attempt` incremented
   - On failure, `attempt < 3`: `status: 'retrying'`, record response, call `enqueueRetry(deliveryId, attempt + 1, qstash)` — note: `attempt` here is the attempt that just ran (2 or 3)
   - On failure, `attempt === 3`: `status: 'failed'`, record response, do NOT enqueue further retries
9. Returns 200 in all cases (QStash will not re-deliver a 200 response — non-200 would trigger QStash's own retry, which we do not want)

**Attempt tracking:** The `attempt` column in `webhook_deliveries` reflects the attempt number of the row's most recent delivery attempt. When U2 creates the row, `attempt = 1`. The retry handler increments this value (in-place, same row) — there is one row per logical delivery, with the `attempt` column tracking how many times it has been tried. The full request/response history is captured by updating `responseStatus`, `responseBody`, and `attemptedAt` on each retry. This differs from creating a new row per attempt — the single-row model keeps the delivery log readable (one entry per webhook+event, not N entries) and preserves the attempt count cleanly.

**Test scenarios:**

- Attempt 1 fails → `enqueueRetry` called with `attempt=1` and 30s delay
- Attempt 2 fails → `enqueueRetry` called with `attempt=2` and 300s delay
- Attempt 3 fails → status set to `'failed'`, `enqueueRetry` NOT called
- Attempt 2 succeeds → status set to `'success'`, no further enqueue
- Job handler called for already-`'success'` row → returns 200 immediately, no delivery attempted (idempotency)
- Job handler called for already-`'failed'` row → returns 200 immediately (idempotency)
- Job handler called with nonexistent `deliveryId` → returns 404 (or 200 with error logged — does not trigger QStash redelivery)
- `deliverWebhook` called by retry handler uses the same webhook URL, headers, and HMAC logic as U3
- Retry handler for a static config webhook (null webhookId): correctly reconstructs the target URL from the payload meta

**Verification:** Retry unit tests pass with mocked QStash and mocked `deliverWebhook`. Integration test: create a delivery row at `attempt=2`, call the retry handler, verify DB row updated correctly for both success and failure cases.

---

### U5. UI-Managed Webhook CRUD API

**Goal:** Implement the admin API endpoints for managing UI-managed webhooks and viewing delivery logs. All endpoints are admin-only (require the `admin` role via better-auth session). Secrets are write-only.

**Requirements:** Full CRUD plus a test endpoint and delivery log endpoint. Secret masking on read. Paginated delivery log (cursor-based, newest first).

**Dependencies:** U1 (types, schema), U3 (deliverWebhook for test endpoint), U4 (retry for delivery re-trigger), Plan 004 (auth middleware — admin role check)

**Files:**
- `packages/core/src/routes/settings/webhooks.ts`
- `packages/core/src/routes/settings/__tests__/webhooks.api.test.ts`

**Approach:**

All endpoints are mounted on a Hono sub-router at `/cms/settings/webhooks`, composed into the main CMS router. Every route runs after the admin role middleware (from Plan 004's auth middleware; the check `c.get('user')?.role !== 'admin'` → 403).

**`GET /cms/settings/webhooks`** — list all UI-managed webhooks.
- Query: `SELECT id, name, url, events, enabled, created_at, updated_at FROM webhooks ORDER BY created_at DESC`
- Mask `secret`: never include secret in the list response (the field is simply omitted, not `****` — `****` appears only in the create/update response to signal that a secret exists)
- Include a `hasSecret: boolean` field to indicate whether a secret is configured
- Include `lastDeliveryAt: Date | null` and `lastDeliveryStatus: 'success' | 'failed' | 'retrying' | null` from a subquery on `webhook_deliveries` (latest delivery per webhook)
- Return shape: `{ data: WebhookListItem[], meta: { total: number } }`

**`POST /cms/settings/webhooks`** — create a new webhook.
- Validate body: `name` (required, non-empty string), `url` (required, valid URL), `events` (required, non-empty string[]), `secret` (optional string), `enabled` (optional boolean, defaults true)
- Insert into `webhooks`
- Return the full record including the `secret` in plaintext (one-time exposure)
- Return 201 Created

**`PUT /cms/settings/webhooks/:id`** — update a webhook.
- Validate body: same fields as POST, all optional
- If `secret` is provided as `null` or empty string: clear the secret (`secret = null`)
- If `secret` is provided as a non-empty string: update the secret
- If `secret` is absent from the body: leave the existing secret unchanged
- Return the updated record; if secret was updated, return new secret in plaintext once. If secret was not changed (absent from body), return `hasSecret: true` and omit the secret field.
- Return 200

**`DELETE /cms/settings/webhooks/:id`** — delete a webhook and all its delivery records (CASCADE handles deliveries).
- Return 204 No Content

**`POST /cms/settings/webhooks/:id/test`** — test endpoint (synchronous). Covered by U7; this route delegates to U7's handler.

**`GET /cms/settings/webhooks/:id/deliveries`** — paginated delivery log.
- Query params: `cursor` (optional, CUID2 of last seen delivery), `limit` (optional, default 50, max 100)
- Query: `WHERE webhook_id = :id AND (cursor is null OR created_at < (SELECT created_at FROM webhook_deliveries WHERE id = :cursor)) ORDER BY created_at DESC LIMIT :limit`
- Return: `{ data: WebhookDelivery[], meta: { nextCursor: string | null } }`
- Each delivery row includes `id, event, status, attempt, responseStatus, responseBody, attemptedAt, createdAt`
- The `payload` column is not returned by default (large); add `?includePayload=true` for debugging

**`POST /cms/settings/webhooks/:id/deliveries/:deliveryId/retry`** — manually retry a failed delivery.
- Validates the delivery belongs to the given webhook (security: prevent cross-webhook delivery access)
- Checks `status === 'failed'` — only failed deliveries can be manually retried
- Sets `status = 'pending'`, `attempt` incremented
- Calls `deliverWebhook` synchronously (same as attempt 1)
- Updates the row with the result
- Returns the updated delivery row and HTTP status 200
- This is the "Retry" button in the admin UI (U6)

**Test scenarios:**

- `GET /webhooks` returns list with `hasSecret: true` for webhook with secret, no secret value exposed
- `GET /webhooks` includes `lastDeliveryStatus` from most recent delivery
- `POST /webhooks` creates webhook, returns 201 with full secret in response body
- `POST /webhooks` with invalid URL → 400 with validation error
- `POST /webhooks` missing `events` → 400
- `PUT /webhooks/:id` omitting `secret` field → existing secret preserved (not cleared)
- `PUT /webhooks/:id` with `secret: null` → secret cleared in DB
- `PUT /webhooks/:id` with new secret string → secret updated, returned in response once
- `DELETE /webhooks/:id` → 204, webhook_deliveries rows also deleted (CASCADE)
- `GET /webhooks/:id/deliveries` returns newest-first, cursor pagination works
- `GET /webhooks/:id/deliveries?limit=2` returns 2 results, `nextCursor` set if more exist
- `GET /webhooks/:id/deliveries?includePayload=true` includes payload field
- `POST /webhooks/:id/deliveries/:deliveryId/retry` with `status: 'failed'` → delivery re-attempted, row updated
- `POST /webhooks/:id/deliveries/:deliveryId/retry` with `status: 'success'` → 409 Conflict (not re-retried)
- All endpoints return 403 for non-admin users
- All endpoints return 401 for unauthenticated requests

**Verification:** All CRUD API tests pass. Secret masking verified at the HTTP response body level. Delivery log pagination verified with >50 records. Admin role enforcement verified with a user lacking the admin role.

---

### U6. Admin Webhook Settings UI

**Goal:** Implement the admin SPA page at `/settings/webhooks` — the list view, create/edit form, and delivery log modal.

**Requirements:** Uses the existing admin SPA stack (TanStack Router + TanStack Query + TanStack Form + Jotai). Integrates with the Hono RPC typed client (`hc`) from Plan 002. Delivery success rate shown per webhook. "Test webhook" button delegates to U7.

**Dependencies:** U5 (CRUD API endpoints), U7 (test endpoint), Plan 005 (admin SPA foundation and routing setup)

**Files:**
- `apps/admin/src/routes/settings/webhooks/index.tsx` — list page
- `apps/admin/src/routes/settings/webhooks/create.tsx` — create form
- `apps/admin/src/routes/settings/webhooks/edit.$id.tsx` — edit form
- `apps/admin/src/routes/settings/webhooks/deliveries.$id.tsx` — delivery log view

**Approach:**

**List page** (`/settings/webhooks`):

Uses TanStack Query to fetch `GET /cms/settings/webhooks`. Renders a table with columns: Name, URL (truncated to 50 chars with tooltip), Events (badges), Status (enabled/disabled toggle), Last Delivery, Success Rate, Actions.

Success rate is computed client-side from the `lastDeliveryStatus` in the list response. For the full rate (last 30 deliveries), a separate `GET /cms/settings/webhooks/:id/deliveries?limit=30` query is fetched lazily when the row is expanded or on hover — not for every webhook in the list view. The list view shows a simplified status indicator (last delivery status only).

The enabled/disabled toggle calls `PUT /cms/settings/webhooks/:id` with `{ enabled: !current }` immediately (optimistic update via TanStack Query's `optimisticUpdates`). On error, TanStack Query rolls back the optimistic state.

Each row has three action buttons: Edit (navigates to `/settings/webhooks/edit/:id`), Delivery Log (opens the delivery log view), Test (calls the test endpoint and shows a result toast).

**Create/Edit form** (`/settings/webhooks/create` and `/settings/webhooks/edit/:id`):

Uses TanStack Form. Fields:
- `name`: text input, required
- `url`: text input with URL validation, required. Shows a green checkmark icon when the URL starts with `https://`; a yellow warning when `http://` (HMAC is still recommended)
- `events`: multi-select combobox. The available event patterns are pre-defined: `*.create`, `*.update`, `*.delete`, `*.publish`, `*.unpublish`, plus collection-specific patterns (`articles.create`, etc. derived from the schema). Operators can also type a custom pattern. Each selected pattern appears as a removable badge.
- `secret`: password-type input. For create: empty by default; hint text "Leave blank for unsigned delivery". For edit: shows `••••••••` placeholder text when a secret exists; button "Rotate secret" clears the field for new input; button "Clear secret" sets it to null.
- `enabled`: toggle switch, defaults on for create

Form submission calls `POST /cms/settings/webhooks` (create) or `PUT /cms/settings/webhooks/:id` (edit) via TanStack Query mutation. On success: navigate to the list page and show a toast. For create, if a secret was entered, show a modal: "Your webhook secret — save this now. It won't be shown again. [secret value with copy button]". This modal must be explicitly dismissed; it is not auto-closed.

**Delivery log view** (`/settings/webhooks/deliveries/:id`):

Rendered as a full page (not a modal — the delivery log can be long and needs full-page space for readability).

Uses TanStack Query with cursor pagination. Renders a table: Attempt #, Event, Status (badge: success/failed/retrying), HTTP Status Code, Duration, Attempted At, Response Body (truncated, click to expand).

"Retry" button on failed rows: calls `POST /cms/settings/webhooks/:id/deliveries/:deliveryId/retry`. Shows loading state on the button. Updates the row optimistically to `pending` and then refreshes the query.

"Load more" button at the bottom fetches the next page using the `nextCursor` from the response.

**Jotai atoms:**
- `deliveryLogModalState`: `{ isOpen: boolean; webhookId: string | null }` — for future inline modal usage (already structured for if the UI moves back to a modal)
- `webhookTestResultState`: `{ status: number | null; body: string | null; loading: boolean }` — per webhook test result shown inline below the Test button

**Test scenarios (component / integration level):**

- List page renders webhook rows with correct enabled state
- Toggling enabled calls PUT with `{ enabled: false }` and optimistically updates the UI
- Toggling enabled, on API error, rolls back the optimistic toggle
- Create form submits valid data, navigates to list on success, shows secret modal when secret was provided
- Create form with invalid URL shows inline validation error before submit
- Edit form loads existing webhook data, pre-fills `hasSecret` indicator in secret field
- Edit form with "Rotate secret" clears the field for new input
- Delivery log renders paginated deliveries newest-first
- "Retry" button for failed delivery triggers retry API call and updates row status
- "Test webhook" button triggers test API and shows result below the button

**Verification:** Admin UI renders without runtime errors. Create + edit flows work end-to-end in a dev environment. Secret modal appears and requires explicit dismissal. Delivery log pagination loads additional pages.

---

### U7. Webhook Test Button

**Goal:** Implement the synchronous test-delivery endpoint `POST /cms/settings/webhooks/{id}/test` — fires a `cms.test` event to the webhook's URL immediately, records the delivery, and returns the HTTP response to the admin UI so operators can verify their endpoint is working.

**Requirements:** Synchronous (no queue). Returns the receiver's HTTP status and response body in the API response. Records the delivery in `webhook_deliveries` for auditability. Admin-only.

**Dependencies:** U1 (types, schema), U3 (deliverWebhook), U5 (admin auth middleware, webhook lookup)

**Files:**
- Handler is implemented inside `packages/core/src/routes/settings/webhooks.ts` (the same file as U5 endpoints, as a `POST /:id/test` route on the same router)
- `packages/core/src/routes/settings/__tests__/webhooks.api.test.ts` (extends U5 test file)

**Approach:**

The handler:

1. Load the webhook record by `:id`, return 404 if not found
2. Construct a test `WebhookPayload`:
   ```
   {
     event: 'cms.test',
     timestamp: <ISO 8601 now>,
     collection: null,
     documentId: null,
     data: { message: 'Test delivery from @hono-cms' },
     meta: { cms_version: <version from package.json> }
   }
   ```
3. Create a `webhook_deliveries` row with `event: 'cms.test'`, `status: 'pending'`, `attempt: 1`
4. Call `deliverWebhook(resolvedWebhook, 'cms.test', testPayload, deliveryId)` with the same U3 function — no special path for test delivery. HMAC signing applies if the webhook has a secret. Timeout is the same 10 seconds.
5. Update the delivery row with `status: 'success'` or `status: 'failed'` (do NOT enqueue retry for test deliveries — test is synchronous and operators want immediate feedback, not deferred retry)
6. Return the response to the caller:
   ```json
   {
     "success": true,
     "statusCode": 200,
     "durationMs": 143,
     "responseBody": "ok",
     "deliveryId": "cuid2..."
   }
   ```
7. Return HTTP 200 from the CMS API regardless of whether the webhook endpoint returned success or failure (the test endpoint always succeeds from the CMS perspective — it delivers the test and reports the result). A 500 from the receiver is captured in `statusCode: 500` in the response body, not a 500 from the CMS API.

**Why test delivery is not queued:** The explicit goal is operator verification — "does my endpoint receive the payload?" Queuing would delay the feedback loop, negating the value of the test button. The 10-second synchronous call is acceptable: operators explicitly triggered the test and are waiting for the result.

**Why test delivery is recorded in `webhook_deliveries`:** Test deliveries appear in the delivery log so operators can review the exact payload and response that was sent during testing, alongside real delivery records. They are visually distinguished by `event: 'cms.test'` in the log view.

**Test scenarios:**

- Test endpoint fires POST to webhook URL with `event: 'cms.test'` payload
- HMAC signature included in test delivery when webhook has a secret
- Response: `{ success: true, statusCode: 200, durationMs: N, responseBody: '...' }` when receiver returns 200
- Response: `{ success: false, statusCode: 404 }` when receiver returns 404 — CMS API still returns HTTP 200
- Response: `{ success: false, statusCode: 0, error: 'timeout' }` when receiver times out — CMS API still returns HTTP 200
- Test delivery record created in `webhook_deliveries` with `event: 'cms.test'`, `status: 'success'` or `'failed'`
- Test delivery record does NOT trigger retry enqueue (no QStash call on failure)
- Test endpoint returns 403 for non-admin users
- Test endpoint returns 404 when webhook ID does not exist

**Verification:** Test endpoint returns the receiver's response inline in the API response. Test delivery appears in the delivery log with `cms.test` event label. No retry is enqueued for test failures. Admin role enforcement verified.

---

## System-Wide Impact

**Affected surfaces:**
- **Content mutation lifecycle (Plan 003):** The dispatcher (`WebhookDispatcher.dispatch`) is called after every successful content write. Plans 003 and later content route plans must invoke the dispatcher at the right point in the request lifecycle (after DB write, before response serialization).
- **`createCMS` bootstrap (Plan 002):** The `CMSConfig` type gains a `webhooks?: WebhookConfig[]` key. The bootstrap instantiates `WebhookDispatcher` and holds it on the CMS internals. This is a non-breaking additive change to the config interface.
- **Job router (Plan 010):** The `POST /cms/jobs/webhook-retry` handler is added to the job routing table from Plan 010. This plan should not land before Plan 010's job router is available.
- **Core schema migrations:** The `webhooks` and `webhook_deliveries` tables are added to the CMS core schema. The next `cms schema plan` run after this plan lands will produce a migration adding these tables.
- **Admin SPA routing (Plan 005):** The `/settings/webhooks` route tree is added to the admin SPA's TanStack Router config.
- **Audit log (Plan 016):** The design decision to fire webhook dispatch before audit log entry (described in U2) must be respected when Plan 016 is implemented.

**Breaking changes:** None. The `webhooks` key in `CMSConfig` is optional. Existing `createCMS` calls without `webhooks` continue to work; the dispatcher no-ops when no static webhooks are configured and no UI-managed webhooks are enabled.

---

## Alternative Approaches Considered

### Alt 1: Always-Async Delivery (Queue Everything, Never Synchronous)

All deliveries go to QStash; no synchronous attempt 1. The mutation returns the instant the DB write completes.

**Why not chosen:** Operators lose the immediate feedback loop. A publish action that should reindex Algolia might not fire for 30 seconds or more if QStash is backlogged. The delivery log would show `pending` for an extended period after content events, reducing operator confidence. The synchronous attempt 1 (with a 10-second timeout) keeps the common case fast and only defers when the receiver is unhealthy.

### Alt 2: One Row Per Attempt in `webhook_deliveries`

Create a new `webhook_deliveries` row for each attempt (1, 2, 3) instead of updating the same row.

**Why not chosen:** The delivery log becomes harder to read — three rows for one failed delivery, each with partial information. The single-row model keeps one logical entry per "dispatch event → webhook endpoint" pair, with the `attempt` count and latest response reflecting the current state. The full request/response history is less critical than the current state for operator debugging.

### Alt 3: Webhook-Specific Event Filtering at SQL Level

Add a SQL `WHERE events @> '["articles.publish"]'` (Postgres JSONB) to filter webhooks at the DB layer rather than loading all enabled webhooks and filtering in JS.

**Why not chosen:** The SQL is dialect-specific (Postgres JSONB array containment is not available in SQLite/D1). The JS-side `matchesAnyPattern` must run regardless because SQL cannot evaluate glob patterns. Loading all enabled webhooks in one query and filtering in JS is correct for the expected scale (< 100 UI-managed webhooks is the realistic ceiling for a CMS deployment). This can be revisited for Postgres-only deployments at scale in a follow-up.

### Alt 4: Store Secrets Hashed (Like Passwords)

Hash the secret at rest using bcrypt or argon2, preventing secret retrieval even from DB access.

**Why not chosen:** HMAC signing requires the plaintext secret at delivery time. A hashed secret cannot be used for HMAC without asking the operator to re-enter it on every delivery — which is not a viable UX. The correct security model for webhook secrets is: plaintext storage, masked UI, one-time exposure at creation. This is the model used by GitHub, Stripe, and every major webhook provider. DB-level encryption (at rest) is the correct mitigation for protecting the plaintext secret — that is an infrastructure concern (encrypted disk, encrypted Turso/Neon storage), not an application concern.

---

## Risk Analysis and Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Webhook dispatch adds >10s to content mutation latency | Low (healthy endpoints respond in <1s) | High (operators experience slow saves) | AbortSignal.timeout(10_000) hard cap. Monitor p95 dispatch duration in delivery log. |
| QStash enqueue fails after attempt 1 failure | Low | Medium (delivery lost, no retry) | Log the QStash failure with full context. Implement a "repair" job that scans for `webhook_deliveries` rows in `retrying` status with `attemptedAt` > 1 minute ago and re-enqueues them. Defer to post-v1. |
| Secret stored in plaintext is exposed via DB breach | Low (mitigated by infra encryption) | High | Document the expectation of encrypted-at-rest DB storage. Add a `GET /cms/health` check (Plan 020) that warns when the DB provider does not support encryption at rest. |
| HMAC signature computed with Web Crypto is async — adds latency to every delivery | Very Low (~0.1ms) | Negligible | Not a real risk at this scale. Document that `createHmacSignature` is async for edge compatibility. |
| Static config webhook URL leaks into DB via payload meta (U4 approach) | Low | Medium (URL visible to DB readers) | Accept as a known tradeoff — the URL is already in the CMS config. Alternatively, store static config webhooks in a separate in-memory registry and pass the full config to the retry handler as a closure. Defer to implementation decision. |
| Operator enters `http://` (not HTTPS) webhook URL | Medium | Medium (payload transmitted unencrypted) | Admin UI shows a yellow warning for non-HTTPS URLs. The API does not block HTTP URLs — it is the operator's responsibility. HMAC signing is still recommended for HTTP endpoints. |

---

## Dependencies and Prerequisites

- **Plan 001 (Monorepo Foundation):** Workspace build tooling must be in place.
- **Plan 002 (Core Library):** `createCMS` type surface must accept the `webhooks?: WebhookConfig[]` key. The dispatcher must be instantiatable during bootstrap.
- **Plan 003 (Database Adapter Interface):** The Drizzle client and shared DB instance are passed to `WebhookDispatcher`. The `webhooks` and `webhook_deliveries` tables must be included in the schema migration.
- **Plan 004 (Auth Integration):** The admin role middleware must be available for the CRUD API routes (U5).
- **Plan 005 (Admin SPA):** TanStack Router routing setup and the Hono RPC `hc` client must be available for the admin UI (U6).
- **Plan 010 (Background Jobs / QStash):** QStash client and job router must be in place before U4 (retry) can be implemented. U1–U3 and U5/U6/U7 can land before Plan 010 is complete, with retry stubbed as a no-op (`console.warn('QStash not configured, retry disabled')`).

---

## Deferred Implementation Notes

- The exact SQL cursor pagination query for `webhook_deliveries` may need adjustment once the ORM query builder conventions are established in Plan 003.
- The `ResolvedWebhook.webhookId = null` approach for static config webhooks (storing target URL in payload meta for retry) is a planning-time decision; implementation may reveal a cleaner approach once the retry handler is being built.
- The admin UI's events multi-select component needs a list of available event patterns. The source of this list (hardcoded + collection-derived) must be determined during Plan 003 (content routes) when the full set of collection events is known.
- Whether `WebhookDispatcher` is instantiated eagerly in `createCMS` or lazily on first dispatch is an implementation detail — lazy is safer in edge runtimes where cold start cost matters.

---

## Test Scenarios Reference (Cross-Unit)

The following integration test scenarios span multiple units and should be written as end-to-end tests in the test suite:

1. **Delivery happy path:** Create a UI webhook. Trigger a content mutation that matches the event. Verify: delivery row created, receiver received the correct payload, delivery row status `'success'`.

2. **HMAC signature valid:** Create a UI webhook with a secret. Trigger delivery. Verify: `X-CMS-Signature` header present and correct; receiver using the standard verification utility accepts the signature.

3. **HMAC signature absent:** Create a UI webhook without a secret. Trigger delivery. Verify: `X-CMS-Signature` header absent from request.

4. **Retry after 2 failures:** Create a webhook pointing to a mock server that returns 503 for the first two requests and 200 on the third. Trigger delivery. Verify: delivery row status progresses `pending → retrying → retrying → success`; QStash enqueued with correct delays (mocked QStash client in tests).

5. **Test button:** Call test endpoint. Verify: `cms.test` delivery row created in `webhook_deliveries`; response contains receiver's status code; no retry enqueued.

6. **UI webhook disable:** Create webhook, disable via admin UI toggle (PUT with `enabled: false`). Trigger content mutation matching the event. Verify: delivery NOT fired for disabled webhook.

7. **Wildcard event matching:** Create static config webhook with `events: ['*.publish']`. Trigger `articles.publish`, `pages.publish`, `blog-posts.publish`. Verify: all three trigger delivery to the static webhook. Trigger `articles.create` — verify NOT delivered.

8. **Static config webhook delivery:** Configure `createCMS` with a static webhook targeting a mock server. Trigger the matching event. Verify: delivery fired, delivery row written with `webhookId: null`.

9. **Delivery log pagination:** Create a webhook and trigger 75 delivery events. Fetch `GET /deliveries?limit=50` → 50 rows, `nextCursor` set. Fetch `GET /deliveries?limit=50&cursor=<nextCursor>` → 25 rows, `nextCursor: null`.

10. **Secret masking:** Create webhook with secret. `GET /webhooks` list response: `hasSecret: true`, no `secret` field. `GET /webhooks/:id` (if individual get endpoint added): same masking. `PUT /webhooks/:id` with same secret string: response includes secret once.

---

## Verification Checklist

- [ ] `matchesPattern` passes all pattern matching unit tests including edge cases (multi-segment patterns, system events)
- [ ] `webhook_deliveries` rows are created for every dispatch attempt (static and UI-managed)
- [ ] HMAC signature in `X-CMS-Signature` header verifies correctly using the standard receiver utility
- [ ] Delivery row status transitions correctly: `pending → success` / `pending → retrying` / `retrying → failed`
- [ ] Retry not enqueued after 3 failed attempts (status: `'failed'`, QStash not called)
- [ ] Test endpoint returns receiver's HTTP status inline in the API response body
- [ ] Test delivery row has `event: 'cms.test'`, no retry enqueued on failure
- [ ] Admin CRUD API returns 403 for non-admin roles, 401 for unauthenticated
- [ ] Secret never returned in list or individual GET responses (only in create/update response)
- [ ] Disabled webhook (enabled=false) does not receive deliveries
- [ ] Static config webhooks receive deliveries without appearing in the admin UI webhook list
- [ ] Delivery log endpoint returns results cursor-paginated, newest first
- [ ] Admin UI "Retry" button on failed delivery fires re-delivery and updates the row in the list
