---
title: "feat: Health Check Endpoint — /cms/health with Subsystem Status"
date: 2026-05-16
type: feat
status: active
depth: standard
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
ideation-ideas: ["#20 Health Check Endpoint"]
---

# feat: Health Check Endpoint — /cms/health with Subsystem Status

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 2
**Research inputs used:** skill review, framework docs, security review

### Key Improvements

1. Clarify public-vs-detailed health output boundaries.
2. Add startup/readiness nuance alongside liveness.
3. Tighten privacy guarantees for subsystem diagnostics.

## Summary

This plan adds three health-check routes (`GET /cms/health`, `/cms/health/live`, `/cms/health/ready`) that are mounted automatically by `createCMS` — no configuration required. All routes are unauthenticated, safe for load balancers and uptime monitors, and parallel-run per-subsystem connectivity probes with a 2-second per-check timeout. The plan also adds a `healthCheck()` method to each adapter interface (`DatabaseAdapter`, `StorageAdapter`, `CacheAdapter`, `EmailAdapter`, `CronAdapter`) so every subsystem owns its own probe logic.

This is Plan 018 of 18.

---

## Problem Frame

After deployment, the first question any operator asks is "is this running?" Without a health endpoint, a misconfigured DB connection produces silent HTTP 500s with no signal about which subsystem is responsible. Load balancers have no way to identify unhealthy instances before routing live traffic to them. Kubernetes cannot distinguish a pod still initializing from one that is permanently broken.

`@hono-cms` is universally deployable — Cloudflare Workers, Fly.io, Railway, Render, Vercel, bare Node.js. Every one of these platforms supports or requires a health endpoint. The endpoint must be always-on and unauthenticated; a health check that requires a session cannot be called by an infrastructure component.

---

## Requirements

- R1. `GET /cms/health` returns `200 OK` with `{ status: "ok", ... }` when all subsystems are reachable, and `503 Service Unavailable` with `{ status: "degraded", ... }` when any subsystem is in error state.
- R2. All subsystem checks run in parallel (not sequentially) to minimize total response time.
- R3. Each subsystem check has a 2-second timeout; a check that times out returns `{ status: "error", error: "check timed out" }` — it does not throw or hang the endpoint.
- R4. Error messages never contain connection strings, credentials, or other sensitive values.
- R5. The endpoint is always enabled — no config key can disable it.
- R6. The endpoint requires no authentication — no session, no API key.
- R7. `GET /cms/health/live` returns immediately (no I/O) with `200` as long as the process is running.
- R8. `GET /cms/health/ready` performs the same full check as `/cms/health` and returns `503` if any subsystem is in error.
- R9. The response includes `version` (the CMS package version) and `uptime_seconds` (seconds since `createCMS()` was called).
- R10. Each adapter interface exposes a `healthCheck(): Promise<SubsystemHealth>` method as part of its contract.

---

## Scope Boundaries

- Metrics collection, Prometheus exposition format (`/metrics`) — outside scope; health checks return a human/machine-readable JSON snapshot, not time-series data.
- Alerting, PagerDuty/OpsGenie integration — outside scope; monitoring platforms consume the health endpoint externally.
- Per-subsystem health history or degradation trending — out of scope; each call is a fresh point-in-time check.
- Authentication/authorization for the health endpoint — explicitly excluded; the endpoint must be callable by infrastructure components without sessions.
- Deep capability tests (e.g., write a record, read it back, delete it) — out of scope; connectivity probes only.
- A health dashboard UI in the admin SPA — deferred; the endpoint itself is the deliverable.

### Deferred to Follow-Up Work

- Caching last-known health state for high-frequency pollers: the `/cms/health/live` route is the near-term mitigation. A TTL-cached state store (e.g., last full-check result cached for 10 s) could be added as a follow-up without changing the interface.
- Health check for future adapters (e.g., `@hono-cms/adapter-git`, `@hono-cms/adapter-convex` if Convex is added later): each new adapter adds a `healthCheck()` implementation per the interface defined in U3.

