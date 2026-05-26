# Hono CMS — Plans Audit

Requirement-by-requirement implementation audit against all 18 architecture plan files in `docs/plans/`. Each plan's Implementation Units (IUs) are mapped to source evidence and a status: `[x]` complete, `[~]` partial or implementation differs from plan, `[ ]` not implemented.

Audit performed 2026-05-22. Source read: all 18 plan docs + key source files in `packages/core`, `packages/schema`, `packages/jobs`, `packages/cli`, `apps/admin`.

---

## Plan 001 — Monorepo Foundation

| IU | Status | Evidence |
|----|--------|----------|
| Bun workspace with `apps/*`, `examples/*`, `packages/*` | `[x]` | `package.json` workspaces |
| Turborepo v2 `tasks` key for build/dev/test/typecheck/lint | `[x]` | `turbo.json` |
| Package scaffold with shared tsdown build config | `[x]` | `packages/*/package.json` |
| Root scripts delegating to turbo | `[x]` | Root `package.json` |
| oxlint for linting | `[x]` | `.oxlintrc.json` in workspace |

**Status: ✅ Complete**

---

## Plan 002 — Core CMS Runtime

| IU | Status | Evidence |
|----|--------|----------|
| `createCMS` synchronous factory function | `[x]` | `packages/core/src/create-cms.ts:29` |
| Returns `CMSInstance<Collections>` (Hono + providers) | `[x]` | `packages/core/src/types/instance.ts` |
| WinterTC-compliant `cms.fetch(Request) => Promise<Response>` | `[x]` | Hono app's `fetch` method |
| Node HTTP bridge via `@hono-cms/platform/node` | `[x]` | `packages/platform/src/node.ts` |
| Cloudflare Worker export with `fetch` + `scheduled` | `[x]` | `packages/platform/src/cloudflare.ts` |
| Vercel route handler | `[x]` | `packages/platform/src/vercel.ts` |
| Next App Router handlers | `[x]` | `packages/platform/src/next.ts` |
| Provider factory registration system | `[x]` | `packages/core/src/providers/factories.ts`, `registry.ts` |

**Status: ✅ Complete**

---

## Plan 003 — Schema DSL and Typing

| IU | Status | Evidence |
|----|--------|----------|
| All field kinds: string, text, richtext, number, boolean, datetime, date, time, json, email, url, password, uid, enum, media, relation | `[x]` | `packages/schema/src/index.ts:7–23` |
| `defineCollection` with kebab-case validation | `[x]` | `packages/schema/src/index.ts:206–221` |
| `defineSchema` with cross-collection validation | `[x]` | `packages/schema/src/index.ts:223–280` |
| `InferCollectionInput`, `InferCollectionOutput`, `InferCMS` | `[x]` | `packages/schema/src/index.ts:155–174` |
| `fields` DSL object | `[x]` | `packages/schema/src/index.ts:180–204` |
| BCP 47 locale validation in schema | `[x]` | `packages/schema/src/index.ts:283–285` |
| Relation cross-collection and inverse validation | `[x]` | `packages/schema/src/index.ts:259–280` |
| `collectionToZod` for request validation | `[x]` | `packages/schema/src/index.ts:291–341` |

**Status: ✅ Complete**

---

## Plan 004 — Database, Storage, and Cache Adapters

| IU | Status | Evidence |
|----|--------|----------|
| `DatabaseAdapter<Collections>` contract in `@hono-cms/schema` | `[x]` | `packages/schema/src/adapter.ts` |
| `StorageAdapter` contract | `[x]` | `packages/core/src/types/providers.ts:64` |
| `CacheAdapter` contract with `checkRateLimit`, `sweep` | `[x]` | `packages/core/src/types/providers.ts:75` |
| Memory DB adapter | `[x]` | `packages/adapter-memory/src/index.ts` |
| D1 adapter | `[x]` | `packages/adapter-d1/src/index.ts` |
| Postgres adapter | `[x]` | `packages/adapter-postgres/src/index.ts` |
| Turso adapter | `[x]` | `packages/adapter-turso/src/index.ts` |
| Convex adapter | `[x]` | `packages/adapter-convex/src/index.ts` |
| `adapter-kit` shared helpers | `[x]` | `packages/adapter-kit/src/index.ts` |
| Memory storage | `[x]` | `packages/storage-memory/src/index.ts` |
| Local filesystem storage | `[x]` | `packages/storage-local/src/index.ts` |
| S3 storage | `[x]` | `packages/storage-s3/src/index.ts` |
| Cloudflare R2 storage | `[x]` | `packages/storage-r2/src/index.ts` |
| Vercel Blob storage | `[x]` | `packages/storage-vercel-blob/src/index.ts` |
| Cache package (Upstash/KV/memory providers) | `[x]` | `packages/cache/src/index.ts` |

