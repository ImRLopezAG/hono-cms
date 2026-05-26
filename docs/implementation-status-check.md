# Implementation Status Check

This is a current-state checklist for the Hono CMS work. It separates what is implemented, partially implemented, and not yet implemented based on the repository contents and verification commands available right now.

Legend:

- `[x]` Implemented with source and test/example evidence.
- `[~]` Partially implemented; usable pieces exist, but important scope remains.
- `[ ]` Not implemented or not proven by current evidence.

## Summary

| Area | Status | Current check |
| --- | --- | --- |
| Monorepo/package foundation | `[x]` | Workspaces, package scripts, Turbo tasks, package builds/typechecks exist. |
| Web Request CMS runtime | `[x]` | Core CMS exposes Web `Request`/`Response` behavior and platform adapters wrap it. |
| Schema DSL and generated typing | `[x]` | Typed field DSL, SDK, OpenAPI, Drizzle, migration planning, and source generation exist. |
| REST content API | `[x]` | Collection CRUD, query parsing, filters, projection, relations, draft/publish, i18n, media, preview tokens exist. |
| GraphQL API | `[x]` | SDL and query/mutation handling exist, including relation filters/population. |
| OpenAPI/docs layer | `[x]` | Generated OpenAPI spec and docs routes exist. |
| Admin SPA | `[~]` | Large admin surface exists; browser E2E coverage and final guided-builder polish remain. |
| Content-Type Builder | `[~]` | Server-backed writes and generated previews exist; full Stripe-style wizard/browser E2E remains. |
| Auth/RBAC/API keys/sessions | `[x]` | Static tokens, API keys, Better Auth helpers, sessions, role/field permissions exist. |
| Organizations | `[x]` | Organization settings, members, invitations, updates, revocation exist. |
| Media/storage | `[x]` | Media APIs, presign/confirm, delete reference checks, active-content protection, storage adapters exist. |
| Database adapters | `[x]` | Memory, D1, Postgres, Turso, Convex adapters exist. |
| Cache/rate limit | `[x]` | Cache package and core integration exist; memory cache lifecycle safeguards exist. |
| Jobs/crons | `[x]` | Scheduled publish, cleanup, cache sweep, webhook retry, translation jobs, QStash/Vercel cron support exist. |
| Webhooks | `[x]` | Targets, HMAC signing, delivery log, retries, tests, admin settings exist. |
| Health checks | `[x]` | Live, health, and ready endpoints exist. |
| CLI tooling | `[x]` | Init, generate/check artifacts, migrations, seeds, doctor, deploy templates, entrypoints exist. |
| Multi-platform hosting | `[~]` | Node, Cloudflare, Vercel, Next adapters/examples/tests exist; provider-account walkthroughs are incomplete. |
| Examples | `[x]` | Newsroom, Next, Cloudflare Worker, Vercel Edge examples exist and typecheck. |
| Public docs | `[~]` | README, capability doc, API reference, and deployment guide exist; admin/adapter/operator docs remain. |
| Completion audit | `[x]` | Per-IU gap matrix completed across all 18 plans; see `docs/plans-audit.md`. P1 gaps: no `createAIProvider` factory, no DB-backed `TranslationStore`/`AuditStore`. P2: CLI uses custom parsing/`fs.watch` instead of citty/chokidar; OpenAPI not via `@hono/zod-openapi createRoute`. |

## Implemented

### Monorepo Foundation

- `[x]` Bun workspace with `apps/*`, `examples/*`, and `packages/*`.
- `[x]` Root scripts for `build`, `dev`, `test`, `typecheck`, `lint`, and package scaffolding.
- `[x]` Shared package structure for core, schema, CLI, platform, adapters, storage, cache, jobs, and admin.

Evidence:

- `package.json`
- `turbo.json`
- `packages/*/package.json`
- `apps/admin/package.json`
- `examples/*/package.json`

### Web Request Runtime And Platform Adapters

- `[x]` Core CMS runtime is created by `createCMS`.
- `[x]` Node HTTP bridge converts `IncomingMessage`/`ServerResponse` to Web `Request`/`Response`.
- `[x]` Cloudflare Worker export supports `fetch` and `scheduled`.
- `[x]` Vercel handler uses Web route handlers and supports generated cron config shape.
- `[x]` Next App Router handler exports all common HTTP methods.

Evidence:

- `packages/core/src/create-cms.ts`
- `packages/platform/src/node.ts`
- `packages/platform/src/cloudflare.ts`
- `packages/platform/src/vercel.ts`
- `packages/platform/src/next.ts`
- `examples/newsroom/src/node-server.ts`
- `examples/cloudflare-worker/src/worker.ts`
- `examples/vercel-edge/src/route.ts`
- `examples/next-app/app/api/cms/[...route]/route.ts`

### Schema, Typing, And Generation

