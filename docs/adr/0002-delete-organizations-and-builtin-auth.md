# ADR 0002 — Delete Organizations, Built-in Auth, and Better-Auth Glue from Core

- **Status:** Accepted (deletion sequenced for U23 after Phase 6 plugin carves land)
- **Date:** 2026-05-25
- **Sources:** `docs/handoff/2026-05-25-plugin-refactor-handoff.md`,
  `docs/plans/2026-05-25-001-refactor-plugin-system-architecture-plan.md` §U23.

## Context

`@hono-cms/core` ships with several surfaces that exceed the CMS's stated
identity ("entity management"):

- `OrganizationStore` interface, `MemoryOrganizationStore`,
  `packages/core/src/organization.ts`, and 8 routes under
  `/cms/settings/organization/*` for invitations, members, and org CRUD.
- `BuiltInAuthConfig` — a discriminated config slot accepting either a
  `static-token` or `api-key` provider, with the api-key implementation
  living in `packages/core/src/auth/api-key.ts` and the static-token one
  in `static-token.ts`.
- `createBetterAuth` and `createBetterAuthAdapter` in
  `packages/core/src/auth/better-auth.ts`. Core directly imports the
  `better-auth` package.
- `AuthSession = { userId, roles, email? }` hard-coded into core, with
  RBAC checks via `rbac.rules: [{ action, collection, roles }]` baked
  into config.

These surfaces drift the CMS toward identity management. Two consumers in
practice have asked for richer auth (one uses Clerk, one runs better-auth
with extra plugins) and both have had to fight the built-in shape.

## Decision

Delete all three surfaces from core. No deprecation period, no compat
shim. The replacements live in plugins:

- **Organizations: outright deletion.** Not moved to a plugin. If a
  consumer needs orgs, their AuthPlugin produces an identity carrying
  org context and they ship their own admin views. The CMS does not own
  identity.
- **`BuiltInAuthConfig` (api-key, static-token):** superseded by
  `@hono-cms/auth-tokens` plugin (the default plugin in the starter
  template). Same hashed-token semantics ported from `.references/tiny-auth`
  with a richer feature set (namespaces, expiry, idle timeout,
  refresh, revoke, encrypted-key vault).
- **`createBetterAuth` and `createBetterAuthAdapter`:** deleted from core.
  Core's `dependencies` drop `better-auth`. Users who want better-auth
  install `@hono-cms/auth-better-auth` (a future package — out of scope
  for the current refactor but unblocked).

The identity shape `AuthSession = { userId, roles }` is replaced by an
opaque `Identity = unknown` from core's perspective. Each auth plugin
produces its own shape; policy plugins (`installAuthorize`) are written
paired with the auth plugin and may read the specific shape.

Per-route authorization migrates from `config.rbac.rules: [...]` to
`ctx.var.authorize(action, collection, resource?)`. The default
`@hono-cms/auth-tokens` plugin ships its own `installAuthorize` reading a
Strapi-style `roles` table.

## Consequences

**Positive:**

- Core's `dependencies` drop `better-auth` and its transitive deps.
- Core no longer owns identity — clear scope boundary that future
  features can be evaluated against.
- The "exactly one AuthPlugin" rule replaces a discriminated config
  union; the runtime check is one line and produces a clear error
  message.
- Bundle size of `@hono-cms/core/dist` shrinks measurably.

**Negative:**

- Existing consumers using `auth: { tokens: {...} }`, `auth: { provider:
  "api-key" }`, or `auth: { provider: "better-auth" }` must rewrite their
  `createCMS` call. The CHANGELOG covers the migration.
- Existing consumers using `organizationStore: ...` lose that feature
  entirely. The admin Settings views for organizations 404 during the
  transition window until the admin SPA migration ships.
- Existing consumers using `rbac.rules: [...]` rewrite to install a
  policy via the auth plugin (or write their own
  `installAuthorize`).

## Deletion targets (from `packages/core/src/`)

```
audit.ts                # absorbed into @hono-cms/audit (U16)
audit/                  # absorbed into @hono-cms/audit (U16)
auth/                   # ENTIRE directory deleted (U23)
  api-key.ts            #   → @hono-cms/auth-tokens (U7)
  static-token.ts       #   → deleted, no replacement
  better-auth.ts        #   → @hono-cms/auth-better-auth (future)
  schema.ts             #   → @hono-cms/auth-tokens/tables (U7)
  types.ts              #   → deleted; AuthSession also goes
  index.ts              #   → deleted
auth.ts                 # re-export shim deleted (U23)
graphql.ts              # → @hono-cms/graphql (U21)
graphql/                # → @hono-cms/graphql (U21)
media.ts                # → @hono-cms/media (U19)
openapi.ts              # → @hono-cms/openapi (U10) (helper retained in core to drive content routes)
openapi-content-routes.ts # KEPT — kernel reads it for /api/<collection> registration
organization.ts         # DELETED (U23) — no replacement
plugins.ts              # legacy CMSPlugin function shape deleted (U23)
providers/              # entire directory deleted (U6 + U23)
  factories.ts          # → deleted; adapters export factories directly (U24)
  registry.ts           # → deleted; transitional shims removed (U23)
webhooks.ts             # → @hono-cms/webhooks (U17)
content/
  cache.ts              # → @hono-cms/content-cache (U14)
  i18n.ts               # → @hono-cms/i18n (U18)
  preview.ts            # → @hono-cms/preview (U15)
  translation.ts        # → @hono-cms/i18n (U18)
  drizzle-translation-store.ts # → @hono-cms/i18n/store/drizzle (U18)
  publish.ts            # ORCHESTRATION → @hono-cms/drafts (U20)
                        # primitives (stripSystemDraftFields, normalizeDraftInput) KEPT in core
```

`packages/core/src/__tests__/auth-config-types.test.ts` and other tests
referencing deleted symbols are deleted or rewritten in U23. The legacy
core test suite is replaced by `tools/plugin-system-e2e` (the integration
suite that exercises the plugin runtime end-to-end).

## Migration guidance

The CHANGELOG accompanying the release includes:

```ts
// Before
createCMS({
  collections,
  db: { provider: "postgres", connectionString: ... },
  cache: { provider: "memory" },
  cors: { origin: "*" },
  auth: { tokens: { secret: process.env.AUTH_SECRET } },
  organizationStore: new MemoryOrganizationStore(),
  webhooks: [{ url: "https://...", events: ["content.*"] }]
});

// After
createCMS({
  collections,
  db: postgresAdapter({ connectionString: ... }),
  plugins: [
    cors({ origin: "*" }),
    memoryCache({}),
    jobsRuntime({ adapter: memoryJobs({}) }),
    tokensAuth({}),
    webhooks({ targets: [{ url: "https://...", events: ["content.*"] }] })
  ]
});
```

Organizations have no migration path. Consumers needing org-scoped CMS
features ship their own AuthPlugin that carries org context inside
identity and write the org admin UI themselves.

## References

- ADR 0001: plugin manifest architecture.
- Plan: `docs/plans/2026-05-25-001-refactor-plugin-system-architecture-plan.md` §U23.
- Handoff: `docs/handoff/2026-05-25-plugin-refactor-handoff.md`.