**Status: ✅ Complete**

---

## Plan 005 — REST Content API

| IU | Status | Evidence |
|----|--------|----------|
| CRUD endpoints for all collections at `/api/:collection` | `[x]` | `packages/core/src/create-cms.ts` |
| Query parsing: filters, sort, cursor/page pagination | `[x]` | `packages/core/src/content/query.ts` |
| Relation population with depth limit 3, budget 100 | `[x]` | `packages/core/src/content/populate.ts:6–7` |
| Field projection including RBAC-aware | `[x]` | `packages/core/src/content/projection.ts` |
| Content caching and invalidation | `[x]` | `packages/core/src/content/cache.ts` |
| Draft/publish state machine endpoints | `[x]` | `packages/core/src/content/publish.ts` |
| Locale variant overlay and fallback chain | `[x]` | `packages/core/src/content/i18n.ts`, `translation.ts` |
| Media upload, presign, confirm, delete | `[x]` | `packages/core/src/media.ts` |
| Preview token create/revoke | `[x]` | `packages/core/src/content/preview.ts` |
| Soft-delete relation constraint checks | `[x]` | `packages/core/src/content/delete.ts` |

**Status: ✅ Complete**

---

## Plan 006 — GraphQL API

| IU | Status | Evidence |
|----|--------|----------|
| Generated SDL from collections | `[x]` | `packages/core/src/graphql.ts` |
| Query and mutation handlers | `[x]` | `packages/core/src/graphql.ts` |
| Relation population and relation filters | `[x]` | `packages/core/src/graphql.ts` |
| Introspection configurable, disabled in production | `[x]` | `packages/core/src/types/config.ts:58` |

**Status: ✅ Complete**

---

## Plan 007 — Admin SPA

| IU | Status | Evidence |
|----|--------|----------|
| Vite React app with shadcn/ui, Tailwind 4 | `[x]` | `apps/admin/components.json`, `apps/admin/package.json` |
| TanStack Router, Query, Table, Virtual, Form, Pacer, Hotkeys | `[x]` | `apps/admin/package.json` |
| Jotai, nuqs, qs, Tiptap | `[x]` | `apps/admin/package.json` |
| Content list and editor views | `[x]` | `apps/admin/src/app/content.$collectionName.tsx` etc. |
| Media library and picker | `[x]` | `apps/admin/src/app/media.tsx` |
| Health dashboard | `[x]` | `apps/admin/src/app/settings.health.tsx` |
| Audit log viewer | `[x]` | `apps/admin/src/app/settings.audit-log.tsx` |
| Webhook settings and delivery history | `[x]` | `apps/admin/src/app/settings.webhooks.tsx` |
| API key management | `[x]` | `apps/admin/src/app/settings.api-keys.tsx` |
| Sessions settings | `[x]` | `apps/admin/src/app/settings.sessions.tsx` |
| Content-Type Builder view | `[x]` | `apps/admin/src/app/settings.content-types.tsx` |
| i18n settings page | `[x]` | `apps/admin/src/app/settings.i18n.tsx` |
| Organization settings, members, invitations | `[x]` | `apps/admin/src/app/organization.*.tsx` |
| Auth flows (login, 2FA, magic link, register) | `[x]` | `apps/admin/src/app/login.tsx` etc. |
| Playwright/automated browser E2E tests | `[ ]` | Not present — dev smoke harness exists at `?cmsSmoke=content-types` only |

**Status: `[~]` Partial — browser E2E coverage absent**

---

## Plan 008 — Content-Type Builder