---

## Context & Research

### Relevant Code and Patterns

- `packages/schema/src/adapter.ts` — `DatabaseAdapter` interface (Plan 003). Health check method follows the same interface-extension pattern used for `ping()` / `checkDrift()`.
- `packages/schema/src/storage.ts` — `StorageAdapter` interface (Plan 008). The `healthCheck()` method is added alongside `upload`, `delete`, `getSignedUrl`.
- `packages/core/src/createCMS.ts` — the `createCMS` function (Plan 002). The `startTime` capture (`Date.now()` at call site) feeds `uptime_seconds`. Health routes are mounted here alongside auth and content routes.
- The per-subsystem `{ status: 'ok' | 'error', latency_ms?, error? }` shape matches the de-facto format used by `@fastify/under-pressure`, NestJS `@nestjs/terminus`, and Rails `health_check` — referenced in ideation idea #20 as the external validation basis.
- Hono route composition: Plan 002 shows that routes are composed as sub-apps and mounted with `app.route('/cms/health', healthApp)`. The health router follows this same pattern.

### Institutional Learnings

- None recorded specifically for health checks in `docs/solutions/`. Patterns are derived from prior adapter interface plans (003, 008).

### External References

- Ideation idea #20 ("Health Check Endpoint") is the canonical source for the response shape, 503 behavior, and the polling-load concern that motivates the `/live` and `/ready` split.
- K8s liveness vs. readiness probe semantics: liveness = "is the process alive?" (lightweight, in-process); readiness = "is the instance ready to receive traffic?" (full connectivity check). This maps directly to `/live` and `/ready` respectively.

---

## Key Technical Decisions

## Research Insights

**Best Practices:**
- Keep `/live` zero-I/O, `/ready` dependency-aware, and document how startup behavior maps onto readiness semantics.
- Reuse adapter-owned health checks so each subsystem owns its own probe behavior instead of centralizing provider-specific logic.
- Prefer degraded/error states with bounded metadata over binary up/down responses when multiple subsystems are involved.

**Security Considerations:**
- Keep the public health surface minimal and avoid exposing version, subsystem inventory, or raw diagnostic detail unless explicitly intended.
- If detailed readiness output remains public, return only coarse status externally and move richer diagnostics behind authenticated admin access.

**Edge Cases:**
- Optional subsystems need explicit semantics so absence is not misreported as failure.
- Timeout handling must always produce deterministic JSON output even when one subsystem hangs.

### 1. Why health checks are always enabled with no way to disable

Health checks are infrastructure primitives, not application features. A developer should never be in a position where their deployment platform rejects the instance because the endpoint was turned off. Disabling health checks silently breaks platform integration (Fly.io, Railway, K8s) and provides no upside — the endpoint is unauthenticated and read-only. Making it non-optional eliminates an entire class of deployment misconfiguration. This is the same reasoning that makes `createCMS` mount the admin SPA automatically: the feature exists for every deployment.

### 2. Why parallel execution (not sequential)

Sequential execution means total response time ≥ sum of all check latencies. With five subsystems each potentially taking up to 2 seconds to time out, sequential checks could block for up to 10 seconds — far beyond what any load balancer liveness check will wait. Parallel execution via `Promise.all` bounds total response time to `max(check latencies)`, not `sum(check latencies)`. With the 2-second per-check timeout, the endpoint always responds within ~2.1 seconds regardless of how many subsystems are degraded.

### 3. Why a 2-second per-check timeout (not 5s or 10s)

The timeout serves two purposes: (a) prevent a single slow/hung subsystem from blocking the entire health response, and (b) ensure the health endpoint itself fits within most platform liveness-probe timeouts (Kubernetes default: 1s, configurable; Fly.io: 2s; Railway: 5s). At 2 seconds per check with parallel execution, the endpoint reliably responds within the platform window. A timed-out check reports `{ status: "error", error: "check timed out" }` — this is actionable (it tells operators which subsystem is slow) without revealing connection details.

### 4. Why two endpoint variants (full vs. `/live` / `/ready`)

