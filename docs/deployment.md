# Deployment Guide

Hono CMS is built around the standard Web `Request` / `Response` API. The same `createCMS` instance can be adapted to Node, Cloudflare Workers, Vercel Edge, and Next.js App Router without changing the content schema.

This guide documents the deployment surfaces currently implemented in the repository.

## Shared CMS Module

Start by keeping the CMS instance in a host-neutral module:

```ts
import { createCMS } from "@hono-cms/core";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";

const collections = defineSchema({
  posts: defineCollection("posts", {
    title: fields.string({ required: true }),
    body: fields.richtext(),
  }, { draftAndPublish: true }),
});

export const cms = createCMS({
  collections,
  db: createMemoryDatabase({ provider: "memory", collections }),
  auth: {
    tokens: {
      admin: { userId: "admin", roles: ["admin"] },
    },
  },
  rbac: { publicRead: true },
  openapi: {
    path: "/cms/openapi.json",
    docs: "/cms/docs",
    title: "CMS API",
    version: "0.1.0",
  },
});
```

For production, swap the memory database/storage providers for the host-appropriate adapters.

## Node

Use `@hono-cms/platform/node` to bridge Node HTTP requests into Web requests:

```ts
import { createServer } from "node:http";
import { createNodeHandler } from "@hono-cms/platform/node";
import { cms } from "./cms";

createServer(createNodeHandler(cms)).listen(3000);
```

Evidence:

- `packages/platform/src/node.ts`
- `examples/newsroom/src/node-server.ts`

## Cloudflare Workers

Use `@hono-cms/platform/cloudflare` for module-worker exports:

```ts
import { createCloudflareExport } from "@hono-cms/platform/cloudflare";
import { cms } from "./cms";

export default createCloudflareExport(cms);
```

The Cloudflare adapter forwards `fetch(request, env, ctx)` to the CMS and also exposes `scheduled` when jobs are configured.

Recommended production pairings:

- Database: `@hono-cms/adapter-d1`
- Storage: `@hono-cms/storage-r2`

Evidence:

- `packages/platform/src/cloudflare.ts`
- `examples/cloudflare-worker/src/worker.ts`

## Vercel Edge

Use `@hono-cms/platform/vercel` for Edge route handlers:

```ts
import { createVercelHandler, generateVercelJson } from "@hono-cms/platform/vercel";
import { cms } from "./cms";

export const runtime = "edge";

const handler = createVercelHandler(cms);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;

export const vercelJson = generateVercelJson({
  "/cms/jobs/scheduled-publish": "*/15 * * * *",
  "/cms/jobs/audit-log-cleanup": "0 3 * * *",
});
```

Recommended production pairings:

- Database: `@hono-cms/adapter-postgres` or `@hono-cms/adapter-turso`
- Storage: `@hono-cms/storage-vercel-blob` or `@hono-cms/storage-s3`
- Jobs: `@hono-cms/jobs` with the Vercel provider/secret config

Evidence:

- `packages/platform/src/vercel.ts`
- `examples/vercel-edge/src/route.ts`
- `examples/newsroom/src/edge.ts`

## Next.js App Router

Use `@hono-cms/platform/next` in an App Router catch-all route:

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

The Next example includes tests for content CRUD/publish and content-type generation through the App Router handler surface.

Recommended production pairings:

- Database: `@hono-cms/adapter-postgres` or `@hono-cms/adapter-turso`
- Storage: `@hono-cms/storage-vercel-blob` or `@hono-cms/storage-s3`

Evidence:

- `packages/platform/src/next.ts`
- `examples/next-app/app/api/cms/[...route]/route.ts`
- `examples/next-app/src/route.test.ts`

## CLI Templates

The CLI can scaffold host-specific files and infrastructure hints:

```sh
cms init --preset cloudflare --database d1 --storage r2
cms init --preset vercel --database postgres --storage vercel-blob
cms init --preset node --database postgres --storage s3
cms init --preset next --database postgres --storage vercel-blob
```

Generate deployment templates:

```sh
cms deploy --target cloudflare --schema cms.schema.ts --out wrangler.generated.toml
cms deploy --target vercel --schema cms.schema.ts --out vercel.generated.json
cms deploy --target node --schema cms.schema.ts --out deploy.node.generated.txt
cms deploy --target next --schema cms.schema.ts --out deploy.next.generated.txt
```

Generate only a platform entrypoint:

```sh
cms entrypoint --target cloudflare --entry src/cms.ts
cms entrypoint --target vercel --entry src/cms.ts
cms entrypoint --target node --entry src/cms.ts
cms entrypoint --target next --entry src/cms.ts
```

The deployment templates inspect the schema when provided and include infrastructure notes for relations, media, draft/publish, i18n, jobs, and scheduled cleanup.

## Generated Artifacts Before Deploy

Run these before deploying a schema change:

```sh
cms doctor --schema cms.schema.ts --state .hono-cms/schema-state.json
cms schema check-sdk --schema cms.schema.ts --out cms/sdk/index.ts
cms schema check-openapi --schema cms.schema.ts --out cms/openapi.json
cms schema check-drizzle --schema cms.schema.ts --out node_modules/.cms/drizzle-schema.ts
cms schema plan --schema cms.schema.ts --state .hono-cms/schema-state.json
```

The admin Content-Type Builder exposes the same idea in its generated preview: source, SDK/API contracts, persistence planning, and verification snippets are shown before and after schema writes.

## Current Production Caveats

- The examples use memory adapters for local tests; production deployments should use durable database and storage adapters.
- The complete browser-admin generation journey is not yet covered by an end-to-end browser test.
- Deployment templates exist, but this repository does not yet include fully hosted, provider-account-specific walkthroughs for every adapter/storage pair.
