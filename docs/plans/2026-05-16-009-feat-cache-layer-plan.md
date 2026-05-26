---
title: "feat: Cache Layer — Upstash Redis, Cloudflare KV, Memory Providers"
date: 2026-05-16
type: feat
status: active
depth: deep
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
ideation-ideas: ["#15 Cache Layer — Upstash Redis as First-Class Config"]
---

# Plan 009: Cache Layer — `@hono-cms/cache`

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 2
**Research inputs used:** skill review, framework docs, architecture review, performance review, security review

### Key Improvements

1. Split semantic concerns that were previously bundled into one coarse cache abstraction.
2. Tighten security-sensitive invalidation and fail-closed guidance.
3. Prefer namespace versioning and normalized cache keys over broad pattern deletion.

**Sequence:** 009 of 018
**Package:** `packages/cache/` → `@hono-cms/cache`
**Blocking:** Plans 010 (core), 011 (auth integration), 012 (content routes) all consume this package.

---

## Purpose

This plan designs and implements the cache abstraction layer for `@hono-cms`. The cache is purely internal infrastructure — the developer declares a provider in `createCMS`; the CMS handles all cache interactions invisibly. Five distinct internal use cases are served by a single `CacheAdapter` interface with three provider implementations: Upstash Redis (canonical edge choice), Cloudflare KV (Workers-native, eventual consistency), and in-memory (dev and single-process Node.js).

Cache correctness is a first-class concern. A cache bug that serves stale content after a publish, leaks a session after logout, or silently skips rate limiting is a security or data-integrity failure, not a performance regression. Every design decision in this plan is evaluated against that bar.

---

## Key Technical Decisions

## Research Insights

**Best Practices:**
- Consider separating `KeyValueStore`, `ResponseCache`, `TokenStore`, and `RateLimiter` responsibilities instead of forcing every use case through one weakest-common-denominator abstraction.
- Keep Upstash Redis as the correctness-oriented default for sessions and rate limiting; use KV only where eventual consistency is acceptable.
- Normalize query inputs before cache-key creation so equivalent requests share entries predictably.

**Performance Considerations:**
- Prefer namespace version bumps or tag-style invalidation over broad pattern scans as collections grow.
- Add single-flight or stale-while-revalidate behavior for hot cache misses after invalidation.

**Security Considerations:**
- Invalidate privileged session cache entries on logout, password reset, user disable, role/org change, API key revoke, and 2FA changes.
- Fail closed for production rate limiting instead of silently degrading into ineffective memory/KV behavior.

### 1. Why Upstash Redis (HTTP, not TCP) is the canonical edge choice

Standard Redis uses TCP connections. Cloudflare Workers, Vercel Edge Functions, and all WinterTC-compliant runtimes prohibit persistent TCP connections — you get one request/response cycle per invocation, no sockets. Upstash Redis solves this by exposing Redis operations entirely over HTTPS using a REST API. The `@upstash/redis/cloudflare` package wraps every Redis command (GET, SET, DEL, SCAN, etc.) as a `fetch()` call to `https://<your-endpoint>.upstash.io/`. No TCP socket is opened. The same package works on Cloudflare Workers, Vercel Edge, Deno Deploy, and plain Node.js — because `fetch` is universal.

As of 2026, Upstash routes read requests to the Redis replica colocated with the Worker's Point-of-Presence (PoP). This means a GET from a London Worker hits a London Redis replica, not a US origin, achieving sub-10ms latency on cache hits — competitive with a local in-process cache for the purposes of a CMS request path.

The alternative — self-hosted Redis over Upstash's connection proxies (Upstash Proxy) — still makes HTTP calls and adds a proxy hop with no benefit for this use case. Direct Upstash Redis via `@upstash/redis/cloudflare` is the correct and only edge-compatible Redis option.

### 2. Why Cloudflare KV is not suitable for session caching

Cloudflare KV is eventually consistent. After a `PUT`, the new value propagates globally to all KV edge nodes within seconds to minutes — not milliseconds. A `GET` from a different PoP than where the `PUT` originated may read a stale value for an indeterminate period.

This is catastrophic for session data. Consider the logout flow: the user logs out → the CMS deletes the session from KV → a request from another PoP arrives 400ms later → that PoP has not yet received the KV propagation → the request reads the stale (deleted) session → the user is treated as authenticated after logout. This is a session fixation vector.

Similarly, rate limiting via KV is not possible. KV has no atomic increment. Two requests from different Workers instances checking the same rate limit key can both read `count=99`, both increment to `100`, and both write back — the rate limit counter is now 100 instead of 101. The window has been gamed by a race condition. Atomicity is the property that makes rate limiting correct; KV does not provide it.

KV is suitable for content response caching where eventual consistency is acceptable. A blog post that returns stale content for 30 seconds while a KV propagation completes is a minor UX issue, not a correctness failure. The CMS uses KV for exactly this use case and routes session caching to in-memory fallback when KV is the selected provider.

### 3. Why session cache TTL is 30–60 seconds

The session cache is a performance optimization on top of better-auth's DB-backed session store. The CMS is not the source of truth for sessions; better-auth's sessions table is. The cache reduces DB hits on the hot path — authenticated requests that arrive faster than a DB round trip allows.

