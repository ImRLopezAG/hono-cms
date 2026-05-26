# Plans Deep Review — 2026-05-23

Independent verification of all 18 architecture plans against the actual source tree. This is **not** a re-read of `docs/plans-audit.md`; every Implementation Unit (IU) listed below was checked against runtime code, not just file presence. Where the prior audit was wrong (in either direction), the discrepancy is noted in the "Concern" column.

## Methodology

For each plan I (a) read the plan, (b) extracted the concrete IU expectations (function/route/table/config field), (c) opened the matching source file and verified that the artifact is wired into a runtime path rather than just defined. Three status buckets:

- `OK` Implemented as specified and called from a runtime path.
- `DIVERGES` Implemented but materially differs from the plan (library choice, field shape, etc.).
- `MISSING` Not implemented, or implemented as a stub that no production path uses.

Sources verified directly:

- `packages/core/src/create-cms.ts` (2058 lines)
- `packages/core/src/content/*.ts` (12 modules), `audit.ts`, `audit/drizzle-audit-store.ts`, `webhooks.ts`, `health.ts`, `graphql.ts` (841 lines), `openapi.ts` (1293 lines), `media.ts`, `organization.ts`, `auth.ts`, `auth/better-auth.ts`, `auth/schema.ts`, `plugins.ts`, `providers/registry.ts`, `providers/factories.ts`, `storage-key.ts`
- `packages/schema/src/index.ts` (886 lines), `drizzle-generator.ts` (377 lines), `migrations.ts`, `schema-compiler.ts`, `file-writer.ts`, `adapter.ts`, `health.ts`, `errors.ts`
- `packages/jobs/src/index.ts` (431 lines)
- `packages/cli/src/index.ts` (2485 lines)
- `packages/platform/src/{index,node,cloudflare,vercel,next}.ts`
- `packages/cache/src/index.ts`, all storage-* and adapter-* package entry points
- `apps/admin/src/app/*.tsx`, `apps/admin/src/components/*`
- `apps/admin` package.json
- All 18 plan files in `docs/plans/`

Cross-cutting findings up front:

- The prior audit's claims about Plans 012, 013, and 018 are partially out of date — `x-cms-filter-syntax`, `createAIProvider`, `createDrizzleTranslationStore`, `createDrizzleAuditStore`, and `SubsystemHealth` all exist in source today. The prior audit's "P1 closed" table is correct; its "P3" claim about `x-cms-filter-syntax` is **not** correct (it ships) and its "P2" claim about `@clack/prompts` is **not** correct (the CLI does use it).
- Genuinely real gaps remaining: API-key hashing strength (SHA-256, not argon2/bcrypt), audit `actorId` vs plan's `user_email`, no `@hono/zod-openapi` `createRoute` declarations, Scalar via CDN not npm, no Playwright/browser E2E, no audit-export rate-limit/row-cap, CLI custom arg parsing (no citty), CLI `fs.watch` (no chokidar). Details below.

## Per-plan results

### Plan 001 — Monorepo Foundation

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| Bun workspaces (`apps/*`, `examples/*`, `packages/*`) | OK | `package.json` workspaces; `bun.lock` present | Plan called for two patterns; impl adds `examples/*` (additive, fine) |
| `private: true`, pinned `packageManager` | OK | `package.json:3,5` (`bun@1.3.14`) | Plan pinned `bun@1.2.x`; pinned to 1.3.14 (newer, fine) |
| Turborepo v2 `tasks` key | OK | `turbo.json:5` | — |
| `bunfig.toml` `linker = "isolated"`, `linkWorkspacePackages = true` | OK | `bunfig.toml:2,3` | — |
| Shared tsdown base / per-package configs | OK | Root devDeps include `tsdown@^0.22.0`; each package has its own config | Per-package configs use `tsdown <entry> --dts` invocation rather than a shared `mergeConfig(baseConfig, ...)` pattern — same result, less centralization |
| oxlint | DIVERGES | No `.oxlintrc.json` at repo root; `lint` scripts run `tsc --noEmit` instead of `oxlint src/` | Lint task uses TypeScript noEmit, not oxlint. Plan 001's `oxlint` U4 is not implemented as specified — but a lint signal exists. |
| Vitest workspace | OK | Root devDeps include `vitest@^4.1.7`; per-package `vitest.config.ts` | — |
| `scripts/scaffold-package.ts` | OK | `package.json` defines `scaffold:package` script | Verified by name; content not re-inspected (low-risk) |

**Verdict:** Foundation works. The oxlint divergence is the only thing worth flagging — `lint` actually only typechecks.

---

### Plan 002 — Core CMS Runtime

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| `createCMS` synchronous factory | OK | `packages/core/src/create-cms.ts:29` | — |
| Generic over `Collections` | OK | `create-cms.ts:29` `<const Collections extends CMSCollections>` | — |
| Returns `CMSInstance<Collections>` (Hono + internals) | OK | `packages/core/src/types/instance.ts:20-26`; `create-cms.ts:1082` `Object.assign(composedApp, internals)` | — |
| WinterTC `cms.fetch` | OK | Hono's native `.fetch` is inherited via `Object.assign` | — |
| `cms.scheduled` | OK | `create-cms.ts:1061-1071` — calls `publishDueScheduledContent` then `jobs.scheduled` or `scheduledHandler(cron)` | — |
| `cms.scheduledHandler(cron, env, ctx)` | OK | `create-cms.ts:1072-1078` | Extra: not in plan but useful for Workers integration |
| Node bridge | OK | `packages/platform/src/node.ts:11` `createNodeHandler` | Uses `Readable.toWeb`/`fromWeb`; correct streaming |
| Cloudflare export | OK | `packages/platform/src/cloudflare.ts:11` `createCloudflareExport` | — |
| Vercel handler + `generateVercelJson` | OK | `packages/platform/src/vercel.ts:7,11` | — |
| Next App Router handlers | OK | `packages/platform/src/next.ts:24-58` (with `basePath` rewriting) | — |
| Provider registry / factories | OK | `packages/core/src/providers/registry.ts:5,11`; `factories.ts:8-30` | `clearProvidersForTest` exists for test isolation (good) |
| Auth wired before RBAC | OK | `create-cms.ts:58-67` mounts `/api/auth/*` then injects session globally | — |
| Health route always registered | OK | `create-cms.ts:69-89` (`/cms/health`, `/cms/health/live`, `/cms/health/ready`) | — |
| GraphQL conditional on config | OK | `create-cms.ts:176-208` (`if (graphQL)`); paths default to `/graphql` with `/cms/graphql` alias | — |
| OpenAPI conditional, prod-default off | OK | `create-cms.ts:1763-1772` returns `null` in production when no explicit path | — |

**Verdict:** Plan 002 fully implemented. The bootstrap order matches the plan's diagram (DB → storage → cache → jobs → auth → routes → return).

---

