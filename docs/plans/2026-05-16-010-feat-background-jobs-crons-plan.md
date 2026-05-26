---
title: "feat: Background Jobs & Crons — QStash, Vercel, Cloudflare + /cms/jobs/* Endpoints"
date: 2026-05-16
type: feat
status: active
depth: deep
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
ideation-ideas: ["#17 Background Jobs (Crons) — QStash as Universal Default"]
---

# Plan 010: Background Jobs & Crons

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 2
**Research inputs used:** skill review, framework docs, architecture review, performance review

### Key Improvements

1. Add bounded-batch, backpressure, and idempotency requirements for all jobs.
2. Make QStash security and dedupe expectations explicit.
3. Separate queue/scheduler concerns more clearly in the abstractions.

**Sequence:** 010 of 018
**Package:** `packages/jobs/` → `@hono-cms/jobs`
**Blocking:** Plans 013 (webhooks), 010 (scheduled publish), and 015 (cache) deliver partial value without this plan. Webhook retry, scheduled publishing, and cache sweep are incomplete features until job execution exists.

---

## Purpose

Background jobs are the silent infrastructure beneath three already-designed CMS features: webhook retry (Plan 013), scheduled publishing (Plan 010 draft/publish), and cache invalidation sweeps (Plan 015). Without job execution, those features degrade silently — failed webhooks are never retried, scheduled-publish documents stay as drafts past their `publishAt` time, and stale cache entries accumulate indefinitely.

The core design principle is **job logic lives once, as standard HTTP handlers**. Each job is a plain `POST` endpoint under `/cms/jobs/*`. The cron provider's only responsibility is to call that endpoint on schedule. Runtime-specific wiring is a thin shim. This means the CMS adds no runtime-specific job code to support Vercel, Cloudflare, or QStash — it adds one HTTP router, and each provider calls it differently.

Three providers are supported:

| Provider | Trigger mechanism | On-demand enqueue | Signature verification |
|---|---|---|---|
| `qstash` | HTTP POST by Upstash scheduler | `publishJSON` + delay | HMAC via `@upstash/qstash` Receiver |
| `vercel` | HTTP GET/POST by Vercel Cron | No (schedule only) | `x-vercel-signature` header |
| `cloudflare` | Worker `scheduled` export (internal) | Cloudflare Queues or QStash fallback | None (internal call) |
| `none` | Disabled | No | Rejects all `/cms/jobs/*` with 404 |

This plan covers the full `@hono-cms/jobs` package: the adapter interface, the job handler registry, all three provider implementations, and the four built-in job functions (webhook retry, scheduled publish, audit log cleanup, cache sweep is addressed in Plan 015 but its endpoint is registered here).

---

## Key Technical Decisions

## Research Insights

**Best Practices:**
- Add a first-class dedupe or idempotency field to every scheduled payload instead of relying on per-job convention.
- Consider splitting queueing and scheduling capabilities so provider gaps stay visible instead of hiding behind one broad cron abstraction.
- Keep the HTTP-handler model because it preserves portability and straightforward testing.

**Performance Considerations:**
- Every built-in job should process bounded batches with explicit claim/lease semantics rather than unbounded scans.
- Define per-job throughput controls early: batch size, max concurrency, retry backoff, dead-letter threshold, and metrics.

**Security Considerations:**
- Require signature verification anywhere a provider can reach job endpoints over HTTP.
- Keep local-development bypass behavior explicit so it does not weaken production assumptions.

### 1. Why HTTP endpoints as the universal job pattern

The alternative is to implement jobs using each runtime's native scheduling API: Worker `scheduled` export for Cloudflare, Vercel Cron's built-in route resolution, Node.js `node-cron` for local development. That approach requires the job logic (retry logic, publish query, cleanup batch) to be duplicated or bridged across all three runtimes.

HTTP endpoints invert this: job logic is written once as a Hono route handler. The runtime-specific code shrinks to a one-line dispatch. Cloudflare's `scheduled` export constructs a synthetic internal `Request` and calls `cms.fetch`. Vercel Cron calls the real endpoint with an HTTP GET. QStash calls with an HTTP POST and a signed body.

