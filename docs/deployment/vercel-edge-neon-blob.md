# Vercel Edge + Neon Postgres (HTTP) + Vercel Blob

Edge route handler on Vercel, Neon serverless Postgres over HTTP (no TCP), Vercel Blob for media.

## What you get

- API: `@hono-cms/platform/vercel` + `@hono-cms/adapter-postgres` (HTTP mode for Neon) + `@hono-cms/storage-vercel-blob` + `@hono-cms/cache` + `@hono-cms/jobs` (Vercel cron)
- Auth: static bearer tokens; RBAC `publicRead: true`
- Deploy target: Vercel Edge (V8 isolates) for the API; Vercel static for the SPA

## Prerequisites

- Vercel account + project, `vercel` CLI (`npm i -g vercel`, `vercel login`)
- Neon project; capture the pooled connection string ending in `neon.tech` (HTTP driver auto-selected — `packages/adapter-postgres/src/index.ts:48-51`)
- `@vercel/blob` read-write token (`vercel env add BLOB_READ_WRITE_TOKEN`)
- `psql` for the one-time migration
- DNS for `cms.example.com` (added in Vercel project Settings → Domains)

## Wire the CMS

Mirrors `examples/vercel-edge/src/route.ts`. The handler shape is the Web standard `(Request) => Response` already verified in `docs/cross-runtime/vercel-edge.md`.

```ts
// src/cms.ts
import { createCMS, MemoryApiKeyStore, MemoryMediaStore } from "@hono-cms/core";
import { createPostgresAdapter } from "@hono-cms/adapter-postgres";
import { createVercelBlobStorage } from "@hono-cms/storage-vercel-blob";
import { createMemoryCache } from "@hono-cms/cache";
import "@hono-cms/jobs";
import { createVercelHandler, generateVercelJson } from "@hono-cms/platform/vercel";
import { neon } from "@neondatabase/serverless";
import { collections } from "./schema";

const sql = neon(process.env.DATABASE_URL!);
const pgClient = {
  async query(statement: string, params: unknown[] = []) {
    return (await sql.query(statement, params)) as unknown[];
  },
  async execute(statement: string, params: unknown[] = []) {
    await sql.query(statement, params);
  }
};

export const cms = createCMS({
  collections,
  db: createPostgresAdapter({ provider: "postgres", collections, url: process.env.DATABASE_URL!, mode: "http", client: pgClient }),
  storage: createVercelBlobStorage({ provider: "vercel-blob", token: process.env.BLOB_READ_WRITE_TOKEN!, access: "public" }),
  cache: createMemoryCache(),
  mediaStore: new MemoryMediaStore(),
  apiKeyStore: new MemoryApiKeyStore(),
  auth: {
    tokens: {
      [process.env.CMS_ADMIN_TOKEN!]: { userId: "admin_1", roles: ["admin"] },
      [process.env.CMS_EDITOR_TOKEN!]: { userId: "editor_1", roles: ["editor"] }
    }
  },
  rbac: { publicRead: true },
  cors: { origin: [process.env.ADMIN_ORIGIN!], credentials: true, allowedHeaders: ["authorization", "content-type"], methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] },
  openapi: { path: "/cms/openapi.json", docs: "/cms/docs", title: "CMS (Vercel Edge)", version: "0.1.0" },
  jobs: { provider: "vercel", secret: process.env.CRON_SECRET! }
});

export const handler = createVercelHandler(cms);
export const vercelJson = generateVercelJson({
  "/cms/jobs/scheduled-publish": "*/15 * * * *",
  "/cms/jobs/audit-log-cleanup": "0 3 * * *"
});
```

Route file:

```ts
// app/api/cms/[...route]/route.ts (or pages/api/cms/[...route].ts)
import { handler } from "@/src/cms";
export const runtime = "edge";
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
```

## Database init

```sh
# 1. Generate Drizzle Postgres migrations
DATABASE_URL='postgresql://...neon.tech/neondb?sslmode=require' \
bunx @hono-cms/cli schema apply --schema src/schema.ts --state .hono-cms/schema-state.json

# 2. Apply against Neon over psql (or via the Neon SQL editor)
psql "$DATABASE_URL" -f .hono-cms/migrations/0001_init.sql
```