A 30–60 second TTL means:
- **Security bound:** A revoked session (logout, admin force-logout, token theft response) takes at most 60 seconds to stop being served from cache. This is the security cost of the optimization. For a CMS — not a financial system — this is an acceptable tradeoff. The session is not eliminated from the DB on revocation; it is marked invalid. A stale cache hit is the only window where the invalid session could be accepted, and that window is bounded to 60 seconds.
- **Performance bound:** At 100 req/s, a 60-second TTL means roughly 5,900 DB calls are avoided per minute per session. The first call per session per minute hits the DB; subsequent calls hit the cache. At higher TTLs (5 minutes), the security window grows unacceptably. At lower TTLs (5 seconds), most requests under moderate load still hit the DB, losing the optimization's value.
- **Logout invalidation:** The explicit delete on logout eliminates the wait for TTL expiry in the normal case. The 60-second window only applies when a session is revoked through a path that does not go through the CMS logout handler (e.g., DBA deletes a session directly, or better-auth's admin API is called externally).

### 4. Why cache invalidation on collection mutations, not TTL-only expiry

TTL-only expiry is simple but produces incorrect behavior after a publish. A content editor publishes an article at 10:00:00. The public API has a 60-second TTL content cache. A reader hits the public API at 10:00:30 and receives the pre-publish (draft) version of the article. The TTL does not expire until 10:01:00. For 30 seconds, published content is not served. Worse, if content is unpublished (taken offline), cached published content continues to be served for up to the full TTL period.

The CMS invalidates the content cache proactively on every mutation that changes the visibility or content of a document: `create`, `update`, `delete`, and `publish`/`unpublish`. The implementation uses `deletePattern('content:{collection}:*')` to clear all cached responses for the affected collection. This is a collection-level invalidation, not a document-level one — when any document in `articles` is mutated, all cached `articles` query responses are cleared.

Collection-level invalidation is simpler than document-level (no need to track which cached queries reference which documents) and safe for content CMS workloads where collections are typically under a few hundred documents. The tradeoff is that a single document change clears all cached queries for the collection. For a blog with 500 articles, a new comment being published clears cached responses for all article list queries. This is correct behavior — the query for "latest articles" now has a new result — and the TTL (60 seconds by default) rebuilds the cache quickly.

### 5. ETags for content response cache (conditional GET)

The content cache stores response bodies and their ETags. When a cached response exists, the CMS includes the `ETag` header in the response. On subsequent requests, browsers and CDN layers send `If-None-Match: <etag>`. The CMS checks the ETag against the cached value; if they match, a `304 Not Modified` is returned with no body — saving bandwidth on every cached hit.

ETag generation uses a hash of the response body (SHA-256, truncated to 16 hex chars). This is a strong ETag — it changes whenever the content changes, which happens naturally after cache invalidation and the next cache fill. ETags are stored alongside the cached response body in the cache entry.

The ETag flow is: cache miss → fetch from DB → serialize → compute ETag → cache {body, etag} → return `200` with `ETag` header. Cache hit with `If-None-Match` match → return `304`. Cache hit without `If-None-Match` → return `200` with body and `ETag` header.

---

## Output Structure

```
packages/cache/
├── package.json                          # @hono-cms/cache
├── tsconfig.json
├── tsdown.config.ts
├── vitest.config.ts
└── src/
    ├── index.ts                          # public re-exports
    ├── types.ts                          # CacheAdapter interface, CacheConfig discriminated union, RateLimitOptions
    ├── factory.ts                        # createCacheAdapter(config, env?) factory
    ├── providers/
    │   ├── upstash.ts                    # UpstashCacheAdapter
    │   ├── kv.ts                         # KVCacheAdapter
    │   └── memory.ts                     # MemoryCacheAdapter
    ├── integrations/
    │   ├── session.ts                    # withSessionCache()
    │   ├── content.ts                    # withContentCache()
    │   └── preview.ts                    # storePreviewToken() / verifyPreviewToken()
    └── __tests__/
        ├── factory.test.ts
        ├── upstash.test.ts
        ├── kv.test.ts
        ├── memory.test.ts
        ├── session.test.ts
        ├── content.test.ts
        └── preview.test.ts
```

---

## High-Level Technical Design

*This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### CacheAdapter interface (directional)

```
interface CacheAdapter {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T, options?: { ttl?: number }): Promise<void>
  delete(key: string): Promise<void>
  deletePattern(pattern: string): Promise<void>
  checkRateLimit(
    identifier: string,
    options: RateLimitOptions
  ): Promise<{ success: boolean; remaining: number }>
}

type RateLimitOptions = {
  limit: number
  window: string    // e.g. '1 m', '30 s'
  prefix?: string   // namespacing key prefix
}
```

### CacheConfig discriminated union (directional)

```
type CacheConfig =
  | { provider: 'upstash'; url: string; token: string }
  | { provider: 'kv'; binding: KVNamespace }
  | { provider: 'memory' }

// Factory signature
function createCacheAdapter(config: CacheConfig, env?: Record<string, unknown>): CacheAdapter
```

### Request flow with cache (directional)

```
Incoming request
  │
  ├─► Session middleware
  │     ├─ compute tokenHash = SHA-256(Authorization header)
  │     ├─ cache.get('session:{tokenHash}')
  │     │     hit → return cached session (skip DB)
  │     │     miss → auth.api.getSession() → cache.set with 30-60s TTL
  │     └─► ctx.set('session', session)
  │
  ├─► Rate limit middleware (Upstash only, others: pass-through with warning)
  │     └─ cache.checkRateLimit(ip, { limit: 100, window: '1 m' })
  │
  ├─► Permission middleware (reads ctx session — no cache interaction)
  │
  └─► Content handler
        ├─ [public request] withContentCache wraps handler
        │     ├─ compute queryHash = SHA-256(collection + qs(queryParams))
        │     ├─ cache.get('content:{collection}:{queryHash}')
        │     │     hit → check ETag, return 304 or 200 with cached body
        │     │     miss → run handler → cache.set(body + etag)
        │     └─ [on mutation] cache.deletePattern('content:{collection}:*')
        └─ [authenticated request] bypass cache, always fresh

Preview token verification (separate middleware for /?preview= routes):
  cache.get('preview:{token}') → { documentId, collection } | null
```

### Provider capability matrix

| Capability | Upstash Redis | Cloudflare KV | Memory |
|---|---|---|---|
| `get` / `set` / `delete` | Full | Full | Full |
| TTL (`EXPIRE`) | Atomic, server-side | `expirationTtl` on `put` | Timestamp check on `get` |
| `deletePattern` (SCAN+DEL) | Full | Not supported (warn) | Key prefix scan |
| `checkRateLimit` | Atomic sliding window via `@upstash/ratelimit` | Not supported (returns `{success:true, remaining:999}` + warn) | In-process sliding window counter (single-process correct) |
| Session caching | Correct | Incorrect (eventual consistency) | Correct (single-process) |
| Rate limiting | Correct (distributed) | Not supported | Correct (single-process) |
| Content caching | Correct | Correct (eventual OK) | Correct (single-process) |

---

## Implementation Units

---

### U1. CacheAdapter Interface and Factory

**Goal:** Define the complete TypeScript type surface for the cache layer and implement the `createCacheAdapter` factory function that inspects the discriminated union config and returns the correct provider implementation.

**Requirements:**
- `CacheAdapter` interface covers all five internal use cases via the five methods listed in the design.
- `CacheConfig` is a discriminated union on `provider` with no overlap between branches.
- `createCacheAdapter(config, env?)` returns the correct implementation based on `config.provider`.
- The `env` parameter supports the `Redis.fromEnv(env)` pattern where the Cloudflare Worker env object is passed directly — callers do not need to extract `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` before calling the factory.
- The factory emits a runtime warning when `provider: 'memory'` is selected and `NODE_ENV === 'production'`.
- The factory emits a runtime warning when `provider: 'kv'` is selected: "KV provider selected. Session caching falls back to in-memory (eventual consistency). Rate limiting is disabled."
- All type exports are re-exported from `packages/cache/src/index.ts`.

**Dependencies:** None (U1 is the foundation all other units depend on).

**Files:**
- `packages/cache/src/types.ts` (create)
- `packages/cache/src/factory.ts` (create)
- `packages/cache/src/index.ts` (create)
- `packages/cache/package.json` (create)
- `packages/cache/tsconfig.json` (create)
- `packages/cache/tsdown.config.ts` (create)
- `packages/cache/vitest.config.ts` (create)
- `packages/cache/src/__tests__/factory.test.ts` (create)

**Approach:**

`types.ts` defines:
- `RateLimitOptions`: `{ limit: number; window: string; prefix?: string }`. The `window` string follows `@upstash/ratelimit` conventions (`'1 m'`, `'30 s'`, `'1 h'`) — the memory provider must parse this string to derive the sliding window duration in milliseconds.
- `RateLimitResult`: `{ success: boolean; remaining: number }`.
- `CacheSetOptions`: `{ ttl?: number }` where `ttl` is in seconds, matching Redis EXPIRE semantics and Cloudflare KV's `expirationTtl`.
- `CacheAdapter` interface — all five methods as typed above.
- `CacheConfig` discriminated union — three branches: `upstash`, `kv`, `memory`.

`factory.ts` is a pure switch on `config.provider`. The factory does no validation of credentials — that surfaces naturally when the first operation fails. The warning for `memory` in production is a `console.warn` call, not a thrown error — the developer may intentionally use the memory provider in a production single-process Node.js deployment and should not have their app crash.

The `env` parameter is typed as `Record<string, unknown>` (not `Env` from `@cloudflare/workers-types`) to avoid an optional dependency on the Cloudflare types package. The `upstash` branch of the factory passes `env` to `Redis.fromEnv(env)` when `env` is provided — this covers the Cloudflare Worker deployment pattern where the user passes `env` into `createCMS` inside the Worker's `fetch` handler. When `env` is absent, the Upstash provider falls back to `Redis.fromEnv()` which reads `process.env` — covering Node.js deployments.

How `env` flows from the Worker into the cache:
1. The Cloudflare Worker's `fetch` handler receives `(request, env, ctx)`.
2. `createCMS` is called with a top-level config; the `cache` config carries `provider: 'upstash'` (url/token may be undefined at module load time if they come from `env`).
3. `createCMS` defers adapter creation to request time — the `cache` config section allows passing `env` into `createCacheAdapter` on first request so `Redis.fromEnv(env)` reads live bindings.
4. Alternatively, the developer passes `env.UPSTASH_REDIS_REST_URL` and `env.UPSTASH_REDIS_REST_TOKEN` explicitly in the cache config — the factory uses those directly.

The `env`-passthrough pattern is the cleaner deployment story. The plan leaves it to `packages/core` (Plan 010) to define how the worker env flows through `createCMS`. This package's factory only needs to accept an optional `env` and forward it.

**Technical design (directional):**

```
// factory.ts shape
export function createCacheAdapter(config: CacheConfig, env?: Record<string, unknown>): CacheAdapter {
  switch (config.provider) {
    case 'upstash': return new UpstashCacheAdapter(config, env)
    case 'kv':      // warn + return new KVCacheAdapter(config)
    case 'memory':  // warn if production + return new MemoryCacheAdapter()
  }
}
```

**Patterns to follow:** The `DatabaseAdapter` interface pattern from the ideation (idea #1) — a typed interface with separate npm-installable implementations. The `CacheAdapter` interface follows the same shape: interface in `types.ts`, factory in `factory.ts`, implementations in `providers/`.

**Test scenarios:**
- `createCacheAdapter({ provider: 'upstash', url: 'x', token: 'y' })` returns an object that satisfies `CacheAdapter`.
- `createCacheAdapter({ provider: 'kv', binding: mockKVNamespace })` returns an object that satisfies `CacheAdapter` and logs a KV warning.
- `createCacheAdapter({ provider: 'memory' })` returns an object that satisfies `CacheAdapter`.
- `createCacheAdapter({ provider: 'memory' })` with `NODE_ENV=production` emits a `console.warn` containing "memory" and "production".
- `createCacheAdapter({ provider: 'kv', binding: ... })` emits a `console.warn` mentioning session fallback and rate limiting disabled.
- Passing `env` with `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to the `upstash` branch does not throw.
- TypeScript: assigning `{ provider: 'upstash' }` without `url`/`token` is a compile error.
- TypeScript: assigning `{ provider: 'kv' }` without `binding` is a compile error.

**Verification:** `turbo run typecheck build --filter=@hono-cms/cache` passes. Factory tests pass. The `CacheAdapter` type is importable from `@hono-cms/cache`.

---

### U2. Upstash Redis Provider

**Goal:** Implement `UpstashCacheAdapter` — the canonical production cache provider — covering all five `CacheAdapter` methods with correct JSON serialization, TTL handling, SCAN-based pattern deletion, and sliding-window rate limiting via `@upstash/ratelimit`.

**Requirements:**
- Uses `@upstash/redis/cloudflare` (HTTP REST, no TCP socket). Not `ioredis`, not `node-redis`.
- `Redis.fromEnv(env)` pattern: when `env` is provided, pass it to `Redis.fromEnv(env)`. When absent, use `Redis.fromEnv()` (reads `process.env`). When `url` and `token` are explicitly in the config, use `new Redis({ url, token })`.
- `get<T>`: `redis.get(key)` → Upstash Redis returns the stored string; JSON-parse and return typed `T`. Return `null` on key-not-found.
- `set<T>`: JSON-serialize the value. `redis.set(key, json)`. If `options.ttl` is provided, use `redis.set(key, json, { ex: ttl })` (EX = expire in seconds). Do not set TTL if `options.ttl` is absent — the entry is persistent.
- `delete`: `redis.del(key)`. Returns `void`.
- `deletePattern`: Iterates with `redis.scan(cursor, { match: pattern, count: 100 })` until `cursor` returns `0`. Collects all matching keys. Deletes in batches of 100 using `redis.del(...keys)`. Important: SCAN is non-blocking and correct under concurrent writes — it may miss keys added after the SCAN started, which is acceptable for cache invalidation (the next mutation will re-invalidate).
- `checkRateLimit`: Constructs a `new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(options.limit, options.window), analytics: true })`. The `Ratelimit` instance is cached per `identifier` prefix to avoid re-constructing on every request. Calls `ratelimit.limit(identifier)` and returns `{ success, remaining }`. The `analytics: true` flag enables Upstash's Ratelimit analytics dashboard at no extra cost.
- All errors from Upstash HTTP calls are propagated — the cache layer does not silently swallow errors. The CMS core (Plan 010) decides whether a cache failure degrades gracefully or surfaces as a 500.

**Dependencies:** U1.

**Files:**
- `packages/cache/src/providers/upstash.ts` (create)
- `packages/cache/src/__tests__/upstash.test.ts` (create)
- `packages/cache/package.json` (modify — add `@upstash/redis`, `@upstash/ratelimit` to `dependencies`)

**Approach:**

The `UpstashCacheAdapter` class holds a `Redis` instance and a `Map<string, Ratelimit>` for caching `Ratelimit` instances by their config fingerprint (limit + window). The `Ratelimit` map prevents creating a new `Ratelimit` object on every `checkRateLimit` call — `Ratelimit` construction is not free (it creates a Redis pipeline under the hood).

`deletePattern` must handle the SCAN cursor protocol correctly. Upstash's `scan` returns `[nextCursor, keys]`. Start with cursor `0`; loop calling `redis.scan(cursor, { match: pattern, count: 100 })` until the returned cursor is `0`. Accumulate all keys across iterations. Delete accumulated keys in one or more `redis.del` calls (Redis DEL accepts multiple keys). If the accumulation is empty (no matching keys), skip the DEL.

Upstash's `@upstash/redis` package serializes stored values as JSON strings automatically when you pass a JavaScript object. However, for type safety and explicit control, this implementation will always explicitly `JSON.stringify` before set and `JSON.parse` after get. This ensures the behavior is predictable regardless of Upstash client version.

The Redis client instance is created once in the constructor. For the Cloudflare Worker pattern where `env` arrives per-request (not at module initialization time), the factory must defer construction of `UpstashCacheAdapter` until the first request. The factory can return a lazy proxy or the core package can call `createCacheAdapter` inside the request handler rather than at module load time. This is a coordination point with Plan 010 (core); document it explicitly in the adapter.

**Technical design — `deletePattern` SCAN loop (directional):**

```
async deletePattern(pattern: string): Promise<void> {
  let cursor = 0
  const keys: string[] = []
  do {
    const [nextCursor, batch] = await this.redis.scan(cursor, { match: pattern, count: 100 })
    cursor = nextCursor
    keys.push(...batch)
  } while (cursor !== 0)
  if (keys.length > 0) {
    // DEL accepts multiple keys; batch to avoid oversized commands
    for (let i = 0; i < keys.length; i += 100) {
      await this.redis.del(...keys.slice(i, i + 100))
    }
  }
}
```

**Patterns to follow:** Upstash's official Cloudflare Workers integration examples. The `@upstash/ratelimit` README's sliding window example. The existing `packages/adapter-d1` pattern (from Plan 001's scaffold) for how a provider class is structured.

**Test scenarios:**

Tests use a mock HTTP interceptor (MSW or `vi.mock('@upstash/redis/cloudflare')`) rather than a live Upstash instance. The Upstash Redis client is a thin HTTP wrapper, making it straightforward to mock at the `fetch` level.

- `get` with a key that exists → returns deserialized object of correct type.
- `get` with a key that does not exist → returns `null`.
- `set` without TTL → calls `redis.set(key, json)` without `ex` option.
- `set` with `ttl: 60` → calls `redis.set(key, json, { ex: 60 })`.
- `delete` → calls `redis.del(key)` once.
- `deletePattern('content:articles:*')` with matching keys across multiple SCAN pages → collects all keys and deletes them in batch.
- `deletePattern('content:articles:*')` with no matching keys → no DEL is called (no error).
- `deletePattern` where SCAN requires multiple iterations (cursor loops) → accumulates all pages before deleting.
- `checkRateLimit` when under limit → returns `{ success: true, remaining: N }`.
- `checkRateLimit` when at limit → returns `{ success: false, remaining: 0 }`.
- `checkRateLimit` called twice with same prefix → reuses the same `Ratelimit` instance (no second construction).
- JSON serialization round-trip: a complex nested object stored via `set` is returned unchanged by `get`.
- Error propagation: an HTTP error from Upstash causes `get` to throw (not return `null`).

**Verification:** Unit tests pass with mocked Redis. `deletePattern` correctly handles multi-page SCAN. TypeScript: `UpstashCacheAdapter` is assignable to `CacheAdapter`.

---

### U3. Cloudflare KV Provider

**Goal:** Implement `KVCacheAdapter` using the `KVNamespace` Workers binding. Cover the three fully-supported operations (`get`, `set`/`delete`) with JSON serialization and TTL via `expirationTtl`. Document and constrain the two unsupported operations (`deletePattern`, `checkRateLimit`) with explicit warnings — they are not blockers, just declared limitations.

**Requirements:**
- Uses the `KVNamespace` type from `@cloudflare/workers-types`. The binding is passed via the config's `binding` property.
- `get<T>`: `kv.get(key, 'text')` → JSON-parse → return typed `T`. Return `null` if the key does not exist.
- `set<T>`: `kv.put(key, JSON.stringify(value))`. If `options.ttl` is provided, use `kv.put(key, json, { expirationTtl: ttl })`.
- `delete`: `kv.delete(key)`. Returns `void`.
- `deletePattern`: Not supported. Log `console.warn('[hono-cms/cache] KV provider does not support deletePattern. Pattern: ' + pattern + '. Keys will expire by TTL.')`. Return `Promise.resolve()` — no error thrown. The content cache falls back to TTL-only expiry for KV deployments; explicit invalidation is a no-op. This is documented prominently in the provider.
- `checkRateLimit`: Not supported atomically. Log `console.warn('[hono-cms/cache] KV provider does not support atomic rate limiting. Rate limiting is disabled.')`. Return `{ success: true, remaining: 999 }`. Callers that need rate limiting must use the Upstash provider.
- The `KVNamespace` type dependency is a `devDependency` / `peerDependency` (from `@cloudflare/workers-types`) — not a runtime import. The KV binding is a Workers runtime object, not a constructed class.

**Dependencies:** U1.

**Files:**
- `packages/cache/src/providers/kv.ts` (create)
- `packages/cache/src/__tests__/kv.test.ts` (create)
- `packages/cache/package.json` (modify — add `@cloudflare/workers-types` to `devDependencies`)

**Approach:**

`KVCacheAdapter` constructor accepts the `KVNamespace` binding directly (passed in from the config). There is no lazy initialization needed — the binding is available at Worker startup.

The `get` method must handle the case where KV returns `null` (key not found or expired). KV's `get(key, 'text')` returns `null` on miss and `string` on hit. The JSON-parse path must be guarded against null.

KV `put` with `expirationTtl` sets a relative TTL in seconds (same unit as Redis EXPIRE). The minimum `expirationTtl` value KV accepts is 60 seconds — keys with TTL under 60 seconds are rejected. This is a KV platform constraint. The implementation should clamp TTLs below 60 to 60 and emit a `console.warn` when clamping occurs. Session cache uses 30–60 second TTL; KV does not support 30-second TTL. This is another signal that KV is not appropriate for session caching (beyond the eventual consistency issue).

The `deletePattern` warning message must include the pattern string to help the developer understand which invalidation was missed and configure a workaround (e.g., shorter TTL on content cache when using KV).

**Technical design (directional):**

```
// kv.ts shape — omitting boilerplate
class KVCacheAdapter implements CacheAdapter {
  constructor(private kv: KVNamespace) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.kv.get(key, 'text')
    if (raw === null) return null
    return JSON.parse(raw) as T
  }

  async set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
    const ttl = options?.ttl
    const clampedTtl = ttl !== undefined ? Math.max(60, ttl) : undefined
    // warn if clamped
    await this.kv.put(key, JSON.stringify(value), clampedTtl ? { expirationTtl: clampedTtl } : undefined)
  }

  async deletePattern(pattern: string): Promise<void> {
    console.warn(`[hono-cms/cache] KV provider does not support deletePattern. Pattern: ${pattern}...`)
  }

  async checkRateLimit(_id: string, _opts: RateLimitOptions): Promise<RateLimitResult> {
    console.warn('[hono-cms/cache] KV provider does not support atomic rate limiting...')
    return { success: true, remaining: 999 }
  }
}
```

**Patterns to follow:** Cloudflare KV documentation for `KVNamespace.put` with `expirationTtl`. The warning pattern from `MemoryCacheAdapter` production detection.

**Test scenarios:**

Tests use a mock `KVNamespace` object (plain object with `get`, `put`, `delete` methods as `vi.fn()`).

- `get` with a key that exists → JSON-parses and returns the value.
- `get` with a missing key (mock returns `null`) → returns `null`.
- `set` without TTL → calls `kv.put(key, json)` without options.
- `set` with `ttl: 3600` → calls `kv.put(key, json, { expirationTtl: 3600 })`.
- `set` with `ttl: 30` (below KV 60-second minimum) → clamps to 60, emits `console.warn`.
- `delete` → calls `kv.delete(key)`.
- `deletePattern('content:articles:*')` → emits `console.warn` containing the pattern string; does not throw; returns `undefined`.
- `checkRateLimit('192.0.2.1', {...})` → returns `{ success: true, remaining: 999 }`; emits `console.warn`.
- `KVCacheAdapter` is assignable to `CacheAdapter` (TypeScript).
- Eventual consistency limitation: no test can assert eventual consistency behavior (this is a platform property, not testable in unit tests). Document this in the test file as a comment explaining why the test suite is intentionally silent on consistency.

**Verification:** Unit tests pass. `console.warn` is called for `deletePattern` and `checkRateLimit`. TypeScript: `KVCacheAdapter` satisfies `CacheAdapter`. The KV provider's limitations are documented in `kv.ts` JSDoc at the class level.

---

### U4. Memory Provider

**Goal:** Implement `MemoryCacheAdapter` using an in-process `Map` with TTL-based expiry, periodic cleanup of expired entries, prefix-based `deletePattern`, and an in-memory sliding window counter for `checkRateLimit`. Emit a production environment warning.

**Requirements:**
- Storage: `Map<string, { value: unknown; expiresAt: number | null }>`. `expiresAt` is a Unix timestamp in milliseconds (from `Date.now() + ttl * 1000`), or `null` for persistent entries.
- `get<T>`: Check if the entry exists AND is not expired (`Date.now() < expiresAt`, or `expiresAt === null`). Return `null` for expired or missing entries. Do not delete expired entries on `get` — cleanup happens in the periodic timer.
- `set<T>`: Store the value with `expiresAt` computed from `options.ttl`. Overwrite if key exists.
- `delete`: Remove key from the Map.
- `deletePattern`: The pattern uses glob `*` suffix (e.g., `content:articles:*`). Extract the prefix (everything before `*`) and iterate all keys in the Map, removing those that start with the prefix. For simplicity, only prefix-glob patterns (`prefix*`) are supported; full glob matching (`*infix*`, `?single`) is not needed for the CMS's use cases.
- `checkRateLimit`: Implement a sliding window counter in memory. Maintain a `Map<string, number[]>` of request timestamps per identifier. On each call, purge timestamps older than the window duration. Count remaining timestamps. If `count >= limit`, return `{ success: false, remaining: 0 }`. Otherwise, push the current timestamp, return `{ success: true, remaining: limit - count - 1 }`. Parse `options.window` string (`'1 m'` → 60000ms, `'30 s'` → 30000ms, `'1 h'` → 3600000ms).
- Periodic cleanup: Use `setInterval` to purge expired entries every 60 seconds. This prevents unbounded Map growth in long-running Node.js processes. The interval is cleared when `destroy()` is called (expose a `destroy()` method for test cleanup).
- Production detection: In the constructor, check `typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'`. Emit `console.warn('[hono-cms/cache] Memory cache provider selected in production. This provider is not distributed — use Upstash Redis for multi-process deployments.')`.
- The memory provider is safe to use in Cloudflare Workers only when there is exactly one Worker instance and global state is acceptable (not a realistic production scenario). Document this constraint.

