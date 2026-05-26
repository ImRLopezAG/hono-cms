# Self-hosted Node.js + Postgres + R2 + Caddy

Long-running Node process behind Caddy, Postgres as the document store, Cloudflare R2 (via S3 API) for media.

## What you get

- API: `@hono-cms/platform/node` + `@hono-cms/adapter-postgres` (TCP mode) + `@hono-cms/storage-s3` against R2's S3 endpoint
- Auth: static bearer tokens; RBAC `publicRead: true` (swap to `@hono-cms/auth-*` for password/magic-link later)
- Deploy target: Linux box (systemd), Caddy as TLS-terminating reverse proxy

## Prerequisites

- A Linux host with `node@20+` (Node 18+ is required for `Readable.toWeb` — `docs/runtimes/node.md`), `bun` (for the workspace build), and `psql`
- Postgres 15+ (managed or self-hosted)
- Cloudflare R2 bucket with S3 API token (Account → R2 → Manage R2 API Tokens). Capture `endpoint`, `accessKeyId`, `secretAccessKey`
- Caddy v2 installed (`brew`/`apt` package)
- DNS: A/AAAA record for `cms.example.com` pointed at the host

## Wire the CMS

```ts
// src/cms.ts
import { createCMS, MemoryApiKeyStore, MemoryMediaStore } from "@hono-cms/core";
import { createPostgresAdapter } from "@hono-cms/adapter-postgres";
import { createS3Storage } from "@hono-cms/storage-s3";
import { createMemoryCache } from "@hono-cms/cache";
import { createMemoryJobs } from "@hono-cms/jobs";
import postgres from "postgres";
import { collections } from "./schema";

const sql = postgres(process.env.DATABASE_URL!, { max: 10 });

const pgClient = {
  async query(statement: string, params: unknown[] = []) {
    return (await sql.unsafe(statement, params as never[])) as unknown[];
  },
  async execute(statement: string, params: unknown[] = []) {
    await sql.unsafe(statement, params as never[]);
  }
};

export const cms = createCMS({
  collections,
  db: createPostgresAdapter({
    provider: "postgres",
    collections,
    url: process.env.DATABASE_URL!,
    mode: "tcp",
    client: pgClient
  }),
  storage: createS3Storage({
    provider: "s3",
    bucket: process.env.R2_BUCKET!,
    region: "auto",
    endpoint: process.env.R2_ENDPOINT!, // https://<accountid>.r2.cloudflarestorage.com
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL!,
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! }
  }),
  cache: createMemoryCache(),
  jobs: createMemoryJobs(),
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
  openapi: { path: "/cms/openapi.json", docs: "/cms/docs", title: "CMS", version: "0.1.0" }
});
```

Server bootstrap mirrors `examples/newsroom/src/dev-server.ts`:

```ts
// src/server.ts
import { createServer } from "node:http";
import { createNodeHandler } from "@hono-cms/platform/node";
import { cms } from "./cms";

const port = Number(process.env.PORT ?? 8787);
createServer(createNodeHandler(cms)).listen(port, "127.0.0.1");
```

Postgres TCP mode unlocks transactions + advisory locks (`packages/adapter-postgres/src/index.ts:27-31`).

## Database init

```sh
# 1. Create the database
psql -h pg.example.com -U postgres -c 'CREATE DATABASE hono_cms;'

# 2. Generate + apply Drizzle migrations from cms.schema.ts
DATABASE_URL=postgres://hono_cms:****@pg.example.com:5432/hono_cms \
bunx @hono-cms/cli schema apply --schema src/schema.ts --state .hono-cms/schema-state.json

# 3. Run the generated SQL against Postgres
psql "$DATABASE_URL" -f .hono-cms/migrations/0001_init.sql
```

`cms schema apply` is the entry point (`packages/cli/src/index.ts:2165-2185`). It writes the per-version `*.sql` files into `.hono-cms/migrations/`.