This also means job handlers are independently testable with standard HTTP testing tools (`fetch`, Hono's `app.request` test helper). No runtime-specific test harnesses are needed. A handler that returns 200 for a valid request and 401 for a missing signature is the entire test contract.

### 2. Why QStash is the universal default

QStash (Upstash) is an HTTP message queue that works on every runtime where `fetch` works — Cloudflare Workers, Vercel Edge Functions, Node.js, and Bun. It has no TCP dependency, no persistent connection, no keep-alive requirement. It signs outbound requests with an HMAC so recipients can verify authenticity.

The alternatives at the time of writing:
- **BullMQ / Sidekiq / similar**: require a persistent Redis TCP connection — incompatible with Cloudflare Workers and Vercel Edge. Disqualified.
- **AWS SQS**: requires `aws-sdk` or `@aws-sdk/client-sqs`, which pulls in Node.js-specific crypto. Possible on Node.js only. Disqualified for universality.
- **Inngest**: HTTP-based like QStash, similar guarantees. Valid alternative but requires Inngest's hosting. QStash (Upstash) is chosen because the project already evaluates Upstash Redis as the cache provider — one Upstash account, two services, same billing.
- **Trigger.dev**: HTTP-based but requires its own server. Disqualified for edge deployments.

QStash passes all three gates: no TCP, signed requests, runs everywhere `fetch` runs.

### 3. Why signature verification is mandatory

The `/cms/jobs/*` endpoints perform privileged operations: publishing documents, deleting audit records, re-sending failed HTTP requests. Any unauthenticated caller who can reach these endpoints can trigger mass-publish, exhaust retention policies, or flood a webhook target with retries.

Signature verification ensures that only the configured cron provider can trigger these endpoints. This is not defense-in-depth — it is the primary security control. The endpoints must not be callable without a valid signature regardless of network configuration (there is no "private network" guarantee on edge runtimes).

For `provider: 'none'`, all `/cms/jobs/*` routes return 404. This is stronger than 401 — it provides no information that the routes exist.

### 4. How `baseUrl` is determined per runtime

QStash needs the CMS's public URL to enqueue jobs (it makes outbound HTTP calls to your endpoints). This URL cannot be hardcoded or inferred from the request — the first request may arrive before any outbound job is enqueued, and on Cloudflare Workers the `request.url` host reflects the Worker's internal routing, not the public DNS name.

The `baseUrl` is configured explicitly by the developer in `createCMS`:

```ts
createCMS({
  baseUrl: env.CMS_PUBLIC_URL,  // e.g., 'https://api.example.com'
  crons: { provider: 'qstash', token: env.QSTASH_TOKEN },
})
```

`CMS_PUBLIC_URL` is a required environment variable when `provider` is `qstash`. The factory (`createJobsAdapter`) validates that `baseUrl` is set and throws a startup error (not a runtime error) if it is missing. This prevents the silent failure mode where job enqueues silently target `undefined/cms/jobs/webhook-retry`.

For `provider: 'vercel'` and `provider: 'cloudflare'`, `baseUrl` is not used (Vercel Cron calls the endpoint by path within the deployment; Cloudflare dispatches internally). The field is still accepted but ignored.

In local development, `baseUrl` is typically `http://localhost:3000`. QStash cannot reach `localhost` — developers should use the [QStash local server](https://github.com/upstash/qstash-local) or set `provider: 'none'` and test job handlers by calling them directly.

### 5. Idempotency requirements for all job handlers

All job handlers must be safe to call multiple times with the same arguments. Cron providers deliver at-least-once — a handler may be called twice for the same scheduled time due to network retries or provider re-delivery. Two concurrent executions of `scheduled-publish` must not double-publish the same document.

Idempotency strategies by job:

- **Webhook retry**: the handler reads the delivery's current `status` before retrying. If `status` is `delivered` or `exhausted`, it returns 200 without re-attempting. Concurrent retries are serialized by a row-level lock or CAS update (`UPDATE ... WHERE status = 'pending' RETURNING *`).
- **Scheduled publish**: the query filters `status = 'draft'`. A published document has `status = 'published'` — re-running the query skips already-published documents. No locking needed; double-publish is prevented by the status filter.
- **Audit log cleanup**: `DELETE WHERE created_at < threshold` is idempotent — deleting already-deleted rows is a no-op.
- **Cache sweep**: cache eviction is idempotent by definition.

---

## Output Structure

```
packages/jobs/
├── package.json                           # @hono-cms/jobs, depends on @hono-cms/core, @upstash/qstash
├── tsconfig.json
├── tsdown.config.ts                       # platform: 'neutral', entry: src/index.ts
├── vitest.config.ts
└── src/
    ├── index.ts                           # public exports: createJobsAdapter, createJobHandlers, job fns
    ├── types.ts                           # CronsConfig discriminated union, JobsAdapter interface
    ├── factory.ts                         # createJobsAdapter(config, baseUrl)
    ├── registry.ts                        # createJobHandlers() — Hono sub-router
    ├── providers/
    │   ├── qstash.ts                      # QStashJobsAdapter
    │   ├── vercel.ts                      # VercelJobsAdapter
    │   ├── cloudflare.ts                  # CloudflareJobsAdapter
    │   └── none.ts                        # NoneJobsAdapter
    └── jobs/
        ├── webhook-retry.ts               # webhookRetryJob()
        ├── scheduled-publish.ts           # scheduledPublishJob()
        ├── audit-log-cleanup.ts           # auditLogCleanupJob()
        └── cache-sweep.ts                 # cacheSweepJob() (stub, implementation in Plan 015)
```

Test files mirror the `src/` structure under `src/__tests__/` or alongside source as `*.test.ts`.

---

## High-Level Technical Design

*This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Request flow: QStash provider

```
QStash Scheduler
  │  POST /cms/jobs/scheduled-publish
  │  Headers: upstash-signature: <HMAC>
  │  Body: {} (or { deliveryId } for webhook-retry)
  ▼
Hono router: /cms/jobs/*
  │
  ├── middleware: adapter.verify(c.req.raw)
  │     QStashJobsAdapter.verify()
  │       Receiver.verify({ signature, body, url })
  │       → false → return 401 Unauthorized
  │       → true  → next()
  │
  └── handler: scheduledPublishJob(db, events)
        query: SELECT * FROM documents WHERE publishAt <= NOW() AND status = 'draft'
        forEach: UPDATE status='published', emit 'articles.publish'
        return 200 OK { published: N }
```

### Cloudflare scheduled dispatch (no HTTP)

```
Cloudflare Cron Trigger fires: "* * * * *"
  │
  ▼
Worker scheduled export:
  await cms.scheduledHandler(event.cron, env, ctx)
  │
  ▼
CloudflareJobsAdapter.dispatch(cron)
  match cron → '* * * * *'  → scheduledPublishJob(db, events)
               '*/5 * * * *' → webhookRetryJob(db)     (poll pending retries)
               '0 0 * * *'   → auditLogCleanupJob(db, retentionDays)
```

### Webhook retry backoff state machine

```
Delivery created, status = 'pending'
  │
  ▼ HTTP POST to webhook target
  ├── success → status = 'delivered'                    (terminal)
  │
  └── failure → attemptCount++
        ├── attemptCount = 1 → enqueue delay 30s  → status = 'pending'
        ├── attemptCount = 2 → enqueue delay 5min → status = 'pending'
        ├── attemptCount = 3 → enqueue delay 1hr  → status = 'pending'
        └── attemptCount > 3 → status = 'exhausted'     (terminal, no more retries)
```

---

## Implementation Units

---

### U1. JobsAdapter Interface and Factory

**Goal:** Define the `JobsAdapter` TypeScript interface and `CronsConfig` discriminated union type. Implement `createJobsAdapter(config, baseUrl)` factory that constructs the correct adapter based on the `provider` field. This is the only module that knows which provider is active — all other modules depend on the interface, not the implementations.

**Requirements:**
- `JobsAdapter` interface must have two methods: `enqueue(endpoint, body, options?)` for on-demand job dispatch and `verify(request)` for signature validation.
- `CronsConfig` must be a discriminated union on the `provider` literal: `'qstash' | 'vercel' | 'cloudflare' | 'none'`.
- `createJobsAdapter` must throw a startup-time `Error` (not a runtime error) if `provider === 'qstash'` and `baseUrl` is falsy.
- The factory must export a `scheduledHandler` function alongside the adapter — used by Cloudflare's `cms.scheduledHandler` export.

**Dependencies:** None. This is the foundation unit.

**Files:**
- `packages/jobs/src/types.ts` — `CronsConfig`, `JobsAdapter`, `EnqueueOptions`, `ScheduledHandlerFn`
- `packages/jobs/src/factory.ts` — `createJobsAdapter(config, baseUrl)`
- `packages/jobs/src/index.ts` — re-exports

**Approach:**

The `JobsAdapter` interface has three members:

```
interface JobsAdapter {
  enqueue(endpoint: string, body: unknown, options?: EnqueueOptions): Promise<void>
  verify(request: Request): Promise<boolean>
  scheduledHandler?(cron: string): Promise<void>
}

interface EnqueueOptions {
  delay?: number  // seconds
}
```

`CronsConfig` is a discriminated union:

```
type CronsConfig =
  | { provider: 'qstash';     token: string; signingKey?: string }
  | { provider: 'vercel';     secret?: string }
  | { provider: 'cloudflare'; cronMap?: CronMap }
  | { provider: 'none' }
```

`CronMap` is `Record<string, () => Promise<void>>` — maps cron expressions to job functions. Used by the Cloudflare adapter's dispatcher.

`createJobsAdapter` is a simple switch on `config.provider` that instantiates the correct class. The `baseUrl` is passed through to the QStash adapter's constructor; the others ignore it.

Startup validation: if `provider === 'qstash'` and `!baseUrl`, throw `new Error('[hono-cms/jobs] QStash provider requires baseUrl (CMS_PUBLIC_URL). Set it in createCMS({ baseUrl }) or provide via env.')`. This must fire during `createCMS()` initialization, not on the first job enqueue.

**Test scenarios:**
- `createJobsAdapter({ provider: 'qstash', token: 'tok' }, 'https://example.com')` returns an object satisfying `JobsAdapter` (has `enqueue`, `verify`).
- `createJobsAdapter({ provider: 'qstash', token: 'tok' }, '')` throws the startup validation error synchronously.
- `createJobsAdapter({ provider: 'none' }, '')` does not throw (no baseUrl required for `none`).
- `createJobsAdapter({ provider: 'vercel' }, '')` does not throw.
- `createJobsAdapter({ provider: 'cloudflare' }, '')` does not throw.
- All returned adapters satisfy the `JobsAdapter` shape (TypeScript structural check via `satisfies`).

**Verification:** TypeScript compiles without errors. Unit tests pass. Switching `provider` returns a different concrete class (verified via `instanceof` or duck-typed method behavior in tests).

---

### U2. Job Handler Registry

**Goal:** Implement `createJobHandlers(deps, adapter)` — a Hono sub-app that mounts all `/cms/jobs/*` POST routes. Each route runs signature verification via `adapter.verify()` first, then calls the corresponding job function. Job logic is pure — no provider-specific code inside the job functions themselves. The registry is mounted inside `@hono-cms/core` under `/cms/jobs`.

**Requirements:**
- All routes must call `adapter.verify(c.req.raw)` before executing job logic. A `false` result must return `401 Unauthorized` with a JSON body `{ error: 'unauthorized' }` and no further processing.
- For `provider: 'none'`, all routes must return `404 Not Found`. (The `NoneJobsAdapter.verify()` always returns `false`, and the router is not mounted at all — both are safety nets.)
- Each route must catch unhandled errors from job functions, log them, and return `500 Internal Server Error` with `{ error: 'job failed', message }`. Job failures must never propagate as unhandled rejections.
- Routes return `200 OK` with a JSON summary of the job's outcome (e.g., `{ published: 3, skipped: 0 }`).

**Dependencies:** U1 (adapter interface)

**Files:**
- `packages/jobs/src/registry.ts` — `createJobHandlers(deps, adapter): Hono`
- `packages/jobs/src/__tests__/registry.test.ts`

**Approach:**

`createJobHandlers` accepts a `deps` object and the `JobsAdapter` instance:

```
interface JobHandlerDeps {
  db: DatabaseAdapter
  cache: CacheAdapter | null
  events: EventEmitter
  retentionDays: number
}
```

The Hono sub-app is created with `new Hono()`. A shared middleware runs first on all routes:

```
app.use('*', async (c, next) => {
  const ok = await adapter.verify(c.req.raw)
  if (!ok) return c.json({ error: 'unauthorized' }, 401)
  await next()
})
```

Routes registered:
- `POST /webhook-retry` → `webhookRetryJob(db)` with body payload `{ deliveryId }`
- `POST /scheduled-publish` → `scheduledPublishJob(db, events)`
- `POST /cache-sweep` → `cacheSweepJob(cache)` (stub in this plan, implemented in Plan 015)
- `POST /translation` → stub returning `{ status: 'not implemented' }` with 501
- `POST /audit-log-cleanup` → `auditLogCleanupJob(db, retentionDays)`

Each route wraps the job call in `try/catch`. On error: log `console.error('[hono-cms/jobs]', route, error)` and return `c.json({ error: 'job failed', message: String(error) }, 500)`.

For `provider: 'none'`, the registry is never mounted — `createCMS` conditionally skips `app.route('/cms/jobs', jobHandlers)` when the adapter is `NoneJobsAdapter`. This is documented as a contract in this unit.

**Test scenarios:**
- Valid signature → handler called → 200 with outcome JSON.
- Invalid signature (`adapter.verify` returns `false`) → 401, handler never called.
- Job function throws → 500, error message in body, no unhandled rejection.
- `POST /cms/jobs/webhook-retry` with `{ deliveryId: 'abc' }` body → `webhookRetryJob` called with `'abc'`.
- `POST /cms/jobs/scheduled-publish` → `scheduledPublishJob` called, returns `{ published: N }`.
- `POST /cms/jobs/audit-log-cleanup` → `auditLogCleanupJob` called, returns `{ deleted: N }`.
- `POST /cms/jobs/translation` → 501 not implemented.
- All routes: missing body or malformed JSON → 400 or graceful 200 (job handles it).

**Verification:** All routes reachable via `app.request()` in Vitest. Signature middleware tested with both a passing stub adapter and a rejecting stub adapter. Error handling verified by injecting a job function that throws.

---

### U3. QStash Provider

**Goal:** Implement `QStashJobsAdapter`. Uses `@upstash/qstash` for both publishing jobs (enqueue) and verifying inbound requests (signature check). Supports one-off delayed jobs and recurring schedules. Handles dev mode with a local QStash server.

**Requirements:**
- `enqueue(endpoint, body, options)` must call `@upstash/qstash` `Client.publishJSON` with the full URL: `${baseUrl}${endpoint}`.
- Recurring schedule setup (`schedules.create`) must be driven by the CMS bootstrap, not the job handler. Schedules are idempotent — if a schedule already exists for the same destination+cron, the create call must be a no-op or replace it without error.
- `verify(request)` must use `@upstash/qstash` `Receiver.verify` with `currentSigningKey` and `nextSigningKey`.
- Dev mode: when `QSTASH_URL=http://localhost:8080` is set (pointing to the [QStash local dev server](https://github.com/upstash/qstash-local)), skip signature verification and use the local URL. When the `DEV_SKIP_JOB_SIGNATURE=true` env var is set, `verify()` always returns `true` (local testing only, explicitly documented as dev-only).
- `QSTASH_TOKEN` env var must be the source of the token in production. The `token` in `CronsConfig` is the runtime value already resolved from env.

**Dependencies:** U1 (adapter interface)

**Files:**
- `packages/jobs/src/providers/qstash.ts` — `QStashJobsAdapter` class
- `packages/jobs/src/__tests__/providers/qstash.test.ts`

**Approach:**

The adapter wraps the `@upstash/qstash` `Client` and `Receiver` classes. Both are instantiated in the constructor. `Receiver` requires `currentSigningKey` and `nextSigningKey` — these are separate from the `token` (they are used for verification, not publishing). In practice, developers get all three from the Upstash console; the `CronsConfig` for QStash accepts `token` and optionally `signingKey` (for the receiver — if not provided, the adapter attempts `process.env.QSTASH_CURRENT_SIGNING_KEY`).

`enqueue` constructs the full URL (`baseUrl + endpoint`) and calls `client.publishJSON({ url, body, delay })`. The `delay` is in seconds, which matches QStash's API.

`verify` reads the `upstash-signature` header from the request, reads the raw body as text (important: the body must not be consumed before this), and calls `receiver.verify({ signature, body, url })`. The `url` passed to verify must be the full URL including the path — constructed from the request's `url` property.

Body consumption is a subtle hazard: `c.req.raw.text()` consumes the body stream. The verify middleware must read the raw body and store it in context variables so the route handler can also read it (via `c.req.json()`). In Hono, this is handled by caching the body: `const body = await c.req.text(); c.set('rawBody', body)` before calling `verify`. The registry (U2) is responsible for this setup, documented here as a constraint the QStash adapter imposes.

**Schedule bootstrap:** `QStashJobsAdapter.bootstrapSchedules(scheduleMap)` creates/updates QStash schedules for recurring jobs. Called once during `createCMS()` initialization. `scheduleMap` is `Record<cron, endpoint>`. The method lists existing schedules and creates only missing ones — skipping duplicates prevents accumulation on every cold start.

Dev mode detection:
1. Check `process.env.QSTASH_URL` — if set to a non-`https://qstash.upstash.io` URL, treat as local dev, disable signature verification.
2. Check `process.env.DEV_SKIP_JOB_SIGNATURE === 'true'` — always skip verification (explicit opt-in).

**Test scenarios:**
- `enqueue('/cms/jobs/webhook-retry', { deliveryId: 'x' }, { delay: 30 })` calls `client.publishJSON` with `url: 'https://example.com/cms/jobs/webhook-retry'`, `delay: 30`.
- `verify(request)` with a valid QStash HMAC signature → returns `true`.
- `verify(request)` with a tampered body → `Receiver.verify` throws → adapter catches and returns `false` (does not re-throw).
- `verify(request)` with missing `upstash-signature` header → returns `false`.
- Dev mode (`QSTASH_URL=http://localhost:8080`): `verify()` returns `true` without calling `Receiver.verify`.
- `DEV_SKIP_JOB_SIGNATURE=true`: `verify()` always returns `true`.
- `bootstrapSchedules` with an empty existing schedule list → calls `schedules.create` for each entry in the map.
- `bootstrapSchedules` with schedules already existing → skips duplicates, no extra creates.

**Verification:** Tests use a mock `Client` and `Receiver` (injected via constructor or vitest module mock). Signature verification tested with a real HMAC token where the test generates the signature using the same algorithm (`@upstash/qstash` exports the HMAC algorithm). Dev mode env vars tested by setting/unsetting `process.env` in `beforeEach`/`afterEach`.

---

### U4. Vercel Provider

**Goal:** Implement `VercelJobsAdapter`. Vercel Cron calls `/cms/jobs/*` endpoints as HTTP requests, signing them with `x-vercel-signature`. The adapter verifies this header. `enqueue()` is a no-op with a logged warning — Vercel Cron is schedule-only, not on-demand. The adapter also provides a helper to generate the `vercel.json` cron configuration.

**Requirements:**
- `verify(request)` must check the `x-vercel-signature` header. Per Vercel docs, the signature is an HMAC-SHA1 of the raw request body (even if empty) using `VERCEL_AUTOMATION_BYPASS_SECRET` (or the internal Vercel signing mechanism). If the header is absent or the HMAC does not match, return `false`.
- `enqueue()` must log a warning: `[hono-cms/jobs] Vercel Cron provider does not support on-demand job enqueuing. Use provider: 'qstash' for on-demand jobs.` and return without error.
- The adapter must expose a `generateVercelJson(scheduleMap)` helper that produces the `vercel.json` cron array. This is a development-time utility, not a runtime concern.

**Dependencies:** U1 (adapter interface)

**Files:**
- `packages/jobs/src/providers/vercel.ts` — `VercelJobsAdapter` class
- `packages/jobs/src/__tests__/providers/vercel.test.ts`

**Approach:**

Vercel Cron request verification uses Vercel's `x-vercel-signature` header. The signature is computed as HMAC-SHA256 of the raw request body using `VERCEL_AUTOMATION_BYPASS_SECRET` as the key. This is distinct from Vercel's OIDC token mechanism — cron requests use the shared secret approach.

The adapter uses the Web Crypto API (`crypto.subtle.importKey` + `crypto.subtle.sign`) for HMAC, ensuring edge compatibility without Node.js `crypto` module dependency. This is a platform-neutral approach consistent with `tsdown.config.ts` `platform: 'neutral'`.

Steps in `verify`:
1. Read the `x-vercel-signature` header.
2. Read the raw request body as text.
3. Compute HMAC-SHA256 of body using `VERCEL_AUTOMATION_BYPASS_SECRET`.
4. Compare computed signature to header value using a timing-safe comparison (important: use `crypto.subtle.verify` or a constant-time comparison to prevent timing attacks).

`generateVercelJson(scheduleMap: Record<string, string>)`:
- `scheduleMap` maps endpoint path to cron expression: `{ '/cms/jobs/scheduled-publish': '* * * * *' }`.
- Returns a `vercel.json`-compatible `crons` array: `[{ path, schedule }]`.
- This is a utility for the developer to copy-paste or write to `vercel.json` during setup. It is not called at runtime.

The `VERCEL_AUTOMATION_BYPASS_SECRET` env var must be documented in the adapter's JSDoc as required for signature verification. If absent, `verify()` returns `false` (fails closed).

**Test scenarios:**
- `verify(request)` with correct HMAC-SHA256 signature → returns `true`.
- `verify(request)` with tampered body (signature no longer matches) → returns `false`.
- `verify(request)` with missing `x-vercel-signature` header → returns `false`.
- `verify(request)` with `VERCEL_AUTOMATION_BYPASS_SECRET` not set → returns `false`.
- `enqueue(...)` → logs warning, returns `Promise<void>` without throwing.
- `generateVercelJson({ '/cms/jobs/scheduled-publish': '* * * * *', '/cms/jobs/audit-log-cleanup': '0 0 * * *' })` → returns `[{ path: '/cms/jobs/scheduled-publish', schedule: '* * * * *' }, { path: '/cms/jobs/audit-log-cleanup', schedule: '0 0 * * *' }]`.

**Verification:** HMAC computed with Web Crypto API in tests (same implementation as production). Timing-safe comparison tested by verifying that a one-byte difference in the body produces `false` but does not throw. Warning logged verified with `vi.spyOn(console, 'warn')`.

---

### U5. Cloudflare Provider

**Goal:** Implement `CloudflareJobsAdapter`. Cloudflare Cron Triggers invoke the Worker's `scheduled` export, not an HTTP endpoint. The adapter dispatches to job functions based on cron expression mapping. `verify()` always returns `true` (internal call, no external verification needed). `enqueue()` delegates to either a Cloudflare Queues binding or a QStash fallback for on-demand job dispatch.

**Requirements:**
- `scheduledHandler(cron: string): Promise<void>` must dispatch to the registered job function for the given cron expression. Unknown cron expressions must log a warning and return without error.
- `verify()` must always return `true` — Cloudflare's `scheduled` export calls `cms.scheduledHandler` directly, bypassing HTTP entirely.
- The CMS must expose `cms.scheduledHandler(cron, env, ctx)` as a public method alongside `cms.fetch`. This is the bridge between the Worker's `scheduled` export and the internal dispatcher.
- `enqueue()` for on-demand job dispatch: if a `Queue` binding is provided in the Cloudflare adapter config, use `env.CMS_QUEUE.send({ endpoint, body, delay })` with a Consumer Worker. If no Queue binding, fall back to a QStash adapter instance (the developer must provide a QStash token alongside the Cloudflare provider config, or accept that on-demand enqueue is unavailable).

**Dependencies:** U1 (adapter interface), U3 (QStash adapter, for the fallback path)

**Files:**
- `packages/jobs/src/providers/cloudflare.ts` — `CloudflareJobsAdapter` class
- `packages/jobs/src/__tests__/providers/cloudflare.test.ts`

**Approach:**

The Cloudflare adapter holds a `cronMap: Record<string, () => Promise<void>>` built at construction time. When `createCMS` is called with `provider: 'cloudflare'`, the adapter's `cronMap` is populated after the job handler dependencies are resolved:

```
// CronsConfig for cloudflare includes optional cronMap
{ provider: 'cloudflare', cronMap: {
    '* * * * *':  () => scheduledPublishJob(db, events),
    '*/5 * * * *': () => webhookRetryJob(db),
    '0 0 * * *':  () => auditLogCleanupJob(db, retentionDays),
}}
```

`cms.scheduledHandler(cron, env, ctx)` is exposed as a method on the CMS instance returned by `createCMS`. It calls `adapter.scheduledHandler(cron)`. This is the only surface the user needs to wire into their Worker:

```ts
export default {
  fetch: cms.fetch,
  scheduled(event, env, ctx) {
    return cms.scheduledHandler(event.cron, env, ctx)
  }
}
```

`enqueue()` priority order:
1. If `env.CMS_QUEUE` (Cloudflare Queue binding) is available: `env.CMS_QUEUE.send({ endpoint, body, delaySeconds: delay })`. A separate Queue Consumer Worker must process these messages and call the endpoint.
2. If `qstashFallback` is set in the adapter config: delegate to `QStashJobsAdapter.enqueue()`.
3. Otherwise: log a warning `[hono-cms/jobs] Cloudflare provider: enqueue() called but no Queue binding or QStash fallback configured. Job not enqueued.` and return.

The Queue Consumer Worker is documented (not implemented here) — it is user-provided code that calls the job endpoint. The adapter's `enqueue` puts a message on the queue; the consumer calls the HTTP endpoint.

**Test scenarios:**
- `scheduledHandler('* * * * *')` with a matching entry in `cronMap` → job function called once.
- `scheduledHandler('0 0 * * *')` with a matching entry → correct job function called.
- `scheduledHandler('1 2 3 4 5')` with no matching entry → warning logged, no error thrown.
- `verify(request)` always returns `true`.
- `enqueue()` with `qstashFallback` set → delegates to QStash adapter's enqueue.
- `enqueue()` with no Queue binding and no fallback → logs warning, returns `Promise<void>` without throwing.
- `cms.scheduledHandler` exposed on the CMS instance (integration test: `createCMS({ ... provider: 'cloudflare' ... }).scheduledHandler` is a function).

**Verification:** `cronMap` dispatch tested by injecting mock job functions and asserting they are called. QStash fallback tested by injecting a mock QStash adapter. `cms.scheduledHandler` accessibility tested via the `createCMS` integration entry point.

---

### U6. Webhook Retry Job

**Goal:** Implement `webhookRetryJob(deliveryId, db)` — looks up a failed webhook delivery by ID, re-attempts the HTTP POST to the registered webhook target, updates delivery status, and enforces exponential backoff with a maximum of 3 retry attempts. Idempotent: safe to call twice for the same delivery.

**Requirements:**
- Must look up the delivery by `deliveryId` in the `webhook_deliveries` table.
- If `status` is already `delivered` or `exhausted`, return early without retrying (idempotency guard).
- Must re-attempt the HTTP POST using the same payload (`body`) and headers (`headers`) stored on the delivery record.
- On success (2xx response from target): update `status = 'delivered'`, `deliveredAt = NOW()`.
- On failure (non-2xx or network error): increment `attemptCount`. If `attemptCount >= 3`: update `status = 'exhausted'`. Else: enqueue next retry via `adapter.enqueue` with the appropriate delay and update `status = 'pending'`.
- Backoff schedule: attempt 1 → 30 seconds delay, attempt 2 → 300 seconds (5 min), attempt 3 → 3600 seconds (1 hour).
- Network timeout for the re-attempt: 10 seconds. A timeout is treated as a failure.

**Dependencies:** U1 (adapter interface for re-enqueue), U2 (registry mounts this job)

**Files:**
- `packages/jobs/src/jobs/webhook-retry.ts` — `webhookRetryJob(deliveryId, db, adapter)`
- `packages/jobs/src/__tests__/jobs/webhook-retry.test.ts`

**Approach:**

`webhookRetryJob` accepts `deliveryId: string`, `db: DatabaseAdapter`, and `adapter: JobsAdapter` (for re-enqueuing the next attempt).

Steps:
1. `db.query('SELECT * FROM webhook_deliveries WHERE id = ?', [deliveryId])` — if not found, return `{ skipped: true, reason: 'not found' }`.
2. Check `delivery.status` — if `delivered` or `exhausted`, return `{ skipped: true, reason: delivery.status }`.
3. Attempt HTTP POST: `fetch(delivery.targetUrl, { method: 'POST', headers: JSON.parse(delivery.headers), body: delivery.body, signal: AbortSignal.timeout(10_000) })`.
4. On success (response.ok): `db.query('UPDATE webhook_deliveries SET status=?, deliveredAt=? WHERE id=?', ['delivered', new Date(), deliveryId])`. Return `{ success: true }`.
5. On failure: `const nextAttempt = delivery.attemptCount + 1`. If `nextAttempt > 3`: `db.query('UPDATE ... SET status=?', ['exhausted', deliveryId])`. Return `{ exhausted: true }`. Else: `db.query('UPDATE ... SET attemptCount=?, status=? WHERE id=?', [nextAttempt, 'pending', deliveryId])`. Enqueue: `adapter.enqueue('/cms/jobs/webhook-retry', { deliveryId }, { delay: backoffDelay[nextAttempt] })`. Return `{ retrying: true, nextAttempt, delay }`.

Backoff map: `{ 1: 30, 2: 300, 3: 3600 }`.

The row-level idempotency is enforced by step 2 (status check). Concurrent calls are handled by DB-level semantics: if two concurrent calls both read `status = 'pending'` and both attempt the HTTP POST, both will try to update status after the call. The second `UPDATE` is a no-op if the first already changed status to `delivered`. This is safe given that webhook delivery is idempotent from the receiver's perspective (most webhook targets are designed for at-least-once delivery).

For the Cloudflare scheduled handler path (poll mode, not QStash per-delivery mode): the job is called without a `deliveryId`. In poll mode, the function queries for all `pending` deliveries due for retry (`nextAttemptAt <= NOW()`) and processes them in a batch of up to 50. This dual-mode behavior is selected by whether `deliveryId` is provided.

**Test scenarios:**
- Delivery `status = 'delivered'` → returns `{ skipped: true, reason: 'delivered' }`, no HTTP call made.
- Delivery `status = 'exhausted'` → returns `{ skipped: true, reason: 'exhausted' }`, no HTTP call made.
- Delivery not found by ID → returns `{ skipped: true, reason: 'not found' }`.
- Successful HTTP POST (mock fetch returns 200) → status updated to `'delivered'`, `deliveredAt` set, returns `{ success: true }`.
- Failed HTTP POST, `attemptCount = 0` → `attemptCount` incremented to 1, `adapter.enqueue` called with `delay: 30`, status remains `'pending'`.
- Failed HTTP POST, `attemptCount = 1` → `adapter.enqueue` called with `delay: 300`.
- Failed HTTP POST, `attemptCount = 2` → `adapter.enqueue` called with `delay: 3600`.
- Failed HTTP POST, `attemptCount = 3` (at max) → status updated to `'exhausted'`, `adapter.enqueue` not called.
- HTTP POST timeout (AbortSignal fires at 10s) → treated as failure, same retry logic.
- Poll mode (no `deliveryId`): queries `pending` deliveries, processes up to 50, returns `{ processed: N }`.

**Verification:** All DB interactions use a mock `DatabaseAdapter`. `fetch` is mocked via `vi.stubGlobal('fetch', ...)`. Backoff delays verified against the map. Status transitions verified by checking mock DB call arguments. The `adapter.enqueue` mock verifies correct delay values.

---

### U7. Scheduled Publish Job

**Goal:** Implement `scheduledPublishJob(db, events)` — queries all documents where `publishAt <= NOW()` AND `status = 'draft'`, publishes each one (updates status, fires the collection's publish event), and returns a count. Idempotent: running twice within the same minute is safe and produces the same outcome.

**Requirements:**
- Must query: `SELECT * FROM documents WHERE publishAt <= NOW() AND status = 'draft'`.
- For each document: `UPDATE documents SET status='published', publishedAt=NOW() WHERE id=?` and emit `events.emit(`${collection}.publish`, { document })`.
- Must process documents in batches of up to 100 per invocation to avoid long DB transactions on busy systems.
- Must return `{ published: N, skipped: 0 }` where N is the number of documents actually published in this invocation.
- Idempotency: once `status = 'published'`, the document no longer matches the query. A second invocation within the same minute returns `{ published: 0 }`.
- Must not throw if `events.emit` fails — log the error and continue processing remaining documents.

**Dependencies:** U2 (registry mounts this job)

**Files:**
- `packages/jobs/src/jobs/scheduled-publish.ts` — `scheduledPublishJob(db, events)`
- `packages/jobs/src/__tests__/jobs/scheduled-publish.test.ts`

**Approach:**

`scheduledPublishJob` is a pure async function with no adapter dependency — it is invoked by the route handler and does not enqueue anything.

Query strategy: `SELECT id, collection, data FROM documents WHERE publishAt <= ? AND status = 'draft' LIMIT 100` with `new Date()` as the parameter. The `LIMIT 100` prevents runaway processing on systems where thousands of documents are scheduled in the same window (bulk imports, date adjustments).

For each document, the update and event emit are independent operations. DB update failure is fatal for that document (log + continue). Event emit failure is non-fatal (log + continue). This ensures a partial DB failure does not silently skip the event for documents that were successfully persisted.

The collection name is stored on the document record (`documents.collection`). Event names follow the `{collection}.publish` pattern (e.g., `articles.publish`).

If `LIMIT 100` is hit, the next invocation (next minute) will pick up remaining documents — the `publishAt <= NOW()` filter ensures they are captured. There is no backpressure problem: the worst case is a 1-minute delay for the 101st document.

**Test scenarios:**
- Zero documents due for publish → returns `{ published: 0 }`.
- One document with `publishAt` 1 minute ago and `status = 'draft'` → status updated to `'published'`, `articles.publish` event emitted, returns `{ published: 1 }`.
- Three documents across two collections → all three updated, three events emitted (correct collection names), returns `{ published: 3 }`.
- Document with `status = 'published'` already → NOT included in query results (idempotency validated by query filter, not by code logic).
- 100 documents ready → processes all 100, returns `{ published: 100 }` (does not process beyond 100 in one invocation).
- `events.emit` throws for one document → error logged, other documents still processed, non-throwing return.
- DB update fails for one document → error logged, other documents still attempted, non-throwing return.
- Called twice in rapid succession (concurrent) → second call returns `{ published: 0 }` because first call already updated status (idempotency via DB state).

**Verification:** Mock `DatabaseAdapter` returns a controlled list of documents. `events.emit` spied with `vi.spyOn`. Concurrent call idempotency tested by running two `Promise.all` calls against a mock DB that simulates real state transitions.

---

### U8. Audit Log Cleanup Job

**Goal:** Implement `auditLogCleanupJob(db, retentionDays)` — deletes `audit_log` rows older than `retentionDays` days. Runs daily. Uses batched deletion (1000 rows per batch) to avoid holding a long-running DB transaction that blocks reads on busy instances.

**Requirements:**
- Must compute the cutoff timestamp: `NOW() - retentionDays days`.
- Must delete in batches of 1000 rows: `DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at < ? LIMIT 1000)`.
- Must continue batching until no rows remain older than the cutoff (batch loop terminates when the DELETE affects 0 rows).
- Must return `{ deleted: totalDeletedCount }`.
- Default `retentionDays` is 90 days when not explicitly configured in `createCMS`.
- Must not fail if `audit_log` table is empty or no rows match the cutoff.

**Dependencies:** U2 (registry mounts this job)

**Files:**
- `packages/jobs/src/jobs/audit-log-cleanup.ts` — `auditLogCleanupJob(db, retentionDays)`
- `packages/jobs/src/__tests__/jobs/audit-log-cleanup.test.ts`

**Approach:**

`auditLogCleanupJob` is a pure async function. It accepts `db: DatabaseAdapter` and `retentionDays: number = 90`.

Cutoff computation: `const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)`.

Batch loop:

```
let totalDeleted = 0
let batchDeleted = 0
do {
  batchDeleted = await db.deleteOlderThan('audit_log', cutoff, 1000)
  totalDeleted += batchDeleted
} while (batchDeleted === 1000)
return { deleted: totalDeleted }
```

The loop termination condition (`batchDeleted < 1000`) is correct: if exactly 1000 rows were deleted, there may be more. If fewer than 1000 were deleted, no rows remain (or the table is empty).

The `DatabaseAdapter` must expose a `deleteOlderThan(table, cutoff, limit)` method that executes the batched delete and returns the count of deleted rows. This is a new method added to the `DatabaseAdapter` interface as part of this plan — the adapter interface is owned by `@hono-cms/core`.

Between batches, the implementation should yield to the event loop with a brief await (`await new Promise(resolve => setTimeout(resolve, 0))`) to prevent blocking the Worker on large deletions. This matters on Cloudflare Workers where CPU time limits apply.

**Test scenarios:**
- Empty `audit_log` table → `deleteOlderThan` returns 0, loop exits immediately, returns `{ deleted: 0 }`.
- 500 rows older than cutoff → loop runs once (returns 500 < 1000), returns `{ deleted: 500 }`.
- 2500 rows older than cutoff → loop runs 3 times (1000, 1000, 500), returns `{ deleted: 2500 }`.
- Exactly 1000 rows → loop runs twice (first returns 1000, second returns 0), returns `{ deleted: 1000 }`.
- `retentionDays = 0` → cutoff is now, deletes everything. (Edge case: valid use case for clearing all audit logs.)
- Default `retentionDays = 90` applied when not specified.
- DB error in first batch → throws (do not swallow DB errors — let the registry's error handler return 500).

**Verification:** Mock `DatabaseAdapter` returns controlled batch counts. Loop iteration count verified by mock call count. `totalDeleted` arithmetic verified for all boundary cases (0, 500, 1000, 2500).

---

## Scope Boundaries

### In Scope

- `packages/jobs/` package with all four files in `src/providers/` and four files in `src/jobs/`.
- `JobsAdapter` interface and `CronsConfig` discriminated union types.
- `createJobHandlers` Hono sub-router with signature verification middleware.
- All three provider adapters: QStash, Vercel, Cloudflare.
- `NoneJobsAdapter` (trivial — `verify()` always returns `false`, `enqueue()` is a no-op with a warning).
- Four job functions: webhook retry, scheduled publish, audit log cleanup, cache sweep stub.
- `cms.scheduledHandler` method on the CMS instance (wired in `@hono-cms/core` as part of this plan's integration step).
- `generateVercelJson` utility on the Vercel adapter.
- `bootstrapSchedules` on the QStash adapter.
- Dev mode bypass for QStash signature verification.
- Idempotency for all job handlers.

### Deferred to Follow-Up Work

- **Cache sweep job implementation** (Plan 015): `cacheSweepJob` is registered as a stub in this plan. Full implementation requires the cache adapter interface from Plan 015.
- **Translation job implementation**: `POST /cms/jobs/translation` returns 501 in this plan. AI translation pipeline is a separate feature scope.
- **Cloudflare Queue Consumer Worker**: the Queue binding integration in `CloudflareJobsAdapter.enqueue()` puts messages on the queue; a Consumer Worker (user-provided) must be documented but is not implemented here.
- **Admin UI for job status**: viewing job execution history, retry counts, and exhausted deliveries in the admin panel. Requires Plan 013 (webhooks) admin work.
- **QStash schedule management UI**: listing and deleting QStash schedules from the admin panel.
- **Dead letter queue**: after `exhausted` status, routing deliveries to a DLQ for manual inspection.

### Outside This Plan's Identity

- Building a full task queue system with priority queues, backpressure, and worker pools — that is a separate infrastructure project, not a CMS feature.
- Runtime-specific Worker deployment configuration beyond the `cms.scheduledHandler` shim — Wrangler config, `wrangler.toml` cron trigger registration, and Cloudflare dashboard setup are user responsibilities.

---

## Risk Analysis

### R1: Body consumption in QStash signature verification

**Risk:** Calling `request.text()` in the verify middleware consumes the body stream. The Hono route handler then cannot parse the JSON body via `c.req.json()` — it will throw `body already consumed` or return empty.

**Mitigation:** The registry (U2) must clone the request body before passing to `verify`, or the adapter must accept `body: string` as a parameter (pre-read body). The recommended approach: the registry middleware reads the raw body once, stores it in Hono context via `c.set('rawBody', text)`, and passes it to `adapter.verify(c.req.raw, text)`. The `verify` signature is extended to accept an optional pre-read body string. Route handlers then use `JSON.parse(c.get('rawBody'))` instead of `c.req.json()`. This is a breaking constraint documented in U2 and U3.

**Severity:** High — silent data loss if not handled. Tests in U2 and U3 must explicitly cover body re-read.

### R2: QStash schedule duplication on cold starts

**Risk:** `bootstrapSchedules` is called on every CMS initialization. On serverless runtimes, cold starts are frequent. Each cold start could create duplicate QStash schedules, resulting in the same job running multiple times per cron interval.

**Mitigation:** `bootstrapSchedules` lists existing schedules before creating new ones and skips any destination+cron combination already registered. QStash's `schedules.list()` API must be called first. Tested in U3 by injecting a mock list that includes existing schedules.

**Severity:** Medium — duplicate job execution is safe for idempotent jobs but wastes execution quota and may cause double-notification side effects for webhook retry.

### R3: Cloudflare CPU time limit on audit log cleanup

**Risk:** Audit log cleanup iterates over potentially thousands of DB rows in a loop. Cloudflare Workers have a 50ms CPU time limit (on the free tier) and up to 30 seconds on the paid tier. A large deletion batch could exceed these limits.

**Mitigation:** Batch size of 1000 rows with a `setTimeout(0)` yield between batches (U8 approach). This allows the Worker runtime to reset its CPU time budget between iterations. If the total deletion exceeds what one `scheduled` invocation can process within the time limit, the job runs partially — the next daily invocation continues from where it left off (the cutoff filter ensures this). Documented as a known constraint.

**Severity:** Medium on large instances with free-tier Workers. Low on paid tier.

### R4: `baseUrl` pointing to localhost in production

**Risk:** A developer forgets to set `CMS_PUBLIC_URL` in the production environment and the default falls back to `localhost`. QStash tries to call `http://localhost/cms/jobs/*`, which fails silently — jobs are enqueued but never processed.

**Mitigation:** Startup validation in U1 throws synchronously if `provider === 'qstash'` and `baseUrl` is falsy or is a localhost URL. The validation for localhost: `if (baseUrl.startsWith('http://localhost') || baseUrl.startsWith('http://127.')) throw ...`. This makes the misconfiguration fail fast at startup rather than at the first failed webhook retry.

**Severity:** High — silent production failure. Startup validation in U1 is the primary defense.

### R5: Vercel Cron calling endpoints with GET instead of POST

**Risk:** Vercel Cron by default sends GET requests to configured paths. The registry registers `POST` routes. A `GET` call returns 404 or 405 (Method Not Allowed) rather than executing the job.

**Mitigation:** Register each job route for both `GET` and `POST` in the Hono sub-router. Alternatively, the Vercel documentation confirms cron requests are GET — the registry should handle `GET /cms/jobs/*` for the Vercel path. The signature verification applies equally to both methods. This is a documentation and implementation constraint, not a design flaw. Tested in U4 by simulating a GET request to the job endpoint.

**Severity:** Medium — would silently skip all job execution on Vercel without this fix.

---

## Dependencies and Prerequisites

- **Plan 001** (Monorepo Foundation): `packages/jobs/` package skeleton, `tsdown.config.ts`, Vitest config, Turborepo task wiring.
- **`@hono-cms/core`** must expose `createCMS`'s return type with `scheduledHandler` method (wired in Plan 002 or the core plan).
- **`DatabaseAdapter` interface** must define `deleteOlderThan(table, cutoff, limit)` — this method is added as part of this plan's integration with the core database adapter interface.
- **`webhook_deliveries` table schema** must exist (Plan 013 defines it). The `webhookRetryJob` assumes columns: `id`, `status`, `targetUrl`, `body`, `headers`, `attemptCount`, `deliveredAt`.
- **`audit_log` table schema** must exist (Plan 019/audit feature defines it). `auditLogCleanupJob` assumes columns: `id`, `created_at`.
- **`documents` table schema** must include `publishAt: timestamp | null`, `status: 'draft' | 'published'`, `collection: string` (Plan 010 draft/publish feature).

External package dependency: `@upstash/qstash` — added to `packages/jobs/package.json`. No other external dependencies beyond Hono (already in workspace). The Web Crypto API is assumed available (all target runtimes: Cloudflare Workers, Vercel Edge, Node 18+, Bun).

---

## Deferred Implementation Notes

- The exact column names in `webhook_deliveries` and `audit_log` are determined by the schema definitions in Plans 013 and the audit log plan. The job implementations must use the `DatabaseAdapter` query API rather than raw SQL column names where possible, for portability across SQL dialects.
- The `DocumentAdapter` query for scheduled publish (`SELECT ... WHERE publishAt <= NOW()`) may need dialect-specific `NOW()` vs `CURRENT_TIMESTAMP` handling. The `DatabaseAdapter` interface should expose a `now()` helper or the query should use a JavaScript `Date` parameter (preferred — avoids dialect differences).
- QStash `currentSigningKey` vs `nextSigningKey` rotation: Upstash rotates keys on a schedule. The `Receiver` accepts both keys and tries each. The adapter must pass both — implementation detail deferred to U3 based on the current `@upstash/qstash` v2 API at implementation time.
- Cloudflare Queue Consumer Worker implementation (receive message → call HTTP endpoint) is user-supplied. A code example should be added to the CMS documentation, not to the package itself.

---

## Alternatives Considered

### Alternative A: Native Worker scheduled API for all job logic (no HTTP endpoints)

Place job logic directly inside the Worker's `scheduled` export and use `event.scheduledTime` for dispatch. Vercel and QStash providers would call a separate in-process dispatch function, not an HTTP endpoint.

**Why rejected:** This couples job logic to the Cloudflare runtime. The scheduled dispatch function would need to be a different code path from the QStash/Vercel HTTP handler path, doubling the test surface. The HTTP endpoint pattern is already validated by the ideation doc (idea #17 explicitly specifies "job handler routes that the cron provider calls on schedule"). Keeping job logic at HTTP boundaries makes each job independently testable with standard tooling.

### Alternative B: Inngest as the universal job provider

Inngest is HTTP-based (like QStash) and supports multi-step workflows, retries, and event-driven triggers. It is edge-compatible and has a Cloudflare Workers integration.

**Why not chosen as default:** Inngest requires hosting (Inngest Cloud or self-hosted). QStash is chosen because the project already evaluates Upstash Redis for caching — one vendor relationship, two services. Inngest would add a second vendor dependency with no offsetting benefit for the four job types in scope. Inngest's multi-step workflow features (branching, waits, fan-out) are not needed for webhook retry, scheduled publish, cache sweep, or audit cleanup. QStash's simpler API is sufficient. Inngest remains a valid community adapter if the ecosystem demands it.

### Alternative C: Polling-only approach (no QStash, Vercel Cron, or Cloudflare Triggers)

A single recurring function checks all pending work every minute: pending webhook retries, documents due for publish, cache entries due for sweep. No external cron provider needed. Implemented as a `setInterval` or a recursive `setTimeout` within the Worker lifecycle.

**Why rejected:** `setInterval` does not survive serverless cold starts — the interval is reset on every new Worker instance. On Cloudflare Workers and Vercel Edge Functions, there is no persistent process to hold the interval. Polling would only work on Node.js with a persistent process, which contradicts the "universally deployable" design goal. The cron provider pattern (external trigger → HTTP endpoint) is the correct model for ephemeral runtimes.

---

## Documentation Plan

Documentation produced alongside this implementation:

1. **`packages/jobs/README.md`** — Provider setup guide: QStash token and signing key configuration, Vercel `vercel.json` generation (`generateVercelJson` usage), Cloudflare `wrangler.toml` cron trigger registration, local development with `provider: 'none'` or QStash local server.
2. **JSDoc on `createJobsAdapter`** — All config fields documented with types, examples, and the `baseUrl` validation requirement.
3. **JSDoc on each job function** — Input types, return type, idempotency guarantee, and failure behavior documented inline.
4. **Inline comments in `providers/cloudflare.ts`** — Queue Consumer Worker example code in comments, explaining the user-supplied Consumer pattern.