A load balancer polling `/cms/health` every 5 seconds generates 12 DB round-trips per minute per instance — harmless at low instance counts, but non-trivial at scale or when DB connection limits are tight. The `/live` route answers "is the process up?" with zero I/O; it is appropriate for high-frequency K8s liveness probes. The `/ready` route performs the full check and is appropriate for K8s readiness probes (called before traffic is routed) and deployment gates. The full `/cms/health` endpoint is best suited for one-off checks, uptime monitors, and operator tooling where accuracy matters more than frequency.

---

## High-Level Technical Design

> This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

### Response Shape

```
// All ok — HTTP 200
{
  status: "ok",
  version: "1.0.0",          // from CMS package.json
  uptime_seconds: 3600,      // Date.now() - startTime captured in createCMS()
  db:      { status: "ok", latency_ms: 3 },
  storage: { status: "ok", latency_ms: 12 },
  cache:   { status: "ok", latency_ms: 8 },
  email:   { status: "ok" },
  crons:   { status: "ok" }
}

// Any error — HTTP 503
{
  status: "degraded",
  version: "1.0.0",
  uptime_seconds: 42,
  db:      { status: "error", error: "connection timeout" },
  storage: { status: "ok",   latency_ms: 12 },
  cache:   { status: "ok",   latency_ms: 8 },
  email:   { status: "ok" },
  crons:   { status: "ok" }
}
```

### Endpoint Summary

| Route | I/O | Use case |
|---|---|---|
| `GET /cms/health` | Full parallel check | Uptime monitors, one-off operator checks |
| `GET /cms/health/live` | In-process only, no I/O | K8s liveness probe (high frequency) |
| `GET /cms/health/ready` | Full parallel check | K8s readiness probe, deployment gates |

### Data Flow

```
Request → HealthRouter
  ├── /cms/health   → runAllChecks() → Promise.all(5 adapters) → aggregate → 200/503
  ├── /cms/health/live → in-process check (always 200 if process is running)
  └── /cms/health/ready → runAllChecks() → Promise.all(5 adapters) → aggregate → 200/503

runAllChecks():
  Each adapter.healthCheck() wrapped in:
    withTimeout(2000, adapter.healthCheck())  // Promise.race with rejection
    catch(err) → { status: "error", error: sanitize(err.message) }
```

---

## Output Structure

```
packages/core/src/health/
├── types.ts            ← SubsystemHealth, HealthReport, HealthChecker interface
├── runner.ts           ← runAllChecks(), withTimeout(), sanitizeError()
├── router.ts           ← Hono sub-app with /health, /health/live, /health/ready
└── index.ts            ← re-exports for internal use by createCMS

packages/schema/src/
└── health.ts           ← SubsystemHealth type (shared; used by adapter interfaces)
```

---

## U1: HealthChecker Interface and Core Utilities

**Goal:** Define the `HealthChecker` interface, `SubsystemHealth` type, and the `withTimeout` / `sanitizeError` utilities that wrap every subsystem check. These are the building blocks consumed by the route handler and adapter implementations.

**Requirements:** R1, R2, R3, R4, R10

**Dependencies:** None — foundational unit.

**Files:**
- `packages/schema/src/health.ts` — `SubsystemHealth` type (shared across all adapter packages)
- `packages/schema/src/index.ts` — re-export `SubsystemHealth`
- `packages/core/src/health/types.ts` — `HealthChecker` interface, `HealthReport` aggregate type
- `packages/core/src/health/runner.ts` — `withTimeout()`, `sanitizeError()`, `runAllChecks()`
- `packages/core/src/health/types.test.ts` — type-level tests (TypeScript compile-time assertions)
- `packages/core/src/health/runner.test.ts` — unit tests for runner utilities

**Approach:**

`SubsystemHealth` lives in `packages/schema/src/health.ts` because adapter packages import it when implementing `healthCheck()`. It must be in the zero-dependency shared schema package (same rationale as `DatabaseAdapter` interface in Plan 003) to avoid circular imports.