**Dependencies:** U1.

**Files:**
- `packages/cache/src/providers/memory.ts` (create)
- `packages/cache/src/__tests__/memory.test.ts` (create)

**Approach:**

The `Map` key type is `string`. The value type is `{ value: unknown; expiresAt: number | null }`. The rate-limit state is a separate `Map<string, number[]>` — not mixed with the cache entries — to avoid accidental `get`/`set` of rate-limit state through the normal cache interface.

Window parsing for `checkRateLimit` is a small pure function: split on space, parse number, multiply by unit factor. Supported units: `s` (seconds), `m` (minutes), `h` (hours). Unknown units throw — this is a programmer error at configuration time, not a runtime event.

The cleanup timer runs `setInterval(() => { for (const [key, entry] of this.map) { if (entry.expiresAt !== null && Date.now() > entry.expiresAt) { this.map.delete(key) } } }, 60_000)`. Vitest's `vi.useFakeTimers()` lets tests advance the timer without real waits.

`deletePattern` limitation: only supports `prefix*` patterns. The CMS's internal cache key design (`content:{collection}:*`, `session:{hash}`, `preview:{token}`, `webhook-retry:{id}`) all use this pattern shape — this limitation is not a practical constraint.

**Technical design (directional):**

```
class MemoryCacheAdapter implements CacheAdapter {
  private map = new Map<string, { value: unknown; expiresAt: number | null }>()
  private rateLimitMap = new Map<string, number[]>()
  private cleanupTimer: ReturnType<typeof setInterval>

  constructor() {
    // production warning
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000)
  }

  destroy() { clearInterval(this.cleanupTimer) }

  async get<T>(key: string): Promise<T | null> { /* expiry check + return */ }
  async set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> { /* store */ }
  async delete(key: string): Promise<void> { this.map.delete(key) }
  async deletePattern(pattern: string): Promise<void> { /* prefix scan */ }
  async checkRateLimit(id: string, opts: RateLimitOptions): Promise<RateLimitResult> { /* sliding window */ }

  private cleanup() { /* evict expired entries */ }
}
```