- `[x]` Typed schema DSL with `defineCollection`, `defineSchema`, `fields`, `InferCollectionInput`, `InferCollectionOutput`, and `InferCMS`.
- `[x]` Field kinds include string, text, richtext, number, boolean, date/time, json, email, url, password, uid, enum, media, and relation.
- `[x]` Generated TypeScript SDK.
- `[x]` Generated OpenAPI schemas.
- `[x]` Generated Drizzle schema and config.
- `[x]` Schema snapshots and migration planning.
- `[x]` Generated collection source files for the Content-Type Builder.

Evidence:

- `packages/schema/src/index.ts`
- `packages/schema/src/file-writer.ts`
- `packages/schema/src/drizzle-generator.ts`
- `packages/schema/src/migrations.ts`
- `packages/schema/src/__tests__/schema.test.ts`
- `examples/newsroom/src/generated/sdk.ts`

### Core Content API

- `[x]` REST CRUD endpoints for configured collections.
- `[x]` Query parsing for filters, sort, cursor/page pagination, relation population, and projection.
- `[x]` Draft/publish state machine with publish, unpublish, schedule, and unschedule endpoints.
- `[x]` i18n locale variants and translation endpoints.
- `[x]` Preview token creation/revocation.
- `[x]` GraphQL SDL and query/mutation handling.
- `[x]` OpenAPI spec and docs mounting.

Evidence:

- `packages/core/src/create-cms.ts`
- `packages/core/src/content/query.ts`
- `packages/core/src/content/populate.ts`
- `packages/core/src/content/publish.ts`
- `packages/core/src/content/i18n.ts`
- `packages/core/src/content/translation.ts`
- `packages/core/src/graphql.ts`
- `packages/core/src/openapi.ts`
- `packages/core/src/__tests__/cms.test.ts`

### Admin App

- `[x]` Vite React admin app initialized with shadcn/ui, Tailwind 4, TanStack Router/Query/Table/Virtual/Form/Pacer/Hotkeys, Jotai, `nuqs`, `qs`, and Tiptap.
- `[x]` Admin views for content, media, health, audit log, webhooks, API keys, sessions, content types, i18n, organization settings, members, and invitations.
- `[x]` Content editor supports generated field controls and rich text.
- `[x]` Content-Type Builder can create/update schema definitions through core endpoints.
- `[x]` Content-Type Builder shows generated source/artifacts after save.
- `[x]` Content-Type Builder shows a pre-save generated API preview with workflow steps, SDK shape, REST endpoints, follow-up commands, and copy actions.
- `[x]` Admin builder has client-side validation for field names, ranges, enum values, relation targets/inverses, and UID targets.
- `[x]` Core content-type endpoints reject direct API payloads with invalid numeric ranges, duplicate enum values, invalid relation inverse names, invalid UID targets, and other malformed field definitions before invoking the schema writer.
- `[x]` Admin dev builds include a content-type smoke harness at `/settings/content-types?cmsSmoke=content-types` that mocks the CMS content-type API for browser/manual smoke runs.

Evidence:

- `apps/admin/src/components/AdminApp.tsx`
- `apps/admin/src/lib/api-client.ts`
- `apps/admin/src/lib/field-rendering.ts`
- `apps/admin/src/lib/route-search.ts`
- `apps/admin/src/components/AdminApp.test.ts`
- `apps/admin/src/components/ContentTypesView.dom.test.tsx`
- `apps/admin/components.json`
- `apps/admin/package.json`

### Auth, Permissions, And Organizations

- `[x]` Static bearer tokens for local/test deployments.
- `[x]` API key hashing, prefixes, enabled state, roles, create/update/delete/list endpoints.
- `[x]` Better Auth integration helpers and auth schema snapshots.
- `[x]` Session endpoints.
- `[x]` Collection-level RBAC and field-level read/write permissions.
- `[x]` Organization settings, members, invitations, updates, and revocation.

Evidence:

- `packages/core/src/auth.ts`
- `packages/core/src/auth/better-auth.ts`
- `packages/core/src/auth/schema.ts`
- `packages/core/src/content/rbac.ts`
- `packages/core/src/organization.ts`
- `packages/core/src/__tests__/auth-config-types.test.ts`
- `packages/core/src/__tests__/cms.test.ts`

### Media And Storage

- `[x]` Direct media upload.
- `[x]` Presigned upload and confirmation flow.
- `[x]` Media metadata store.
- `[x]` Media file serving.
- `[x]` Media delete protection when content references media fields.
- `[x]` Multiple-media fields.
- `[x]` Active-content denial for SVG/HTML/XML/JS unless explicitly enabled.
- `[x]` Storage adapters for memory, local, S3, R2, and Vercel Blob.
- `[x]` Shared storage-key validation.

Evidence:

- `packages/core/src/media.ts`
- `packages/core/src/storage-key.ts`
- `packages/storage-memory/src/index.ts`
- `packages/storage-local/src/index.ts`
- `packages/storage-s3/src/index.ts`
- `packages/storage-r2/src/index.ts`
- `packages/storage-vercel-blob/src/index.ts`
- `packages/core/src/__tests__/cms.test.ts`

### Database Adapters

- `[x]` Database adapter contract.
- `[x]` Shared adapter helpers.
- `[x]` Memory adapter.
- `[x]` D1 adapter.
- `[x]` Postgres adapter.
- `[x]` Turso adapter.
- `[x]` Convex adapter.