## Deploy

systemd unit `/etc/systemd/system/hono-cms.service`:

```ini
[Unit]
Description=Hono CMS
After=network.target

[Service]
Type=simple
User=cms
WorkingDirectory=/opt/hono-cms
EnvironmentFile=/etc/hono-cms.env
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
```

`/etc/hono-cms.env` (chmod 600):

```ini
DATABASE_URL=postgres://hono_cms:****@127.0.0.1:5432/hono_cms
R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
R2_BUCKET=hono-cms-media
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_PUBLIC_BASE_URL=https://media.example.com
CMS_ADMIN_TOKEN=...
CMS_EDITOR_TOKEN=...
ADMIN_ORIGIN=https://admin.example.com
PORT=8787
```

`/etc/caddy/Caddyfile`:

```caddy
cms.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8787 {
    header_up Host {host}
    header_up X-Forwarded-For {remote}
  }
}
```

```sh
bun install && bun run build           # produces dist/server.js
systemctl daemon-reload
systemctl enable --now hono-cms caddy
```

## Admin SPA wiring

Two options. Either co-host on the same Caddy or push to Vercel/Pages.

Build:

```sh
export VITE_CMS_API_URL=https://cms.example.com
bun --filter @hono-cms/admin-spa build
# apps/admin/dist contains the static SPA
```

Co-hosted Caddy block:

```caddy
admin.example.com {
  root * /opt/hono-cms/apps/admin/dist
  try_files {path} /index.html
  file_server
}
```

Or push `apps/admin/dist` to Vercel with the same `vercel.json` shape shown in [cloudflare-workers-d1-vercel-admin.md](./cloudflare-workers-d1-vercel-admin.md#admin-spa-wiring).

## Verification

```sh
API=https://cms.example.com
ADMIN_TOKEN=...

curl -s "$API/cms/health/live" | jq
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$API/cms/schema" | jq '.collections | keys'
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Node post","body":"hello"}' "$API/api/posts" | jq
```

Same probes as `docs/cross-runtime-matrix.md`.

## Cost ballpark

VPS (Hetzner CX22 / DO basic): ~$5–7/mo. Managed Postgres (Neon free, Supabase free, or RDS db.t4g.micro ~$15/mo). Cloudflare R2: 10GB storage + ~1M Class A ops free per month, zero egress. Caddy and the Node process are free. Realistic floor for a small site: $5–10/mo all-in if you co-locate Postgres on the VPS.

## Pitfalls

1. **`Readable.toWeb` requires Node 18+.** `@hono-cms/platform/node` bridges `IncomingMessage` ↔ Web `Request` using stream interop only available on modern Node (`docs/runtimes/node.md` "Gotcha"). Node 16 will silently throw on request bodies.
2. **R2 S3 API needs `forcePathStyle: true`.** The R2 endpoint hostname is per-account, not per-bucket; virtual-hosted-style addressing fails. `createS3Storage` accepts this flag (`packages/storage-s3/src/index.ts:14-35`).
3. **Set `publicBaseUrl` to your R2 custom domain.** Without it `S3StorageAdapter.publicUrl` returns the raw S3 URL — which R2 does **not** serve over HTTPS unless you wire a custom domain or `pub-*.r2.dev` URL.
4. **Caddy must trust the proxy hop.** If you terminate TLS at Caddy and the Node side reads `X-Forwarded-Proto`, ensure Caddy sets it (Caddy v2 does so by default for `reverse_proxy`). Otherwise sessions/cookies marked `Secure` are dropped.
5. **Postgres advisory locks gate the schema writer.** The Postgres adapter advertises `advisoryLocks: true` only in `tcp` mode (`packages/adapter-postgres/src/index.ts:27-31`). Don't run `cms schema apply` against a pgbouncer connection in `statement`/`transaction` mode — it'll lose the lock between statements. Point migrations at the direct Postgres port.