**Patterns to follow:** `vi.useFakeTimers()` for timer-dependent tests (from the Vitest docs and the `vitest.shared.ts` pattern established in Plan 001).

**Test scenarios:**

- `get` an existing, non-expired key → returns the value.
- `get` a key that never existed → returns `null`.
- `get` a key that has expired (its `expiresAt` is in the past) → returns `null` (even though the entry still exists in the Map until cleanup).
- `set` without TTL → entry persists indefinitely (`expiresAt: null`).
- `set` with `ttl: 60` → entry expires after 60 seconds (verified via `vi.useFakeTimers()`).
- `delete` → key is removed; subsequent `get` returns `null`.
- `deletePattern('content:articles:*')` with 3 matching keys and 2 non-matching keys → only the 3 matching keys are removed.
- `deletePattern('content:articles:*')` with no matching keys → no error.
- Cleanup timer: after 60 seconds (via `vi.advanceTimersByTime(60_000)`), expired entries are purged from the Map.
- `checkRateLimit` under the limit → `{ success: true, remaining: N }`.
- `checkRateLimit` at the limit → `{ success: false, remaining: 0 }`.
- `checkRateLimit` sliding window: requests within the window count; requests outside the window (older than window duration) are evicted from the timestamp list and do not count.
- `checkRateLimit` with `window: '1 m'` parses to 60000ms.
- `checkRateLimit` with `window: '30 s'` parses to 30000ms.
- `checkRateLimit` with unknown unit (e.g., `'1 d'`) throws.
- Production warning: constructing `MemoryCacheAdapter` with `process.env.NODE_ENV = 'production'` emits `console.warn`.
- `destroy()` clears the cleanup timer (Vitest does not report leaked timers after test cleanup).