```
// Directional — not implementation specification
SubsystemHealth = {
  status: 'ok' | 'error' | 'unknown'
  latency_ms?: number        // omitted for email and crons (not round-trip latency)
  error?: string             // omitted when status is 'ok'
}
```

`HealthChecker` is a simple interface with one method: `check(): Promise<SubsystemHealth>`. Each adapter implements this via its `healthCheck()` method. The router creates a `HealthChecker` wrapper per adapter that delegates to `adapter.healthCheck()`.

`withTimeout(ms, promise)` uses `Promise.race` with a rejection that fires after `ms` milliseconds. If the race resolves to an error result or rejects, the runner catches it and returns `{ status: 'error', error: sanitizeError(err) }`. The timeout rejection itself produces the message `"check timed out"`.

`sanitizeError(err)` converts an error to a plain string message. It strips patterns that look like connection strings (anything matching `://.*@`, long hex strings, file paths containing home directories). It caps the message at 200 characters. The goal is a message that tells an operator what went wrong without revealing how the system is configured.

`runAllChecks(checkers)` accepts a map of subsystem name to `HealthChecker`, runs all checks with `Promise.all` (not `Promise.allSettled` — `withTimeout` never rejects, only resolves), and returns a `HealthReport` aggregate.

**Test scenarios:**
- `withTimeout`: promise resolves before timeout → returns resolved value
- `withTimeout`: promise takes longer than timeout → returns `{ status: 'error', error: 'check timed out' }`
- `withTimeout`: promise rejects immediately → returns `{ status: 'error', error: sanitized message }`
- `sanitizeError`: connection string in error message → connection string stripped from output
- `sanitizeError`: normal error message → message preserved up to 200 chars
- `sanitizeError`: error message with credentials pattern (`://user:pass@host`) → credentials stripped
- `sanitizeError`: message longer than 200 chars → truncated at 200 chars
- `runAllChecks`: all checkers return `ok` → aggregate `status` is `"ok"`
- `runAllChecks`: one checker returns `error` → aggregate `status` is `"degraded"`
- `runAllChecks`: all checkers return `error` → aggregate `status` is `"degraded"`
- `runAllChecks`: checks run in parallel → total wall-clock time ≈ max(individual latencies), not sum

**Verification:** All unit tests pass. `runAllChecks` timing test confirms parallel execution (mock two 100ms checkers; total time < 250ms). TypeScript compile-time assertions confirm `SubsystemHealth` is correctly typed for all three status values.

---

## U2: Health Route Handler

**Goal:** Implement the three Hono routes (`GET /cms/health`, `/cms/health/live`, `/cms/health/ready`) as a Hono sub-app that `createCMS` mounts automatically. Wire `version` from the CMS package, `uptime_seconds` from the `createCMS` start time, and all subsystem checkers from the instantiated adapters.

**Requirements:** R1, R5, R6, R7, R8, R9

**Dependencies:** U1 (runner utilities and types), U3 (adapter `healthCheck()` methods must exist)

**Files:**
- `packages/core/src/health/router.ts` — Hono sub-app with the three routes
- `packages/core/src/health/index.ts` — re-exports `createHealthRouter`
- `packages/core/src/createCMS.ts` — captures `startTime = Date.now()` and calls `app.route('/cms/health', createHealthRouter(...))`
- `packages/core/src/health/router.test.ts` — integration tests using Hono's `app.request` test helper

**Approach:**

`createHealthRouter` is a factory function that accepts `{ adapters, startTime, version }` and returns a Hono `app`. This keeps the router testable without requiring a full `createCMS` instance.

**Version sourcing:** The `version` field reads from the `@hono-cms/core` package's own `package.json`. In Node.js and edge environments that support JSON imports (all target runtimes do with the bundler's handling), this is a static import resolved at build time — no runtime file read. The value represents the CMS library version, not the developer's application version. This is consistent with how health endpoints work in frameworks like Fastify and NestJS (they report the framework version, not the app version).

