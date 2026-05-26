# ADR 0001 — Plugin Manifest Architecture (Better Auth shape, Hono runtime)

- **Status:** Accepted
- **Date:** 2026-05-25
- **Supersedes:** `docs/plans/2026-05-16-002-feat-core-library-plan.md` §U3
  ("The registry pattern must be the sole coupling point").
- **Sources:** `docs/handoff/2026-05-25-plugin-refactor-handoff.md`,
  `docs/plans/2026-05-25-001-refactor-plugin-system-architecture-plan.md`.

## Context

Through Plan 002–017 (2026-05-16 series), `@hono-cms/core`'s `create-cms.ts`
accumulated every cross-cutting concern: CORS, OpenAPI, GraphQL, audit,
webhooks, i18n, media, jobs, preview, content-type builder, draft/publish,
rate-limit, content-cache. The file grew to **2,553 lines**. Adapter packages
(`adapter-postgres`, `storage-s3`, `cache`, `jobs`, …) registered themselves
via `registerProvider("kind", "name", factory)` at module top-level — a side
effect at import time. The existing `CMSPlugin = (app, ctx) => app | void`
was a thin Hono-route hook and nothing more (no schema extension, no hooks,
no rate-limit declarations, no `onRequest`/`onResponse`, no service-registry
communication, no dependency declarations).

Three concrete pains motivated the change:

1. **Workers/Edge regressions.** `MemoryCacheAdapter`'s constructor ran
   `setInterval(...)`, which broke when `packages/cache` was imported from a
   Cloudflare Workers entrypoint (see `docs/cross-runtime/cloudflare-worker.md`
   lines 55–60). The fix landed, but the module-load side-effect pattern
   keeps the class of bug alive: any future adapter that does global work at
   import time will hit the same wall.

2. **No first-class extension surface.** Every new feature shipped as code
   directly in `create-cms.ts`. There was no atomic-commit-sized extension
   API, no third-party plugin story, no way to add behaviour without
   modifying core.

3. **Two parallel extension mechanisms** (the weak `CMSPlugin` function +
   the `registerProvider` registry) competed for the same problem. New
   features ignored both and went directly into the monolith.

## Decision

Replace the side-effect registry + monolithic `create-cms.ts` with a
**declarative plugin manifest** modelled on Better Auth's `BetterAuthPlugin`
interface, adapted from `better-call` to Hono. Cross-cutting features become
independently versioned packages following one contract:

```ts
type Plugin = {
  id: string;
  requires?: readonly string[];
  schema?: SchemaExtension;
  app?: (app, ctx) => Hono | void;
  hooks?: { before?, after? };
  middlewares?: Array<{ path, middleware }>;
  onRequest?:  (req, ctx) => ...;
  onResponse?: (res, ctx) => ...;
  rateLimit?:  Array<...>;
  trustedOrigins?: readonly string[];
  installAuthorize?: (ctx) => Authorize;
  capabilities?: CMSPluginCapabilities;
  mountPhase?: "early" | "normal" | "catchAll";
};

type AuthPlugin = Plugin & {
  protected: MiddlewareHandler;
  identity?: (req, ctx) => Identity | null;
};
```

`createCMS({ plugins: [...] })` replaces the discrete config slots (`auth:`,
`cors:`, `openapi:`, `graphql:`, `cache:`, `jobs:`, `auditLog:`, `webhooks:`,
`i18n:`, `contentTypeBuilder:`, `organizationStore:`, …). Exactly one
`AuthPlugin` is allowed; at most one plugin may declare
`mountPhase: "catchAll"`; install order is explicit (array order, with
`requires: [...]` validated).

Adapter packages migrate from `registerProvider(...)` side-effects to named
factory exports:

```ts
// Before
import "@hono-cms/adapter-postgres";  // registerProvider side effect
createCMS({ db: { provider: "postgres", connectionString: ... } });

// After
import { postgresAdapter } from "@hono-cms/adapter-postgres";
createCMS({ db: postgresAdapter({ connectionString: ... }), plugins: [...] });
```

### Mirror divergences (acknowledged)

The manifest matches Better Auth field-for-field where the field carries
real meaning, with three intentional divergences:

1. **`endpoints` becomes `app(app, ctx)`** — Better Auth's `createAuthEndpoint`
   (a Better Call wrapper) attaches input/output Zod schemas to each
   endpoint, enabling `createAuthClient` codegen. We replace it with raw
   Hono registration. **Trade-off:** loses typed client generation; the
   admin SPA continues with hand-rolled fetch + manually-typed responses.
   Acceptable because (a) `createAuthClient` is out of scope for v1 and
   (b) a future client SDK can layer over OpenAPI.