**Verification:** All unit tests pass with fake timers. TTL eviction and sliding window are verified without real time passing. `MemoryCacheAdapter` satisfies `CacheAdapter`.

---

### U5. Session Cache Integration

**Goal:** Implement `withSessionCache` — a higher-order function wrapping better-auth's session lookup with a cache-aside pattern using SHA-256 key hashing. Covers cache hit (skip DB), cache miss (fetch + store), and explicit cache invalidation on logout. Integrate with the session extraction middleware from Plan 004 (auth middleware package).

**Requirements:**
- `tokenHash`: SHA-256 of the raw `Authorization` header value (the full `Bearer <token>` string) or the session cookie value. Use the Web Crypto API (`crypto.subtle.digest('SHA-256', encoder.encode(token))`) — available in all target runtimes (Workers, Vercel Edge, Node.js 20+). Truncate or hex-encode the 32-byte output to a 64-char hex string for the cache key.
- Cache key format: `session:{tokenHash}`.
- TTL: 45 seconds (midpoint of the 30–60s range). Configurable by the caller via `options.ttl`.
- Cache-aside flow: `cache.get(key)` → if non-null, return the cached session object immediately. If null, call `authAdapter.api.getSession({ headers })` → if the result is non-null, `cache.set(key, session, { ttl: 45 })` → return session. If `getSession` returns null, do not cache (avoid caching "no session" — absence should always be freshly verified).
- Explicit invalidation on logout: `invalidateSessionCache(token: string, cache: CacheAdapter): Promise<void>` — computes the same `tokenHash` and calls `cache.delete('session:{tokenHash}')`. This function is called by the logout route handler in the auth middleware package.
- Do not cache errors from `getSession`. If `getSession` throws, let the error propagate — do not cache a failed state.
- The session object stored in the cache must be JSON-serializable. better-auth's `Session` type is a plain object — no methods, no Date objects that need special handling. The cache stores and returns the raw session object as-is.

**Dependencies:** U1, U2 (or whichever provider is configured). Integration point with Plan 004 (auth middleware) and Plan 006 (better-auth integration).

**Files:**
- `packages/cache/src/integrations/session.ts` (create)
- `packages/cache/src/__tests__/session.test.ts` (create)

**Approach:**

`withSessionCache` is not a class — it is a factory function that returns a `getSession` function with the same signature as `authAdapter.api.getSession`. The wrapped function is a drop-in replacement.

```
// Directional shape
export function withSessionCache(
  authAdapter: { api: { getSession(opts: { headers: Headers }): Promise<Session | null> } },
  cache: CacheAdapter,
  options?: { ttl?: number }
): (headers: Headers) => Promise<Session | null>
```