**Uptime tracking:** `createCMS` captures `const startTime = Date.now()` immediately at the top of the function body, before any async initialization. The `uptime_seconds` in the health response is `Math.floor((Date.now() - startTime) / 1000)`. This is stored in closure scope — not a module-level singleton — so multiple `createCMS` calls in tests do not share state.

**Route behavior:**

`GET /cms/health` and `GET /cms/health/ready` share the same implementation: call `runAllChecks(checkers)`, set HTTP status to `200` if `aggregate.status === 'ok'` else `503`, return the JSON response. The distinction is semantic (caller intent), not behavioral — both routes return the same payload.

`GET /cms/health/live` skips all I/O. It returns `200` with `{ status: "ok", uptime_seconds }` immediately. The only failure mode is if the process has crashed, in which case no handler runs at all — which is exactly what K8s liveness probes rely on.

**No authentication middleware:** The health router must be mounted before any auth middleware in the route composition order. `createCMS`'s route mounting sequence places health routes first, then content routes (which carry RBAC middleware). This ensures health checks bypass all session and token verification.

**Test scenarios:**
- `GET /cms/health`: all adapter `healthCheck()` mocks return `ok` → response status 200, body `status: "ok"`
- `GET /cms/health`: one adapter mock returns `{ status: 'error', error: 'timeout' }` → response status 503, body `status: "degraded"`
- `GET /cms/health`: response body includes `version` (non-empty string) and `uptime_seconds` (non-negative integer)
- `GET /cms/health`: response body has keys for all five subsystems (`db`, `storage`, `cache`, `email`, `crons`)
- `GET /cms/health/live`: returns 200 with no adapter calls made (verify with spy/mock)
- `GET /cms/health/live`: response body includes `uptime_seconds` but not subsystem keys
- `GET /cms/health/ready`: same behavior as `/cms/health` (shares implementation — test confirms identical response shape)
- No auth header required: requests without `Authorization` header return the health response, not 401
- Route is mounted at `/cms/health` (not `/health` or `/api/health`) — verify exact path
- DB timeout simulated: mock returns after >2s → route still responds within 2.5s, `db.status: "error"`

**Verification:** Integration tests pass using Hono's `app.request()`. The route responds without any `Authorization` header. A test that mocks all adapters to take 3 seconds confirms the endpoint responds within ~2.2 seconds due to per-check timeout.

---

## U3: Adapter-Level Health Check Implementations

**Goal:** Add `healthCheck(): Promise<SubsystemHealth>` to each adapter interface in `packages/schema/` and implement it in each concrete adapter. Each implementation performs the minimal connectivity probe appropriate to the adapter type — never a full capability test.

**Requirements:** R3, R4, R10

**Dependencies:** U1 (`SubsystemHealth` type from `packages/schema/src/health.ts`)

**Files:**

*Interface additions (schema package):*
- `packages/schema/src/adapter.ts` — add `healthCheck(): Promise<SubsystemHealth>` to `DatabaseAdapter`
- `packages/schema/src/storage.ts` — add `healthCheck(): Promise<SubsystemHealth>` to `StorageAdapter`
- `packages/schema/src/cache.ts` — add `healthCheck(): Promise<SubsystemHealth>` to `CacheAdapter`
- `packages/schema/src/email.ts` — add `healthCheck(): Promise<SubsystemHealth>` to `EmailAdapter`
- `packages/schema/src/crons.ts` — add `healthCheck(): Promise<SubsystemHealth>` to `CronAdapter`