| IU | Status | Evidence |
|----|--------|----------|
| `POST /cms/content-types` and `PUT /cms/content-types/:name` | `[x]` | `packages/core/src/create-cms.ts:108–146` |
| `SchemaWriter` interface with `writeCollection` + `afterWrite` | `[x]` | `packages/core/src/types/config.ts:83–91` |
| `generateCollectionFile` source generation | `[x]` | `packages/schema/src/file-writer.ts` |
| Server-side validation for all field kinds and options | `[x]` | `packages/core/src/create-cms.ts` — `validateContentTypeChange` |
| Client-side validation (names, ranges, enum, relation, uid) | `[x]` | `apps/admin/src/components/AdminApp.tsx` |
| Generated artifact summary returned after save | `[x]` | `contentTypeWriteResponse` in `create-cms.ts` |
| Pre-save API preview with workflow steps, SDK shape, copy actions | `[x]` | `apps/admin/src/app/settings.content-types.tsx` |
| Dev smoke harness at `?cmsSmoke=content-types` | `[x]` | `apps/admin/src/app/settings.content-types.tsx` |
| Dedicated Stripe-style multi-step wizard flow | `[ ]` | Not implemented — single form, no progressive step UX |
| Browser E2E test (admin UI against real running app) | `[ ]` | Not present |
| Browser E2E test inside Next-hosted setup | `[ ]` | Not present (lower-level route handler test exists in `examples/next-app`) |

**Status: `[~]` Partial — functional but not wizard-level UX; no browser E2E**

---

## Plan 009 — Auth, RBAC, Sessions, Organizations

| IU | Status | Evidence |
|----|--------|----------|
| Static bearer-token auth for dev/test | `[x]` | `packages/core/src/auth.ts` |
| API key hashing (argon-style), prefixes, enabled state | `[x]` | `packages/core/src/auth.ts` — `hashApiKey`, `apiKeyPrefix` |
| API key CRUD admin endpoints | `[x]` | `packages/core/src/create-cms.ts:278–340` |
| Better Auth integration helpers | `[x]` | `packages/core/src/auth/better-auth.ts` |
| Auth schema snapshot generation | `[x]` | `packages/core/src/auth/schema.ts` |
| Collection-level RBAC | `[x]` | `packages/core/src/content/rbac.ts` |
| Field-level read/write permissions | `[x]` | `packages/core/src/content/projection.ts` |
| Organization settings, members, invitations, revocation | `[x]` | `packages/core/src/organization.ts`, `create-cms.ts:342–430` |

**Status: ✅ Complete**

---

## Plan 010 — Background Jobs and Crons

| IU | Status | Evidence |
|----|--------|----------|
| `JobsAdapter` interface | `[x]` | `packages/core/src/types/providers.ts` |
| `CronsConfig` discriminated union (memory/none/qstash/cloudflare/vercel) | `[x]` | `packages/jobs/src/index.ts:4–57` |
| `MemoryJobsAdapter` and `NoneJobsAdapter` | `[x]` | `packages/jobs/src/index.ts:62–125` |
| `QStashJobsAdapter` with signing key validation and `bootstrapSchedules` | `[x]` | `packages/jobs/src/index.ts:127–228` |
| `VercelJobsAdapter` with HMAC-SHA256 verify and `generateVercelJson` | `[x]` | `packages/jobs/src/index.ts:302–368` |
| `CloudflareJobsAdapter` with `cronMap` dispatch and queue fallback | `[x]` | `packages/jobs/src/index.ts:230–298` |
| Job HTTP endpoints at `/cms/jobs/*` | `[x]` | `packages/core/src/create-cms.ts:546–600` |
| `webhookRetryJob` (30 s → 5 min → 1 hr backoff, max 3 attempts) | `[x]` | `packages/core/src/create-cms.ts:557–563`, `packages/core/src/webhooks.ts` |
| `scheduledPublishJob` (batch=100, idempotent) | `[x]` | `packages/core/src/content/publish.ts:58–78` |
| `auditLogCleanupJob` | `[x]` | `packages/core/src/audit.ts:67–82` |
| `cacheSweepJob` | `[x]` | `packages/core/src/create-cms.ts:556` |
| Provider registration at module init | `[x]` | `packages/jobs/src/index.ts:426–430` |

**Status: ✅ Complete**

---

## Plan 011 — CLI Tooling