The returned function is what the auth middleware calls instead of `authAdapter.api.getSession` directly. Plan 004 wires this by accepting an optional `sessionResolver` parameter or by the core package composing them.

SHA-256 hashing: `crypto.subtle.digest` returns an `ArrayBuffer`. Convert to hex string via `Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')`. This is a 64-character lowercase hex string — safe for Redis keys, KV keys, and Map keys without escaping.

The `Authorization` header extraction: the session integration receives the full `Headers` object (the same `headers` passed to `authAdapter.api.getSession`). The key is derived from `headers.get('authorization') ?? headers.get('cookie') ?? ''`. If both are absent, there is no meaningful session to cache — the function calls through to `getSession` directly (no caching for unauthenticated requests).

**Test scenarios:**

- Cache hit: `cache.get` returns a valid session → `getSession` on `authAdapter` is never called → cached session is returned.
- Cache miss: `cache.get` returns `null` → `authAdapter.api.getSession` is called → result is cached with the configured TTL → session is returned.
- `authAdapter.api.getSession` returns `null` (invalid/expired session) → `cache.set` is NOT called → `null` is returned.
- Two requests with the same Authorization header hit the same cache key (same `tokenHash`).
- Two requests with different Authorization headers hit different cache keys.
- `invalidateSessionCache(token, cache)` calls `cache.delete` with the correct `session:{tokenHash}` key.
- Explicit invalidation: after `invalidateSessionCache`, the next call to the wrapped `getSession` is a cache miss and calls through to `authAdapter`.
- `getSession` throws an error → error propagates; `cache.set` is not called.
- Authorization header absent and cookie absent → calls through directly without touching cache.
- SHA-256 of the same token always produces the same 64-char hex string (determinism).
- `options.ttl` is passed to `cache.set` when provided.

**Verification:** All tests pass. The wrapped function is a drop-in for `authAdapter.api.getSession` with identical signature. `invalidateSessionCache` correctly removes the cache entry.

---

### U6. Content Response Cache Integration

**Goal:** Implement `withContentCache` — a higher-order function wrapping content route handlers with a cache-aside pattern. Caches only public (unauthenticated) responses. Invalidates on collection mutations. Supports ETags for conditional GET (`304 Not Modified`).

**Requirements:**
- Signature: `withContentCache(handler: RouteHandler, cache: CacheAdapter, options: ContentCacheOptions): RouteHandler` where `ContentCacheOptions` includes `{ collection: string; ttl?: number }`.
- Default TTL: 60 seconds. Configurable per-collection via `options.ttl`.
- Cache key: `content:{collection}:{queryHash}` where `queryHash` = SHA-256 of `JSON.stringify(sortedQueryParams)`. Query params must be sorted (by key, ascending) before hashing to ensure `?a=1&b=2` and `?b=2&a=1` produce the same cache key.
- Only cache responses for requests where there is **no authenticated session** (`ctx.get('session')` is `null` or `undefined`). Authenticated requests always bypass the cache and get a fresh DB response. This prevents cached responses from leaking field-permission-stripped data across roles.
- ETag: compute SHA-256 of the response body, truncate to 16 hex chars. Store as `{ body: string; etag: string; contentType: string }` in the cache entry.
- If the incoming request has `If-None-Match: "<etag>"` and it matches the cached ETag, return `304 Not Modified` with no body.
- If the incoming request has no `If-None-Match` or it does not match, return `200` with the cached body, `Content-Type`, and `ETag: "<etag>"` headers.
- Cache miss: call the underlying `handler`, capture the JSON response body, compute ETag, store in cache, return `200` with `ETag` header.
- Invalidation function: `invalidateCollectionCache(collection: string, cache: CacheAdapter): Promise<void>` calls `cache.deletePattern('content:{collection}:*')`. This is called by the content mutation handlers (create, update, delete, publish) in the core package (Plan 010/012). For KV providers, `deletePattern` is a no-op with a warning — invalidation falls back to TTL expiry.
- The `handler` is called in the Hono context — `withContentCache` must be compatible with Hono's middleware/handler composition. The wrapper returns a Hono handler function.

**Dependencies:** U1, U2/U3/U4 (whichever provider). Integration with Plan 008 (content routes) and Plan 010 (core, which calls `invalidateCollectionCache` on mutations).

**Files:**
- `packages/cache/src/integrations/content.ts` (create)
- `packages/cache/src/__tests__/content.test.ts` (create)

**Approach:**

Query param sorting: parse the URL's search params into an object, sort the keys, re-stringify via `new URLSearchParams(sortedEntries).toString()`, then JSON-stringify the result string before hashing. This ensures cache key stability across param order variations.

The response body capture: `withContentCache` calls the underlying handler and awaits the Response. It then reads the body via `response.clone().text()` — cloning is necessary because Response bodies are one-time-read streams. The body text is stored in the cache as a string.

ETag storage: the cache entry is `{ body: string; etag: string; contentType: string }`. The `Content-Type` is captured from the handler's response headers. On cache hit, the response is reconstructed with `new Response(body, { headers: { 'Content-Type': contentType, 'ETag': '"' + etag + '"' } })`.

ETag format: per HTTP spec, ETags are quoted strings. Store the raw hex; wrap in double-quotes when sending in headers. The `If-None-Match` header may contain `W/"etag"` (weak ETag) or `"etag"` — strip the `W/` prefix and quotes before comparing.

Hono context integration: `withContentCache` receives a Hono `Context` (`c`) and the `next` function (or the raw handler). The decision to bypass cache for authenticated requests reads from `c.get('session')` — this assumes the session middleware from Plan 004 has already run and set the session in context. Middleware ordering in `createCMS` must guarantee this.

**Technical design (directional):**

```
// content.ts shape
export function withContentCache(
  handler: (c: Context) => Promise<Response>,
  cache: CacheAdapter,
  options: { collection: string; ttl?: number }
): (c: Context) => Promise<Response> {
  return async (c: Context) => {
    const session = c.get('session')
    if (session) return handler(c)  // authenticated: bypass cache

    const queryHash = await hashQueryParams(c.req.url)
    const cacheKey = `content:${options.collection}:${queryHash}`
    const cached = await cache.get<CachedResponse>(cacheKey)

    if (cached) {
      const clientEtag = c.req.header('if-none-match')
      if (clientEtag && stripEtagQuotes(clientEtag) === cached.etag) {
        return new Response(null, { status: 304 })
      }
      return new Response(cached.body, {
        headers: { 'Content-Type': cached.contentType, 'ETag': `"${cached.etag}"` }
      })
    }

    const response = await handler(c)
    const body = await response.clone().text()
    const etag = await hashBody(body)
    await cache.set(cacheKey, { body, etag, contentType: response.headers.get('content-type') ?? 'application/json' }, { ttl: options.ttl ?? 60 })
    return new Response(body, {
      status: response.status,
      headers: { ...Object.fromEntries(response.headers), 'ETag': `"${etag}"` }
    })
  }
}

export async function invalidateCollectionCache(collection: string, cache: CacheAdapter): Promise<void> {
  await cache.deletePattern(`content:${collection}:*`)
}
```

**Test scenarios:**

