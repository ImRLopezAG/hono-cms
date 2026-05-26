# Handoff — Hono CMS: Move from Direct Adapters to Plugin System

## Context

Workspace: `/Users/imrlopez/dev/monorepo/cms`
Project: Hono CMS (production-grade OSS CMS library, ~100% implemented at feature level)
Author intent: Before completing the implementation, refactor the architecture from *direct adapters + side-effect provider registry* into a **Better Auth–style declarative plugin system**, while doing a major scope cut on what the CMS owns.

Reference docs the user has been working from:
- `docs/handoff/plugin-structure.md` — Better Auth plugin docs the user pasted as the reference shape
- `.references/tiny-auth/{service,schema,table}.ts` — the minimal API-key/token service the user wants as the default built-in
- `docs/plans/2026-05-16-*` — existing feature plans (already implemented)
- `docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md`
- Memory: `~/.claude/projects/-Users-imrlopez-dev-monorepo-cms/memory/MEMORY.md` (gap analysis from 2026-05-22 audit)

Current code touchpoints already inspected:
- `packages/core/src/create-cms.ts` (2,553 lines — the monolith to split)
- `packages/core/src/plugins.ts` (existing weak `CMSPlugin` shape — function over Hono app)
- `packages/core/src/providers/{registry,factories}.ts` (current side-effect `registerProvider` model)
- `packages/core/src/types/{config,providers,instance}.ts`
- `packages/adapter-kit/src/index.ts`
- `packages/adapter-memory/src/index.ts` (representative adapter pattern)

## Decisions reached (already grilled and locked in)

### Architecture direction
- **Move from**: side-effect `registerProvider("db", "postgres", factory)` at import time + `db: DatabaseAdapter | ProviderConfig` dichotomy + a weak `CMSPlugin = (app, ctx) => app` shape.
- **Move to**: Better Auth–style declarative plugin manifests passed via `plugins: [...]`.

### What stays as direct adapter vs. becomes plugin
- **Adapters (stay direct, stateful service interfaces core depends on)**: `DatabaseAdapter`, `StorageAdapter`, `MediaStore`. These are *implementations of contracts core owns*.
- **Plugins (manifest-style, installed via `plugins: []`)**: everything cross-cutting that touches HTTP/middleware — cache, jobs, cors, openapi, graphql, audit, webhooks, i18n, preview, content-type-builder, draft/publish, rate-limit, content-cache, media routes.

### Scope cut (DELETED, not "moved to plugin")
- **Organization model**: `OrganizationStore`, `MemoryOrganizationStore`, `/cms/settings/organization/*` (8 routes), invitations, members → **all deleted from core**. The CMS is for entity management, not identity/orgs.
- **`BuiltInAuthConfig`**: `static-token` + `api-key` provider variants → deleted.
- **`createBetterAuth` / `createBetterAuthAdapter` / `core/src/auth/better-auth.ts`** → deleted from core. Core no longer depends on `better-auth` package at all.

### Auth model
- Auth is a **plugin**, not config — lives in `plugins: []` array.
- Two factories: `createPlugin(...)` (generic) and `createAuthPlugin(...)` (specialized).
- Identity is **opaque to core**. No `session.roles: string[]` baked in. Strapi-style **public vs protected routes** is the only authentication concept core ships.
- `createAuthPlugin` shape (sketch):
  ```ts
  createAuthPlugin({
    id: "...",
    app?: (app) => app,           // mount routes (sign-in, callbacks, /api/auth/*)
    protected: async (c, next) => { /* set identity, return 401 if absent, await next() */ },
    identity?: (c) => Promise<Identity | null>,
  })
  ```
- **Important**: in the user's first sketch, `next()` was called before the session check — that's inverted. Correct order: resolve identity → 401 if absent → policy check → `await next()`.
- Third-party auth (better-auth, Clerk, Auth.js, mTLS, JWT-from-gateway, …) = user writes their own auth plugin that adapts the provider into this contract. Optional `opts.rolePolicy: (c, { action, collection }) => boolean | Promise<boolean>` callback for authorization.

### Authorization (two-step pipeline)
1. Auth plugin's `protected` middleware: gates "is there an identity?" (yes/no) — sets `ctx.var.identity`.
2. Content/route handlers call `ctx.var.authorize(action, collection, resource?)` for granular (action × collection × optional record) checks. The policy plugin installs `authorize` onto context.
- Signature:
  ```ts
  type Authorize = (
    action: "read" | "create" | "update" | "delete" | "publish" | string,
    collection: string | null,
    resource?: ContentRecord | null
  ) => boolean | Promise<boolean>;
  ```

### Built-in default: `@hono-cms/auth-tokens`
- Ported from `tiny-auth` shape: hashed tokens, namespaces, expiry, idle timeout, revocation, refresh, encrypted-key vault.
- Owns **two internal tables** (not CMS collections): `api_keys` AND `roles`.
- Roles table shape (Strapi-style):
  ```ts
  {
    name: string;
    description?: string;
    permissions: { [collection: string]: { [action: string]: boolean } }
  }
  ```