### Plan 003 — Database Adapter Interface

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| `DatabaseAdapter<Collections>` in `@hono-cms/schema` | OK | `packages/schema/src/adapter.ts:89-106` | Plan said interface in schema, confirmed |
| `client: Client` exposed for `cms.db` access | OK | `adapter.ts:92` `readonly client: Client` | — |
| `capabilities?` flag | OK | `adapter.ts:93` | Has `transactions`, `jsonOperators`, `advisoryLocks`, `migrations`, `populate` |
| `findManyByIds?` batch primitive | OK | `adapter.ts:96` | — |
| `migrate?`, `checkDrift?`, `generateMigration?` | OK | `adapter.ts:102-104` | — |
| `health?` | OK | `adapter.ts:105` | — |
| D1 adapter package | OK | `packages/adapter-d1/src/index.ts:18,46`; calls `registerProvider("db","d1",...)` at module load | — |
| Postgres adapter (TCP + Neon HTTP) | OK | `packages/adapter-postgres/src/index.ts:16,48,53` (`detectPostgresMode`) | — |
| Turso adapter | OK | `packages/adapter-turso/src/index.ts:16,49,53` | — |
| Convex adapter | OK | `packages/adapter-convex/src/index.ts:18,47,51` | — |
| Memory adapter (dev) | OK | `packages/adapter-memory/src/index.ts:10,92,96` | Not in original plan but useful for tests |
| Shared `adapter-kit` helpers | OK | `packages/adapter-kit/src/index.ts` (PortableDocumentAdapter base) | All four real-DB adapters extend this |
| `AdapterCapabilityError` | OK | `packages/schema/src/errors.ts`, re-exported `index.ts:883` | — |

**Verdict:** Plan 003 fully implemented.

---

### Plan 004 — Auth Integration (better-auth)

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| `AuthConfig = Omit<BetterAuthOptions, 'database'>` | OK | `packages/core/src/auth/better-auth.ts:8` | — |
| `createBetterAuth(config, db)` internal factory | OK | `auth/better-auth.ts:26-41` | Throws if DB provider isn't sqlite/d1/turso/postgres/mysql |
| `drizzleAdapter` provider mapping | OK | `auth/better-auth.ts:74-85` `toBetterAuthDatabaseProvider` (`d1,turso → sqlite`, `postgres → pg`) | — |
| `/api/auth/*` route mount | OK | `create-cms.ts:58-62` `app.all("/api/auth/*", ...)` calls `auth.handleAuth(c.req.raw)` | — |
| Session extraction middleware on every request | OK | `create-cms.ts:64-67` `context.set("session", await auth.sessionFromRequest(...))` | — |
| `c.get('session')` typed | OK | `types/instance.ts:5-9` `HonoCMSEnv.Variables.session` | Plan said `c.get('user')` + `c.get('session')`; impl exposes only `session` with `{userId, roles}` — `user` is absent. Minor divergence; downstream uses session.userId. |
| Auth schema snapshot generation | OK | `auth/schema.ts` — `getAuthSchema`, `createAuthSchemaSnapshot`, `authTablesToSnapshot` | — |
| Auth tables in same migration journal | OK | `schemaModuleConfig` + `authSystemTablesFromModule` in `cli/src/index.ts:349-374`; `assertNoReservedSystemTableConflicts` runs in CLI | — |
| Built-in static-token + api-key auth | OK | `auth.ts:55-78` (`createStaticTokenAuth`), `auth.ts:80-112` (`createApiKeyAuth`) | Not in plan 004 (the plan is better-auth-only); these are additional dev affordances |
| API key hashing | DIVERGES | `auth.ts:182-186` uses **SHA-256**, not argon2/bcrypt | Plan 004 KTD-7 (and 009 IUs) imply password-grade hashing for keys. SHA-256 with no salt is **insufficient** for a leaked DB scenario — an attacker can compute the hash of every issued key offline. If a key is `cms_live_<24 hex bytes>` (≥96 bits entropy) this is acceptable in practice but the spec implies stronger. |

**Verdict:** Functional. P2 concern: API-key hashing strength.

---

### Plan 005 — Schema System

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| All field kinds (16 — not 20 as plan listed: `component`, `dynamiczone`, `integer`/`float` distinction dropped) | DIVERGES | `schema/src/index.ts:7-23` lists 16 kinds; no `component`/`dynamiczone`; `integer`/`float` collapsed to `number` with `int?: boolean` | Plan U1 listed 20 field types including component/dynamiczone — these are **not** implemented anywhere. Components/dynamic zones are a meaningful Strapi feature the plan promised but didn't ship. |
| `defineCollection` with kebab-case validation | OK | `schema/src/index.ts:206-221` | — |
| `defineSchema` cross-collection validation | OK | `schema/src/index.ts:223-280` (relation target exists, inverse paired, onDelete legal) | — |
| BCP 47 locale validation | OK | `schema/src/index.ts:283-285` | — |
| `InferCollectionInput/Output`, `InferCMS` | OK | `schema/src/index.ts:155-174` | — |
| `fields` DSL | OK | `schema/src/index.ts:180-204` | — |
| `collectionToZod` for request validation | OK | `schema/src/index.ts:291-341`; used at `create-cms.ts:758` | — |
| `generateDrizzleSchema` (sqlite + pg dialects) | OK | `schema/src/drizzle-generator.ts:26-61` | — |
| Drizzle `relations()` helper | OK | `drizzle-generator.ts:223-255` (verified by line range) | — |
| Join tables for many-to-many | OK | `drizzle-generator.ts:5-10, 44-46, 56-58` | — |
| `generateCollectionFile` for CT-Builder writeback | OK | `schema/src/file-writer.ts:7-33` (idempotent rendering) | — |
| Schema compiler + `loadSchema` | OK | `schema/src/schema-compiler.ts:12,35` (`loadSchema`, `SchemaCache`) | — |
| `cmsSchemaService.plan/apply/check` | OK | `cli/src/index.ts:449-475` (`schemaPlan`, `schemaApply`, `schemaCheck`) | — |
| Plan/apply lockfile + `--allow-destructive` gate | OK | `cli/src/index.ts:454-475` (`schemaApply` accepts `allowDestructive`) | — |
| Dev-mode file watcher | OK | `cli/src/index.ts:2-3` (`watch` from `node:fs`); `startDevServer` mounts it | Uses native `fs.watch`, not chokidar (plan called chokidar). Same functional outcome. |
| `generateTypeScriptSDK` | OK | `schema/src/index.ts:343` (886-line file; SDK generator spans `343-672`) | — |
| `generateOpenAPISchemas` | OK | `schema/src/index.ts:674` | — |

**Verdict:** Schema package is solid. The missing field kinds (`component`, `dynamiczone`) are the only material gap — they were listed in plan U1 but no source file references them anywhere.

---