- Unauthenticated request, cache miss → handler is called → response is cached → `200` with `ETag` header returned.
- Unauthenticated request, cache hit, no `If-None-Match` → handler is NOT called → `200` with body and `ETag` returned.
- Unauthenticated request, cache hit, `If-None-Match` matches ETag → handler is NOT called → `304 Not Modified` with empty body returned.
- Unauthenticated request, cache hit, `If-None-Match` does not match ETag → handler is NOT called → `200` with body and new `ETag` header.
- Authenticated request (session in context) → handler is called regardless of cache state; cache is NOT populated.
- Same query in different param order (`?a=1&b=2` vs `?b=2&a=1`) → same cache key → cache is shared.
- Different query params → different cache keys → separate cache entries.
- `invalidateCollectionCache('articles', cache)` → `cache.deletePattern('content:articles:*')` is called.
- After `invalidateCollectionCache`, the next request is a cache miss and calls the handler.
- ETag format: header value is `"<16-char-hex>"` (double-quoted).
- Weak ETag in `If-None-Match` (`W/"etag"`) → `W/` prefix is stripped before comparison.
- Cache `set` is called with TTL from `options.ttl`; defaults to 60 when absent.
- Handler throws → error propagates; cache is not written.
- KV provider: `invalidateCollectionCache` does not throw (KV `deletePattern` is a warned no-op).

**Verification:** All tests pass. ETag round-trip is correct. Authenticated requests never touch the cache. `invalidateCollectionCache` is callable from mutation handlers.

---

### U7. Preview Token Storage

**Goal:** Implement `storePreviewToken` and `verifyPreviewToken` — the storage and verification layer for draft content preview URLs. Tokens are cryptographically random, stored with a 1-hour TTL, and verified on every preview request without DB involvement.

**Requirements:**
- Token format: 32 cryptographically random bytes, hex-encoded → 64-char lowercase hex string. Generated via `crypto.getRandomValues(new Uint8Array(32))` — available in all target runtimes.
- `storePreviewToken(token, documentId, collectionName, cache)`: Store `{ documentId, collection: collectionName }` under key `preview:{token}` with TTL 3600 (1 hour). Return `void`.
- `verifyPreviewToken(token, cache)`: `cache.get('preview:{token}')` → return `{ documentId: string; collection: string }` if found; return `null` if not found or expired (TTL-based expiry is handled by the cache provider — the token simply does not exist after 1 hour).
- `generatePreviewToken(): string` — pure function that generates a secure random token. Exported for use by the `POST /api/preview-tokens` route handler in Plan 008.
- Tokens are single-use intent: once a preview token is generated and stored, it may be used multiple times within the 1-hour window (it is not consumed on first use — it is a preview link, not a one-time secret). If single-use behavior is desired in the future, `verifyPreviewToken` would call `cache.delete` after the first successful verify. Not required for v1.
- Tokens are created by the admin SPA via `POST /api/preview-tokens` (the route handler lives in Plan 008). The handler requires an admin session, generates the token, stores it, and returns `{ token, previewUrl }` to the SPA.
- Token revocation: `revokePreviewToken(token, cache)` calls `cache.delete('preview:{token}')`. This is called if an admin wants to invalidate a preview link before it expires.

**Dependencies:** U1, U2/U3/U4.

**Files:**
- `packages/cache/src/integrations/preview.ts` (create)
- `packages/cache/src/__tests__/preview.test.ts` (create)

**Approach:**

`generatePreviewToken` uses the Web Crypto API's `getRandomValues` — synchronous on all platforms. The 32-byte Uint8Array is converted to hex with `Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')`. This produces a 64-char lowercase hex string with 256 bits of entropy — sufficient for a preview token (birthday attack resistance at 2^128 with 64-char hex in a birthday-collision scenario).

`storePreviewToken` and `verifyPreviewToken` are thin wrappers around `cache.set` and `cache.get`. The token itself is used as-is in the key — the key is `preview:{64-char-hex}`. No additional hashing is needed because the token is already opaque and high-entropy. Hashing the token before using it as a key provides no additional security in this context (the token is not a password, it is not derived from user input).

`verifyPreviewToken` validates the token format before making the cache call: the token must be a 64-char hex string. Invalid format returns `null` immediately without hitting the cache. This prevents cache probing with malformed inputs.

**Technical design (directional):**

```
// preview.ts shape
const HEX_64 = /^[0-9a-f]{64}$/

export function generatePreviewToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function storePreviewToken(
  token: string,
  documentId: string,
  collectionName: string,
  cache: CacheAdapter
): Promise<void> {
  await cache.set(`preview:${token}`, { documentId, collection: collectionName }, { ttl: 3600 })
}

export async function verifyPreviewToken(
  token: string,
  cache: CacheAdapter
): Promise<{ documentId: string; collection: string } | null> {
  if (!HEX_64.test(token)) return null
  return cache.get<{ documentId: string; collection: string }>(`preview:${token}`)
}

export async function revokePreviewToken(token: string, cache: CacheAdapter): Promise<void> {
  await cache.delete(`preview:${token}`)
}
```

**Test scenarios:**

- `generatePreviewToken()` returns a 64-character string matching `/^[0-9a-f]{64}$/`.
- `generatePreviewToken()` called twice returns different tokens (entropy test — probabilistic, passes with overwhelming probability).
- `storePreviewToken(token, documentId, collection, cache)` calls `cache.set('preview:{token}', { documentId, collection }, { ttl: 3600 })`.
- `verifyPreviewToken(token, cache)` when the token exists in cache → returns `{ documentId, collection }`.
- `verifyPreviewToken(token, cache)` when the token does not exist (cache returns `null`) → returns `null`.
- Preview token TTL expiry: after 1 hour (simulated via fake timers on the memory provider), `verifyPreviewToken` returns `null`.
- `verifyPreviewToken` with a malformed token (not 64 hex chars) → returns `null` without calling `cache.get`.
- `verifyPreviewToken` with a valid-format token that contains non-hex chars (e.g., 64 chars of `z`) → returns `null` without calling `cache.get`.
- `revokePreviewToken(token, cache)` calls `cache.delete('preview:{token}')`.
- After `revokePreviewToken`, `verifyPreviewToken` returns `null`.
- `storePreviewToken` with TTL 3600 — the stored entry expires after 3600 seconds on the memory provider (fake timer verification).

**Verification:** All tests pass. `generatePreviewToken` output passes the 64-char hex format check. `verifyPreviewToken` handles all edge cases without throwing.

---

## System-Wide Impact

### Consumers of `@hono-cms/cache`

| Plan | Consumer | Usage |
|---|---|---|
| Plan 010 (core) | `createCMS` factory | Calls `createCacheAdapter(config.cache, env)` during request initialization; passes `CacheAdapter` to all subsystems |
| Plan 004 (auth middleware) | Session extraction middleware | Wraps `auth.api.getSession` with `withSessionCache`; calls `invalidateSessionCache` on logout |
| Plan 008 (content routes) | Content list/detail route handlers | Wraps handlers with `withContentCache`; calls `invalidateCollectionCache` on mutations |
| Plan 008 (content routes) | Preview token route (`POST /api/preview-tokens`) | Calls `generatePreviewToken` and `storePreviewToken` |
| Plan 004 (auth middleware) | Preview route middleware | Calls `verifyPreviewToken` to authorize preview requests |
| Plan 012 (webhook delivery) | Retry state management | Calls `cache.set('webhook-retry:{id}', retryState, { ttl: 86400 })` and `cache.delete` on success |

### Webhook retry state (not a separate implementation unit)

The webhook retry state (`webhook-retry:{deliveryId}`, 24h TTL) is used directly via the `CacheAdapter` interface by Plan 012 (webhooks). No wrapper function is needed — the caller uses `cache.set`/`cache.get`/`cache.delete` directly. The cache key format and TTL are documented here as the canonical reference; Plan 012 must follow them.

### Rate limiting via `checkRateLimit`

Rate limiting is applied to content mutation endpoints in Plan 010/012. The `checkRateLimit` call is made in a Hono middleware that runs before the mutation handler. The middleware reads the client IP from `c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown'` and calls `cache.checkRateLimit(ip, { limit: 100, window: '1 m' })`. For KV and memory providers, this returns `{ success: true }` unconditionally — rate limiting is only enforced when Upstash is the provider. The middleware emits the KV/memory warning on the first call per Worker instance (not on every request — use a module-scoped flag).