- Mounts `/api/api-keys/*` CRUD and `/api/roles/*` CRUD.
- **Bootstrap key on first run**: when key table is empty, generate one root-scoped key and write it to a **file at the project root** (e.g. `./.cms-bootstrap-key`). Printed-via-file, not stdout, not env var.
- The starter templates pre-wire this plugin. Users who bring their own auth replace it entirely.

### Kernel scope (what stays in core)
After refactor, `packages/core` keeps only:
- Plugin runtime: `createCMS`, `createPlugin`, `createAuthPlugin`, manifest types, lifecycle ordering, plugin DI context, schema-merging across plugins
- Adapter interface types: `DatabaseAdapter`, `StorageAdapter`, `CacheAdapter`, `JobsAdapter` (types only)
- Schema types (already in `@hono-cms/schema`)
- **Minimal content REST surface**: `GET/POST/PUT/DELETE /api/<collection>` + `GET /api/<collection>/:id` (list + CRUD)
- Health endpoints (`/cms/health`, `/cms/health/live`, `/cms/health/ready`)
- The `protected` + `authorize` glue wired around content routes

Target: `create-cms.ts` shrinks from 2,553 lines to ~200 (kernel-only).

### Migration table — what becomes its own plugin

| Today (in `create-cms.ts`) | Becomes |
|---|---|
| `/cms/content-types/*` + `SchemaWriter` + hot-route registration | `@hono-cms/content-type-builder` |
| `/cms/audit-log` + audit writes on every mutation | `@hono-cms/audit` |
| `/cms/settings/webhooks/*` (7 routes) + dispatch + retry sweep + cleanup job | `@hono-cms/webhooks` |
| `/cms/admin/i18n/*` + translation jobs + locale fallback + translation store | `@hono-cms/i18n` |
| `/api/preview-tokens/*` + preview token verification | `@hono-cms/preview` |
| `/api/media/*` (8 routes) + presign + confirm + folder store | `@hono-cms/media` |
| `/cms/jobs/*` + dispatch + verification + scheduled-publish + cache-sweep | `@hono-cms/jobs-runtime` |
| `/graphql` + SDL + Apollo handler + GraphQL context | `@hono-cms/graphql` |
| `/openapi.json` + docs page + spec merging | `@hono-cms/openapi` |
| CORS middleware | `@hono-cms/cors` (or just user-installed Hono CORS) |
| Rate-limit middleware (uses cache adapter) | `@hono-cms/rate-limit` |
| Content cache (uses cache adapter) | `@hono-cms/content-cache` |
| Draft/publish state machine + scheduled-publish + unpublish | `@hono-cms/drafts` |
| api-keys + roles + bootstrap | `@hono-cms/auth-tokens` (the default auth plugin) |
| Better Auth glue | `@hono-cms/auth-better-auth` (optional, user-installed) |
| Organizations | **DELETED** |

### Plugin manifest shape (Better Auth-style, adapted for Hono)
```ts
type Plugin = {
  id: string;                          // unique
  requires?: readonly string[];        // plugin ids this one depends on
  app?: (app: Hono, ctx: PluginContext) => Hono | void;
  schema?: SchemaExtension;            // internal tables the plugin owns (with disableMigration option)
  hooks?: {
    before?: Array<{ matcher: (ctx) => boolean; handler: MiddlewareHandler }>;
    after?:  Array<{ matcher: (ctx) => boolean; handler: MiddlewareHandler }>;
  };
  middlewares?: Array<{ path: string | RegExp; middleware: MiddlewareHandler }>;
  onRequest?:  (req, ctx) => Response | Request | void;
  onResponse?: (res, ctx) => Response | void;
  rateLimit?:  Array<{ pathMatcher: (path) => boolean; limit: number; window: number }>;
  trustedOrigins?: readonly string[];
  // Optional: install authorize() onto context (policy plugins do this)
  installAuthorize?: (ctx: PluginContext) => Authorize;
};
```

### Plugin lifecycle
- **Explicit-order**: `plugins: [...]` array order is install order. Plugins declare `requires: ["cache"]`; `createCMS` throws if order/presence is wrong. No magical topological sort.
- **Plugin → plugin DI**: typed service registry — `ctx.plugins.get("cache")` returns the installed cache plugin's interface. Standard event bus + service registry pattern for hooks like `audit` reacting to `content:after-create`.

## Open question (not yet resolved — user just approved direction in last message)

Q7 part (a/b/c) — **already implicitly approved by the user's last reply ("sounds great for me")**:
- (a) Massive `create-cms.ts` → plugins migration: **YES**
- (b) Content REST stays in core (not its own plugin): **YES (implied — was the recommendation)**
- (c) Explicit-order with `requires: []` declarations: **YES (implied)**

So all major architectural decisions are pinned. The next step is producing an implementation plan.

## Things to verify before/during planning

