# Plans Audit Verification — 2026-05-22

Re-verifies `docs/plans-audit.md` by spot-checking 3 IUs per plan against the current source.

## Methodology

- Random sampling skewed toward IUs with specific line references and large cited files (`create-cms.ts` at 2046 lines, `cli/src/index.ts` at 2485 lines, `schema/src/index.ts` at 886 lines, `jobs/src/index.ts` at 430 lines).
- Cross-checks read function signatures, route registrations, table schemas, and exported symbols.
- Verification scale:
  - `OK` verified-accurate (line number / claim matches)
  - `DRIFT` minor-drift (e.g. line off by a small N, or wording slightly inaccurate; behavior intact)
  - `FALSE` false-claim (feature genuinely missing or substantially different from claim)

## Per-Plan Results

### Plan 001 — Monorepo Foundation
- IU "Bun workspace with apps/examples/packages": OK — workspaces listed in root `package.json`.
- IU "Turborepo v2 `tasks` key": OK — `turbo.json` present at root.
- IU "oxlint for linting": OK — `.oxlintrc.json` present.

(All Plan 001 IUs are file-presence checks with no line refs; sampling additional IUs is redundant.)

### Plan 002 — Core CMS Runtime
- IU "`createCMS` synchronous factory at `create-cms.ts:29`": OK — `export function createCMS<...>(config): CMSInstance<Collections>` is exactly at line 29.
- IU "`startedAt = Date.now()` captured in `createCMS`": OK — line 30 (`const startedAt = Date.now();`) — also referenced by Plan 018.
- IU "Provider factory registration system at `providers/factories.ts`, `registry.ts`": OK — directory `packages/core/src/providers/` contains both files (referenced by plan 002 + 010 alike).

### Plan 003 — Schema DSL and Typing
- IU "All field kinds at `index.ts:7–23`": OK — `FieldKind` union literally lists string, text, richtext, number, boolean, datetime, date, time, json, email, url, password, uid, enum, media, relation in that range.
- IU "`defineCollection` with kebab-case validation at `index.ts:206–221`": OK — function header at 206, kebab-case regex check at 211, closes at 221.
- IU "`fields` DSL object at `index.ts:180–204`": OK — `export const fields = { string: ..., ..., relation: ... };` spans 180-204 exactly.

### Plan 004 — Database, Storage, and Cache Adapters
- IU "`DatabaseAdapter<Collections>` at `packages/schema/src/adapter.ts`": OK — adapter.ts exists; type `HealthStatus` exported at line 82 (also relevant to Plan 018).
- IU "Memory DB adapter at `packages/adapter-memory/src/index.ts`": OK — file present.
- IU "Cache package at `packages/cache/src/index.ts`": OK — package directory exists. (File-presence IUs; thin verification, but the existence claims are accurate.)

### Plan 005 — REST Content API
- IU "Relation population with depth limit 3, budget 100 at `content/populate.ts:6–7`": OK — `MAX_POPULATE_DEPTH = 3` at line 6 and `MAX_POPULATE_NODES = 100` at line 7 verbatim.
- IU "Query parsing: `content/query.ts`": OK — `parseQueryParams` at line 43, `applyListQuery` at 87, cursor encode/decode at 119/124.
- IU "Soft-delete relation constraint checks at `content/delete.ts`": OK — `deleteWithRelationPolicy` exported at line 21, `RelationConstraintError` at line 3.

### Plan 006 — GraphQL API
- IU "Introspection configurable at `types/config.ts:58`": OK — `GraphQLConfig.introspection` documented at lines 58-59 with "disabled in production unless explicitly enabled".
- IU "Generated SDL from collections at `packages/core/src/graphql.ts`": OK — file present; spot-checked existence.
- IU "Query and mutation handlers": OK — `handleGraphQL` used at create-cms.ts:189-195 and limited via rate limiter for mutations.

### Plan 007 — Admin SPA
- IU "Content list at `app/content.$collectionName.tsx`": OK — file exists in `apps/admin/src/app/`.
- IU "Audit log viewer at `app/settings.audit-log.tsx`": OK — file exists.
- IU "Playwright/automated browser E2E tests: NOT PRESENT": OK — checked there are no `playwright.config.*` or `tests/e2e/` directories; consistent with claim.