| IU | Status | Evidence |
|----|--------|----------|
| CLI binary entry with shebang | `[x]` | `packages/cli/src/index.ts:1` (`#!/usr/bin/env node`) |
| `cms schema plan` | `[x]` | `packages/cli/src/index.ts:2157` |
| `cms schema apply` with lock file and `--allow-destructive` | `[x]` | `packages/cli/src/index.ts:2165`, lock file at `:1967` |
| `cms schema check --assert-clean` CI gate | `[x]` | `packages/cli/src/index.ts:2147` |
| `cms schema generate` with `--check` drift mode | `[x]` | `packages/cli/src/index.ts:2071` |
| `cms schema openapi`, `drizzle`, `drizzle-config` commands | `[x]` | `packages/cli/src/index.ts:2079–2120` |
| `cms schema check-sdk`, `check-openapi`, `check-drizzle` | `[x]` | `packages/cli/src/index.ts:2021–2054` |
| `cms schema drizzle-generate`, `drizzle-migrate` | `[x]` | `packages/cli/src/index.ts:2124` |
| `cms dev` with file watcher and admin SPA proxy | `[x]` | `packages/cli/src/index.ts:2246` |
| `cms init` preset wizard | `[x]` | `packages/cli/src/index.ts:2298` |
| `cms deploy --target` template generation | `[x]` | `packages/cli/src/index.ts:2320` |
| `cms doctor` health checks | `[x]` | `packages/cli/src/index.ts:2361` |
| `cms seed` runner | `[x]` | `packages/cli/src/index.ts` |
| `cms build` multi-artifact generation | `[x]` | `packages/cli/src/index.ts:2188` |
| CLI framework: **citty** (planned) | `[~]` | **Uses custom Node.js argument parsing, not citty.** All commands functional. |
| File watcher: **chokidar** (planned) | `[~]` | **Uses Node.js native `fs.watch`, not chokidar.** |
| Interactive init: **@clack/prompts** (planned) | `[~]` | **Custom readline-style prompts, not @clack/prompts.** |

**Status: `[~]` Partial — all commands functional; implementation uses custom parsing rather than planned external libraries (citty, chokidar, @clack/prompts)**

---

## Plan 012 — OpenAPI and Scalar Docs

| IU | Status | Evidence |
|----|--------|----------|
| OpenAPI 3.1 spec generated from collections | `[x]` | `packages/core/src/openapi.ts`, `packages/schema/src/index.ts:674` |
| Spec served at configurable path with ETag caching | `[x]` | `packages/core/src/create-cms.ts:152–165` — checks `if-none-match`, returns 304 |
| Scalar docs UI disabled in production by default | `[x]` | `packages/core/src/create-cms.ts:1758–1762` — `production && !explicitDocsPath ? undefined` |
| Scalar UI via CDN script tag | `[x]` | `packages/core/src/create-cms.ts:1741` — `@scalar/api-reference` CDN |
| OpenAPI CORS support | `[x]` | `packages/core/src/create-cms.ts` — `applyOpenAPICorsHeaders` |
| `stable operationId` convention for SDK readiness | `[~]` | OpenAPI spec is generated but routes are NOT declared with `@hono/zod-openapi` `createRoute`; operationId stability is not verified per-route |
| Routes declared with `@hono/zod-openapi` `createRoute` | `[ ]` | **Not implemented.** Standard Hono routes used; spec is generated separately by `createOpenAPISpec`. |
| `@scalar/hono-api-reference` npm package | `[ ]` | **Not used.** CDN script tag used instead. |
| `x-cms-filter-syntax` extension on query params | `[ ]` | Not present in generated spec |

**Status: `[~]` Partial — spec, ETag caching, and Scalar UI work; route-level zod-openapi declarations and `@scalar/hono-api-reference` package not used**

---

## Plan 013 — AI-Powered i18n

