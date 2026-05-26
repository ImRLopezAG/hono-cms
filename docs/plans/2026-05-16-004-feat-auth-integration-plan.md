---
title: "feat: Auth Integration — better-auth with CMS-Owned DB Config"
date: 2026-05-16
type: feat
status: active
depth: deep
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
ideation-ideas: ["#6 better-auth as Canonical Auth Integration"]
plan-series: "004 of 018"
---

# feat: Auth Integration — better-auth with CMS-Owned DB Config

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 2
**Research inputs used:** skill review, framework docs, security review, flow review

### Key Improvements

1. Tighten origin, cookie, and provider configuration requirements.
2. Define shared actor/auth-decision semantics earlier for downstream RBAC and audit work.
3. Surface missing mixed-auth and invitation flows that would otherwise be deferred to implementation.

## Summary

This plan wires [better-auth](https://better-auth.com) into `@hono-cms/core` as the canonical auth layer. The CMS owns the database config entirely — it creates the Drizzle adapter internally and shares the same connection with both content storage and auth storage. Developers declare auth capabilities through a nested `auth` key in `createCMS`; the CMS handles all internal wiring, route mounting, and session extraction. Auth tables live in the same migration journal as content tables. No pre-built auth instance is ever accepted.

This is a security-critical foundation. All seven units below must be implemented in order. Plan 006 (RBAC middleware) and Plan 009 (cache layer) depend on the session context variables and auth instance exposure defined here.

---

## Problem Frame

better-auth is a TypeScript-native auth library with Hono as a first-class backend integration and Drizzle as a first-class database adapter. Wiring it into `createCMS` requires four concerns to be solved correctly and in the right order:

1. **Type boundary** — What can the developer pass to the `auth` key, and what is the CMS responsible for injecting? The `database` option must be excluded from the public-facing type and injected internally from the `db` config. Everything else passes through.
2. **Factory correctness** — The `drizzleAdapter` call must use the correct provider string (`sqlite`, `pg`, `mysql`) derived from the `db.provider` discriminant. The email config from the top-level `email` key must be bridged into better-auth's `emailAndPassword` and plugin email sender configs.
3. **Route mounting completeness** — `GET` and `POST` cover the standard better-auth handler. `OPTIONS` must be handled for CORS preflight. The admin SPA (on a different origin in production) must be able to reach `/api/auth/*` endpoints.
4. **Session extraction correctness** — Every request must have `c.get('user')` and `c.get('session')` populated (or null). The Hono env type must reflect this so downstream handlers have type-safe access. Performance: this hits the DB on every request. Plan 009 adds Redis caching on top; this middleware is the foundation that Plan 009 replaces with a cache-aware version.

Auth tables and content tables live in the same database. The same Drizzle migration journal covers both. This is not an implementation convenience — it is a design decision that prevents the split-DB-config class of bugs.

---

## Key Technical Decisions

### KTD-1: CMS injects DB config — never accepts a pre-built auth instance

**Decision:** `createCMS` accepts `db: DatabaseConfig` and builds the Drizzle client internally. The same client is passed to better-auth via `drizzleAdapter`. The developer never constructs a `betterAuth({...})` instance outside `createCMS`.

**Rationale:** Accepting a pre-built better-auth instance would require the developer to configure the database twice — once for content, once for auth. These configs would inevitably drift. Two separate Drizzle instances pointed at the same DB create two connection pools, two migration surfaces, and two sources of truth for schema state. The CMS can only guarantee "single migration journal" if it also guarantees "single DB connection construction."

**Implications:** The `auth` key in `CMSConfig` explicitly omits `database`. TypeScript's `Omit<BetterAuthOptions, 'database'>` makes this a compile error if anyone tries to pass it. The internal `createAuth` factory accepts `DatabaseAdapter` (the CMS's internal type) as its second argument and calls `drizzleAdapter` internally.

### KTD-2: Auth tables live in the same DB as content tables

**Decision:** The better-auth schema (users, sessions, accounts, verifications, and all plugin tables) is included in the same Drizzle migration journal that covers content tables. `cms schema plan` diffs both when generating migration plans.

**Rationale:** A separate auth database creates a cross-DB join problem: RBAC checks (Plan 006) need to read both the user's role (from auth tables) and the collection's permission matrix (from content config). A single DB makes this a simple join. It also means a single `drizzle-kit generate` run produces a complete migration that covers the entire application state. There is no "auth migration" and "content migration" to sequence — there is one migration journal.

