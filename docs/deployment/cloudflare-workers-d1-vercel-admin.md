# Cloudflare Workers + D1 + R2, Admin SPA on Vercel

End-to-end recipe: CMS API on Cloudflare Workers backed by D1 and R2, admin SPA hosted on Vercel.

## What you get

- API: `@hono-cms/platform/cloudflare` + `@hono-cms/adapter-d1` + `@hono-cms/storage-r2` + `@hono-cms/cache` (memory, lazy)
- Auth: static bearer tokens via `auth.tokens` (rotate to `@hono-cms/auth-*` later); RBAC `publicRead: true`
- Deploy target: Workers for the API, Vercel (static SPA) for `@hono-cms/admin-spa`

## Prerequisites

- Cloudflare account with Workers Paid or free tier; Vercel account (Hobby is fine)
- `wrangler@^4` (`npm i -g wrangler` then `wrangler login`)
- `vercel` CLI (`npm i -g vercel` then `vercel login`)
- `bun` (workspace install)
- DNS: a hostname for the API (e.g. `cms.example.com`) routable through Cloudflare; a hostname for the admin (e.g. `admin.example.com`) pointed at Vercel

## Wire the CMS

Mirror `examples/cloudflare-worker/src/worker.ts` and swap the memory adapters for D1 + R2. The CF runtime forbids async I/O at module scope, so lazy-instantiate inside `fetch` (see `docs/cross-runtime/cloudflare-worker.md`).

```ts
// src/cms.ts
import { createCMS, MemoryApiKeyStore, MemoryMediaStore, type CMSInstance } from "@hono-cms/core";
import { createD1Adapter } from "@hono-cms/adapter-d1";
import { createR2Storage } from "@hono-cms/storage-r2";
import { createMemoryCache } from "@hono-cms/cache";
import { createCloudflareExport } from "@hono-cms/platform/cloudflare";
import { collections } from "./schema";

export interface Env {
  DB: import("@hono-cms/adapter-d1").D1DatabaseLike; // D1 binding
  MEDIA: import("@hono-cms/storage-r2").R2BucketBinding; // R2 binding
  CMS_ADMIN_TOKEN: string;
  CMS_EDITOR_TOKEN: string;
  R2_PUBLIC_BASE_URL: string; // e.g. https://media.example.com
}

let cached: Pick<CMSInstance, "fetch" | "scheduled"> | null = null;
function getCMS(env: Env) {
  if (cached) return cached;
  const cms = createCMS({
    collections,
    db: createD1Adapter({ provider: "d1", collections, binding: env.DB }),
    storage: createR2Storage({ provider: "r2", bucket: env.MEDIA, publicBaseUrl: env.R2_PUBLIC_BASE_URL }),
    cache: createMemoryCache(),
    mediaStore: new MemoryMediaStore(),
    apiKeyStore: new MemoryApiKeyStore(),
    auth: {
      tokens: {
        [env.CMS_ADMIN_TOKEN]: { userId: "admin_1", roles: ["admin"] },
        [env.CMS_EDITOR_TOKEN]: { userId: "editor_1", roles: ["editor"] }
      }
    },
    rbac: { publicRead: true },
    cors: { origin: ["https://admin.example.com"], credentials: true, allowedHeaders: ["authorization", "content-type"], methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] },
    openapi: { path: "/cms/openapi.json", docs: "/cms/docs", title: "CMS", version: "0.1.0" }
  });
  cached = createCloudflareExport(cms);
  return cached;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return getCMS(env).fetch(request, env, ctx);
  }
};
```

`src/schema.ts` is identical to `examples/cloudflare-worker/src/schema.ts`.

> The Cloudflare runtime has **no filesystem**, so do **not** pass `contentTypeBuilder.writer`. Schema mutation must go through `cms schema apply` from CI.

## Database init

Create the D1 database, generate Drizzle artifacts from the schema, and apply migrations.

```sh
# 1. Generate Drizzle SQLite artifacts from cms.schema.ts
bunx @hono-cms/cli schema apply --schema src/schema.ts --state .hono-cms/schema-state.json

# 2. Provision D1
wrangler d1 create hono-cms
# -> copy the returned database_id into wrangler.toml below

# 3. Apply the generated migrations
wrangler d1 migrations apply hono-cms --remote
```