### Plan 008 — Content-Type Builder
- IU "`POST /cms/content-types` and `PUT /cms/content-types/:name` at `create-cms.ts:108–146`": OK — POST at line 108, PUT at line 127, block ends at 146 exactly.
- IU "`SchemaWriter` interface at `types/config.ts:83–91`": OK — `export type SchemaWriter = { ... writeCollection(...) ... afterWrite?(...) ... }` spans 83-91 verbatim.
- IU "Server-side validation `validateContentTypeChange`": OK — called at create-cms.ts:119 and 140; function exists.

### Plan 009 — Auth, RBAC, Sessions, Organizations
- IU "API key CRUD admin endpoints at `create-cms.ts:278–340`": OK — GET at 278, POST at 288, PATCH at 310, DELETE at 332. Block closes at 340 verbatim.
- IU "API key hashing/prefixes in `auth.ts`": OK — `hashApiKey` at line 182 and `apiKeyPrefix` at 194 in `packages/core/src/auth.ts`.
- IU "Organization endpoints at `create-cms.ts:342–430`": OK — organization GET at 342, members PATCH at 370, invitations POST at 405, revoke at 419, block ends at 430.

### Plan 010 — Background Jobs and Crons
- IU "`CronsConfig` discriminated union at `jobs/src/index.ts:4–57`": OK — provider configs for memory, none, vercel, qstash, cloudflare span lines 4-57.
- IU "`VercelJobsAdapter` with HMAC-SHA256 verify at `jobs/src/index.ts:302–368`": OK — class at 302, `verify()` does HMAC-SHA256 at 327-335, `generateVercelJson` at 350, helper boundary ends at 368 verbatim.
- IU "Provider registration at `jobs/src/index.ts:426–430`": OK — five `registerProvider(...)` calls at lines 426-430 verbatim.

### Plan 011 — CLI Tooling
- IU "`cms schema apply` with lock file at `cli/src/index.ts:2165`, lock at `:1967`": OK — schema apply at line 2165; lock-file collision error at line 1967.
- IU "`cms schema generate` at `cli/src/index.ts:2071`": OK — exact line.
- IU "`cms doctor` at `cli/src/index.ts:2361`": DRIFT — actual `doctor` command handler is at line **2213**. Line 2361 is the `cms info` command. The audit's line reference is ~148 lines off, but the doctor command itself is present and functional.

(Additional minor line drifts noticed across the CLI section: `cms init` audited at 2298 vs actual 2289; `cms deploy` audited at 2320 vs actual 2329; `cms dev` audited at 2246 vs actual 2245; `cms build` audited at 2188 vs actual 2187. All small; commands exist.)

### Plan 012 — OpenAPI and Scalar Docs
- IU "Spec served with ETag caching at `create-cms.ts:152–165`": OK — `if-none-match` check at 152, 304 response at 153, block closes at 156-165 (etag handling spans range).
- IU "Scalar docs UI disabled in production at `create-cms.ts:1758–1762`": OK — `const docsPath = production && !explicitDocsPath ? undefined : ...` at line 1762.
- IU "Scalar UI via CDN script at `create-cms.ts:1741`": OK — `<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference">` at line 1741 verbatim.

### Plan 013 — AI-Powered i18n
- IU "`localeFallbackChain` at `content/i18n.ts:23–33`": OK — function at 23, returns deduped chain ending at 33.
- IU "`translateDocument` at `content/translation.ts:106–175`": OK — function at 106, returns LocaleVariant | Response, error path at 163-174 closes at 175.
- IU "`createAIProvider` factory (Anthropic/OpenAI/Gateway) — Not implemented": **FALSE** — `createAIProvider` is fully implemented at `packages/core/src/content/ai-provider.ts:212`. It handles `anthropic` (via `createAnthropicProvider`), `openai` and `ai-gateway` (via OpenAI-compatible chat completions endpoint), and `custom`. The file is 237 lines and has working Anthropic + OpenAI HTTP clients with response validation. The audit's "Not implemented. TranslationProvider is an interface only." claim is wrong.
- IU "Drizzle-generated locale variant table — Not implemented": **FALSE** — `createDrizzleTranslationStore` exists at `packages/core/src/content/drizzle-translation-store.ts:35` (282 lines), supports both `sqlite` and `postgres` dialects via dynamic imports of `drizzle-orm/sqlite-core` and `drizzle-orm/pg-core`, defines a `locale_variants` table with unique index on `(collection, document_id, locale)`, and implements `getVariant`, `listVariants`, `upsertVariant`, and `health`. The audit's "Only `MemoryTranslationStore` exists — data lost on restart" claim is wrong. (Caveat: the table is a single shared `locale_variants` table, not the per-collection `{collection}_locale_variants` tables the plan mentioned, so the IU is partial but not absent.)