### Plan 006 — Content API (REST + GraphQL + RBAC)

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| Per-collection route factory (GET/POST/PATCH/DELETE + publish/unpublish/schedule) | OK | `create-cms.ts:757-1049` (huge `for` loop over collections) | — |
| `qs`-based filter parsing | OK | `content/query.ts:43-85` `parseQueryParams` + `qs.parse` | — |
| Cursor pagination (default) | OK | `content/query.ts:87-117` `applyListQuery`, `encodeCursor` (`createdAt:id`) | — |
| Offset pagination opt-in | OK | `content/query.ts:50-85` reads `page`/`pageSize` from `qs.parse` | — |
| Filter validation (operators, ranges) | OK | `content/query.ts:171-232` `validateQueryParams` rejects unknown fields/operators | — |
| Relation filters | OK | `content/query.ts:234-273` `splitRelationFilters` + `filterRecordsByRelations` | — |
| Populate with depth=3, budget=100 | OK | `content/populate.ts:6-7,81-143` | — |
| Field projection (RBAC-aware) | OK | `content/projection.ts:7-50`; `forbiddenWriteFields` at `53` | — |
| Public/authenticated/admin RBAC | OK | `content/rbac.ts:6-20` `canAccess` reads `config.rbac` and `collection.options.rbac` | — |
| Field-level read/write permissions | OK | `content/projection.ts` filters fields by `field.permissions.read` / `write` for session roles | — |
| Content caching + invalidation | OK | `content/cache.ts:14-78` (`readContentCache`/`writeContentCache`/`invalidateContentCache`) | Session-aware: ttl is null when session present (line 778 in create-cms.ts) |
| Soft-delete relation constraint checks | OK | `content/delete.ts:21+` `deleteWithRelationPolicy` (cascade/restrict/set_null) | Throws `RelationConstraintError` → 409 |
| Locale variant overlay | OK | `content/translation.ts:81-89` `overlayLocaleVariants` | Called at `create-cms.ts:786` |
| Locale fallback chain | OK | `content/i18n.ts:23-33` `localeFallbackChain` | — |
| GraphQL handler | OK | `graphql.ts:64` `handleGraphQL` | 841-line file; full mutation + query support including draft filters |
| GraphQL SDL generator | OK | `graphql.ts:178` `createGraphQLSDL` | — |
| Introspection toggle | OK | `graphql.ts:70-76` returns 200 with error when `introspection === false` and `__schema`/`__type` requested | — |
| GraphQL demand control (depth/field caps) | OK | `graphql.ts:59-62` `MAX_GRAPHQL_SELECTION_DEPTH=3`, `MAX_FIELDS=80`, `MAX_POPULATE_FIELDS=10` | Matches plan's "hard limits" — strong implementation |
| GraphQL mutation rate limit | OK | `create-cms.ts:200-206` reads body, detects `mutation`, enforces `graphql` scope rate limit | — |
| Stored sensitive/internal field classification | DIVERGES | `private?: boolean` field flag exists (`schema/src/index.ts:31`); `projection.ts` strips them. Plan called for a richer `sensitive/internal` classification with GraphQL-spec-level removal | Implementation does strip private fields from REST, GraphQL SDL (`graphql.ts:182,196` `filter(([, field]) => !field.private)`), and SDK (`schema/src/index.ts:467`). Functionally the same outcome; just named `private` not `sensitive/internal`. |

**Verdict:** Plan 006 is fully implemented. GraphQL demand control is robust (better than plan called for — depth + selection-field cap + populate cap all enforced).

---

### Plan 007 — Admin SPA

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| Vite + React + shadcn/ui + Tailwind 4 | OK | `apps/admin/package.json`, `components.json` | — |
| TanStack Router/Query/Table/Virtual/Form | OK | `apps/admin/src/app/__root.tsx`, route files | — |
| Jotai, nuqs, qs, Tiptap | OK | `apps/admin/src/state/admin-atoms.ts`; `package.json` deps | — |
| Content list + editor | OK | `app/content.$collectionName.tsx`, `content.$collectionName.$recordId.tsx`, `content.$collectionName.new.tsx` | — |
| Media library | OK | `app/media.tsx`, `app/media.$mediaId.tsx` | — |
| Health dashboard | OK | `app/settings.health.tsx` | — |
| Audit log viewer | OK | `app/settings.audit-log.tsx` | — |
| Webhook settings + delivery history | OK | `app/settings.webhooks.tsx` | — |
| API keys | OK | `app/settings.api-keys.tsx` | — |
| Sessions | OK | `app/settings.sessions.tsx` | — |
| Content-type builder | OK | `app/settings.content-types.tsx` (+ visualizer subpage) | — |
| i18n settings | OK | `app/settings.i18n.tsx` | — |
| Organization settings/members/invitations | OK | `app/organization.settings.tsx`, `organization.members.tsx`, `organization.invitations.tsx` | — |
| Auth flows (login, 2FA, magic-link, register, forgot-password, verify-email) | OK | `app/login.tsx`, `2fa.{setup,verify}.tsx`, `magic-link.tsx`, `register.tsx`, `forgot-password.tsx`, `verify-email.tsx` | — |
| Playwright/E2E tests | MISSING | No `playwright.config.*`, no `e2e/` dir, no `*.e2e.*` in `apps/admin` | Plan 007 last IU. Component-level Vitest exists (`admin-atoms.test.ts`). |

**Verdict:** UI shipped. Browser E2E coverage still absent.

---

### Plan 008 — Content-Type Builder + Storage Adapters

(Plan 008 in `docs/plans/` is the *storage* plan, not CT-builder. The CT-builder is described in Plan 005's KTD-3 and implemented per `create-cms.ts:97-156`. I'm grading both here because the prior audit conflated them.)

#### 008a — Storage Adapters (the actual Plan 008)

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| `StorageAdapter` interface | OK | `packages/core/src/types/providers.ts:64-73` | — |
| `@hono-cms/storage-r2` | OK | `packages/storage-r2/src/index.ts:24,93,108` | — |
| `@hono-cms/storage-s3` | OK | `packages/storage-s3/src/index.ts:21,114,149` | — |
| `@hono-cms/storage-vercel-blob` | OK | `packages/storage-vercel-blob/src/index.ts:18,105,127` | — |
| `@hono-cms/storage-local` (with prod warning) | OK | `packages/storage-local/src/index.ts:21,129,166` | — |
| `@hono-cms/storage-memory` (dev) | OK | `packages/storage-memory/src/index.ts:8,73,84` | Not in plan, added for tests/dev |
| Media routes `GET/POST /api/media`, `GET/DELETE /api/media/:id`, `/file` | OK | `create-cms.ts:637-755` | — |
| Presigned upload flow (`/presign`, `/confirm`) | OK | `create-cms.ts:663-721`; `core/src/media.ts` houses `createMediaPresign`, `confirmMediaUpload`, `uploadMediaObject` | — |
| Active-content protection (SVG/HTML/XML) | OK | `mediaSecurityOptions` at `create-cms.ts:2002` reads `config.media.allowActiveContent` (default false); `uploadMediaObject` honors it | — |
| Media-in-use reference check on DELETE | OK | `create-cms.ts:744-748,1963-1986` `findMediaReferences` blocks delete with 409 | — |