`cms schema apply` writes Drizzle artifacts under `node_modules/.cms/` and SQL under `.hono-cms/migrations/` (`packages/cli/src/index.ts:2165`). Wrangler's migrations command consumes the same `*.sql` files when you point its `migrations_dir` at that path.

## Deploy

`wrangler.toml`:

```toml
name = "hono-cms-api"
main = "src/worker.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "hono-cms"
database_id = "<from-d1-create>"
migrations_dir = ".hono-cms/migrations"

[[r2_buckets]]
binding = "MEDIA"
bucket_name = "hono-cms-media"

[vars]
R2_PUBLIC_BASE_URL = "https://media.example.com"
```

Secrets + deploy:

```sh
wrangler r2 bucket create hono-cms-media
wrangler secret put CMS_ADMIN_TOKEN
wrangler secret put CMS_EDITOR_TOKEN
wrangler deploy
# Bind the custom hostname in dash: Workers > hono-cms-api > Triggers > cms.example.com
```

## Admin SPA wiring

`@hono-cms/admin-spa` reads `VITE_CMS_API_URL` (see `apps/admin/src/lib/api-client.ts:699`). Build, then ship the static `dist/` to Vercel.

```sh
export VITE_CMS_API_URL=https://cms.example.com
bun --filter @hono-cms/admin-spa build
cd apps/admin
vercel --prod                       # one-time link
vercel deploy --prod --prebuilt     # subsequent
```

`vercel.json` at `apps/admin/`:

```json
{
  "buildCommand": "bun --filter @hono-cms/admin-spa build",
  "outputDirectory": "dist",
  "framework": null,
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

Set `VITE_CMS_API_URL` in Vercel project settings so subsequent CI builds pick it up.

## Verification

```sh
API=https://cms.example.com
ADMIN_TOKEN=...   # the one set via wrangler secret put

curl -s "$API/cms/health/live" | jq
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$API/cms/schema" | jq '.collections | keys'
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"title":"CF post","body":"hello"}' "$API/api/posts" | jq
```

Expected: `200`, `200` listing `posts`, `201` with `status: "draft"`. Matches the matrix probes in `docs/cross-runtime-matrix.md`.

## Cost ballpark

Cloudflare Workers free tier covers 100k requests/day and 10ms CPU/request; D1 free tier allows ~5GB storage and ~5M reads/day; R2 free includes 10GB storage and ~1M Class A ops/month with zero egress fees. Vercel Hobby is free for the SPA (100GB bandwidth) and disallows commercial use — bump to Pro ($20/seat/mo) for production. Typical small-newsroom traffic stays inside free tiers on both providers.

## Pitfalls

1. **No module-scope async I/O.** `MemoryCacheAdapter` `setInterval` in the constructor used to crash `wrangler dev` with `Disallowed operation called within global scope`; fixed in `packages/cache/src/index.ts` by deferring to first use. Still: instantiate the CMS **inside** `fetch`, not at import time — see `examples/cloudflare-worker/src/worker.ts:62-66`.
2. **No filesystem → no live Content-Type Builder writes.** Omit `contentTypeBuilder.writer`. Schema changes go through `cms schema apply` + `wrangler d1 migrations apply` in CI (`docs/cross-runtime/cloudflare-worker.md` "Known limits" §1).
3. **D1 has no advisory locks and limited transactions.** The D1 adapter declares `capabilities.transactions: true, advisoryLocks: false` (`packages/adapter-d1/src/index.ts:25-31`). Long-running multi-row writes should batch in single statements.
4. **CORS must whitelist the admin origin explicitly** when shipping cookies / `credentials: true`. `origin: true` will be rejected by browsers in credentialed mode.
5. **R2 public URLs require a custom domain or public bucket.** Set `publicBaseUrl` to your custom domain (Cloudflare dash → R2 → bucket → Settings → Public access). Otherwise `storage.publicUrl(key)` falls back to `r2://bucket/...`, which the admin can't render.