Evidence:

- `packages/core/src/types/providers.ts`
- `packages/adapter-kit/src/index.ts`
- `packages/adapter-memory/src/index.ts`
- `packages/adapter-d1/src/index.ts`
- `packages/adapter-postgres/src/index.ts`
- `packages/adapter-turso/src/index.ts`
- `packages/adapter-convex/src/index.ts`

### Cache, Jobs, Webhooks, Health

- `[x]` Cache adapter contract and cache package.
- `[x]` Memory cache production warning, cleanup interval, and `destroy()`.
- `[x]` Rate-limit integration through core request paths.
- `[x]` Jobs package and core routes for scheduled publish, audit cleanup, cache sweep, webhook retry, and translation.
- `[x]` QStash fail-fast production config validation.
- `[x]` Vercel Cron-style GET routes.
- `[x]` Webhook signing, event matching, deliveries, retries, and admin settings endpoints.
- `[x]` Health checks and live/ready endpoints.

Evidence:

- `packages/cache/src/index.ts`
- `packages/jobs/src/index.ts`
- `packages/core/src/webhooks.ts`
- `packages/core/src/health.ts`
- `packages/core/src/create-cms.ts`
- `packages/jobs/src/__tests__/jobs.test.ts`
- `packages/core/src/__tests__/cms.test.ts`

### CLI And Examples

- `[x]` CLI project init for Cloudflare, Vercel, Node, and Next.
- `[x]` SDK/OpenAPI/Drizzle generation and drift checks.
- `[x]` Schema migration plan/apply.
- `[x]` Seed runner.
- `[x]` Content-type writer for admin-driven schema generation.
- `[x]` Workspace doctor.
- `[x]` Deploy templates and platform entrypoint generation.
- `[x]` Examples for newsroom, Next App Router, Cloudflare Worker, and Vercel Edge.

Evidence:

- `packages/cli/src/index.ts`
- `packages/cli/src/__tests__/cli.test.ts`
- `examples/newsroom`
- `examples/next-app`
- `examples/cloudflare-worker`
- `examples/vercel-edge`

## Partially Implemented

### Stripe-Style Guided Content-Type Builder

Status: `[~]`

Implemented:

- Server-backed create/update endpoints for content types.
- Schema writer integration.
- Generated source/artifact/migration summaries after save.
- Pre-save generated API preview.
- Four-step generation workflow summary.
- Copy actions for generated snippets.
- Client/server validation for many common builder errors.
- Lower-level Next App Router test for content-type generation.

Still missing:

- Dedicated wizard flow with progressive steps and clearer task completion states.
- Browser E2E test that creates a content type through the real running admin UI.
- Browser E2E test for the same admin generation journey inside a Next-hosted setup.
- Automated Playwright/Vitest-browser runner coverage. The dev smoke harness exists, but the automated browser runner is not installed.

### Multi-Platform Production Hosting

Status: `[~]`

Implemented:

- Runtime adapters for Node, Cloudflare Workers, Vercel Edge, and Next App Router.
- Examples for those hosts.
- CLI deployment templates and entrypoint generation.
- Deployment guide with recommended adapter/storage pairings.

Still missing:

- Provider-account-specific production walkthroughs for every supported database/storage combination.
- Real deployed smoke tests against hosted providers.
- Complete secret/environment setup examples for each provider combination.

### Public Documentation

Status: `[~]`

Implemented:

- Root README.
- Implemented capabilities document.
- API reference.
- Deployment guide.
- Example READMEs.

Still missing:

- Admin user guide.
- Adapter authoring guide.
- Plugin authoring guide.
- Migration guide.
- Production operations guide.

### Completion Audit

Status: `[ ]`

Not yet done:

- A requirement-by-requirement audit across every plan in `docs/plans`.
- A final proof matrix mapping every original plan item to source, tests, examples, and rendered/runtime verification.

## Not Implemented Or Not Proven

- `[ ]` Full browser E2E coverage for admin-driven schema generation.
- `[ ]` Full browser E2E coverage for admin-driven schema generation in a Next-hosted app.
- `[ ]` Complete guided Content-Type Builder wizard.
- `[ ]` Provider-account-specific production deployment walkthroughs for all adapter/storage combinations.
- `[ ]` Real hosted-provider smoke tests.
- `[ ]` Complete public documentation suite.
- `[ ]` Final requirement-by-requirement completion audit across all original plans.

## Verification Snapshot

Recently used verification commands:

```sh
bun --filter @hono-cms/core test
bun --filter @hono-cms/core typecheck
bun --filter @hono-cms/schema test
bun --filter @hono-cms/admin-spa test
bun --filter @hono-cms/admin-spa typecheck
bun --filter @hono-cms/admin-spa build
bun --filter @hono-cms/example-next-app test
bun --filter @hono-cms/example-next-app typecheck
bun run typecheck
```

The current documentation does not claim the whole goal is complete. It records the implemented surface and highlights the remaining evidence gaps that still need implementation or verification.