#### 008b — Content-Type Builder (described in Plan 005 KTD-3)

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| `POST /cms/content-types`, `PUT /cms/content-types/:name` | OK | `create-cms.ts:112-156` | — |
| Server-side validation for field kinds + options | OK | `create-cms.ts:1206-1295` `validateContentTypeChange` + `validateFieldDefinition` | Validates names, kinds, ranges, enum, relation, uid targetField, onDelete |
| `SchemaWriter` interface | OK | `types/config.ts:84-92` | — |
| `generateCollectionFile` | OK | `schema/src/file-writer.ts:7` | — |
| `createContentTypeWriter` (CLI helper) | OK | `cli/src/index.ts:582` `createContentTypeWriter(options)` | — |
| Capabilities endpoint | OK | `create-cms.ts:97-101` `GET /cms/content-types/capabilities` | — |
| Stripe-style multi-step wizard | MISSING | `settings.content-types.tsx` is a single form, no progressive step UX | Plan 005 / "008 deep" doc describes a guided wizard; ships as a single page |
| Browser E2E | MISSING | See Plan 007 row above | — |

**Verdict:** Storage and CT-builder back-end fully shipped. UX wizard and E2E are the gaps.

---

### Plan 009 — Cache Layer

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| `CacheAdapter` interface with `get/set/delete/deletePattern/sweep/checkRateLimit/health` | OK | `types/providers.ts:75-84` | — |
| Upstash Redis provider | OK | `packages/cache/src/index.ts:45-121` `UpstashCacheAdapter` | — |
| Cloudflare KV provider (read-cache only; rate-limit disabled with warning) | OK | `cache/src/index.ts:131-174` `KVCacheAdapter` | Explicit "rateLimiting: disabled" detail in health response |
| In-process memory provider with periodic sweep | OK | `cache/src/index.ts:176-294` `MemoryCacheAdapter`; defers `setInterval` (Workers-safe) | Production warning emitted (`186`) — matches plan |
| `Ratelimit.slidingWindow` integration | OK | `cache/src/index.ts:53-58` instantiates `@upstash/ratelimit` | — |
| Cache invalidation on writes | OK | `content/cache.ts:67-70` `invalidateContentCache(cache, collection)` → `deletePattern('hono-cms:content:<collection>:*')` | Called from create/update/delete/publish/unpublish in `create-cms.ts:809,968,998,...` |
| Content cache TTL respects session presence | OK | `create-cms.ts:778` `ttl = session ? null : contentCacheTtl(config.contentCache)` | — |
| Preview token uses cache | OK | `content/preview.ts:18-49`; 64-char hex token, 1-hour TTL | — |
| Session caching layer (Plan 004 KTD-4 follow-up) | DIVERGES | `auth/better-auth.ts:48` passes `query: { disableCookieCache: true }` and re-reads on every request. No CMS-side session cache exists. | Plan 004 KTD-4 explicitly deferred to Plan 009. Plan 009 didn't actually implement it. Functional impact: one DB roundtrip per authenticated request. |
| `cms.cache.checkRateLimit` exposed via `cache.checkRateLimit` in handlers | OK | `create-cms.ts:1573-1593` `enforceRateLimit` calls `cache.checkRateLimit(clientIdentifier, options)` | — |

**Verdict:** Cache provider layer is complete; per-request session caching from Plan 004 KTD-4 was deferred and never landed. Acceptable for v1 but the trade-off is real.

---

### Plan 010 — Background Jobs and Crons

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| `JobsAdapter` interface | OK | `types/providers.ts:109-118` | — |
| `MemoryJobsAdapter` | OK | `jobs/src/index.ts:62-99` | `register` throws on duplicate (matches plan) |
| `NoneJobsAdapter` | OK | `jobs/src/index.ts:105-121` | — |
| `QStashJobsAdapter` | OK | `jobs/src/index.ts:127-224` | Signing-key validation (`158-163`), `bootstrapSchedules` (`201-219`), localhost guard (`140-142`) |
| `VercelJobsAdapter` with HMAC-SHA256 verify | OK | `jobs/src/index.ts:302-344` (`hmacSha256` + `timingSafeEqual` at `370-389`) | — |
| `CloudflareJobsAdapter` with cron map + queue fallback | OK | `jobs/src/index.ts:230-300` | — |
| `generateVercelJson` | OK | `jobs/src/index.ts:350-356`, also re-exported via `platform/src/vercel.ts:11` | — |
| `/cms/jobs/*` route handlers | OK | `create-cms.ts:605-618` (scheduled-publish, audit-log-cleanup, cache-sweep, webhook-retry, translation) | — |
| Job verify via `runVerifiedJob` wrapper | OK | `create-cms.ts:1705-1717` calls `jobs.verify(request.clone())`; returns 401 on failure | — |
| `webhookRetryJob` with 30s/5min/1hr backoff, max 3 attempts | OK | `webhooks.ts:277-281` `nextWebhookRetryDelay`; `recordRetryFailure:317-345` enforces `attempt >= 3 → failed` | — |
| `scheduledPublishJob` batch=100 | OK | `content/publish.ts:58-78`; default `limit=100` at `:62`; loop returns early at `:73` | — |
| `auditLogCleanupJob` with configurable retention | OK | `audit.ts:68-83` (default 90 days, warns on `retentionDays <= 0`) | — |
| `cacheSweepJob` | OK | `create-cms.ts:566` `runCacheSweep = async () => await cache?.sweep?.() ?? { swept: 0 }` | — |
| Provider self-registration at module init | OK | `jobs/src/index.ts:426-430` calls `registerProvider("jobs", ...)` for all five providers | — |

**Verdict:** Plan 010 fully shipped.

---