| IU | Status | Evidence |
|----|--------|----------|
| `CollectionOptions.i18n` with locales + defaultLocale | `[x]` | `packages/schema/src/index.ts:114–121` |
| BCP 47 locale validation | `[x]` | `packages/schema/src/index.ts:283–285` |
| `localeFallbackChain` (`es-MX → es → default`) | `[x]` | `packages/core/src/content/i18n.ts:23–33` |
| `listWithLocaleFallback` for locale-aware queries | `[x]` | `packages/core/src/content/i18n.ts:44–60` |
| `TranslationStore` interface | `[x]` | `packages/core/src/types/providers.ts` |
| `MemoryTranslationStore` | `[x]` | `packages/core/src/content/translation.ts:5–43` |
| `translateDocument` function | `[x]` | `packages/core/src/content/translation.ts:106–175` |
| `enqueueTranslationJobs` | `[x]` | `packages/core/src/content/translation.ts:92–104` |
| `overlayLocaleVariants` post-query overlay | `[x]` | `packages/core/src/content/translation.ts:81–89` |
| Per-document locale endpoints (`GET/POST/PATCH/PUT /api/:col/:id/locales`) | `[x]` | `packages/core/src/create-cms.ts:836–938` |
| Admin i18n backfill + status endpoints | `[x]` | `packages/core/src/create-cms.ts:477–543` |
| Translation job at `/cms/jobs/translation` | `[x]` | `packages/core/src/create-cms.ts:565–581` |
| Admin i18n settings page | `[x]` | `apps/admin/src/app/settings.i18n.tsx` |
| `createAIProvider` factory (Anthropic/OpenAI/Gateway) | `[ ]` | **Not implemented.** `TranslationProvider` is an interface only. Users must supply their own implementation. |
| Drizzle-generated `{collection}_locale_variants` table | `[ ]` | **Not implemented.** `drizzle-generator.ts` generates no locale variant tables. DB adapters do not implement `TranslationStore`. Only `MemoryTranslationStore` exists — data lost on restart. |
| DB-level COALESCE JOIN for locale-aware queries | `[ ]` | **Not implemented.** Application-level overlay used instead (post-query via `overlayLocaleVariants`). |

**Status: `[~]` Partial — core i18n routing, fallback chains, translation jobs, admin UI all implemented; concrete AI provider factory and database-backed locale variant persistence are missing**

---

## Plan 014 — Audit Log

| IU | Status | Evidence |
|----|--------|----------|
| `computeDiff` with `excludeFields` and 10 KB truncation | `[x]` | `packages/core/src/audit.ts:45–65` |
| `writeAuditEntry` (synchronous, errors swallowed) | `[x]` | `packages/core/src/audit.ts:84–112` |
| `MemoryAuditStore` with `append`, `list`, `cleanup`, `health` | `[x]` | `packages/core/src/audit.ts:8–43` |
| `auditLogCleanupJob` with configurable retention | `[x]` | `packages/core/src/audit.ts:67–82` |
| `auditEntriesToCSV` | `[x]` | `packages/core/src/audit.ts:114–118` |
| `GET /cms/audit-log` with cursor pagination, filters, CSV export | `[x]` | `packages/core/src/create-cms.ts:200–213` |
| Always-on (never enterprise-gated) | `[x]` | Core feature, no plan tier gate |
| `actorEmail` denormalized on entries | `[~]` | **Uses `actorId: session.userId` (userId), not user email.** Plan specified `user_email` for audit permanence. |
| CSV export rate limiting (10 req/hour/admin) | `[ ]` | Not present in endpoint handler |
| CSV export 100 K row cap | `[ ]` | Not present |
| Drizzle-backed AuditStore in any adapter | `[ ]` | **Not implemented.** Only `MemoryAuditStore` — data lost on restart without custom implementation. |

**Status: `[~]` Partial — core diff, write, cleanup, and CSV export work; no DB-backed store; actorId is userId not email; no export rate limit or row cap**

---

## Plan 015 — Webhooks

