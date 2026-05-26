# Hono CMS Implemented Capabilities

This document records the capabilities that are implemented in the current repository. It is evidence-driven: every section points at source files, tests, or examples that can be inspected to verify the claim. For a checklist view of implemented, partially implemented, and missing work, see [implementation-status-check.md](implementation-status-check.md).

## Runtime Shape

The CMS is centered on a Hono app that consumes and returns standard Web `Request` and `Response` objects. The main runtime is created by `createCMS` in `packages/core/src/create-cms.ts`, and platform packages adapt the same handler shape to each host:

- Node HTTP bridge: `packages/platform/src/node.ts`
- Cloudflare Worker export: `packages/platform/src/cloudflare.ts`
- Vercel route handler: `packages/platform/src/vercel.ts`
- Next.js App Router handlers: `packages/platform/src/next.ts`

Examples prove the same CMS can be mounted in multiple environments:

- `examples/cloudflare-worker`
- `examples/vercel-edge`
- `examples/next-app`
- `examples/newsroom`

The newsroom example also exercises direct Web fetch, Node HTTP, Cloudflare-style exports, and Vercel-style handlers from one schema.

## Schema And Typing

The schema package implements a typed collection DSL in `packages/schema/src/index.ts`.

Implemented field kinds:

- `string`, `text`, `richtext`
- `number`, `boolean`
- `datetime`, `date`, `time`
- `json`
- `email`, `url`, `password`
- `uid`
- `enum`
- `media`
- `relation`

The DSL exposes `defineCollection`, `defineSchema`, `fields`, `InferCollectionInput`, `InferCollectionOutput`, and `InferCMS`. Required fields, enum values, relation cardinality, media multiplicity, and collection options flow into generated TypeScript types.

Generated artifacts are implemented in the schema and CLI layers:

- TypeScript SDK generation: `generateTypeScriptSDK` in `packages/schema/src/index.ts`
- OpenAPI schema generation: `generateOpenAPISchemas` in `packages/schema/src/index.ts`
- Drizzle schema generation: `packages/schema/src/drizzle-generator.ts`
- Collection source generation: `packages/schema/src/file-writer.ts`
- Schema migration planning and snapshots: `packages/schema/src/migrations.ts`

The committed generated SDK in `examples/newsroom/src/generated/sdk.ts` is checked against the newsroom schema by `examples/newsroom` scripts and tests.

## Core HTTP API

`packages/core/src/create-cms.ts` implements REST endpoints for generated content collections under `/api/:collection`.

Implemented content behavior includes:

- List, create, read, update, and delete operations.
- Cursor/page query parsing.
- Filtering, sorting, relation population, and field projection.
- Draft/publish flows, including publish, unpublish, schedule, and unschedule endpoints when enabled.
- Locale variants and translation endpoints for localized collections.
- Media upload, presign, confirm, fetch, and delete endpoints.
- Preview token creation and revocation.

GraphQL is implemented in `packages/core/src/graphql.ts`, including generated SDL, collection queries/mutations, relation population, and relation filters.

OpenAPI is implemented in `packages/core/src/openapi.ts` and mounted by the core runtime when enabled. The current spec includes generated content paths plus admin, auth, media, jobs, health, webhook, organization, and i18n paths.

## Admin And Content-Type Builder

The admin app lives in `apps/admin`. It is a Vite React application with shadcn/ui components, Tailwind 4 configuration, TanStack Router, TanStack Query, TanStack Table, TanStack Virtual, TanStack Form, TanStack Pacer, TanStack Hotkeys, Jotai state, `nuqs` search state, `qs` helpers, and Tiptap rich text controls.

Implemented admin areas include:

- Content list and editor views.
- Media library and picker.
- Health dashboard.
- Audit log.
- Webhook settings and delivery history.
- API key management.
- Auth/session settings.
- Content-Type Builder.
- i18n backfill.
- Organization settings, members, and invitations.

The Content-Type Builder talks to the core content-type endpoints:

- `GET /cms/content-types/capabilities`
- `GET /cms/content-types`
- `POST /cms/content-types`
- `PUT /cms/content-types/:name`

When a content type is created or updated, core generates collection source through `generateCollectionFile`, calls the configured `SchemaWriter`, and returns a write summary with source, path, artifacts, migrations, and message. The admin UI displays this generated output after save.

Before save, the admin also renders a generated API preview from the draft content type. The preview shows the expected artifact categories, a four-step generation workflow, TypeScript input shape, generated SDK-style client calls, REST endpoints, draft/publish endpoints when that workflow is enabled, and follow-up commands for doctor, SDK drift, OpenAPI drift, and migration planning. Each generated preview block has a copy action backed by the browser clipboard API.

For manual browser smoke testing in Vite dev, open `/settings/content-types?cmsSmoke=content-types`. This dev-only harness seeds an admin token and mocks the content-type endpoints so the generated preview, copy actions, create flow, and post-save artifact summary can be exercised without a separate CMS server.

Implemented validation around UI-driven generation includes:

- Client-side detection of blank, duplicate, and invalid field names.
- Client-side checks for invalid numeric ranges, empty or duplicate enum values, missing relation targets, invalid relation inverse names, and invalid UID targets.
- Server-side validation for collection names, field objects, empty fields, unsupported field kinds, invalid option types, invalid numeric ranges, duplicate enum values, relation configuration, invalid relation inverse names, media multiplicity, and UID `targetField` references.