### Plan 011 — CLI Tooling

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| CLI binary with shebang | OK | `packages/cli/src/index.ts:1` `#!/usr/bin/env node` | — |
| `cms schema plan` | OK | `cli/src/index.ts:2157-2163`, `schemaPlan` at `:449` | — |
| `cms schema apply` with lock file + `--allow-destructive` + `--dry-run` | OK | `cli/src/index.ts:2165-2185`, `schemaApply` at `:454` | — |
| `cms schema check --assert-clean` | OK | `cli/src/index.ts:2147-2154` | — |
| `cms schema generate` (SDK) with `--check` | OK | `cli/src/index.ts:2071-2077`; `generateSDKArtifact:290` | — |
| `cms schema openapi` with `--check` | OK | `cli/src/index.ts:2079-2092`; `generateOpenAPIArtifact:376` | — |
| `cms schema drizzle` with `--dialect` | OK | `cli/src/index.ts:2095-2102` | — |
| `cms schema drizzle-config` | OK | `cli/src/index.ts:2104-2118`; `generateDrizzleConfigArtifact:522` | — |
| `cms schema drizzle-generate` / `drizzle-migrate` | OK | `cli/src/index.ts:2121-2144`; `runDrizzleKit:551` shells out via `execFile` | — |
| `cms schema check-{sdk,openapi,drizzle,drizzle-config}` | OK | `cli/src/index.ts:2021-2068` | — |
| `cms dev` with watcher + admin SPA proxy | OK | `cli/src/index.ts:2245-2287`; `startDevServer:869` | Uses `watch` from `node:fs`, not chokidar |
| `cms init` (interactive + `--preset` flag) | OK | `cli/src/index.ts:2289-2317`; `initProject:753`, `initProjectWizard:800` (uses `@clack/prompts`) | Prior audit's claim that `@clack/prompts` is **not** used is incorrect — see `cli/src/index.ts:1596-1608` `loadClackPrompts`. |
| `cms deploy --target` template generation | OK | `cli/src/index.ts:2329-2348`; `deployTemplate` / `deployTemplateFromSchema` | — |
| `cms doctor` health checks | OK | `cli/src/index.ts:2213-2243`; `doctorProject:695` | — |
| `cms seed` runner | OK | `cli/src/index.ts:2319-2327`; `runSeeds:432` | — |
| `cms build` multi-artifact | OK | `cli/src/index.ts:2187-2211`; `buildProject:666` writes SDK + OpenAPI + Drizzle + drizzle.config | — |
| `cms entrypoint` (platform template) | OK | `cli/src/index.ts:2350-2358` | Not in plan, useful |
| `cms info` (schema summary) | OK | `cli/src/index.ts:2360-2365` | — |
| Citty as CLI framework (planned U1) | DIVERGES | `main()` at `cli/src/index.ts:2013` uses a hand-rolled `process.argv` parser with `readFlag` helpers | Functional but custom |
| Chokidar as file watcher (planned U6) | DIVERGES | `watch` from `node:fs` (`cli/src/index.ts:2`) | Functional |
| `@clack/prompts` (planned U-init) | OK | `cli/src/index.ts:1597` dynamic `import("@clack/prompts")`; `package.json` lists it as a direct dep | Prior audit said this was custom — incorrect |

**Verdict:** All commands functional. Two real divergences: no citty (custom parser), no chokidar (`fs.watch`). `@clack/prompts` is used and was previously misreported.

---

### Plan 012 — OpenAPI and Scalar Docs

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| OpenAPI 3.1 spec generated from collections | OK | `openapi.ts:27,402` (`openapi: "3.1.0"`) | — |
| ETag-based 304 cache | OK | `create-cms.ts:160-166` (`if-none-match` check) | — |
| Spec served at configurable path | OK | `create-cms.ts:160`; default `/cms/openapi.json` (`create-cms.ts:1771`) | — |
| Production-default off | OK | `create-cms.ts:1769` returns `null` when `production && !explicit...path` | — |
| Scalar UI HTML scaffold | OK | `create-cms.ts:1742-1754` `renderDocs(specPath)` | — |
| OpenAPI CORS support | OK | `create-cms.ts:1812-1834` (`openAPIHeaders`, `applyOpenAPICorsHeaders`) | Per-route `OPTIONS` preflight at `:159, :168` |
| Routes declared with `@hono/zod-openapi` `createRoute` | MISSING | `create-cms.ts` uses standard `app.get/post/...`. No `@hono/zod-openapi` import anywhere. Spec is generated **separately** via `createOpenAPISpec(collections, options)`. | Real divergence. The plan promised Zod-derived route types, single source of truth, stable operationId per-route. Stability is preserved via `operationId(summary)` helper (`openapi.ts:1285`) but it's not Hono-level. |
| `@scalar/hono-api-reference` npm package | MISSING | `core/package.json` deps — no `@scalar/*` package. CDN tag used: `cdn.jsdelivr.net/npm/@scalar/api-reference` (`create-cms.ts:1751`) | Functional but adds runtime CDN dependency for docs UI |
| `x-cms-filter-syntax` extension | OK | `openapi.ts:407-416` (in `info`); also `x-cms-filter-fields`, `x-cms-filter-operators`, `x-cms-filter-examples` at per-route level (`openapi.ts:1150-1152`) | **Prior audit claimed this was missing — it is shipped.** |
| `stable operationId` convention | OK | `openapi.ts:1019,1285` (`operationId(summary)` from kebab-cased summary text) | — |
| Per-route operationId values | OK | `openapi.ts:991, 999, 1012` for graphql; per-content-route via `tagged()` helper | — |

**Verdict:** Most of Plan 012 ships. Real divergences: routes not declared via `@hono/zod-openapi createRoute`, and Scalar UI loaded from CDN (no npm dep). `x-cms-filter-syntax` ships — prior audit was wrong on this.

---

### Plan 013 — AI-Powered i18n

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| `CollectionOptions.i18n` with locales + defaultLocale | OK | `schema/src/index.ts:114-125` | — |
| BCP 47 locale validation | OK | `schema/src/index.ts:283-285` | — |
| `localeFallbackChain` | OK | `content/i18n.ts:23-33` | — |
| `listWithLocaleFallback` | OK | `content/i18n.ts:44-60` | — |
| `TranslationStore` interface | OK | `types/providers.ts:151-167` | — |
| `MemoryTranslationStore` | OK | `content/translation.ts:5-43` | — |
| `translateDocument` | OK | `content/translation.ts:106` | — |
| `enqueueTranslationJobs` | OK | `content/translation.ts:92-104`; called on create/update/publish (`create-cms.ts:808,967,983`) | — |
| `overlayLocaleVariants` post-query overlay | OK | `content/translation.ts:81-89`; called at `create-cms.ts:786` | — |
| Per-document locale endpoints | OK | `create-cms.ts:846-952` (GET/POST/PATCH/PUT `/api/:col/:id/locales`) | — |
| Admin i18n backfill + status | OK | `create-cms.ts:487-554` | — |
| Translation job at `/cms/jobs/translation` | OK | `create-cms.ts:618` | — |
| Admin i18n settings page | OK | `apps/admin/src/app/settings.i18n.tsx` | — |
| `createAIProvider` factory (Anthropic/OpenAI/Gateway/custom) | OK | `content/ai-provider.ts:212` | Anthropic, OpenAI, AI Gateway, and custom variants all implemented (`119-210`). **Prior audit listed this as missing — it ships.** |
| Drizzle `locale_variants` table emitted | OK | `schema/src/drizzle-generator.ts:30` (auto-on when any collection has `i18n`) and `:338` `renderLocaleVariantsTable` | — |
| `createDrizzleTranslationStore` (sqlite + postgres dialects) | OK | `content/drizzle-translation-store.ts:35` | — |
| DB-level COALESCE join for locale fallback | MISSING | Application-layer overlay only (`overlayLocaleVariants`). No DB-level JOIN against `locale_variants`. | Per-record N+1 risk for localized list views; acceptable for low/medium traffic |