| IU | Status | Evidence |
|----|--------|----------|
| `MemoryWebhookStore` (webhooks + deliveries) | `[x]` | `packages/core/src/webhooks.ts:3–65` |
| Two-layer model (static config + DB-managed) | `[x]` | `packages/core/src/webhooks.ts:74–87` — `staticTargets` + `managedTargets` |
| `dispatchWebhooks` with `Promise.allSettled` fan-out | `[x]` | `packages/core/src/webhooks.ts:67–98` |
| `deliverWebhook` with 10 s timeout | `[x]` | `packages/core/src/webhooks.ts:100–` |
| `createHmacSignature` via Web Crypto API, `X-CMS-Signature` | `[x]` | `packages/core/src/webhooks.ts:122,169,283–286` |
| Event pattern matching (glob-style, no regex) | `[x]` | `packages/core/src/webhooks.ts` — `matchesEventPattern` |
| Async retry via jobs with backoff | `[x]` | `packages/core/src/webhooks.ts:94–97` — enqueues with `nextWebhookRetryDelay` |
| `retryFailedWebhookDelivery` | `[x]` | `packages/core/src/webhooks.ts` |
| `deliverWebhookTest` (synchronous, no retry) | `[x]` | `packages/core/src/webhooks.ts` |
| Webhook CRUD admin endpoints (GET/POST/PATCH/PUT/DELETE) | `[x]` | `packages/core/src/create-cms.ts:215–268` |
| Webhook delivery list endpoint | `[x]` | `packages/core/src/create-cms.ts:270–276` |
| Webhook retry endpoint | `[x]` | `packages/core/src/create-cms.ts:432–445` |
| Secrets stored plaintext, masked on read, one-time exposure | `[x]` | `serializeWebhook` / `serializeWebhookListItem` in `create-cms.ts` — `hasSecret` field |
| 2 KB response truncation on delivery | `[x]` | `packages/core/src/webhooks.ts` |

**Status: ✅ Complete**

---

## Plan 016 — Draft/Publish State Machine

| IU | Status | Evidence |
|----|--------|----------|
| `publishDocument`, `unpublishDocument` with idempotency | `[x]` | `packages/core/src/content/publish.ts:15–37` |
| `schedulePublish`, `unschedulePublish` | `[x]` | `packages/core/src/content/publish.ts:40–55` |
| `runScheduledPublishes` batch=100 | `[x]` | `packages/core/src/content/publish.ts:58–78` |
| `normalizeDraftInput`, `stripSystemDraftFields` | `[x]` | `packages/core/src/content/publish.ts:5–13` |
| Single-row model: `status` + `publishedAt` columns | `[x]` | `packages/schema/src/drizzle-generator.ts:73–74` |
| Draft/publish REST endpoints at `/api/:collection/:id/publish` etc. | `[x]` | `packages/core/src/create-cms.ts` |
| `generatePreviewToken` (64-char hex via `crypto.getRandomValues`, cache TTL) | `[x]` | `packages/core/src/content/preview.ts:18–36` |
| `verifyPreviewToken` (cache-backed, not JWT) | `[x]` | `packages/core/src/content/preview.ts:38–44` |
| `revokePreviewToken` (cache DELETE) | `[x]` | `packages/core/src/content/preview.ts:46–49` |
| Preview token endpoints at `/api/preview-tokens` | `[x]` | `packages/core/src/create-cms.ts:447–475` |
| Draft filter applied to populated relations | `[x]` | `packages/core/src/content/populate.ts:124` — `options.status !== 'published' || child.status === 'published'` |
| Status-aware public queries (role-based filter) | `[x]` | `publicStatusFilter` in `create-cms.ts` |

**Status: ✅ Complete**

---

## Plan 017 — Relations and SDK Types

| IU | Status | Evidence |
|----|--------|----------|
| `RelationField` with full cardinality: one, many, one-to-one, many-to-one, one-to-many, many-to-many | `[x]` | `packages/schema/src/index.ts:70–79, 81` |
| `onDelete` constraint options per cardinality | `[x]` | `packages/schema/src/index.ts:83–92` |
| Drizzle FK columns (`{field}Id`) for owning relations | `[x]` | `packages/schema/src/drizzle-generator.ts:95–103` |
| Drizzle join tables for many-to-many | `[x]` | `packages/schema/src/drizzle-generator.ts:167–196` |
| Drizzle `relations()` helper generation | `[x]` | `packages/schema/src/drizzle-generator.ts:223–255` |
| `parsePopulateParams` + `populateRecords` with `MAX_POPULATE_DEPTH=3`, `MAX_POPULATE_NODES=100` | `[x]` | `packages/core/src/content/populate.ts:6–7, 81–143` |
| `generateTypeScriptSDK` producing committed `.ts` source | `[x]` | `packages/schema/src/index.ts:343–671` |
| SDK types: `{Type}`, `{Type}Populated`, `{Type}RelationKey`, `{Type}Query`, `{Type}CreateInput`, `{Type}UpdateInput` | `[x]` | `packages/schema/src/index.ts:463–519` |
| `buildQuery<T>` with `DeepFilters<T>` | `[x]` | `packages/schema/src/index.ts:415–417` |
| `createCMSClient` factory with full CRUD, draft/publish, i18n methods | `[x]` | `packages/schema/src/index.ts:593–668` |
| Alphabetically sorted SDK output | `[x]` | `orderedCollections` sort at `index.ts:344` |
| Schema hash fingerprint in generated file | `[x]` | `packages/schema/src/index.ts:349` — `// schemaHash:` comment |
| SDK committed to git in examples | `[x]` | `examples/newsroom/src/generated/sdk.ts` |
| RBAC enforcement on relation populate | `[x]` | `packages/core/src/content/populate.ts:137` — applies `projectRecord` with session |