---

## Scope Boundaries

### In scope (this plan)
- All three provider implementations in `packages/cache/`
- The `CacheAdapter` interface and `CacheConfig` discriminated union
- The `createCacheAdapter` factory
- Session cache wrapping (`withSessionCache`, `invalidateSessionCache`)
- Content response caching (`withContentCache`, `invalidateCollectionCache`)
- Preview token storage and verification
- Provider-level unit tests for all behaviors

### Deferred to Follow-Up Work
- **Webhook retry state wrapper**: Plan 012 uses `CacheAdapter` directly; no wrapper is needed here.
- **Cache warming**: Pre-populating the cache on cold start with popular queries. Deferred — requires knowing query popularity, which requires analytics (post-v1).
- **Stale-while-revalidate (SWR)**: Serving stale content while revalidating in the background. The current model invalidates immediately. SWR is a future optimization.
- **Self-hosted Redis provider**: An adapter wrapping `ioredis` for teams with existing Redis. Deferred — Upstash covers all edge cases; self-hosted Redis is Node.js-only and can be added without changing the interface.
- **Cache bypass header** (`Cache-Control: no-cache` from client): Allowing clients to request uncached responses. A future feature for CDN-aware deployments.
- **Distributed rate limiting on Node.js without Upstash**: Using the Upstash provider with a self-hosted Upstash Serverless Redis (open-source) is the path — no separate adapter needed.

### Outside this package's scope
- The rate limit middleware wiring (which routes it applies to) — that is Plan 010/012.
- Session lifecycle management — that is Plan 004/006 (better-auth integration).
- Content mutation handlers that trigger `invalidateCollectionCache` — that is Plan 008/012.
- The `POST /api/preview-tokens` route handler — that is Plan 008.

---

## Risk Analysis

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Cache invalidation bug produces stale content after publish | Low (explicit design) | High (data correctness) | Test: mutation-then-read confirms cache miss after `invalidateCollectionCache`. Integration test in Plan 012. |
| Session served after logout due to cache TTL | Low (explicit delete on logout) | High (security) | Test: `invalidateSessionCache` + subsequent request is a miss. Document the 60s window for non-CMS-logout revocations. |
| KV eventual consistency causes stale session on logout | Medium (KV is eventual) | High (security) | Factory warns developers when KV is selected; session caching falls back to in-memory for KV provider. |
| SCAN-based `deletePattern` misses keys added during iteration | Low (Upstash SCAN is consistent-enough for cache invalidation) | Low (only affects cache, not DB) | Acceptable — next mutation re-invalidates. Document this in `upstash.ts` JSDoc. |
| Upstash HTTP latency exceeds session cache benefit | Low (sub-10ms from colocated PoP) | Medium (performance regression) | Measure: if P99 cache get > 20ms, reconsider TTL strategy. Memory provider in same-region Node.js may outperform. |
| `deletePattern` on Upstash with very large key sets (>10k keys) | Low (CMS collections rarely hit this scale) | Medium (slow invalidation) | Batch delete in chunks of 100 (already designed). Document a per-collection key limit recommendation. |
| Memory provider used accidentally in distributed production | Medium (easy misconfiguration) | High (inconsistent cache state) | Constructor warns on `NODE_ENV=production`. `createCacheAdapter` warns on KV selection. Docs reinforce. |
| Preview token entropy is insufficient | Very Low (256-bit entropy) | High (forged preview access) | 32 bytes = 2^256 space. Documented. No mitigation action needed. |

---

## Alternative Approaches Considered

### 1. Separate npm packages per provider (`@hono-cms/cache-upstash`, `@hono-cms/cache-kv`, etc.)

Rejected. The adapter packages pattern (from idea #1) applies to database adapters because each DB adapter has distinct runtime-only dependencies that should not be co-installed. A Cloudflare D1 adapter that imports `@cloudflare/workers-types` should not be installed on a Node.js deployment. Cache providers do not have this problem: `@upstash/redis/cloudflare` is an HTTP client that works everywhere, `@cloudflare/workers-types` is a `devDependency` only (the `KVNamespace` type is erased at runtime), and the memory provider has zero dependencies. All three can safely co-exist in one package. Separate packages add version coordination overhead with no structural benefit.

### 2. TTL-only cache expiry (no explicit invalidation on mutation)

Rejected. As documented in Key Technical Decision #4, TTL-only expiry produces a correctness window where published content is not served and unpublished content continues to be served. For a CMS, this is unacceptable. The explicit `invalidateCollectionCache` call on every mutation is two lines of code in the mutation handler — a trivial addition with no architectural complexity, eliminating the correctness window entirely.

### 3. Document-level cache invalidation instead of collection-level

Considered and rejected for v1. Document-level invalidation would be: `cache.delete('content:articles:{documentId}')` instead of `cache.deletePattern('content:articles:*')`. This is more precise — a mutation to one document only invalidates cached responses that include that document. However, implementing it correctly requires tracking which query results include which document IDs, which means either persisting a reverse index in the cache or accepting that some queries (list queries, filter queries) cannot be targeted. The implementation complexity is high for a v1. Collection-level invalidation is correct, simpler, and fast — the full collection rebuild under Upstash's sub-10ms GET takes under a second for typical CMS collection sizes.

### 4. Using `hono/cache` middleware instead of a custom `withContentCache`

Rejected. Hono's built-in cache middleware targets CDN/Cloudflare Cache rather than application-level cache stores. It does not integrate with the `CacheAdapter` interface, does not support cache invalidation on mutation, and does not handle ETag generation. A custom `withContentCache` is necessary for the CMS's collection-mutation invalidation requirement.

---

## Dependencies / Prerequisites

- **Plan 001 (monorepo foundation):** The `packages/cache/` scaffold, `tsdown.config.base.ts`, `vitest.shared.ts`, and `tsconfig.base.json` must exist. All tooling (tsdown, Vitest, oxlint, Bun) must be installed.
- **`@upstash/redis` and `@upstash/ratelimit`:** These are public npm packages. No credentials needed for installation; credentials are needed for integration tests against a live Upstash instance (integration tests are deferred — unit tests use mocks).
- **`@cloudflare/workers-types`:** For the `KVNamespace` type in `packages/cache/package.json` `devDependencies`.
- **No Plan 004/006/008/010 dependency:** This package has no imports from other `@hono-cms/*` packages — it is a leaf in the dependency graph. Consumer packages import from `@hono-cms/cache`, not the reverse.

---

## Deferred Implementation Notes

- The exact shape of how `env` flows from the Cloudflare Worker `fetch` handler into `createCacheAdapter` is a coordination point with Plan 010 (core). Two valid approaches: (a) the core calls `createCacheAdapter` inside the first request handler so `env` is available, (b) the core creates the adapter at module init time using explicit URL/token from the config. Approach (a) requires the factory to be idempotent (or lazily initialized once). This decision belongs in Plan 010.
- Vitest fake timers for the `MemoryCacheAdapter` cleanup interval — verify that `vi.useFakeTimers()` works with `setInterval` in the Bun + Vitest setup established in Plan 001. If there are compat issues, use `vi.runAllTimers()` or refactor cleanup to accept an injectable clock.
- Integration tests against a live Upstash instance and a live Cloudflare KV namespace are deferred. They belong in a dedicated E2E test stage (separate CI job) that runs against real Upstash/KV credentials. Unit tests suffice for development.