### Plan 014 — Audit Log
- IU "`computeDiff` with 10 KB truncation at `audit.ts:45–65`": OK — function at 45, `maxFieldBytes = 10 * 1024` at 47, block closes at 65.
- IU "`MemoryAuditStore` at `audit.ts:8–43`": OK — class at 8, `append`/`list`/`cleanup`/`health` all present, ends at 43.
- IU "`actorId` is `userId` not `user_email`": OK — confirmed at audit.ts:107 (`if (options.session?.userId) entry.actorId = options.session.userId;`). The audit's drift claim is accurate.
- IU "Drizzle-backed AuditStore — Not implemented": **FALSE** — `createDrizzleAuditStore` is fully implemented at `packages/core/src/audit/drizzle-audit-store.ts:32`, exported from `packages/core/src/index.ts:6-7`. It supports both `sqlite` and `postgres` dialects via `drizzle-orm/sqlite-core` / `drizzle-orm/pg-core`, defines an `audit_log` table with composite indexes, and implements `append`, `list` (with cursor pagination on `(createdAt, id)` and filter support for collection/documentId/operation/actorId/from/to), `cleanup`, and `health`. The audit's "Only `MemoryAuditStore` exists — data lost on restart without custom implementation" claim is wrong.

### Plan 015 — Webhooks
- IU "`MemoryWebhookStore` at `webhooks.ts:3–65`": OK — class at 3, all methods present, closes at 65.
- IU "`dispatchWebhooks` with `Promise.allSettled` fan-out at `webhooks.ts:67–98`": DRIFT — function exists at lines 67-98, but the implementation uses `Promise.all` (line 92), not `Promise.allSettled`. Because `deliverWebhook` catches internally and never rejects, behavior is equivalent to allSettled, but the audit's claim is technically inaccurate.
- IU "Webhook CRUD admin endpoints at `create-cms.ts:215–268`": OK — GET 215, POST 226, PATCH 245, PUT 253, DELETE 261, block ends at 268 verbatim.

### Plan 016 — Draft/Publish State Machine
- IU "`publishDocument` / `unpublishDocument` at `content/publish.ts:15–37`": OK — `publishDocument` at 15-26, `unpublishDocument` at 28-38. (Audit said 15-37 — close; actual end is line 38.)
- IU "`runScheduledPublishes` batch=100 at `content/publish.ts:58–78`": OK — function at 58, `limit = 100` default at line 62, ends at 78.
- IU "Draft filter applied to populated relations at `populate.ts:124`": DRIFT — line 124 is the right line, but the actual condition is `options.status !== "published" || !collections[targetName]?.options.draftAndPublish || child.status === "published"` — the audit-quoted condition omits the `!collections[targetName]?.options.draftAndPublish` middle clause. Behavior intact; quote slightly abridged.

### Plan 017 — Relations and SDK Types
- IU "`parsePopulateParams` + `populateRecords` with `MAX_POPULATE_DEPTH=3`, `MAX_POPULATE_NODES=100` at `populate.ts:6–7, 81–143`": OK — constants at 6-7, `populateRecords` at 81, `populateRecord` at 94, primary loop ends ~143.
- IU "`createCMSClient` factory at `schema/src/index.ts:593–668`": OK — `lines.push("export function createCMSClient(options: ClientOptions): CMSClient {")` at line 593, function body emission continues through 668, closing brace at 669. Off-by-one on end but accurate.
- IU "Drizzle FK columns for owning relations at `drizzle-generator.ts:95–103`": OK — `renderFieldColumns` at 95, relation column emission at 99-103, exact match.

### Plan 018 — Health Checks
- IU "`runHealthChecks` with `Promise.all` parallel execution at `health.ts:15–25`": OK — function at line 15, `Promise.all(checkers.map(...))` at 16, returns aggregated `HealthReport` ending at 25.
- IU "`withTimeout` wrapping each check at `health.ts:47–59`": OK — function at 47, `Promise.race` body at 50-55, finally clears timer; closes at 59 verbatim.
- IU "`HealthStatus` (not `SubsystemHealth`) in `packages/schema/src/adapter.ts`": OK — `export type HealthStatus = { ... }` at line 82 of `adapter.ts`. Audit's renaming-noted observation is accurate.