**Status: ✅ Complete**

---

## Plan 018 — Health Checks

| IU | Status | Evidence |
|----|--------|----------|
| `runHealthChecks` with `Promise.all` parallel execution | `[x]` | `packages/core/src/health.ts:15–25` |
| `withTimeout` wrapping each check (2 s default) | `[x]` | `packages/core/src/health.ts:47–59` — `timeoutMs ?? 2000` in create-cms.ts |
| `sanitizeError` to redact credentials from messages | `[x]` | `packages/core/src/health.ts:61–66` |
| `startedAt = Date.now()` captured in `createCMS` | `[x]` | `packages/core/src/create-cms.ts:30` |
| `/cms/health/live` — zero I/O liveness | `[x]` | `packages/core/src/create-cms.ts:65` |
| `/cms/health` — full health report | `[x]` | `packages/core/src/create-cms.ts:66–75` |
| `/cms/health/ready` — readiness check | `[x]` | `packages/core/src/create-cms.ts:76–85` |
| Always enabled (no config toggle) | `[x]` | Endpoints always registered, no `if (config.health)` gate |
| `health?()` on all adapter interfaces | `[x]` | `StorageAdapter`, `CacheAdapter`, `JobsAdapter`, `DatabaseAdapter`, `AuditStore`, `MediaStore` all have optional `health()` |
| `SubsystemHealth` type in `@hono-cms/schema` for cross-package sharing | `[~]` | **Type is `HealthStatus` (in `packages/schema/src/adapter.ts`), not `SubsystemHealth` as named in the plan.** Functionally equivalent. |

**Status: ✅ Complete** (type is named `HealthStatus` instead of `SubsystemHealth`)

---

## Summary Table

| Plan | Title | Status | Key Gaps |
|------|-------|--------|----------|
| 001 | Monorepo Foundation | `[x]` | — |
| 002 | Core CMS Runtime | `[x]` | — |
| 003 | Schema DSL and Typing | `[x]` | — |
| 004 | Adapters | `[x]` | — |
| 005 | REST Content API | `[x]` | — |
| 006 | GraphQL API | `[x]` | — |
| 007 | Admin SPA | `[~]` | Browser E2E absent |
| 008 | Content-Type Builder | `[~]` | Wizard UX; browser E2E absent |
| 009 | Auth/RBAC/Organizations | `[x]` | — |
| 010 | Background Jobs and Crons | `[x]` | — |
| 011 | CLI Tooling | `[~]` | Custom arg parsing instead of citty; native `fs.watch` instead of chokidar; no `@clack/prompts` |
| 012 | OpenAPI and Scalar Docs | `[~]` | No `@hono/zod-openapi` `createRoute`; Scalar via CDN not npm; no `x-cms-filter-syntax` |
| 013 | AI-Powered i18n | `[~]` | No `createAIProvider` factory; no Drizzle-backed locale variants table; no DB-level COALESCE join |
| 014 | Audit Log | `[~]` | No DB-backed AuditStore; `actorId` is userId not email; no CSV export rate limit or row cap |
| 015 | Webhooks | `[x]` | — |
| 016 | Draft/Publish State Machine | `[x]` | — |
| 017 | Relations and SDK Types | `[x]` | — |
| 018 | Health Checks | `[x]` | Minor: type named `HealthStatus` not `SubsystemHealth` |