2. **Service registry typing is `as`-cast.** `ctx.plugins.get<T>(id)`
   requires the caller to supply `T`. Better Auth uses TypeScript module
   augmentation; we accept the looser typing for v1 and reserve the right
   to tighten it via `declare module "@hono-cms/core" { interface
   CMSPluginServices { cache: CacheAdapter } }` in a follow-up.

3. **Identity opacity is a contract, not a runtime guard.** TypeScript
   marks `ctx.var.identity` as written-by-AuthPlugin-only via convention.
   A plugin that defies this can still call `ctx.set("identity", ...)`. We
   rely on the "exactly one AuthPlugin + auth runs in `early` phase" rule
   to ensure auth always writes first.

### Cache, not adapter

`cache` is promoted from `CMSConfig.cache: CacheAdapter | ProviderConfig`
to a plugin. Rationale: cache is consumed exclusively by HTTP-layer
middleware (`rate-limit`, `content-cache`, `preview`). It is never read by
core's content REST handlers directly. Forcing three plugins to reach it
via a separate `ctx.adapters.cache` DI path would create two parallel
mechanisms for the same problem.

If a future feature wants collection-level cache hints that core itself
reads (e.g. `defineCollection({ cache: { ttl: "5m" } })`), cache moves
back to an adapter slot. Today this is hypothetical.

### Bootstrap key delivery

When `@hono-cms/auth-tokens` boots empty, it writes one root-scoped key to
`<cwd>/.cms-bootstrap-key` (mode `0o600`, banner-prefixed). Serverless
fallback: read `env.CMS_BOOTSTRAP_KEY`. Callback escape hatch:
`onBootstrapKey(key) => void`. Three delivery paths because file, env, and
secret-manager are the three real deployment shapes; one user has already
asked for each.

## Consequences

**Positive:**

- One mental model for users, mirroring Better Auth.
- One extension surface for third parties — clean separation between
  kernel and plugins.
- Adapter packages become tree-shakeable; no module-load work.
- The fast-handler rule (R17) keeps mutation responses snappy even under
  webhook fanout.
- The `requires: []` graph + array-order install makes plugin failures
  debuggable in a way topological sort would obscure.

**Negative / costs:**

- One-time **breaking change**: every consumer rewrites their `createCMS`
  call. The CHANGELOG calls out the breaking-change migration steps.
- The plugin contract surface is larger than the old `CMSPlugin`
  function — more to learn for plugin authors. Mitigated by Better Auth's
  doc surface being well-known.
- Service registry `as`-cast typing is looser than module-augmented
  typing. Acceptable for v1, tightenable later.
- Identity opacity is enforced by convention, not by the type system. The
  "exactly one AuthPlugin in `early` phase" rule makes this safe in
  practice.

## Alternatives considered

### A1 — Topological sort on `requires`

`createCMS` could accept an unordered `plugins: [...]` array and sort it by
the `requires` graph. **Rejected** because:

- Cycle and missing-dep errors against a sort algorithm are harder to
  debug than against array position.
- Array order is also useful for non-dep reasons (visual auditing of
  install sequence).
- The user explicitly preferred explicit ordering when this was discussed
  during planning.

### A2 — Single `createPlugin` factory with `kind: "auth" | "regular"`

One factory, one type, one runtime check. **Rejected** because the user
asked for two factories so the type system distinguishes "any plugin"
from "the auth plugin", and so `createAuthPlugin(...)` reads as "the
thing that produces an identity" at the call site.

### A3 — Cache stays as a direct adapter

Keep `CMSConfig.cache: CacheAdapter`; plugins read via
`ctx.adapters.cache`. **Rejected** — creates two parallel DI paths for
cross-cutting middleware vs. content code; cache is consumed only by HTTP
middleware in practice. (Revisit if collection-level cache hints land.)

### A4 — One atomic carve (all 12 plugins in one PR)

**Rejected.** The smoke-test phase (U9: `cors`) catches plugin-runtime
bugs at minimal cost. Atomic carve pays for the first runtime bug across
every plugin.

## References

- Plan: `docs/plans/2026-05-25-001-refactor-plugin-system-architecture-plan.md`
- Handoff: `docs/handoff/2026-05-25-plugin-refactor-handoff.md`
- Better Auth plugin reference: `docs/handoff/plugin-structure.md`
- Tiny-auth source: `.references/tiny-auth/{service,schema,table}.ts`
- Workers regression history: `docs/cross-runtime/cloudflare-worker.md`
  lines 55–60.
- Plan being superseded: `docs/plans/2026-05-16-002-feat-core-library-plan.md`
  §U3 lines 445–488.