**Implications:** The `auth.api.generateSchema()` method (better-auth's built-in schema generation) must be called during the CLI's `schema plan` phase and its output merged into the Drizzle schema diff. Plugin tables appear automatically when plugins are registered.

### KTD-3: drizzleAdapter provider detection from db config discriminant

**Decision:** The `db.provider` field in `CMSConfig` is a discriminated union string literal: `'sqlite' | 'd1' | 'turso' | 'postgres' | 'mysql'`. The `createAuth` factory maps this to the `drizzleAdapter` provider string: `d1` and `turso` both map to `'sqlite'` (since D1 and Turso use the libSQL/SQLite dialect); `postgres` maps to `'pg'`; `mysql` maps to `'mysql2'`.

**Rationale:** better-auth's `drizzleAdapter` `provider` option accepts `'sqlite' | 'pg' | 'mysql2'`. The CMS's `db.provider` has more granularity (`d1`, `turso`) to distinguish connection mechanics, but the Drizzle dialect is the same for all SQLite-family providers. A static mapping function (`toAdapterProvider(provider: DBProvider): 'sqlite' | 'pg' | 'mysql2'`) handles this translation in one place and is the single point of update if a new provider is added.

### KTD-4: Session caching deferred to Plan 009 — middleware foundation runs on every request

**Decision:** The session extraction middleware calls `auth.api.getSession({ headers: c.req.raw.headers })` on every request with no caching at the Hono middleware level. Plan 009 (cache layer) replaces this with a Redis-backed version that hashes the session token and returns a cached session object on hit.

**Rationale:** Caching sessions at the middleware level before the cache layer is designed would embed cache-invalidation logic in two places. The session middleware is the correct abstraction level for "give me the session or null"; the cache layer is the correct abstraction for "give me the session or null, fast." Implementing both in one step creates a dependency on Plan 009's Redis config that does not yet exist. The middleware implemented here is the non-cached foundation that Plan 009 augments — the interface (`c.get('user')`, `c.get('session')`) does not change.

**Performance note:** For a CMS under moderate load, every authenticated request will incur one DB read for session lookup. This is acceptable for v1 and becomes the baseline for Plan 009's performance improvement.

### KTD-5: Social providers on edge runtimes — callback URL handling

**Decision:** Social provider OAuth callbacks (`/api/auth/callback/github`, `/api/auth/callback/google`) are standard `GET` routes handled by better-auth's built-in handler. The `trustedOrigins` option in the `auth` config covers the SPA origin for CORS. On Cloudflare Workers, the callback URL is the Worker's public URL (configured via `BETTER_AUTH_URL` or `baseURL` in the auth config). On Vercel Edge, it is the deployment URL. The developer is responsible for registering the correct callback URL with the OAuth provider — this is a configuration concern, not a CMS implementation concern.

**Edge runtime constraint:** OAuth callbacks require cookie-setting and redirects — both are standard `Response` capabilities available in all WinterTC-compliant runtimes. better-auth uses `Set-Cookie` headers and `302` redirects internally; no Node.js-specific APIs are used. This is confirmed behavior from better-auth's design as an edge-first library.

---

## Output Structure

```
packages/core/src/
├── auth/
│   ├── factory.ts           # createAuth() — internal better-auth factory (U2)
│   ├── middleware.ts        # sessionMiddleware() — session extraction (U4)
│   ├── plugins.ts           # plugin type re-exports and helpers (U7)
│   └── index.ts             # barrel export for auth/ submodule
├── types/
│   ├── config.ts            # CMSConfig, AuthConfig, and related types (U1)
│   ├── env.ts               # HonoEnv type extension for c.get('user') (U4)
│   └── index.ts             # barrel export for types/ submodule
└── create-cms.ts            # createCMS() — auth wiring + route mounting (U3, U5)

packages/core/src/schema/
└── auth-schema.ts           # generated auth schema integration point (U6)

packages/cli/src/commands/
└── schema/
    └── plan.ts              # cms schema plan — includes auth schema in diff (U6)
```

*This tree shows the expected output shape. The implementer may adjust the structure if implementation reveals a better layout. Per-unit `**Files:**` sections are authoritative for what each unit creates or modifies.*

---

## High-Level Technical Design

## Research Insights

**Best Practices:**
- Set `baseURL` explicitly and keep `trustedOrigins` as exact per-environment deployment config.
- Define a shared `ActorContext` and `AuthorizationDecision` shape before Plan 006 so RBAC, audit, and admin guards do not invent parallel semantics.
- Pin better-auth to a verified version before implementation because current docs and import paths vary by release.

**Security Considerations:**
- Validate at startup that `trustedOrigins` are exact origins only, HTTPS-only in production, and paired with an explicit post-login redirect allowlist.
- Hard-gate unsafe pass-through options such as disabling CSRF checks in production.
- Make baseline rate limits mandatory for sign-in, password reset, magic link, OTP, invitation accept, and 2FA verify.

**Edge Cases:**
- Define precedence when both bearer credentials and session cookies are present on the same request.
- Specify invite flows for expired, revoked, wrong-user, and already-claimed invitations because the admin plan depends on them.

*This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Bootstrap sequence in `createCMS`

```
createCMS(config)
  │
  ├─ 1. createDatabaseAdapter(config.db)
  │       → db.client (Drizzle instance)
  │       → db.provider ('sqlite' | 'd1' | 'turso' | 'postgres' | 'mysql')
  │
  ├─ 2. createEmailSender(config.email)
  │       → emailSender (better-auth SendEmailFn compatible)
  │
  ├─ 3. createAuth(config.auth, db, emailSender)
  │       → auth (BetterAuth instance, typed with configured plugins)
  │       Internally:
  │         drizzleAdapter(db.client, { provider: toAdapterProvider(db.provider) })
  │         betterAuth({ database: adapter, ...config.auth, emailAndPassword: { ... sendVerificationEmail, sendResetPassword } })
  │
  ├─ 4. app.on(['GET', 'POST', 'OPTIONS'], '/api/auth/**', auth.handler)
  │
  ├─ 5. app.use('*', sessionMiddleware(auth))
  │       → sets c.get('user') and c.get('session') on every request
  │
  ├─ 6. [content routes, graphql, cms/*, etc. — other plans]
  │
  └─ 7. return Object.assign(app, { auth, db }) as CMSInstance<TPlugins>
```

### Session extraction middleware flow

```
Request arrives
  │
  ├─ sessionMiddleware
  │     auth.api.getSession({ headers: c.req.raw.headers })
  │       ├─ Session found  → c.set('user', session.user)
  │       │                   c.set('session', session.session)
  │       └─ No session    → c.set('user', null)
  │                          c.set('session', null)
  │
  └─ next()  →  route handlers / RBAC middleware (Plan 006)
               c.get('user')    → BetterAuthUser | null
               c.get('session') → BetterAuthSession | null
```

### Plugin table accumulation (U6 concern)

```
cms schema plan
  │
  ├─ collect content schema   (from defineCollection files)
  ├─ collect auth base schema (users, sessions, accounts, verifications)
  │     auth.api.generateSchema() — better-auth built-in
  ├─ collect plugin schemas   (per registered plugin)
  │     organization() → organizations, members, invitations
  │     apiKey()       → apiKeys
  │     twoFactor()    → twoFactors
  │
  └─ drizzle-kit diff (all combined) vs. live DB state
       → human-readable migration plan output
```

---

## Implementation Units

### U1. AuthConfig Type Definition

**Goal:** Define the public-facing TypeScript type for the `auth` key in `CMSConfig`. Explicitly exclude the `database` option (always injected by CMS). Include all pass-through better-auth options. Establish the type file location.

**Requirements:** Every better-auth option that can be user-supplied must be representable. The `database` key must be absent from the type (compile-time enforcement, not runtime validation). Plugin types must be preserved so that `cms.auth` carries the correct generic plugin list downstream (see U5).

**Dependencies:** None (foundational type unit).

**Files:**
- `packages/core/src/types/config.ts` — create; add `AuthConfig` type alongside `CMSConfig`
- `packages/core/src/types/index.ts` — create; barrel export

**Approach:**

The `AuthConfig` type is derived from better-auth's `BetterAuthOptions` with two transformations:

1. **Omit `database`** — use `Omit<BetterAuthOptions, 'database'>`. This removes the database option entirely from the public API surface. TypeScript will produce a compile error if a consumer attempts to pass `database` in the `auth` object.

2. **Preserve plugin generics** — the `plugins` field must preserve the plugin array type so that the plugin list flows through to `BetterAuth<..., TPlugins>` at the factory (U2) and the `cms.auth` exposure (U5). The type should be `plugins?: BetterAuthPlugin[]` at the `AuthConfig` level, with the generic threading happening at the factory's call site. The `createCMS` function itself must be generic over the plugin array (`TPlugins extends BetterAuthPlugin[]`) so that `ReturnType<createCMS<TPlugins>>` carries the correct `BetterAuth` instance type.

Pass-through options to explicitly document in the type (these are already present in `BetterAuthOptions` — the documentation here is for plan clarity, not type invention):

- `plugins` — array of better-auth plugin instances
- `emailAndPassword` — `{ enabled, requireEmailVerification, sendVerificationEmail, sendResetPassword, minPasswordLength, maxPasswordLength }`
- `socialProviders` — `{ github, google, discord, twitter, ... }` (record of provider configs)
- `trustedOrigins` — `string[]` — origins the auth system trusts for CORS and CSRF
- `secret` — `string` — signing secret for sessions/JWTs (if not provided, better-auth looks for `BETTER_AUTH_SECRET` env var)
- `baseURL` — `string` — the canonical URL of the API server (required for OAuth callbacks, email links)
- `basePath` — `string` — defaults to `/api/auth`; CMS always sets this to `/api/auth` internally but the developer can override
- `session` — `{ expiresIn, updateAge, cookieCache }` — session lifetime configuration
- `account` — `{ accountLinking }` — account linking behavior
- `advanced` — `{ generateId, useSecureCookies, crossSubDomainCookies, disableCSRFCheck, cookiePrefix }`
- `rateLimit` — rate limiting config for auth endpoints
- `logger` — logging config / custom logger

**What is explicitly excluded from `AuthConfig`:**
- `database` — always injected by CMS from `config.db`
- `emailSender` — at the `betterAuth({})` top level; the CMS bridges `config.email` into this internally (see U2). The developer configures email via the top-level `email` key in `CMSConfig`, not inside `auth`.

The `CMSConfig` type gains the `auth?: AuthConfig` key. It is optional — if omitted, the CMS boots with no auth plugins and no emailAndPassword enabled (suitable for API-key-only or public-read deployments).

**Test scenarios:**
- TypeScript compile: passing `database` inside the `auth` object produces a type error
- TypeScript compile: passing `plugins: [organization(), apiKey()]` resolves without error and the plugin array type is preserved at the type level
- TypeScript compile: omitting `auth` entirely from `CMSConfig` does not error
- TypeScript compile: `auth.secret` is `string | undefined` (not required at type level; better-auth reads `BETTER_AUTH_SECRET` env var at runtime)
- TypeScript compile: `auth.emailAndPassword` does not include `sendVerificationEmail` — this is injected by the CMS from `config.email` (verify this field is omitted or overridden in the type or documented as CMS-injected)
- Unit: the type is correctly exported from `packages/core/src/types/index.ts`

**Verification:** `tsc --noEmit` passes on a `CMSConfig` object with a valid `auth` key. TypeScript IntelliSense in the consuming project shows only the allowed options under `auth: { ... }`, with `database` absent.

---

### U2. better-auth Factory Function

**Goal:** Implement `createAuth(config: AuthConfig | undefined, db: DatabaseAdapter, emailSender: EmailSender | null): BetterAuth` — the internal function that constructs the better-auth instance. Handles provider mapping, config merging, and email bridging.

**Requirements:**
- Map `db.provider` to the correct `drizzleAdapter` provider string
- Merge user-supplied auth config with CMS-injected database adapter
- Bridge the CMS email sender into better-auth's email sender config for `emailAndPassword` and plugin email flows
- Return a fully configured `BetterAuth` instance
- Be testable in isolation (not requiring a real DB connection)

**Dependencies:** U1 (AuthConfig type)

**Files:**
- `packages/core/src/auth/factory.ts` — create
- `packages/core/src/auth/index.ts` — create; barrel export
- `packages/core/src/auth/factory.test.ts` — create; unit tests

**Approach:**

**Provider mapping** — a pure function `toAdapterProvider(provider: DBProvider): 'sqlite' | 'pg' | 'mysql2'` maps the CMS db provider discriminant to the drizzleAdapter provider string:

```
'sqlite'   → 'sqlite'
'd1'       → 'sqlite'   (D1 uses libSQL/SQLite dialect)
'turso'    → 'sqlite'   (Turso uses libSQL)
'postgres' → 'pg'
'mysql'    → 'mysql2'
```

This mapping is the single point of maintenance for new provider additions. It is pure and unit-testable without any DB connection.

**Config merging** — the `betterAuth({...})` call receives:
- `database`: `drizzleAdapter(db.client, { provider: toAdapterProvider(db.provider) })` — always injected, never from user config
- `...config` — spread of the user-supplied `AuthConfig` (all pass-through options)
- `emailAndPassword`: merged object — user's `config.emailAndPassword` options merged with CMS-injected `sendVerificationEmail` and `sendResetPassword` functions derived from `emailSender`

The spread order matters: `database` is set first (cannot be overridden), then `...config` (user values), then specific CMS-injected overrides for email sender fields. The email sender functions are only injected when `emailSender` is non-null and `emailAndPassword.enabled` is true (or truthy by plugin presence).

**Email bridging** — the `emailSender` parameter (created by `createEmailSender(config.email)` upstream) has the CMS's internal email provider abstraction. It must be converted to the better-auth `sendEmail` function signature: `(options: { to: string, subject: string, body: string }) => Promise<void>`. The bridge is a simple adapter function wrapping the CMS email sender. Additionally:

- `emailAndPassword.sendVerificationEmail` receives `{ user, url, token }` from better-auth; the CMS bridge calls `emailSender.send({ to: user.email, subject: 'Verify your email', body: buildVerificationEmailBody(url) })`
- `emailAndPassword.sendResetPassword` receives `{ user, url, token }`; same pattern

If no `emailSender` is configured (provider is `console`), the bridge logs the email content to stdout with a clear `[CMS EMAIL DEV]` prefix — the developer can copy magic link URLs directly from terminal output. This prevents silent failures in dev when no email provider is configured.

**Plugin handling** — plugins are passed through as-is: `plugins: config?.plugins ?? []`. No plugin-specific logic lives in the factory — plugins self-register their schemas and routes with better-auth internally. The factory's job is to pass the plugin array and let better-auth handle plugin initialization.

**`baseURL` injection** — if `config.baseURL` is not set, the factory does not supply a default (better-auth reads `BETTER_AUTH_URL` from env). If it is set in the auth config, it is passed through. The CMS does not attempt to detect the base URL automatically — this is a runtime deployment concern.

**Test scenarios:**
- Unit: `toAdapterProvider('sqlite')` returns `'sqlite'`
- Unit: `toAdapterProvider('d1')` returns `'sqlite'`
- Unit: `toAdapterProvider('turso')` returns `'sqlite'`
- Unit: `toAdapterProvider('postgres')` returns `'pg'`
- Unit: `toAdapterProvider('mysql')` returns `'mysql2'`
- Unit: `createAuth(undefined, db, null)` does not throw; returns a BetterAuth instance with no plugins
- Unit: `createAuth({ plugins: [mockPlugin] }, db, null)` passes the plugin through to the betterAuth call
- Unit: with `emailSender` configured, `emailAndPassword.sendVerificationEmail` is present in the betterAuth config
- Unit: with `emailSender: null`, the console logger is used; calling the send function logs to stdout rather than throwing
- Unit: user-supplied `emailAndPassword.minPasswordLength` is preserved in the merged config
- Unit: user-supplied `database` key (if somehow present despite type exclusion) is overridden by the CMS-injected adapter (defense in depth)
- Integration: with a real in-memory SQLite Drizzle client, `createAuth` produces an auth instance that can call `auth.api.getSession` without crashing

**Verification:** All unit tests pass. `createAuth` can be called with a minimal config (no plugins, no email, SQLite db) and return a usable auth instance. TypeScript: `createAuth` return type is `BetterAuth`.

---

### U3. Auth Route Mounting

**Goal:** Mount the better-auth request handler on `GET`, `POST`, `OPTIONS`, and `HEAD` HTTP methods at the `/api/auth/**` path pattern inside `createCMS`. Handle CORS preflight for the admin SPA when it is on a different origin.

**Requirements:**
- `GET /api/auth/**` and `POST /api/auth/**` must be routed to `auth.handler(c.req.raw)`
- `OPTIONS /api/auth/**` must return correct CORS preflight headers when the request origin is in `trustedOrigins`
- `HEAD /api/auth/**` must be handled (some HTTP clients check endpoint existence via HEAD)
- Auth routes must be mounted before session middleware to avoid session lookup on auth requests themselves (optimization, not correctness requirement)
- The admin SPA (deployed to a different origin in production) must be able to call auth endpoints via `fetch` from the browser

**Dependencies:** U2 (auth instance available)

**Files:**
- `packages/core/src/create-cms.ts` — modify; add auth route mounting section
- `packages/core/src/auth/middleware.ts` — create; will also house `mountAuthRoutes` helper
- `packages/core/src/auth/middleware.test.ts` — create; integration tests for route mounting

**Approach:**

**Route mounting** — better-auth's Hono integration exposes `auth.handler` which is already a `(req: Request) => Promise<Response>` function. The Hono `app.on` method accepts a method array and a path pattern:

```
app.on(['GET', 'POST', 'OPTIONS', 'HEAD'], '/api/auth/**', (c) => auth.handler(c.req.raw))
```

The `**` glob matches any sub-path. better-auth's handler routes internally based on the request URL path — it will process `/api/auth/sign-in/email`, `/api/auth/sign-up/email`, `/api/auth/callback/github`, etc. The CMS does not need to know about specific better-auth endpoint paths.

**CORS for the admin SPA** — better-auth has built-in CORS handling when `trustedOrigins` is set. The CMS does not need to add a separate Hono CORS middleware for `/api/auth/**` — better-auth handles it in `auth.handler`. However, the CMS must ensure that `trustedOrigins` from `config.auth.trustedOrigins` is passed through to the betterAuth call (this happens naturally via the config spread in U2).

When the admin SPA origin (e.g., `https://admin.myapp.com`) is included in `trustedOrigins`, better-auth will:
1. Set `Access-Control-Allow-Origin: https://admin.myapp.com` on auth responses
2. Handle `OPTIONS` preflight for `POST /api/auth/sign-in/email` with correct `Access-Control-Allow-Methods` and `Access-Control-Allow-Headers`
3. Set `Access-Control-Allow-Credentials: true` for cookie-bearing requests

**`HEAD` handling** — `HEAD /api/auth/sign-in/email` should return the same headers as `GET` with no body. Passing `HEAD` to `auth.handler` is safe — better-auth's handler will return a `Response` with the correct headers; the Hono runtime strips the body for `HEAD` responses automatically.

**Ordering constraint** — auth routes must be mounted before the session middleware (U4). The session middleware calls `auth.api.getSession` on every request including auth requests. On a `POST /api/auth/sign-in/email` request, the session cookie may not exist yet (user is signing in). The `getSession` call returns null, which is correct. However, mounting auth routes first and session middleware second ensures the ordering is explicit and documented for future maintainers.

**Dev-mode consideration** — better-auth exposes `/api/auth/` (note trailing slash) as a discovery endpoint listing all registered endpoints. This is available in development and can be disabled via `advanced.disableCSRFCheck` or by not exposing the path. The CMS does not suppress this — it is useful during development.

**Test scenarios:**
- Integration: `POST /api/auth/sign-in/email` with valid credentials returns `200` with a session cookie
- Integration: `POST /api/auth/sign-up/email` creates a user and returns `200`
- Integration: `GET /api/auth/session` with a valid session cookie returns the session object
- Integration: `GET /api/auth/session` with no cookie returns `{ session: null, user: null }`
- Integration: `OPTIONS /api/auth/sign-in/email` with `Origin: https://admin.myapp.com` and that origin in `trustedOrigins` returns `200` with `Access-Control-Allow-Origin: https://admin.myapp.com`
- Integration: `OPTIONS /api/auth/sign-in/email` with `Origin: https://evil.com` and that origin NOT in `trustedOrigins` does not return CORS allow headers for that origin
- Integration: `HEAD /api/auth/session` returns `200` with headers, no body
- Integration: `GET /api/auth/callback/github` with a valid OAuth code redirects to the configured redirect URL (requires mock OAuth provider)
- Edge case: `DELETE /api/auth/sign-out` — verify better-auth handles this method correctly on sign-out (or that the sign-out path is `POST`)
- Edge case: A request to `/api/auth/nonexistent-path` returns `404` from better-auth, not a Hono 404

**Verification:** All HTTP methods used by the admin SPA to reach better-auth endpoints return correct responses. CORS headers are present for requests from trusted origins. Requests from untrusted origins do not receive CORS allow headers.

---

### U4. Session Extraction Middleware

**Goal:** Implement the Hono middleware that runs on every request, calls `auth.api.getSession()`, and sets `user` and `session` variables in the Hono context. Define the `HonoEnv` type extension so that `c.get('user')` and `c.get('session')` are correctly typed throughout the application.

**Requirements:**
- Runs on every request (`app.use('*', ...)`)
- Sets `c.get('user')` to `BetterAuthUser | null`
- Sets `c.get('session')` to `BetterAuthSession | null`
- Never throws — `getSession` failure (network error, DB error) must not crash the request; log and treat as unauthenticated
- `HonoEnv` type must be exported and used as the generic parameter for all Hono instances within `@hono-cms/core`
- Plan 006 (RBAC) reads from these context variables — the type contract here is the interface Plan 006 depends on

**Dependencies:** U2 (auth instance), U3 (route mounting — session middleware registered after auth routes)

**Files:**
- `packages/core/src/auth/middleware.ts` — add `sessionMiddleware` function
- `packages/core/src/types/env.ts` — create; `HonoEnv` type definition
- `packages/core/src/types/index.ts` — re-export `HonoEnv`
- `packages/core/src/auth/middleware.test.ts` — add session middleware test scenarios

**Approach:**

**HonoEnv type** — Hono's context typing uses a generic `Env` parameter with a `Variables` key for values stored via `c.set()` / `c.get()`:

```
// packages/core/src/types/env.ts  — directional sketch, not implementation code
type CMSVariables = {
  user: BetterAuthUser | null       // from better-auth, null if unauthenticated
  session: BetterAuthSession | null // from better-auth, null if unauthenticated
  // Plan 006 will add: role, permissions, organizationId
}

type CMSEnv = {
  Variables: CMSVariables
  // Bindings (Cloudflare env bindings) are not typed here — that is the host app's concern
}
```

All Hono instances in `@hono-cms/core` use `new Hono<CMSEnv>()`. The `CMSEnv` type is exported as `HonoEnv` for external consumers who mount `cms.fetch` inside an existing Hono app.

**Session middleware implementation** — the middleware function receives the auth instance via closure (factory function pattern, not a global):

```
// Directional pseudocode — not implementation specification
function sessionMiddleware(auth: BetterAuth) {
  return async (c: Context<CMSEnv>, next: Next) => {
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers })
      c.set('user', session?.user ?? null)
      c.set('session', session?.session ?? null)
    } catch (err) {
      // Log the error but do not propagate — treat as unauthenticated
      // This handles DB timeouts, connection errors, malformed session tokens
      console.error('[CMS] Session extraction failed:', err)
      c.set('user', null)
      c.set('session', null)
    }
    await next()
  }
}
```

**Why catch and continue:** If `getSession` throws (DB timeout, connection error, malformed cookie), crashing the entire request is a worse outcome than treating the request as unauthenticated. The RBAC middleware (Plan 006) will deny access to protected resources for null users, so security is preserved. The error is logged for observability.

**Performance characteristics** (documented for Plan 009 implementer):
- Every authenticated request incurs one DB read: a SELECT on the sessions table keyed by the session token from the cookie/header
- For a CMS with 100 req/s, this is 100 session DB reads/second at steady state
- Plan 009 replaces `auth.api.getSession` with a Redis-cached wrapper that reduces this to one DB read per cache miss (expected: 1 miss per 30-second TTL window per active user)
- The interface (`c.get('user')`, `c.get('session')`) does not change when Plan 009 upgrades the implementation

**Registration in `createCMS`** — the session middleware is registered after auth routes but before all content routes:
```
// createCMS bootstrap order (directional)
1. mountAuthRoutes(app, auth)      // U3
2. app.use('*', sessionMiddleware(auth))  // U4 — runs on every request after auth routes are matched
3. [content routes, Plan 005+]
```

**Test scenarios:**
- Unit: middleware with a valid session cookie calls `c.set('user', user)` and `c.set('session', session)` with non-null values
- Unit: middleware with no cookie calls `c.set('user', null)` and `c.set('session', null)` without throwing
- Unit: middleware with an expired session token (better-auth returns null) sets both to null
- Unit: middleware with a malformed/tampered session cookie — better-auth throws; middleware catches, logs, and sets both to null
- Unit: `auth.api.getSession` throws a DB connection error — middleware catches, logs, sets both to null, does NOT propagate the error, request continues to next middleware
- Integration: `c.get('user')` in a downstream route handler returns the correct user object after authentication
- Integration: `c.get('session')` in a downstream route handler returns the session with correct `expiresAt`
- TypeScript: `c.get('user')` in a handler typed with `CMSEnv` resolves to `BetterAuthUser | null` without a type cast
- TypeScript: `c.get('nonexistent')` in a handler typed with `CMSEnv` produces a type error
- Edge case: two concurrent requests with different valid sessions each see their own user in context (no cross-request contamination — Hono context is per-request, this should be guaranteed by Hono's design but worth verifying)

**Verification:** Session middleware is registered in the correct position in `createCMS`. `c.get('user')` returns the authenticated user on protected routes. `c.get('user')` returns null on unauthenticated requests. Type errors are caught at compile time, not runtime.

---

### U5. `cms.auth` Exposure via `Object.assign`

**Goal:** Return the `createCMS` function's result as a Hono app extended with `auth` and `db` properties via `Object.assign`. Thread TypeScript generics so that `cms.auth` has the correct `BetterAuth<..., TPlugins>` type with the configured plugins visible to consumers. Document usage patterns for custom routes that need direct auth access.

**Requirements:**
- `createCMS` returns `Hono<CMSEnv> & { auth: BetterAuth<TPlugins>; db: DrizzleInstance }`
- TypeScript generic threading preserves the plugin list type from the input `auth.plugins` to the `cms.auth` return type
- `cms.auth` is the live better-auth instance — not a copy, not a facade
- `cms.db` is the Drizzle client instance — the same one used by better-auth internally
- The return type must be explicit (TypeScript cannot infer `Object.assign` generics correctly without explicit annotation)

**Dependencies:** U1 (AuthConfig), U2 (createAuth), U3 (route mounting), U4 (session middleware)

**Files:**
- `packages/core/src/create-cms.ts` — primary file; `createCMS` function and `CMSInstance` return type
- `packages/core/src/types/config.ts` — add `CMSInstance<TPlugins>` type
- `packages/core/src/types/index.ts` — export `CMSInstance`

**Approach:**

**Return type** — `CMSInstance<TPlugins extends BetterAuthPlugin[]>` is defined as:

```
// Directional type sketch — not implementation specification
type CMSInstance<TPlugins extends BetterAuthPlugin[]> =
  Hono<CMSEnv> & {
    auth: BetterAuth<{ plugins: TPlugins }>
    db: DrizzleInstance
  }
```

**Generic threading in `createCMS`** — the function signature captures the plugin list type:

```
// Directional sketch
function createCMS<TPlugins extends BetterAuthPlugin[]>(
  config: CMSConfig<TPlugins>
): CMSInstance<TPlugins>
```

Where `CMSConfig<TPlugins>` has `auth?: AuthConfig<TPlugins>` with `plugins?: TPlugins`.

The `Object.assign` call that produces the return value:

```
// Directional sketch — not implementation specification
return Object.assign(app, { auth, db }) as CMSInstance<TPlugins>
```

The `as CMSInstance<TPlugins>` cast is necessary because TypeScript cannot infer that `Object.assign(Hono, { auth, db })` produces the union type correctly without the explicit annotation.

**Usage patterns for custom routes** — the plan documents these for implementers and consumers:

*Custom route using `cms.auth` directly (for operations outside the generated content API):*
```
// Custom route — auth instance accessed directly
app.get('/me', async (c) => {
  // c.get('user') is available via session middleware — prefer this
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  return c.json({ user })
})

// Direct auth API access — for operations not covered by session middleware
cms.route('/admin/sessions', adminApp)  // adminApp uses cms.auth.api internally
```

*Custom route using `cms.db` directly:*
```
// Direct DB query outside the CMS content API
const latest = await cms.db.select().from(articles).orderBy(desc(articles.createdAt)).limit(1)
```

*Type narrowing for plugin-specific auth operations:*
```
// If organization() plugin is configured, cms.auth.api.organization is available
// TypeScript knows this because TPlugins carries the plugin list
const org = await cms.auth.api.organization.getOrganization({ headers })
```

**Test scenarios:**
- TypeScript: `cms.auth` resolves to `BetterAuth` without requiring a type cast at the call site
- TypeScript: with `plugins: [organization()]`, `cms.auth.api.organization` is accessible and typed
- TypeScript: without `organization()` in plugins, `cms.auth.api.organization` does not exist (type error)
- TypeScript: `cms.db` is typed as the Drizzle instance for the configured provider
- TypeScript: `cms.use(...)` and `cms.route(...)` work without error — `cms` is a full Hono instance
- Unit: `typeof cms.fetch === 'function'` — verifies WinterTC compliance
- Unit: `cms.auth === auth` — the exposed auth instance is the same object used internally (referential equality)
- Unit: `cms.db === db.client` — same DB instance used internally
- Integration: a custom route added via `cms.route('/custom', router)` after `createCMS` returns can call `c.get('user')` and receive the session-populated user

**Verification:** `tsc --noEmit` passes on a consuming project that uses `cms.auth.api`, `cms.db`, and `cms.use()`. Plugin-specific APIs are accessible on `cms.auth` when the corresponding plugins are configured.

---

### U6. Auth Schema Migration Integration

**Goal:** Integrate better-auth's table schema (base tables: users, sessions, accounts, verifications; plugin tables: organizations, members, invitations, apiKeys, twoFactors, etc.) into the CMS migration journal. Ensure `cms schema plan` includes auth schema in migration diffs alongside content schema.

**Requirements:**
- `auth.api.generateSchema()` output must be merged with content schema before `drizzle-kit` diff
- Plugin tables appear automatically in the schema when the corresponding plugins are configured
- `cms schema plan` output is a single unified diff — no separate "auth migration" and "content migration"
- `cms schema check --assert-clean` in CI covers auth tables as well as content tables
- Adding a new better-auth plugin (e.g., adding `organization()` to an existing deployment) produces a correct migration diff that adds only the new tables, not re-creates existing ones

**Dependencies:** U1 (AuthConfig — plugin list drives which tables are generated), U2 (auth instance — `auth.api.generateSchema()` requires a live auth instance)

**Files:**
- `packages/core/src/schema/auth-schema.ts` — create; integration point for better-auth schema generation
- `packages/cli/src/commands/schema/plan.ts` — modify; include auth schema in diff computation
- `packages/cli/src/commands/schema/check.ts` — modify; include auth schema in assert-clean
- `packages/core/src/schema/auth-schema.test.ts` — create; tests for schema generation

**Approach:**

**Schema generation** — better-auth's `auth.api.generateSchema()` returns a set of Drizzle table definitions (the exact return shape depends on the better-auth version; treat it as `Record<string, DrizzleTable>`). These definitions are Drizzle-native — they can be passed directly to `drizzle-kit` as part of the schema input.

The `auth-schema.ts` module exports a function `getAuthSchema(auth: BetterAuth): Record<string, DrizzleTable>` that calls `auth.api.generateSchema()` and returns the result. This thin wrapper exists to allow mocking in tests and to provide a single import point for the CLI.

**CLI integration** — the `cms schema plan` command currently (conceptually — this is a greenfield repo) will:
1. Import `createCMS` with the project's config
2. Call `getAuthSchema(cms.auth)` to get auth table definitions
3. Merge auth tables with content tables into a single Drizzle schema object
4. Run `drizzle-kit generate` (or the equivalent programmatic API) against the merged schema
5. Output the migration plan in human-readable format

The merge must handle name collisions gracefully — if a content type is named `users` (conflicting with better-auth's `user` table), a clear error must be raised at schema plan time, not at runtime.

**Idempotency guarantee** — running `cms schema plan` twice on the same DB state must produce identical output. The `auth.api.generateSchema()` output is deterministic — same plugin list → same table definitions.

**Plugin table lifecycle** — when a plugin is added to an existing deployment:
1. Developer adds `organization()` to `auth.plugins` in config
2. `cms schema plan` detects new tables (`organizations`, `members`, `invitations`) not present in the live DB
3. Plan output shows: "Add table: organizations, members, invitations"
4. Developer reviews and runs `cms schema apply`
5. Tables are created; the plugin is now functional

When a plugin is removed: the reverse migration (dropping tables) is NOT automatic. `cms schema plan` warns that tables exist in the DB that are no longer in the schema and asks the developer to confirm removal. This prevents accidental data loss when a plugin is temporarily removed from config.

**Test scenarios:**
- Unit: `getAuthSchema(auth)` with no plugins returns the base set of tables: `user`, `session`, `account`, `verification`
- Unit: `getAuthSchema(auth)` with `organization()` plugin returns base tables plus `organization`, `member`, `invitation`
- Unit: `getAuthSchema(auth)` with `apiKey()` plugin returns base tables plus `apiKey`
- Unit: `getAuthSchema(auth)` with `twoFactor()` plugin returns base tables plus `twoFactor`
- Unit: `getAuthSchema` output is deterministic — calling it twice with the same auth instance returns identical table definitions
- Integration: `cms schema plan` on an empty DB includes all configured auth tables in the "create" output
- Integration: `cms schema plan` on a DB that already has the base auth tables but not the organization plugin tables outputs only the missing organization tables
- Integration: `cms schema check --assert-clean` on a DB that matches the configured schema exits with code 0
- Integration: `cms schema check --assert-clean` on a DB missing the `apiKey` table exits with non-zero code and an error message identifying the missing table
- Edge case: content type named `users` (conflicting with better-auth's `user` table) — `cms schema plan` outputs a clear error: "Schema conflict: content type 'users' conflicts with better-auth's reserved table name 'user'. Rename the content type."
- Edge case: removing `organization()` from plugins — `cms schema plan` warns about orphaned tables rather than generating a silent drop migration

**Verification:** A fresh `cms schema plan` on an empty DB produces a migration that, when applied, creates all better-auth base tables plus all plugin-configured tables. `cms schema check --assert-clean` passes after applying the migration. Adding a plugin and re-running `cms schema plan` adds only the new plugin tables.

---

### U7. Plugin-Specific Requirements

**Goal:** Document and implement the CMS-side requirements for the three most commonly used better-auth plugins in v1: Organization, API Key, and Two-Factor. Ensure plugin tables are correctly generated (covered by U6), session context is enriched with plugin-specific data where relevant, and edge cases (TOTP setup flow, API key scoping, org membership in session) are handled correctly.

**Requirements:**
- Organization plugin: org membership is available in session context for RBAC (Plan 006)
- API Key plugin: API key auth works via `Authorization: Bearer <key>` header in addition to cookie session
- Two-factor plugin: TOTP setup and verification flows function correctly; partial sessions (2FA required but not completed) are handled correctly

**Dependencies:** U1 (types), U2 (factory — plugins passed through), U4 (session middleware — reads enriched session), U6 (plugin tables in migration)

**Files:**
- `packages/core/src/auth/plugins.ts` — create; plugin-specific helpers and type re-exports
- `packages/core/src/auth/plugins.test.ts` — create; plugin-specific integration tests
- `packages/core/src/auth/middleware.ts` — modify; handle plugin-enriched session data

**Approach:**

#### Organization Plugin

The `organization()` plugin adds `organizations`, `members`, and `invitations` tables and enriches the better-auth session object with the active organization's membership data.

**Session context enrichment** — when the organization plugin is active, `auth.api.getSession()` returns a session object that includes the user's active organization membership (if the `activeOrganizationId` cookie is set). The session middleware (U4) should forward this enrichment to the Hono context:

```
// When organization() plugin is active, session.session may include:
//   activeOrganizationId: string | null
//   activeOrganizationRole: 'owner' | 'admin' | 'member' | custom
```

Plan 006 (RBAC) reads `activeOrganizationRole` from `c.get('session')` to evaluate collection permissions against organization-scoped roles.

**Invitation flow** — invitations are sent via better-auth's organization API (`auth.api.organization.inviteMember`). The email sender configured in U2 is used for invitation emails. No CMS-specific logic is needed — the plugin handles the invitation flow internally.

**Multi-org membership** — a user can be a member of multiple organizations. The active organization is set via a cookie managed by better-auth. The admin SPA is responsible for org-switching UI (calling `auth.api.organization.setActiveOrganization`). The CMS does not need to handle org-switching logic.

#### API Key Plugin

The `apiKey()` plugin adds the `apiKey` table and enables machine-to-machine (M2M) authentication via `Authorization: Bearer <api-key>` header.

**How it integrates with session middleware** — when an API key is present in the `Authorization: Bearer` header, `auth.api.getSession()` with that header populates the session with the API key owner's user and a synthetic session object. The session middleware (U4) works identically for API key auth and cookie-based auth — no changes needed to the middleware. The `c.get('user')` variable is populated with the API key owner's user object.

**Key behavior** — API keys are created by users via better-auth's API key API (`auth.api.apiKey.create`). The admin SPA exposes key management UI. Keys can have optional expiration dates and scopes. The CMS does not define scopes — scope definition and enforcement is the consuming application's responsibility (beyond what better-auth provides).

**Security note** — API key values are only returned once at creation time. They are stored as hashed values in the `apiKey` table. If a key is lost, it must be rotated (delete and create new). The session middleware surfaces the key owner's user, but not the raw key value — this is better-auth's built-in security behavior.

#### Two-Factor Plugin

The `twoFactor()` plugin adds the `twoFactor` table (stores TOTP secret + backup codes per user) and adds 2FA verification to the sign-in flow.

**Partial session handling** — when a user completes the first factor (password) but has not yet completed 2FA, better-auth returns a `twoFactorRequired` status rather than a full session. The session middleware receives this from `getSession` — the user is not yet authenticated. The admin SPA must detect this state and redirect to the 2FA verification page.

**How the CMS detects the partial session** — better-auth's `getSession` response when 2FA is required: the session object is null and the response includes a `twoFactorRequired: true` indicator (exact shape depends on better-auth version; implementer should check the better-auth docs for the current API). The session middleware should pass this through to a `c.set('twoFactorRequired', true)` variable for downstream handlers to inspect. This extends `CMSVariables` in `HonoEnv` with `twoFactorRequired: boolean`.

**TOTP setup flow** — 2FA enrollment is handled by better-auth's built-in endpoints (`/api/auth/two-factor/enable`, `/api/auth/two-factor/verify-totp`). The admin SPA renders the TOTP setup UI (QR code display, backup codes). No CMS-specific logic is needed for the setup flow.

**Backup codes** — better-auth generates backup codes on TOTP enable. These are one-time use. The admin SPA must surface a "view backup codes" flow at setup time and warn users to save them. The CMS does not store or manage backup codes beyond what better-auth provides.

**Test scenarios — Organization plugin:**
- Integration: user who is a member of an organization has `activeOrganizationId` and `activeOrganizationRole` available in `c.get('session')` after setting the active org
- Integration: user with no organization membership has `activeOrganizationId: null` in session
- Integration: sending an org invitation calls the configured email sender with an invitation email
- Integration: `POST /api/auth/organization/invite-member` with valid org admin session succeeds
- Integration: `POST /api/auth/organization/invite-member` with non-admin session returns 403
- Edge case: user is member of two orgs — switching active org updates `activeOrganizationId` in session cookie; subsequent requests reflect the new active org
- Edge case: org is deleted while user has it set as active org — `getSession` returns null active org; session middleware sets `activeOrganizationId: null`

**Test scenarios — API Key plugin:**
- Integration: `Authorization: Bearer <valid-key>` header in a request to a protected route → `c.get('user')` is the key owner
- Integration: `Authorization: Bearer <expired-key>` → `c.get('user')` is null, request treated as unauthenticated
- Integration: `Authorization: Bearer <invalid-key>` → `c.get('user')` is null
- Integration: `Authorization: Bearer <valid-key>` and a session cookie present simultaneously → better-auth behavior defines precedence (implementer: verify which takes priority and document it)
- Edge case: API key for a user whose account has been disabled → `c.get('user')` is null; key does not grant access

**Test scenarios — Two-factor plugin:**
- Integration: sign-in with email+password when 2FA is enabled → `getSession` indicates 2FA required; `c.get('user')` is null; `c.get('twoFactorRequired')` is true
- Integration: sign-in with email+password when 2FA is NOT enabled → full session returned; `c.get('user')` is populated
- Integration: TOTP verification with valid code after first factor → full session returned
- Integration: TOTP verification with invalid code → error response; session not created
- Integration: TOTP verification with valid backup code → full session returned; backup code is consumed (cannot be reused)
- Integration: TOTP verification with expired valid code (code was valid 35 seconds ago, outside the 30s window) → error response
- Edge case: user loses 2FA device and has no backup codes — account recovery flow (better-auth's reset mechanism or admin override via Admin plugin)

**Verification:** Each plugin's core flows function correctly in integration tests using an in-memory SQLite Drizzle client. Session context variables reflect plugin-enriched data where applicable. Plugin table schema is generated correctly by `cms schema plan` when each plugin is configured.

---

## Scope Boundaries

### In Scope

- `AuthConfig` TypeScript type and `CMSConfig.auth` integration
- `createAuth` factory: drizzleAdapter provider mapping, config merging, email bridging
- Auth route mounting at `/api/auth/**` with CORS and all HTTP methods
- Session extraction middleware: `c.get('user')`, `c.get('session')`, error handling
- `CMSInstance` return type and `Object.assign` exposure of `cms.auth` and `cms.db`
- Auth schema integration into `cms schema plan` and `cms schema check`
- Organization, API Key, and Two-Factor plugin-specific requirements

### Deferred to Follow-Up Work

- **Plan 006** — RBAC middleware: reads `c.get('user')` and `c.get('session')` established here; evaluates collection permissions
- **Plan 009** — Cache layer: Redis-backed session caching; replaces the `auth.api.getSession` call inside the session middleware with a cache-aware version; interface (`c.get('user')`, `c.get('session')`) is unchanged
- **Admin SPA auth pages** — Login, register, 2FA setup, org management, API key management UI; the admin SPA (Plan 005) owns these; they call the `/api/auth/**` endpoints established here
- **OIDC Provider, SSO, SCIM** — enterprise plugins; supported by the plugin pass-through mechanism but not specifically implemented or tested in this plan
- **Stripe/Polar payment plugins** — payment integrations; same pass-through support as enterprise plugins
- **Magic Link, Email OTP, Anonymous auth plugins** — core plugins that work via the email sender bridge established in U2; not specifically integration-tested in this plan but architecturally supported
- **Passkeys** — requires WebAuthn; edge-runtime support depends on runtime capabilities; deferred
- **MCP plugin (AI agent access)** — supported by plugin pass-through; implementation details deferred to a plugin-specific plan
- **Admin UI for user management** — viewing users, disabling accounts, resetting 2FA — admin SPA concern
- **Rate limiting on auth endpoints** — can be configured via `auth.rateLimit` in `AuthConfig`; specific rate limit values and Redis-backed distributed limiting are Plan 009 concerns
- **Session invalidation on logout across devices** — better-auth handles this internally; the admin SPA triggers logout via `DELETE /api/auth/sign-out`; no CMS-specific implementation needed beyond the route mount

### Outside This Feature's Identity

- Replacing better-auth with a different auth library — this plan bets on better-auth as the canonical auth integration. Pluggable auth backends are explicitly not a design goal.
- Accepting a pre-built `betterAuth()` instance in `createCMS` — see KTD-1.
- Building auth UI pages inside `@hono-cms/core` — the CMS ships zero auth UI. All auth pages live in the admin SPA.
- Fine-grained content-level authorization (e.g., "user can only edit their own posts") — this is not a better-auth concern and is not an `auth` key concern; it is expressed via `filter` predicates in `defineCollection` permissions (Plan 006).

---

## Risk Analysis

### R1: better-auth API shape changes between versions

**Risk:** better-auth is actively developed. The `auth.api.generateSchema()` method, the `getSession` return shape, and plugin API surfaces may change in minor versions.

**Mitigation:** Pin `better-auth` to an exact version in `packages/core/package.json` (no `^` or `~`). Upgrade intentionally with a full integration test run. The `getAuthSchema` wrapper (U6) and `sessionMiddleware` (U4) are the only two places the CMS touches better-auth's internal API — isolating the surface area for upgrades.

### R2: Plugin table naming conflicts with content types

**Risk:** A developer creates a content type named `users`, `sessions`, or `accounts`, which conflicts with better-auth's reserved table names.

**Mitigation:** `cms schema plan` raises a hard error before generating any migration when a content type name matches a reserved better-auth table name. The reserved name list is exported from `packages/core/src/schema/auth-schema.ts` and used at content type definition time (so the error appears at config load, not only at migration time).

### R3: Session middleware DB overhead under load

**Risk:** The session middleware calls the DB on every request. Under high load (1000+ req/s), this becomes the primary DB bottleneck before Plan 009 is implemented.

**Mitigation:** This is documented as a known limitation of the Plan 004 implementation. Plan 009 explicitly addresses it. Deployers who need high throughput before Plan 009 is complete can configure `cache: { provider: 'memory' }` as a temporary measure (in-process cache, not distributed) or reduce session TTL to increase cache-to-DB ratio. The session middleware code includes a comment pointing to Plan 009 as the upgrade path.

### R4: OAuth callback URL mismatch in different environments

**Risk:** Social providers (GitHub, Google) require the callback URL to be registered in the OAuth app settings. A developer who deploys to multiple environments (dev, staging, prod) must register multiple callback URLs. Misconfiguration produces a cryptic OAuth error.

**Mitigation:** The CMS logs a startup warning if `auth.socialProviders` is configured but `auth.baseURL` is not set (relying on env var). The error message in the warning includes the expected callback URL format (`{baseURL}/api/auth/callback/{provider}`) so the developer knows exactly what to register. This is a configuration concern, not an implementation bug.

### R5: Cookie security on HTTP in development

**Risk:** better-auth's session cookies use `Secure` flag by default (required for `SameSite=None` CORS cookies). In local development over HTTP, this breaks cookie setting.

**Mitigation:** better-auth's `advanced.useSecureCookies` option defaults to `false` when the URL scheme is `http://`. The CMS passes `baseURL` through from config, and better-auth handles the Secure flag detection automatically. No CMS-level workaround is needed — this is built-in behavior. However, the CMS dev startup logs should print a reminder: "Auth cookies: Secure flag is disabled in development (HTTP). Enable HTTPS in production."

### R6: 2FA partial session creating misleading unauthenticated behavior

**Risk:** A user who has enabled 2FA completes password auth and expects to be logged in. The session middleware sets `c.get('user') === null` because the session is partial. If a route handler checks for null user, it returns 401 — which is technically correct but may be confusing (the user expects to be logged in after entering their password).

**Mitigation:** The `c.get('twoFactorRequired')` context variable (U7) gives the admin SPA and custom route handlers the ability to distinguish between "not logged in" and "2FA required." The admin SPA must handle this state and redirect to the 2FA entry page rather than the login page. This is documented in the session middleware as a behavioral note.

---

## Dependencies and Sequencing

```
U1 (AuthConfig types)
  └─► U2 (factory function)
        └─► U3 (route mounting) ──────────────────────┐
        └─► U4 (session middleware) ──────────────────┤
              └─► U5 (cms.auth exposure) ◄────────────┘
U1 + U2
  └─► U6 (schema migration integration)
U2 + U4 + U6
  └─► U7 (plugin-specific requirements)
```

All units are linear within their chain. U3 and U4 can be implemented in parallel once U2 is complete. U5 requires U3 and U4 to be complete (the `createCMS` function must have auth routes mounted and session middleware registered before it can be returned). U6 requires U1 and U2 (needs the auth instance to call `generateSchema`). U7 requires U2, U4, and U6 (plugin flows need the factory, session enrichment, and table schema all in place).

---

## Deferred Implementation Notes

These are knowable questions that require touching real code to answer. Do not pre-resolve in this plan.

- **Exact better-auth version to pin** — check `npm info better-auth` at implementation time for the current stable version. Review the changelog for any breaking changes in the `drizzleAdapter` or `getSession` API since the ideation doc was written (2026-05-15).
- **`auth.api.generateSchema()` exact return shape** — the better-auth docs describe this method; the exact TypeScript return type depends on the installed version. The `getAuthSchema` wrapper should be typed against the installed version's types, not assumed.
- **Plugin table name casing** — better-auth uses camelCase for table names internally (`apiKey`, `twoFactor`) but Drizzle may generate snake_case column names. Verify actual table and column names from `auth.api.generateSchema()` before building the reserved-name conflict check in `cms schema plan`.
- **`twoFactorRequired` signal exact API** — verify whether better-auth's `getSession` throws, returns null, or returns a specific shape when 2FA is required. The `c.set('twoFactorRequired', true)` approach in U7 is directional; the actual implementation depends on the better-auth API.
- **Drizzle provider string for D1** — verify that `drizzleAdapter(client, { provider: 'sqlite' })` works correctly with a Cloudflare D1 binding. D1 is accessed via Workers binding (not a URL), and the Drizzle D1 adapter (`drizzle(env.DB)`) produces a different client type than `drizzle(new Database(url))`. The `createDatabaseAdapter` (Plan 003) handles this distinction; verify the output is compatible with `drizzleAdapter`.

---

## References

- Origin ideation: `docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md` (Idea #6)
- Related plans:
  - Plan 003: Database Adapter Layer (`@hono-cms/adapter-*`) — `db.client` produced here is the input to `createAuth` in U2
  - Plan 005: Admin SPA (TanStack + Jotai) — auth UI pages call `/api/auth/**` endpoints mounted in U3
  - Plan 006: Schema-Level RBAC — reads `c.get('user')` and `c.get('session')` from U4
  - Plan 009: Cache Layer — Redis-backed session caching replaces the `auth.api.getSession` call in U4
- External docs:
  - better-auth Hono integration: https://www.better-auth.com/docs/integrations/hono
  - better-auth Drizzle adapter: https://www.better-auth.com/docs/adapters/drizzle
  - better-auth organization plugin: https://www.better-auth.com/docs/plugins/organization
  - better-auth API key plugin: https://www.better-auth.com/docs/plugins/api-key
  - better-auth two-factor plugin: https://www.better-auth.com/docs/plugins/two-factor
  - better-auth schema generation: https://www.better-auth.com/docs/concepts/database#generating-the-schema
