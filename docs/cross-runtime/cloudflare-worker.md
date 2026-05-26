# Cloudflare Worker runtime (examples/cloudflare-worker)

End-to-end verification that the Hono CMS serves correctly inside a real
Cloudflare Workers runtime via `wrangler dev --local` (workerd).

## How to run

From the repo root, with workspace dependencies installed (`bun install`):

```bash
cd examples/cloudflare-worker
bun run dev:wrangler
# wrangler dev --port 8789 --local
```

The Worker boots at `http://127.0.0.1:8789` and serves the full CMS surface
(`/cms/*` plus `/api/*` for each collection).

## What is wired up

`src/worker.ts` mirrors the in-memory adapter set used by
`examples/newsroom/src/dev-server.ts`:

- `db`: `@hono-cms/adapter-memory`
- `storage`: `@hono-cms/storage-memory`
- `cache`: `@hono-cms/cache` (`createMemoryCache()`)
- `mediaStore`: `MemoryMediaStore` (from `@hono-cms/core`)
- `apiKeyStore`: `MemoryApiKeyStore` (from `@hono-cms/core`)
- `auth.tokens`: `admin` (admin role) and `editor` (editor role)
- `rbac.publicRead: true`
- CORS allows all origins with the standard CMS methods/headers
- OpenAPI is exposed at `/cms/openapi.json` and `/cms/docs`

The Worker default export is a plain `ExportedHandler` (`fetch` + `scheduled`)
backed by the platform helper `createCloudflareExport`.

## Verified end-to-end (wrangler dev --local, port 8789)

All five live HTTP checks executed against the Worker runtime:

| # | Request | Result |
|---|---------|--------|
| 1 | `GET /cms/health/live` | `200` &mdash; `{"status":"ok","version":"0.1.0",...}` |
| 2 | `GET /cms/schema` (Bearer admin) | `200` &mdash; payload includes the `posts` collection with `title/slug/body/featured` fields |
| 3 | `POST /api/posts` (Bearer admin, JSON body) | `201` &mdash; returns `{ id, status: "draft", title: "CF post", slug: "cf-post" }` |
| 4 | `POST /api/posts/<id>/publish` (Bearer admin) | `200` &mdash; returns the document with `status: "published"` and `publishedAt` |
| 5 | `GET /cms/audit-log` (Bearer admin) | `200` &mdash; `items` includes one `create` and one `publish` entry for the post |

## Known limits on the Cloudflare runtime

1. **No filesystem &rArr; no schema mutation.** The content-type builder writer
   (`contentTypeBuilder.writer`) is intentionally omitted. Persisting schema
   edits requires a filesystem (or a remote schema service), neither of which
   the Worker has. The CMS itself still serves `/cms/schema` for read access.
2. **No timers / async I/O at module scope.** Cloudflare Workers reject any
   `setTimeout`/`setInterval`/`fetch()` calls outside of a handler. The
   `MemoryCacheAdapter` uses `setInterval` in its constructor for periodic
   sweeps, so this example lazy-instantiates the CMS on the first request
   instead of at import time. Without that change, `wrangler dev` fails on
   boot with `Disallowed operation called within global scope`.
3. **Memory adapters are per-isolate.** Data does not survive a Worker reload
   or scale-out. For production deployments swap in D1 (`@hono-cms/adapter-d1`),
   R2 (`@hono-cms/storage-r2`), and a real cache provider.

## Files

- `examples/cloudflare-worker/src/worker.ts`
- `examples/cloudflare-worker/src/schema.ts`
- `examples/cloudflare-worker/wrangler.toml`
- `examples/cloudflare-worker/package.json`