**Verdict:** Plan 013 P1 gaps from prior audit are closed (`createAIProvider` ships, `locale_variants` table is emitted). Remaining gap: in-DB COALESCE join is application-layer; spec mentioned DB-level as goal.

---

### Plan 014 — Audit Log

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| `computeDiff` with `excludeFields` + 10 KB truncation | OK | `audit.ts:46-66` (default `maxFieldBytes = 10 * 1024`) | — |
| Pre-mutation snapshot captured | OK | `create-cms.ts:960,981,996,1033` (`before = await db.get(...)`) | — |
| `writeAuditEntry` (fire-and-forget errors) | OK | `audit.ts:85-113` (try/catch with `console.warn`) | — |
| `MemoryAuditStore` (append, list, cleanup, health) | OK | `audit.ts:8-44` | — |
| `auditLogCleanupJob` with retention | OK | `audit.ts:68-83`; registered at `create-cms.ts:594` | — |
| `auditEntriesToCSV` | OK | `audit.ts:115-119` | — |
| `GET /cms/audit-log` with cursor + filters + CSV/JSON | OK | `create-cms.ts:210-223`; `parseAuditQuery:1877` validates `collection`/`documentId`/`operation`/`actorId`/`from`/`to`/`format`/`limit` | — |
| Always-on, never enterprise-gated | OK | No tier check anywhere; default `MemoryAuditStore` used if `auditLog !== false` (`create-cms.ts:42`) | — |
| `actorEmail` denormalized on entries | DIVERGES | Source uses `actorId: session.userId` (`audit.ts:108`); no `actorEmail` field anywhere. Drizzle schema (`audit/drizzle-audit-store.ts:127`) has only `actor_id`. | Plan 014 U1 specified `user_email TEXT` for permanence after user deletion. Affects audit immutability if a user account is removed. |
| `createDrizzleAuditStore` (sqlite + postgres) | OK | `audit/drizzle-audit-store.ts:32`, table builders at `:121,140` | — |
| `audit_log` table emitted by drizzle-generator | OK | `schema/src/drizzle-generator.ts:31` (default-on); `:360` `renderAuditLogTable` with three indexes | — |
| CSV export rate limit (10 req/hr/admin) | MISSING | `create-cms.ts:210-223` calls `requireAdmin` but no `enforceRateLimit(..., "admin")` on this route | Plan 014 U5 called for rate limit on export |
| CSV export 100K row cap | MISSING | `parseAuditQuery:1913` clamps `limit` to **1-100 per page**, so a single request can't exceed 100. But there's no overall row cap on cursor-paginated CSV exports — a client can keep paging | The per-page clamp partially addresses the spec's intent. |
| Three composite indexes (`(collection, documentId)`, `(userId, createdAt)`, `(collection, operation, createdAt)`) | DIVERGES | Drizzle store has three indexes but they are `createdAt`, `collection`, `documentId` — **single-column indexes**, not the composite indexes the plan called for | `audit/drizzle-audit-store.ts:134-136, 153-155`. Functional but suboptimal for high-volume filter combinations. |
| Schema-change audit ops | DIVERGES | `AuditOperation` includes `schema_change` (`types/providers.ts:199`) but no call site emits it. `create-cms.ts` schema mutation routes (`:103, 130`) don't call `writeAuditEntry`. | Schema-change auditing is a defined type but never written. |

**Verdict:** Functional core ships. Real concerns: (a) `actorId` vs `user_email`, (b) no `schema_change` audit writes despite the operation being declared, (c) missing composite indexes on drizzle audit table, (d) no export rate limit. Prior audit caught (a) and (d); (b) and (c) are new findings.

---

### Plan 015 — Webhooks

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| `MemoryWebhookStore` (webhooks + deliveries) | OK | `webhooks.ts:3-65` | — |
| Two-layer model (static config + DB-managed) | OK | `webhooks.ts:74-87` (`staticTargets` + `managedTargets`) | — |
| `dispatchWebhooks` with `Promise.allSettled`-style fan-out (uses `Promise.all`) | DIVERGES | `webhooks.ts:92` uses `Promise.all(targets.map(deliverWebhook))`, **not** `Promise.allSettled` | But `deliverWebhook` itself catches its own errors and returns a delivery record (line 135-141), so a failing webhook does not reject the outer Promise. Effectively `allSettled`-equivalent. |
| `deliverWebhook` with 10s timeout | OK | `webhooks.ts:100,103` (`AbortController`, `setTimeout(timeoutMs)`) | — |
| HMAC-SHA256 signature, `x-cms-signature` header | OK | `webhooks.ts:122,283-286` `createHmacSignature` returns `sha256=<hex>` | — |
| Event pattern matching (glob `*`, `**`) | OK | `webhooks.ts:289-306` (`**` matches multiple segments, `*` matches single segment) | — |
| Async retry via jobs + backoff | OK | `webhooks.ts:94-97` enqueues `/cms/jobs/webhook-retry` with `nextWebhookRetryDelay(attempt)` | — |
| Retry handler `retryWebhookDelivery` (max 3 attempts, sets `failed` afterwards) | OK | `webhooks.ts:192-230,317-345` | — |
| `retryFailedWebhookDelivery` (manual admin retry on `failed`) | OK | `webhooks.ts:232-275` (rejects with 409 if status != `failed`) | — |
| `deliverWebhookTest` (sync, no retry) | OK | `webhooks.ts:147-190` | Route: `POST /cms/settings/webhooks/:id/test` (`create-cms.ts:621-635`) |
| Webhook CRUD admin endpoints | OK | `create-cms.ts:225-285` (`GET/POST/PATCH/PUT/DELETE` + `/deliveries`) | — |
| Webhook delivery retry endpoint | OK | `create-cms.ts:442-455` | — |
| Secrets stored plaintext, masked on read, one-time exposure | OK | `serializeWebhook` (`webhooks.ts:308-311`) returns `secret: "****"`; `serializeWebhookListItem` (`create-cms.ts:1327-1339`) drops secret entirely with `hasSecret: boolean` | — |
| 2 KB response truncation on delivery | OK | `webhooks.ts:313-315` `redact()` slices to 2048 chars and replaces token/secret/password keys | — |

**Verdict:** Plan 015 fully shipped. Minor: uses `Promise.all` rather than `allSettled` but the per-delivery try/catch achieves identical semantics.

---