---

## Prioritized Gap Register

### P1 — Functional gaps affecting production deployments

**All P1 gaps closed in this branch.** See `docs/plans-audit-verification.md` for the re-verification.

| # | Gap | Status |
|---|-----|--------|
| G-1 | ~~No concrete AI translation provider~~ | ✅ **Closed.** `createAIProvider` factory at `packages/core/src/content/ai-provider.ts` (Anthropic, OpenAI, AI Gateway, custom). |
| G-2 | ~~No Drizzle-backed `TranslationStore`~~ | ✅ **Closed.** `createDrizzleTranslationStore` at `packages/core/src/content/drizzle-translation-store.ts` (sqlite + postgres dialects). `locale_variants` table now emitted by `generateDrizzleSchema` when any collection enables i18n. |
| G-3 | ~~No Drizzle-backed `AuditStore`~~ | ✅ **Closed.** `createDrizzleAuditStore` at `packages/core/src/audit/drizzle-audit-store.ts` (sqlite + postgres dialects, base64url `(createdAt, id)` keyset cursor). `audit_log` table now emitted by `generateDrizzleSchema` by default. |

### P2 — Implementation diverges from plan spec

| # | Gap | Impact |
|---|-----|--------|
| G-4 | **CLI uses custom arg parsing, not citty** (Plan 011 U1) | All commands functional. No external CLI framework dependency. Maintenance burden if the CLI grows. |
| G-5 | **CLI uses `fs.watch`, not chokidar** (Plan 011 U6) | Dev watch mode works. Native `fs.watch` has known edge cases on some platforms (Linux high-freq edits). |
| G-6 | **OpenAPI routes not declared with `@hono/zod-openapi`** (Plan 012 U1) | Spec is generated separately. Route types not derived from Zod schemas. Request validation via `collectionToZod` is separate from OpenAPI spec. No `operationId` stability guarantee per-route. |
| G-7 | **Scalar UI via CDN, not `@scalar/hono-api-reference` npm package** (Plan 012 U5) | Functionally equivalent but adds CDN dependency and network fetch for docs. |
| G-8 | **`actorId` is `userId` not `user_email`** (Plan 014 KTD-3) | Audit log records user ID rather than email. If a user account is deleted, the actor is an unresolvable ID rather than a permanent email string. |

### P3 — Missing UX and testing coverage

| # | Gap | Impact |
|---|-----|--------|
| G-9 | **No Playwright/browser E2E tests** (Plans 007, 008) | Admin UI correctness relies on manual testing and unit-level DOM tests only. |
| G-10 | **No Stripe-level guided Content-Type Builder wizard** (Plan 008) | Current UX is a single form. The plan described a progressive multi-step wizard with clear task-completion states. |
| G-11 | **No CSV export rate limiting or row cap on audit log** (Plan 014 U5) | A high-volume audit log could produce very large exports without guard rails. |
| G-12 | **No `x-cms-filter-syntax` extension in OpenAPI spec** (Plan 012) | OpenAPI consumers cannot discover the CMS filter syntax from the spec. |

### P4 — Documentation and deployment gaps (already tracked)

| # | Gap |
|---|-----|
| G-13 | Complete public documentation (admin guide, adapter guide, plugin guide, migration guide, ops guide) |
| G-14 | Provider-account-specific production deployment walkthroughs for all adapter/storage combinations |
| G-15 | Real hosted-provider smoke tests |

---

## Verification Evidence

Audit based on direct source reads of:

- `packages/core/src/create-cms.ts` (2046 lines)
- `packages/core/src/content/populate.ts`, `i18n.ts`, `translation.ts`, `publish.ts`, `preview.ts`
- `packages/core/src/audit.ts`, `webhooks.ts`, `health.ts`
- `packages/core/src/types/config.ts`, `providers.ts`
- `packages/schema/src/index.ts` (886 lines), `drizzle-generator.ts` (324 lines), `migrations.ts`
- `packages/jobs/src/index.ts` (430 lines)
- `packages/cli/src/index.ts` (2485 lines)
- `apps/admin/src/app/*.tsx` (route file listing)
- All 18 plan files in `docs/plans/`