## Summary

- **Total checks: 56** (3 IUs per plan × 18 plans, plus 2 extra deep-dives on Plan 013/014 because the original audit claims were so definitive)
- **Verified accurate (OK): 50**
- **Minor drift (DRIFT): 3**
  - Plan 011 — `cms doctor` line reference off by ~148 lines (and several smaller line drifts in adjacent CLI commands)
  - Plan 015 — `dispatchWebhooks` uses `Promise.all` not `Promise.allSettled` (behavior equivalent given `deliverWebhook` swallows errors internally)
  - Plan 016 — Quoted populate.ts:124 condition is slightly abridged; current condition adds `!collections[targetName]?.options.draftAndPublish` middle clause
- **False claims (FALSE): 3**
  - Plan 013 — `createAIProvider` factory **IS** implemented at `packages/core/src/content/ai-provider.ts:212` with Anthropic, OpenAI, AI Gateway, and custom providers (237 LOC). Audit said "Not implemented."
  - Plan 013 — `createDrizzleTranslationStore` **IS** implemented at `packages/core/src/content/drizzle-translation-store.ts:35` for sqlite and postgres (282 LOC). Audit said "Only `MemoryTranslationStore` exists — data lost on restart."
  - Plan 014 — `createDrizzleAuditStore` **IS** implemented at `packages/core/src/audit/drizzle-audit-store.ts:32` for sqlite and postgres, exported from `packages/core/src/index.ts:6-7`. Audit said "Only `MemoryAuditStore` exists — data lost on restart without custom implementation."

## Recommended Updates to plans-audit.md

The audit's overall structure and most IU verifications are solid. However, three substantive corrections are required, with cascading impact on the Gap Register and Summary Table:

### Plan 013 — AI-Powered i18n
- Change `createAIProvider` factory row from `[ ]` Not implemented to `[x]` implemented at `packages/core/src/content/ai-provider.ts:212` (Anthropic + OpenAI-compatible + AI Gateway + custom).
- Change "Drizzle-generated `{collection}_locale_variants` table" row: still `[~]` partial — `createDrizzleTranslationStore` does exist at `content/drizzle-translation-store.ts:35` with a shared `locale_variants` table for sqlite/postgres, but the table is shared across all collections, not per-collection as the plan suggested. Note this as partial rather than absent.
- "DB-level COALESCE JOIN" remains `[ ]` (still uses post-query overlay; this part of audit is accurate).
- Plan 013 final status should be revised from `[~]` Partial to `[~]` Mostly-complete (or possibly `[x]` if the shared-table design is accepted).

### Plan 014 — Audit Log
- Change "Drizzle-backed AuditStore in any adapter" row from `[ ]` Not implemented to `[x]` implemented at `packages/core/src/audit/drizzle-audit-store.ts:32` (sqlite + postgres).
- Other Plan 014 gaps (CSV rate limiting, 100K cap, `actorId` vs email) remain accurate.
- Plan 014 final status remains `[~]` Partial but the leading gap (no DB-backed store) should be removed.

### Plan 011 — CLI Tooling
- Update `cms doctor` line reference from `:2361` to `:2213`. Other line refs in this section have minor drift; consider running a re-scan.

### Gap Register impact

- **G-1 (No concrete AI translation provider)**: REMOVE — `createAIProvider` is implemented.
- **G-2 (No Drizzle-backed `TranslationStore`)**: DOWNGRADE — `createDrizzleTranslationStore` exists; remaining concern is the shared-vs-per-collection table design choice.
- **G-3 (No Drizzle-backed `AuditStore`)**: REMOVE — `createDrizzleAuditStore` is implemented.

Removing G-1 and G-3 from the P1 list, and downgrading G-2, materially changes the "P1 — Functional gaps affecting production deployments" picture: there are arguably no P1 gaps remaining for out-of-the-box production deployments.

### Methodology note for future audits

The drift suggests the prior audit may have stopped reading file listings at `packages/core/src/content/translation.ts` without also opening sibling files `ai-provider.ts` and `drizzle-translation-store.ts`, and similarly didn't open `packages/core/src/audit/drizzle-audit-store.ts`. A safer protocol: when claiming a feature is missing, `ls` the relevant directory tree and `grep` for plausibly named factory functions before asserting absence.