`cms schema apply` writes the SQL into `.hono-cms/migrations/` (`packages/cli/src/index.ts:2165-2185`); Neon accepts the same DDL as upstream Postgres.

## Deploy

`vercel.json` at the project root (use the structure emitted by `generateVercelJson` for crons):

```json
{
  "crons": [
    { "path": "/cms/jobs/scheduled-publish", "schedule": "*/15 * * * *" },
    { "path": "/cms/jobs/audit-log-cleanup", "schedule": "0 3 * * *" }
  ]
}
```

```sh
vercel env add DATABASE_URL          # production
vercel env add BLOB_READ_WRITE_TOKEN
vercel env add CMS_ADMIN_TOKEN
vercel env add CMS_EDITOR_TOKEN
vercel env add CRON_SECRET           # signs the cron pings
vercel env add ADMIN_ORIGIN
vercel deploy --prod
```

The Edge runtime is mandatory because `@hono-cms/adapter-postgres` in `http` mode uses the Neon serverless driver (fetch-only). `mode: "http"` reports `transactions: false, advisoryLocks: false` (`packages/adapter-postgres/src/index.ts:27-31`) — don't expect cross-statement atomicity in this configuration.

## Admin SPA wiring

```sh
export VITE_CMS_API_URL=https://cms.example.com
bun --filter @hono-cms/admin-spa build
cd apps/admin
vercel --prod                 # one-time link
vercel deploy --prod --prebuilt
```

`apps/admin/vercel.json`:

```json
{
  "buildCommand": "bun --filter @hono-cms/admin-spa build",
  "outputDirectory": "dist",
  "framework": null,
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

Set `VITE_CMS_API_URL` in Vercel project settings; `apps/admin/src/lib/api-client.ts:699` reads it.

## Verification

```sh
API=https://cms.example.com
ADMIN_TOKEN=...

curl -s "$API/cms/health/live" | jq
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$API/cms/schema" | jq '.collections | keys'
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Edge post","body":"hello"}' "$API/api/posts" | jq
```

## Cost ballpark

Vercel Hobby is free for personal projects (100GB bandwidth, Edge included, cron jobs limited to 2/day) — production sites need Pro at $20/seat/mo for commercial use and unrestricted cron. Neon free tier: 0.5 GB storage, one always-on compute, autosuspend. Vercel Blob free tier: 1 GB storage + 10 GB bandwidth per month, $0.023/GB beyond. A small CMS comfortably fits free Neon + Hobby for previews; flip to Pro + Neon Launch ($19/mo) for production.

## Pitfalls

1. **Edge runtime forbids `node:*`.** No `node:fs`, no `pg` (TCP), no `node:crypto.pbkdf2Sync`. The Neon HTTP driver is the only Postgres client that works here; `detectPostgresMode("…neon.tech…")` returns `"http"` automatically (`packages/adapter-postgres/src/index.ts:48-51`).
2. **HTTP-mode Postgres has no transactions/advisory locks.** Migrations should run from CI against the direct (non-pooled) Neon endpoint; the runtime adapter advertises `transactions: false` (see `packages/adapter-postgres/src/index.ts:27-31`).
3. **Omit `contentTypeBuilder.writer`.** The Edge sandbox has no filesystem — same constraint as Cloudflare Workers (`docs/cross-runtime/cloudflare-worker.md` "Known limits" §1). Schema mutations go through `cms schema apply` + a redeploy.
4. **`@vercel/blob` requires `BLOB_READ_WRITE_TOKEN` even at runtime.** The adapter's constructor accepts it (`packages/storage-vercel-blob/src/index.ts:25-30`); without it, every `put` fails with 401. `vercel link`'s default env pulls only the dev token — set the prod one explicitly.
5. **Vercel crons need the `CRON_SECRET` to match.** `jobs.provider: "vercel"` validates the secret header on every invocation (`examples/vercel-edge/src/route.ts:10,45`). Mismatched secrets silently 401 and the cron entry disappears from Vercel's UI without a clear error.