*Concrete implementations:*
- `packages/adapter-d1/src/index.ts` — DB: `SELECT 1` via Drizzle, measure latency
- `packages/adapter-postgres/src/index.ts` — DB: `SELECT 1` (TCP or HTTP mode), measure latency
- `packages/adapter-turso/src/index.ts` — DB: `SELECT 1` via libSQL, measure latency
- `packages/storage-r2/src/index.ts` — Storage: verify R2 binding is non-null (no network call)
- `packages/storage-s3/src/index.ts` — Storage: `HeadObject` on a sentinel key (`_health`)
- `packages/storage-vercel-blob/src/index.ts` — Storage: verify token is non-null (Blob SDK is auth'd via token at construction)
- `packages/storage-local/src/index.ts` — Storage: `access()` check on the configured upload directory
- `packages/cache-redis/src/index.ts` — Cache: `PING` command, measure round-trip
- `packages/cache-kv/src/index.ts` — Cache: verify KV binding is non-null
- `packages/cache-memory/src/index.ts` — Cache: always return `{ status: 'ok' }`
- `packages/email-resend/src/index.ts` — Email: verify API key is non-null string (no HTTP call)
- `packages/email-console/src/index.ts` — Email: always return `{ status: 'ok' }`
- `packages/jobs/src/qstash.ts` — Crons: verify QStash token is non-null string (no HTTP call)
- `packages/jobs/src/vercel-crons.ts` — Crons: always return `{ status: 'ok' }` (no external token)
- `packages/jobs/src/cloudflare-crons.ts` — Crons: always return `{ status: 'ok' }` (internal trigger)
- `packages/jobs/src/none.ts` — Crons: always return `{ status: 'ok' }` (disabled)

*Test files:*
- `packages/adapter-d1/src/health.test.ts`
- `packages/adapter-postgres/src/health.test.ts`
- `packages/storage-r2/src/health.test.ts`
- `packages/storage-s3/src/health.test.ts`
- `packages/storage-local/src/health.test.ts`
- `packages/cache-redis/src/health.test.ts`

**Approach:**

**Database adapters (D1, Postgres, Turso):** Record `start = performance.now()` before the query, execute the ping (e.g., `SELECT 1` as a raw query or via the adapter's existing `ping` pathway), record `end = performance.now()`, return `{ status: 'ok', latency_ms: Math.round(end - start) }`. Any thrown error is caught by the caller (`withTimeout` in the runner) — the adapter's `healthCheck()` should not catch internally; let the runner's `try/catch` handle it so sanitization happens in one place.

**Storage adapters:**
- **R2:** R2 bindings are injected at Worker startup; a non-null binding means R2 is accessible. No network call is needed — the binding failing to be present at all is an infrastructure configuration error surfaced at startup, not a health check concern. Return `{ status: 'ok' }` if binding is truthy.
- **S3:** `HeadObject` on a well-known sentinel key (`__hono_cms_health`) with the expectation that a 404 (key not found) is also a success — it proves the S3 connection and credentials work. Only network errors and auth failures are `error` states. Measure latency. The sentinel key is never created; a 404 is an expected healthy response.
- **Vercel Blob:** Blob access is credential-validated at construction time (via `BLOB_READ_WRITE_TOKEN`). Verify the token is a non-empty string at health check time — if it is null, the adapter was misconfigured. No HTTP call; return `{ status: 'ok' }` or `{ status: 'error', error: 'storage token not configured' }`.
- **Local:** `fsPromises.access(uploadDir, fs.constants.W_OK)` — verifies the upload directory exists and is writable. This catches the common "upload directory not created" misconfiguration.

**Cache adapters:**
- **Redis:** `client.ping()` — all Redis-compatible clients (Upstash, ioredis, @redis/client) expose `ping()`. Measure round-trip latency.
- **KV (Cloudflare):** Same as R2 — verify binding is non-null. Return `{ status: 'ok' }`.
- **Memory:** Always `{ status: 'ok' }` — in-process cache is always available if the process is running.

**Email adapters:**
- **Resend:** Do NOT make an HTTP call. The Resend `/domains` API call adds latency and burns Resend API quota on every health check. Instead, verify the API key is a non-null, non-empty string. If it is null, the adapter was misconfigured (the key wasn't set in env). Return `{ status: 'ok' }` or `{ status: 'error', error: 'email API key not configured' }`. Note: this is an in-process check; it cannot detect a revoked key. That is acceptable — health checks are connectivity probes, not capability proofs.
- **Console:** Always `{ status: 'ok' }` — console email is always available.

**Crons adapters:**
- **QStash:** Verify token is a non-null, non-empty string (same rationale as Resend — no HTTP call on every health check). Return `{ status: 'ok' }` or `{ status: 'error', error: 'QStash token not configured' }`.
- **Vercel / Cloudflare / None:** Always `{ status: 'ok' }` — these are internal or disabled; no token to verify.

**Sensitive info constraint:** Adapter implementations must never include connection strings, host names, or credentials in error messages. Error messages should describe the failure class ("connection refused", "authentication failed", "upload directory not writable"), not the specifics. The `sanitizeError` utility in U1 provides a second safety net, but the first defense is the adapter implementation itself.

**Test scenarios:**

*DB adapters (D1 as representative):*
- Mock Drizzle returns in 5ms → `healthCheck()` returns `{ status: 'ok', latency_ms: 5 }` (±10ms)
- Mock Drizzle throws `"SQLITE_ERROR: connection failed"` → let the caller's `withTimeout` catch it; verify the adapter does not swallow the error internally
- Latency field is a non-negative integer (not float)

*S3 storage:*
- `HeadObject` returns 404 (key not found) → `{ status: 'ok', latency_ms: N }`
- `HeadObject` throws network error → error propagates to runner (not caught in adapter)
- `HeadObject` returns 403 (auth failure) → error propagates to runner

*Local storage:*
- Upload directory exists and is writable → `{ status: 'ok' }`
- Upload directory does not exist → error propagates to runner
- Upload directory exists but not writable (permission denied) → error propagates to runner

*Redis cache:*
- `ping()` returns `"PONG"` in 8ms → `{ status: 'ok', latency_ms: 8 }`
- `ping()` throws (connection refused) → error propagates to runner

*Email (Resend):*
- API key is a non-empty string → `{ status: 'ok' }` (no network call made — verify with spy)
- API key is null → `{ status: 'error', error: 'email API key not configured' }`
- API key is empty string → `{ status: 'error', error: 'email API key not configured' }`

*Crons (QStash):*
- Token is non-empty string → `{ status: 'ok' }` (no network call — verify with spy)
- Token is null → `{ status: 'error', error: 'QStash token not configured' }`

*Cross-cutting:*
- Connection string in error message: create an adapter where the underlying client throws an error containing `"postgres://user:pass@host/db"` → verify runner's `sanitizeError` strips it (tested via the full `runAllChecks` integration path, not just the adapter unit)

**Verification:** Each adapter's `healthCheck()` test file passes. No adapter test makes real network calls (all mocked at the client boundary). S3 `HeadObject` mock returning 404 is verified as a success path. Email and crons mocks confirm zero HTTP calls are made during `healthCheck()`.

---

## Implementation Order

The natural build sequence respects dependencies:

1. **U1** — types and runner utilities (no dependencies)
2. **U3** — adapter interface additions and implementations (depends on U1's `SubsystemHealth` type)
3. **U2** — route handler and `createCMS` wiring (depends on U1 runner + U3 adapter methods)

U3 can be built in parallel with U2's route skeleton (the route can be written with mock checkers while adapter implementations are being added), but U3 must be complete before the full integration test in U2 passes.

---

## System-Wide Impact

- **`packages/schema/`:** Five interface files gain a `healthCheck()` method. Any external custom adapter implementation (a developer who wrote their own `DatabaseAdapter`) will get a TypeScript compile error until they add the method. This is a breaking interface change — acceptable for v1 greenfield work, but worth noting in the release notes.
- **`createCMS` route ordering:** Health routes are mounted before auth middleware. This is the first route-ordering constraint imposed by a feature plan. The route composition in `packages/core/src/createCMS.ts` must document this ordering requirement.
- **No new runtime dependencies:** The health check system uses only `Promise.race`, `performance.now()`, and existing adapter clients. No new npm packages are added.
- **Bundle impact:** The health router and runner add < 2 KB to the `@hono-cms/core` bundle. Adapter `healthCheck()` methods add < 100 bytes per adapter (trivially small).