1. **Hono's `OpenAPIHono`** is currently the app type in `create-cms.ts:64`. If `openapi` becomes a plugin, decide whether kernel uses `OpenAPIHono` always (so plugins can register routes that get auto-documented) or whether the openapi plugin upgrades the app type. Probably keep `OpenAPIHono` in kernel as the chosen Hono variant.
2. **Hot-route registration** (`create-cms.ts:154`, `:198`, `:241`) currently relies on `TrieRouter` sub-app + `db.ensureCollection?.()` + `rebuildGraphQLHandler` + `refreshOpenAPISpec`. The content-type-builder plugin must trigger these rebuilds across plugins via the hook/event bus — needs to be designed.
3. **GraphQL session bridging** (`create-cms.ts:284`) uses `graphQLSessionRef: WeakMap<Request, AuthSession | null>` to thread the per-request session into Apollo's per-request context. If `auth` and `graphql` are separate plugins, this bridge has to be expressed through the plugin DI (probably `ctx.plugins.get("auth").identity(req)`).
4. **Adapter capability declarations** (`AdapterCapabilities` in `@hono-cms/schema`) — plugins that need adapter features (e.g. `cache` needs `cache.health`, `jobs` needs `dispatch`) should still validate via the existing `validatePluginCapabilities` mechanism in `plugins.ts:55` — that gets carried forward into the new system.
5. **Existing memory of known P1 gaps** (`memory/project_gap_analysis.md`) — make sure the plugin refactor doesn't regress any out-of-the-box capability the gap analysis flagged.
6. **No `CONTEXT.md` / `docs/adr/` exist yet** — this refactor introduces enough load-bearing new vocabulary (Plugin, AuthPlugin, Identity, Authorize, Policy, internal table vs collection, kernel scope) that `CONTEXT.md` and at least one ADR ("Why we moved from direct adapters to manifest plugins") should be created.

## What the next session is for

Run `compound-engineering:ce-plan` to produce a **right-sized, deepenable implementation plan** for this refactor. The plan should cover:

1. **Phase 0** — Foundation: define `Plugin`, `AuthPlugin`, `PluginContext`, `Authorize` types in `@hono-cms/core`. Build the lifecycle runtime (`requires`-validated, ordered install). Schema-merging contract for internal tables.
2. **Phase 1** — Auth: build `@hono-cms/auth-tokens` (port tiny-auth: api_keys table, roles table, bootstrap-key-to-file, `/api/api-keys` + `/api/roles` CRUD). Replace `auth:` config slot with `plugins: []`.
3. **Phase 2** — Carve plugins out of `create-cms.ts` one at a time, in dependency order:
   - `@hono-cms/cors`, `@hono-cms/openapi` (no deps)
   - `@hono-cms/cache` (adapter — note cache is somewhat hybrid; verify direct vs plugin)
   - `@hono-cms/rate-limit`, `@hono-cms/content-cache`, `@hono-cms/preview` (depend on cache)
   - `@hono-cms/jobs-runtime`
   - `@hono-cms/audit`, `@hono-cms/webhooks` (hook into mutations)
   - `@hono-cms/i18n`
   - `@hono-cms/media`
   - `@hono-cms/drafts`
   - `@hono-cms/graphql`
   - `@hono-cms/content-type-builder`
4. **Phase 3** — Delete: `OrganizationStore` + routes, `BuiltInAuthConfig`, `core/src/auth/better-auth.ts`, the `registerProvider` registry side-effect model.
5. **Phase 4** — Migrate adapter packages from `registerProvider(...)` side-effect to explicit factory exports (e.g. `import { postgresAdapter } from "@hono-cms/adapter-postgres"; createCMS({ db: postgresAdapter({...}) })`).
6. **Phase 5** — Update `examples/newsroom` and starter templates to the new plugin shape. Update `CLAUDE.md` references. Write `CONTEXT.md` + ADR.
7. **Phase 6** — Verify against `memory/project_gap_analysis.md` P1 list; no regressions in admin panel.

Each phase should include a feasibility check on the open `create-cms.ts` concerns (hot-route registration, GraphQL session bridging, OpenAPIHono variant choice).

## Suggested skills for the next session

In order of when to invoke them:

1. **`compound-engineering:ce-plan`** — primary task. Generate the structured plan from this handoff. The user explicitly requested this.
2. **`compound-engineering:ce-doc-review`** — after the initial plan, run persona-based review (architecture, scope-guardian, feasibility, coherence) since this is a high-stakes refactor touching every package.
3. **`grill-with-docs`** — if the plan exposes unresolved sub-decisions; the current session already ran this and pinned the architectural decisions but the implementation plan may surface new ones (plugin schema-merging strategy, capability-validation surface, hot-reload semantics).
4. **`compound-engineering:ce-architecture-strategist`** (via Agent tool) — for pattern compliance review once the plan structure is concrete.

## Conversation tone calibration

User profile (from memory + this session):
- Senior full-stack engineer, deep TypeScript/Hono/React/SQL knowledge
- Building production-grade OSS — wants pure, principled abstractions, not pragmatic shortcuts
- Pushes back hard when recommendations don't match intent (rejected `tokensAuth({...})` import sugar; rejected role-coupled session shape; rejected stdout bootstrap-key in favor of file)
- Communicates in rough English; prefers concrete code sketches over abstract discussion
- Wants the *minimum-viable principled* design — not feature-gated complexity
- Decisions made via Q&A grilling work well; one-question-at-a-time format suits them