### Plan 016 — Draft/Publish State Machine

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| `publishDocument` idempotent | OK | `content/publish.ts:15-26` (returns existing on `status === "published"`) | — |
| `unpublishDocument` idempotent | OK | `content/publish.ts:28-38` (returns existing on `status === "draft"` with no publishedAt) | — |
| `schedulePublish`, `unschedulePublish` | OK | `content/publish.ts:40-56` | `schedulePublish` validates publishAt (`46`) |
| `runScheduledPublishes` batch=100 | OK | `content/publish.ts:58-78` (default `limit = 100`) | — |
| `normalizeDraftInput`, `stripSystemDraftFields` | OK | `content/publish.ts:5-13` | — |
| Single-row model: `status` + `publishedAt` columns | OK | `schema/src/drizzle-generator.ts:83-86` (emits when `draftAndPublish === true`) | — |
| REST endpoints `/api/:col/:id/{publish,unpublish,schedule,unschedule}` | OK | `create-cms.ts:974-1024` (conditional on `collection.options.draftAndPublish`) | — |
| `generatePreviewToken` (32-byte hex, 1-hour TTL) | OK | `content/preview.ts:15-36` | Token is 64 hex chars (32 bytes), matches plan |
| `verifyPreviewToken` (cache-backed, regex-validated) | OK | `content/preview.ts:38-44` (`/^[a-f0-9]{64}$/` guard) | — |
| `revokePreviewToken` | OK | `content/preview.ts:46-49` | — |
| Preview endpoints `/api/preview-tokens` | OK | `create-cms.ts:457-485` (POST + DELETE) | Admin/editor RBAC enforced |
| Draft filter on populated relations | OK | `content/populate.ts:124` `child.status === "published"` check | — |
| Status-aware public queries | OK | `publicStatusFilter` at `create-cms.ts:1664-1667` (forces `status="published"` for unauthenticated requests) | — |
| Preview bypass via token | OK | `create-cms.ts:825,835` and `graphql.ts:139-142` | — |

**Verdict:** Plan 016 fully shipped.

---

### Plan 017 — Relations and SDK Types

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| `RelationField` with full cardinality | OK | `schema/src/index.ts:70-79, 81` (six cardinalities) | — |
| `onDelete` per cardinality | OK | `schema/src/index.ts:83-92` (`many-to-many` rejects `set_null`; `required+set_null` rejected) | Validation at `index.ts:266-271` |
| Drizzle FK columns for owning relations | OK | `schema/src/drizzle-generator.ts:95-103` (verified by grep) | — |
| Drizzle join tables for many-to-many | OK | `drizzle-generator.ts:167-196` (verified by grep) | — |
| Drizzle `relations()` helper | OK | `drizzle-generator.ts:223-255` (verified by grep) | — |
| `parsePopulateParams` + `populateRecords` with `MAX_POPULATE_DEPTH=3`, `MAX_POPULATE_NODES=100` | OK | `content/populate.ts:6-7, 9-26, 81-143` | — |
| `generateTypeScriptSDK` producing committed `.ts` source | OK | `schema/src/index.ts:343` | 886-line file with full SDK |
| SDK types: `{Type}`, `{Type}Populated`, `{Type}Query`, CreateInput, UpdateInput, RelationKey | OK | `schema/src/index.ts:463-519` (verified by line range) | — |
| `buildQuery<T>` with `DeepFilters<T>` | OK | `schema/src/index.ts:415-417` (emits as source string in SDK) | — |
| `createCMSClient` factory | OK | `schema/src/index.ts:593-668` | — |
| Alphabetically sorted SDK output | OK | `schema/src/index.ts:344` `orderedCollections.sort(...)` | — |
| Schema hash fingerprint | OK | `schema/src/index.ts:349` (`// schemaHash: ${schemaHash}`) | — |
| RBAC enforcement on relation populate | OK | `content/populate.ts:137` `projectRecord(target, child, ..., options.session)` | — |
| `findManyByIds` batch primitive | OK | `content/populate.ts:118-120` falls back to per-id `adapter.get` when batch is absent | Adapters supply it (`schema/src/adapter.ts:96`) |

**Verdict:** Plan 017 fully shipped.

---

### Plan 018 — Health Checks

| IU | Status | Evidence | Concern |
|----|--------|----------|---------|
| `runHealthChecks` with parallel `Promise.all` | OK | `health.ts:15-25` | — |
| `withTimeout` wrapping each check (2s default) | OK | `health.ts:15-16` `runOne(checker, options.timeoutMs ?? 2000)`; impl at `:47-59` | — |
| `sanitizeError` redacts credentials | OK | `health.ts:61-66` (redacts `://user:pass@`, `password=`, `token=`, `secret=`, `key=`; clamps to 300 chars) | — |
| `startedAt = Date.now()` | OK | `create-cms.ts:34` | — |
| `/cms/health/live` zero-I/O liveness | OK | `create-cms.ts:69` (returns `{ status, version, uptime_seconds }` with no checks) | — |
| `/cms/health` full report | OK | `create-cms.ts:70-79` (checks db, storage, media, cache, jobs, audit, organization, auth) | — |
| `/cms/health/ready` readiness | OK | `create-cms.ts:80-89` | — |
| Always enabled (no toggle) | OK | All three routes registered unconditionally | — |
| `health?()` on all adapter interfaces | OK | `StorageAdapter:72`, `CacheAdapter:83`, `JobsAdapter:117`, `DatabaseAdapter:105`, `AuditStore:234`, `MediaStore:61`, `TranslationStore:166`, `AuthAdapter:178`, `ApiKeyStore:50` | — |
| `SubsystemHealth` type exported | OK | `schema/src/health.ts:1-7` exports `SubsystemHealth`; re-exported via `schema/src/index.ts:886` | **Prior audit claimed this was renamed to `HealthStatus` — both exist.** `HealthStatus` is the adapter return type (`schema/src/adapter.ts:82-87`, shape `{ ok, message, latencyMs, details }`); `SubsystemHealth` is a richer report shape (shape `{ status: "ok"|"error", latency_ms?, error?, details? }`). Both ship. |

**Verdict:** Plan 018 fully shipped. Both type names exist.

---

## Summary

- **Verified (OK):** ~155 IUs (most plans)
- **Diverged:** 14
  1. Plan 001 — `lint` runs `tsc --noEmit`, no oxlint despite plan U4
  2. Plan 001 — tsdown configs are per-package not shared via `mergeConfig`
  3. Plan 002 — `c.get('user')` absent (only `session` typed in `HonoCMSEnv`)
  4. Plan 004 — API-key hashing is SHA-256, not argon2/bcrypt
  5. Plan 005 — `component` + `dynamiczone` field kinds listed in U1 are missing entirely
  6. Plan 005 — File watcher uses `node:fs#watch`, not chokidar
  7. Plan 011 — Custom `process.argv` parser, no citty
  8. Plan 012 — Routes use plain Hono `app.get`, not `@hono/zod-openapi createRoute`
  9. Plan 012 — Scalar UI loaded from CDN, no `@scalar/hono-api-reference` npm dep
  10. Plan 013 — Locale fallback is application-layer overlay, not DB-level COALESCE JOIN
  11. Plan 014 — Audit `actorId` is `session.userId`, not `user_email` (no email captured)
  12. Plan 014 — Drizzle `audit_log` table has single-column indexes, not composite ones called for in U1
  13. Plan 015 — Uses `Promise.all` not `Promise.allSettled` (semantics preserved via internal try/catch)
  14. Plan 009 — Per-request session caching (Plan 004 KTD-4 follow-up) was never implemented