This is a functional generated-schema workflow, but it is not yet a polished Stripe-style guided setup experience. It does not yet include a dedicated wizard or browser E2E coverage inside a Next-hosted admin flow.

The Next.js example now includes a route-handler test that creates a content type through `createNextRouteHandlers`, verifies the schema writer receives generated collection source, and verifies returned artifacts and migrations.

## Auth, RBAC, Sessions, And Organizations

Core auth support is implemented in `packages/core/src/auth.ts` and `packages/core/src/auth/better-auth.ts`.

Implemented auth features include:

- Static bearer-token auth for local and test deployments.
- API key auth with hashing, prefixes, enabled/disabled state, and role assignment.
- Better Auth integration helpers and auth schema snapshots.
- Admin session endpoints.
- Role-aware content permissions.
- Field-level read/write permissions.

Organization support is implemented in `packages/core/src/organization.ts`, with admin endpoints for organization settings, members, invitations, member updates, and invitation revocation.

## Media And Storage

Media handling is implemented in `packages/core/src/media.ts`.

Implemented behavior includes:

- Direct uploads.
- Presigned upload creation and confirmation.
- Media metadata storage.
- Media file serving.
- Safe delete checks that prevent deleting media still referenced by content records.
- Multiple-media field support.
- Active-content denial for SVG, HTML, XML, JavaScript, and related browser-executable types unless `media.allowActiveContent` is explicitly enabled.

Storage adapters are implemented for:

- Memory: `packages/storage-memory`
- Local filesystem: `packages/storage-local`
- S3: `packages/storage-s3`
- Cloudflare R2: `packages/storage-r2`
- Vercel Blob: `packages/storage-vercel-blob`

Shared storage key validation lives in `packages/core/src/storage-key.ts`.

## Database Adapters

The adapter contract is implemented in `packages/core/src/types/providers.ts` and helper packages.

Implemented adapters include:

- Memory: `packages/adapter-memory`
- D1: `packages/adapter-d1`
- Postgres: `packages/adapter-postgres`
- Turso: `packages/adapter-turso`
- Convex: `packages/adapter-convex`

`packages/adapter-kit` provides shared helpers for adapter implementations.

## Caching, Jobs, Webhooks, And Health

Caching support is implemented through the core cache provider contract and `packages/cache`. Content caching and rate limiting are wired through core request paths. The memory cache includes production warnings, interval cleanup, and explicit `destroy()`.

Jobs support is implemented in `packages/jobs` and wired into core job routes:

- Scheduled publish.
- Audit log cleanup.
- Cache sweep.
- Webhook retry.
- Translation jobs.

QStash support validates required production configuration before use, and Vercel Cron-style GET routes are supported for scheduled jobs.

Webhook support is implemented in `packages/core/src/webhooks.ts` and exposed through admin settings routes. Implemented behavior includes event matching, HMAC signing, delivery recording, test deliveries, retries, and serialization that hides secrets.

Health checks are implemented in `packages/core/src/health.ts` and exposed through:

- `/cms/health/live`
- `/cms/health`
- `/cms/health/ready`

## CLI Tooling

The CLI lives in `packages/cli/src/index.ts` and exposes `cms` / `hono-cms`.

Implemented CLI capabilities include:

- Project initialization presets for Cloudflare, Vercel, Node, and Next.
- SDK generation and drift checking.
- OpenAPI generation and drift checking.
- Drizzle schema/config generation.
- Drizzle Kit integration.
- Schema migration planning and applying.
- Seed execution.
- Content-type writer support for admin-driven schema generation.
- `cms doctor` checks for schema load, migration drift, SDK drift, OpenAPI drift, and Drizzle drift.

## Verification Coverage

Implemented verification includes package-level tests and typechecks across the monorepo. Recent successful checks included:

- `bun --filter @hono-cms/core test`
- `bun --filter @hono-cms/core typecheck`
- `bun --filter @hono-cms/schema test`
- `bun --filter @hono-cms/admin-spa test`
- `bun --filter @hono-cms/admin-spa typecheck`
- `bun --filter @hono-cms/admin-spa build`
- `bun --filter @hono-cms/example-next-app test`
- `bun --filter @hono-cms/example-next-app typecheck`
- `bun run typecheck`

The full workspace typecheck most recently completed with all `22` tasks successful.

## Known Gaps

These items are not documented as complete because current evidence does not prove the full target state:

- Stripe-level guided UI generation flow. Draft API/SDK preview, generation workflow steps, follow-up command snippets, and snippet copy actions exist, but the complete guided product flow is not finished.
- Browser E2E coverage of creating content types from the admin against a real running app.
- Browser E2E coverage of the same UI-driven generation flow inside a Next-hosted app. The lower-level Next route-handler generation path is tested, but the browser-admin journey is not.
- A full requirement-by-requirement completion audit across every original plan file.
- Production-grade hosted deployment recipes for every adapter/storage combination.
- Complete public documentation set, including root README, getting started guide, API reference, admin guide, adapter guide, and deployment guide.
