# Hono CMS

A TypeScript-first headless CMS built on Hono and the standard Web `Request` / `Response` API. The project is designed to run the same CMS core on Node, Next.js App Router, Vercel Edge, and Cloudflare Workers, with generated SDK/OpenAPI/database artifacts and an admin app for content operations.

This repository is still pre-release, but the core runtime, schema system, admin app, platform adapters, examples, and verification suites are implemented enough to exercise real content workflows.

## What Is Implemented

- Typed schema DSL with `defineCollection`, `defineSchema`, `fields`, and inferred input/output types.
- REST content APIs under `/api/:collection`.
- GraphQL SDL and query/mutation execution.
- OpenAPI generation and hosted docs/spec routes.
- Generated TypeScript SDK, OpenAPI schemas, Drizzle schema output, and migration planning.
- Admin SPA with shadcn/ui, Tailwind 4, TanStack Router/Query/Table/Virtual/Form/Pacer/Hotkeys, `nuqs`, `qs`, Jotai, and Tiptap.
- Content-Type Builder with server-backed schema writes, generated source/artifact summaries, pre-save SDK/API previews, copyable snippets, and validation.
- Auth, API keys, RBAC, field permissions, sessions, organizations, audit log, webhooks, i18n, jobs, cache, media, and health checks.
- Database adapters for memory, D1, Postgres, Turso, and Convex.
- Storage adapters for memory, local, S3, R2, and Vercel Blob.
- Platform adapters for Node, Cloudflare Workers, Vercel, and Next.js App Router.

See [docs/implemented-capabilities.md](docs/implemented-capabilities.md) for a fuller evidence-backed capability map, [docs/implementation-status-check.md](docs/implementation-status-check.md) for the current implemented/not-implemented checklist, [docs/api-reference.md](docs/api-reference.md) for the implemented API surface, and [docs/deployment.md](docs/deployment.md) for host-specific setup.

## Quick Start From The Monorepo

Install dependencies:

```sh
bun install
```

Run the full typecheck:

```sh
bun run typecheck
```

Run tests:

```sh
bun run test
```

Try the newsroom example:

```sh
cd examples/newsroom
bun run generate:sdk
bun run check:sdk
bun run typecheck
bun run test
```

Run the admin app during development:

```sh
bun --filter @hono-cms/admin-spa dev
```

For a deterministic Content-Type Builder smoke run in the browser, open `/settings/content-types?cmsSmoke=content-types` on the Vite dev server. The dev-only harness mocks the CMS content-type endpoints and seeds an admin token.

## Minimal CMS

```ts
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { createCMS } from "@hono-cms/core";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";

const schema = defineSchema({
  articles: defineCollection("articles", {
    title: fields.string({ required: true }),
    slug: fields.uid({ targetField: "title", required: true }),
    body: fields.richtext(),
    views: fields.number(),
  }, { draftAndPublish: true }),
});

export const cms = createCMS({
  collections: schema,
  db: createMemoryDatabase({ provider: "memory", collections: schema }),
  auth: {
    tokens: {
      admin: { userId: "admin_1", roles: ["admin"] },
    },
  },
  openapi: {
    path: "/cms/openapi.json",
    docs: "/cms/docs",
    title: "CMS API",
    version: "0.1.0",
  },
});
```

The resulting CMS exposes Web-standard request handling through `cms.fetch(request)`.

## Platform Mounts

Use the platform package to keep the same CMS core across hosts.

The deployment guide has the fuller host-by-host version: [docs/deployment.md](docs/deployment.md).

Node:

```ts
import { createServer } from "node:http";
import { createNodeHandler } from "@hono-cms/platform/node";
import { cms } from "./cms";

createServer(createNodeHandler(cms)).listen(3000);
```

Cloudflare Workers:

```ts
import { createCloudflareExport } from "@hono-cms/platform/cloudflare";
import { cms } from "./cms";

export default createCloudflareExport(cms);
```

Vercel Edge:

```ts
import { createVercelHandler } from "@hono-cms/platform/vercel";
import { cms } from "./cms";

export const runtime = "edge";
export const GET = createVercelHandler(cms);
export const POST = GET;
```

Next.js App Router:

```ts
import { createNextRouteHandlers } from "@hono-cms/platform/next";
import { cms } from "../../../../src/cms";

export const runtime = "edge";

const handlers = createNextRouteHandlers(cms);

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PUT = handlers.PUT;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
export const OPTIONS = handlers.OPTIONS;
export const HEAD = handlers.HEAD;
```

## Generated Contracts

The CLI can generate and check SDK/OpenAPI/database artifacts from a schema:

```sh
bun packages/cli/src/index.ts schema generate --schema src/schema.ts --out src/generated/sdk.ts
bun packages/cli/src/index.ts schema check-sdk --schema src/schema.ts --out src/generated/sdk.ts
bun packages/cli/src/index.ts schema openapi --schema src/schema.ts --out src/generated/openapi.json
bun packages/cli/src/index.ts schema check-openapi --schema src/schema.ts --out src/generated/openapi.json
bun packages/cli/src/index.ts schema plan --schema src/schema.ts --state ./.hono-cms/schema-state.json
bun packages/cli/src/index.ts doctor --schema src/schema.ts --state ./.hono-cms/schema-state.json
```

The admin Content-Type Builder can also call `/cms/content-types` when a `SchemaWriter` is configured, returning generated source, artifacts, migrations, and a UI summary.

## Examples

- [examples/newsroom](examples/newsroom): typed schema, generated SDK, direct Web fetch, Node, Cloudflare-style, and Vercel-style handlers.
- [examples/next-app](examples/next-app): Next.js App Router route handlers, including content-type generation through the Next handler surface.
- [examples/cloudflare-worker](examples/cloudflare-worker): Cloudflare Worker-style module export.
- [examples/vercel-edge](examples/vercel-edge): Vercel Edge handler and generated cron config shape.

## Verification

Useful gates:

```sh
bun run typecheck
bun run test
bun --filter @hono-cms/core test
bun --filter @hono-cms/schema test
bun --filter @hono-cms/admin-spa test
bun --filter @hono-cms/admin-spa build
bun --filter @hono-cms/example-next-app test
```

## Continuous integration

GitHub Actions workflows live under `.github/workflows/`:

- [`ci.yml`](.github/workflows/ci.yml) — runs on every pull request against `main` and on pushes to `main`. The single `verify` job installs Bun `1.3.14`, restores the Bun install cache keyed on `bun.lock`, and runs `bun run typecheck`, `bun run test`, and `bun run lint` (workspace-wide via Turborepo). Concurrency cancels in-progress runs on the same branch.
- [`parity.yml`](.github/workflows/parity.yml) — opt-in (`workflow_dispatch`) run of the Strapi parity harness (`capture` → `diff` → `report`). It installs Playwright Chromium and uploads the parity output as an artifact. Not gated on PRs because it requires the full Strapi reference setup.

Playwright-based admin E2E tests are intentionally not part of `ci.yml`. They are meant for local dev (`bun --filter @hono-cms/admin-spa test:e2e`) or a separate `e2e.yml` workflow that can be added when we want browser E2E gated on PRs.

## Deployment recipes

Concrete, command-driven walkthroughs for shipping the CMS to real infrastructure. Each recipe shows the exact `createCMS({...})` call, migration commands, deploy commands, admin SPA wiring, verification curls, and provider-specific pitfalls.

- [`docs/deployment/cloudflare-workers-d1-vercel-admin.md`](docs/deployment/cloudflare-workers-d1-vercel-admin.md) — CMS API on Cloudflare Workers + D1 + R2, admin SPA on Vercel.
- [`docs/deployment/node-postgres-r2-caddy.md`](docs/deployment/node-postgres-r2-caddy.md) — Self-hosted Node.js + Postgres + R2 storage + Caddy reverse proxy.
- [`docs/deployment/vercel-edge-neon-blob.md`](docs/deployment/vercel-edge-neon-blob.md) — Vercel Edge route handler + Neon Postgres (HTTP) + Vercel Blob.

For the host-by-host adapter overview see [`docs/deployment.md`](docs/deployment.md); for the live cross-runtime verification matrix see [`docs/cross-runtime-matrix.md`](docs/cross-runtime-matrix.md).

## Current Gaps

The project is not being marked complete yet. Remaining work includes browser E2E coverage for admin-driven content-type generation against a real running app, a fuller guided wizard polish pass, production deployment recipes for every adapter/storage combination, and a full requirement-by-requirement audit across the original plan files.