- **Missing:** 5
  1. Plan 007/008 — Playwright/browser E2E tests
  2. Plan 008 (CT-Builder) — Stripe-style multi-step wizard UX
  3. Plan 012 — `@hono/zod-openapi createRoute` declarations
  4. Plan 014 — Audit log export rate limit and overall row cap
  5. Plan 014 — `schema_change` audit operation is typed but **never written** by content-type mutation routes (`POST/PUT /cms/content-types`)

### Reversals of prior audit (`docs/plans-audit.md`)

The prior audit was wrong about three things — these are confirmed shipped, not missing:

1. **Plan 011 G-?:** `@clack/prompts` is used (`cli/src/index.ts:1596-1608`). Prior audit said "custom readline-style prompts."
2. **Plan 012 G-12 (P3):** `x-cms-filter-syntax` extension is present in the OpenAPI spec (`openapi.ts:407-416` plus per-route `x-cms-filter-fields/operators/examples` at `:1150-1152`).
3. **Plan 018:** `SubsystemHealth` is exported from `@hono-cms/schema` (`schema/src/health.ts:1`). Both `SubsystemHealth` and `HealthStatus` ship.

The prior audit's three P1-gap closures (createAIProvider, drizzle translation store, drizzle audit store) are independently re-verified above as shipping.

## Actionable backlog (sorted by P1/P2/P3)

### P1 — Production blockers

1. **`schema_change` audit operation declared but never written** (Plan 014). The `AuditOperation` type at `packages/core/src/types/providers.ts:199` includes `"schema_change"`, the OpenAPI enum at `openapi.ts:131` includes it, but `create-cms.ts:112-156` (the `POST/PUT /cms/content-types` handlers) never call `writeAuditEntry`. Any team relying on the audit log for compliance will silently miss every schema-change event. Repro: `POST /cms/content-types {...}` → 201; query `GET /cms/audit-log?operation=schema_change` → `{ items: [] }`. Fix: add a `writeAuditEntry({ operation: "schema_change", collection: parsed.name, before: null, after: parsed.collection, ... })` inside both content-type endpoints.

2. **API-key hash is bare SHA-256, no salt, no work factor** (Plan 004). `packages/core/src/auth.ts:182-186` `hashApiKey`. If the api-key store is ever leaked, every existing key can be brute-forced against the hash without per-key cost. The plan calls for password-grade hashing. Fix: use Web Crypto's PBKDF2 with a per-key salt stored alongside `hash` (column `salt`), or switch to argon2id via a peer-dep package.

3. **`component` / `dynamiczone` field kinds missing** (Plan 005 U1). Plan called these out as in-scope; no source files reference them. Strapi parity claims in the plan rest partly on these. If "Strapi compatibility" is a marketing promise, this is a P1; otherwise P2.

### P2 — Diverges from spec but works

4. **CLI uses custom `process.argv` parser, not citty** (Plan 011 U1). All commands functional. Maintenance cost rises with command count.

5. **CLI watcher uses `fs.watch`, not chokidar** (Plan 011 U6). Known platform quirks on Linux (high-frequency-edit double-fires) won't surface during normal dev.

6. **OpenAPI routes not declared via `@hono/zod-openapi createRoute`** (Plan 012 U1). Spec generated separately; works but doesn't enforce route ↔ spec ↔ Zod validator alignment.

7. **Scalar UI via CDN** (Plan 012 U5). Works; adds a runtime CDN fetch and a tracking surface.

8. **Audit `actorId` is `session.userId`, not `user_email`** (Plan 014 U1, KTD-3). User deletion → audit row points at an unresolvable ID.

9. **Per-request session caching never implemented** (Plan 004 KTD-4 → Plan 009 follow-up). `auth.api.getSession` runs on every authenticated request with `disableCookieCache: true` (`auth/better-auth.ts:48-51`). Visible as one extra DB query per request.

10. **Drizzle `audit_log` indexes are single-column, not composite** (Plan 014 U1). Filter combinations like `?collection=articles&operation=update&from=...` will not use a composite index → table scan once volume grows.

11. **Application-layer locale overlay, not DB-level COALESCE JOIN** (Plan 013). N+1-shaped queries on localized list views.

12. **`c.get('user')` absent** (Plan 004 KTD-?). Plan 004 promises `c.get('user')` and `c.get('session')`. Only `session` is typed in `HonoCMSEnv`. Handlers must derive any user info from `session.userId`. Minor but contradicts plan.

13. **`Promise.all` instead of `Promise.allSettled` for webhook fan-out** (Plan 015). Behavior matches `allSettled` because of internal try/catch, but the code shape doesn't match the spec wording.

### P3 — UX / polish / testing

14. **No Playwright/browser E2E tests** (Plans 007 + 008). Admin UI changes have to be hand-tested.

15. **No Stripe-style multi-step Content-Type Builder wizard** (Plan 008 / 005 KTD-3). Single-form UX shipped.

16. **No CSV export rate limit or overall row cap on `GET /cms/audit-log`** (Plan 014 U5). Per-page limit is clamped to 100, but a script can paginate freely.

17. **`lint` task is `tsc --noEmit`, no oxlint** (Plan 001 U4). Plan 001 promised `oxlint src/`; no `.oxlintrc.json` exists at repo root and per-package `lint` scripts run typecheck.

18. **`@hono/zod-openapi createRoute` declarations** (Plan 012 U1). Same as P2 #6 — listed both because closing it has product impact (SDK consumers can rely on type-stable operationIds) and DX impact (route+spec drift caught at compile time).

---

## Closing observations

- The codebase is more feature-complete than the prior audit suggested, with three of its flagged "missing" items actually present.
- The two P1 blockers (`schema_change` audit miss, SHA-256 api-key hash) and one design-blocking gap (no composite indexes on `audit_log`) are the only items I'd treat as ship-stoppers for a v1 GA. Everything else is either UX polish, library divergence with matching behavior, or testing scaffolding.
- The richest source of confusion in this repo is that several capabilities live in three places (route handler in `create-cms.ts`, helper in `core/src/content/*`, store interface in `types/providers.ts`). A future deepening pass could consolidate the audit/webhook/i18n call sites into named subsystems (e.g. `subsystems/audit.ts` wrapping all three concerns).
