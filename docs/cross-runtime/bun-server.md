# Bun.serve cross-runtime verification

**Runtime:** Bun 1.3.14
**Date:** 2026-05-23
**Example:** [`examples/bun-server`](../../examples/bun-server)
**Adapter required:** **none** — `cms.fetch` is a Web standard
`(Request) => Response` handler, which is exactly the shape `Bun.serve({ fetch })`
expects.

## TL;DR

`@hono-cms/core` boots on Bun with **zero adapter code**:

```ts
import { cms } from "./src/cms";

Bun.serve({ port: 8791, fetch: cms.fetch });
```

No `@hono/node-server`, no Express, no Elysia, no Fastify. The CMS instance
extends Hono, Hono exposes `.fetch`, and `Bun.serve` consumes `.fetch` directly.

## What the example covers

- Schema: `posts` (with `draftAndPublish: true`) + `authors` collections, exact
  shape requested for the cross-runtime matrix.
- Adapters: `@hono-cms/adapter-memory`, `@hono-cms/storage-memory`,
  `@hono-cms/cache` (memory), `@hono-cms/jobs` (memory).
- Built-in stores: `MemoryMediaStore`, `MemoryApiKeyStore`, default memory
  audit log.
- CORS: enabled with credentials, full method allow-list.
- Auth: static bearer tokens (`admin`, `editor`).
- OpenAPI: enabled with custom title `"Hono CMS (Bun.serve)"`.

## Live verification (real TCP socket)

Booted the server with `PORT=8791 bun src/index.ts` in the background and ran
curl against `127.0.0.1:8791`.

| Check | Endpoint | Expected | Got |
|-------|----------|----------|-----|
| Liveness | `GET /cms/health/live` | `200 {"status":"ok"}` | `200 {"status":"ok","version":"0.1.0","uptime_seconds":9}` |
| Schema present | `GET /cms/openapi.json` → `paths` | Contains `/api/posts` and `/api/authors` | `/api/posts`, `/api/posts/{id}`, `/api/posts/{id}/publish`, `/api/authors`, `/api/authors/{id}` (and others) all present |
| Create draft | `POST /api/posts` (Bearer admin) | `201` with `status: "draft"` | `201 {"id":"1da6e24c-…","status":"draft","title":"Bun-native CMS",…}` |
| Publish | `POST /api/posts/:id/publish` (Bearer admin) | `200` with `status: "published"` | `200 {"id":"1da6e24c-…","status":"published","publishedAt":"2026-05-23T13:52:18.977Z",…}` |
| Public list (filtered) | `GET /api/posts?status=published` | `items: [{ status: "published" }]` | `items: 1, first: { slug: "bun-native-cms", status: "published" }` |
| Audit log | `GET /cms/audit-log?collection=posts&documentId=:id` (Bearer admin) | Both `create` and `publish` entries | `[ "publish", "create" ]` |

## Automated tests

`bun test src/index.test.ts` spins up `Bun.serve({ port: 0, fetch: cms.fetch })`
on an ephemeral port and runs the same flow over `fetch()`:

```
bun test v1.3.14 (0d9b296a)

 5 pass
 0 fail
 14 expect() calls
Ran 5 tests across 1 file. [225.00ms]
```

The five tests cover: health 200, schema contains posts + authors, POST creates
a draft, publish flips status, audit log has both entries — i.e. the
"curl-equivalent" checks in the task spec, but executed against a real Bun
server in-process and torn down cleanly in `afterAll`.

## Conclusion

A third-party framework (Express, Elysia, Hono Node adapter, etc.) is **not
required** to host `@hono-cms/core` on Bun. The portability of the Web
`Request`/`Response` API plus Bun's native `Bun.serve` is sufficient. This is
the same property exploited by the `cloudflare-worker` and `vercel-edge`
examples — Bun joins them as a first-class no-adapter target.
