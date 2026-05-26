# Vercel Edge cross-runtime verification

**Runtime:** Vercel Edge handler contract (`(Request) => Response`)
**Live host:** Bun 1.3.14 (`Bun.serve({ fetch: vercelHandler })`)
**Date:** 2026-05-23
**Example:** [`examples/vercel-edge`](../../examples/vercel-edge)
**Adapter required:** **none** — `createVercelHandler(cms)` returns the exact
`(Request) => Response | Promise<Response>` function shape that the Vercel
Edge runtime invokes. The handler itself is runtime-agnostic.

## TL;DR

The Vercel Edge route handler exported by `src/route.ts` is a Web standard
`(Request) => Response`. That contract is what Vercel Edge calls in production
and is also what `Bun.serve({ fetch })` accepts directly. The same handler
function, with no changes, answers HTTP under both. This example exploits that
to live-boot the handler over a real TCP socket without depending on
`vercel dev`.

```ts
// src/local-server.ts
import { handler } from "./route";

Bun.serve({ port: 8793, fetch: handler });
```

```bash
bun src/local-server.ts
# [vercel-edge] Hono CMS (Vercel Edge handler) listening on http://localhost:8793
```

## Why this is a faithful Vercel Edge probe

Vercel Edge functions are documented to receive a Web `Request` and return a
Web `Response`. They run on a V8 isolate with Web-standard `fetch`,
`Request`, `Response`, `URL`, `Headers`, `crypto.subtle`, etc.

Bun's runtime is also Web-standard compliant for the same surface. Plugging
the handler into `Bun.serve({ fetch })` exercises the identical contract:

- The handler is called with a real `Request` built from a TCP socket
- It returns a `Response` that gets streamed back over the same socket
- Auth headers, JSON bodies, URL parsing, query strings, status codes — all
  routed through the same code path Vercel would hit

The only thing this probe does not exercise that `vercel dev` would are
Vercel platform shims (`@vercel/edge`'s `geo`, `ip`, `waitUntil`) — none of
which the CMS uses.

**Why not `vercel dev`?** Preferred path (a) from the task spec requires the
Vercel CLI to be installed locally. It is not currently on this machine; the
fallback path (b) — Bun.serve with the Vercel handler shape — was used. The
fallback is sufficient because the handler is Web-standard
`(Request) => Response`, which is the entire Vercel Edge contract.

The `vercel.ts` adapter in `packages/platform/src/vercel.ts` was **not
modified** — it already returns the Web-standard handler shape, and that
shape is what enabled this live probe to work unchanged.

## What the example covers

`src/route.ts` mirrors the in-memory adapter set used by the other
cross-runtime examples (`examples/bun-server`, `examples/cloudflare-worker`,
`examples/elysia-host`):

- Schema: `posts` (with `draftAndPublish: true`) + `authors` collections,
  plus the original `pages` collection retained for the pre-existing
  route handler test.
- Adapters: `@hono-cms/adapter-memory` (db), `@hono-cms/storage-memory`,
  `@hono-cms/cache` (memory), `@hono-cms/jobs` (vercel provider with cron
  secret).
- Built-in stores: `MemoryMediaStore`, `MemoryApiKeyStore`, default memory
  audit log.
- CORS: enabled with credentials, full method allow-list.
- Auth: static bearer tokens (`admin`, `editor`).
- OpenAPI: enabled with custom title `"Hono CMS (Vercel Edge)"`.

## Live verification (real TCP socket on port 8793)

Booted with `PORT=8793 bun src/local-server.ts` and ran curl against
`127.0.0.1:8793`:

| # | Check | Endpoint | Expected | Got |
|---|-------|----------|----------|-----|
| 1 | Liveness | `GET /cms/health/live` | `200 {"status":"ok"}` | `200 {"status":"ok","version":"0.1.0","uptime_seconds":2}` |
| 2 | Schema | `GET /cms/schema` (Bearer admin) | `200` with `posts` + `authors` | `200` — `collections` includes `posts` (draft/publish) and `authors` |
| 3 | Create draft | `POST /api/posts` (Bearer admin, JSON body) | `201 status:"draft"` | `201 {"id":"780d56b1-…","status":"draft","title":"Vercel Edge live",…}` |
| 4 | Publish | `POST /api/posts/:id/publish` (Bearer admin) | `200 status:"published"` | `200 {"id":"780d56b1-…","status":"published","publishedAt":"2026-05-23T14:06:23.177Z",…}` |
| 5 | Audit log | `GET /cms/audit-log?collection=posts&documentId=:id` (Bearer admin) | Both `create` and `publish` entries | `200` — items contain one `publish` and one `create` entry |

## Automated tests

Two complementary test suites, both green:

### 1. `bun test src/local-server.test.ts` — live HTTP probes

Spins up `Bun.serve({ port: 0, fetch: handler })` on an ephemeral port and
runs the same flow over `fetch()`:

```
bun test v1.3.14 (0d9b296a)

 5 pass
 0 fail
 12 expect() calls
Ran 5 tests across 1 file. [185.00ms]
```

The five tests cover: health 200, schema includes posts + authors, POST
creates a draft, publish flips status, audit log has both entries.

### 2. `vitest run src/route.test.ts` — in-process handler test

The original pre-matrix test that asserts the Vercel Edge route handler
contract directly (no socket). Retained untouched; verifies the `pages`
collection workflow plus cron secret protection.

```
Test Files  1 passed (1)
     Tests  3 passed (3)
```

`vitest.config.ts` excludes `local-server.test.ts` so vitest does not try to
resolve `bun:test`.

## How to run

```bash
cd examples/vercel-edge

# In-process handler tests (vitest)
bun run test

# Live HTTP probes (bun:test against Bun.serve)
bun run test:live

# Boot the dev server manually
PORT=8793 bun run dev
curl http://127.0.0.1:8793/cms/health/live
```

## Conclusion

The Vercel Edge runtime is a Web-standard `(Request) => Response` host. By
treating it that way and plugging the same handler into `Bun.serve`, the
example proves the live HTTP contract without depending on the Vercel CLI.
This is the same property exploited by `examples/cloudflare-worker` and
`examples/bun-server` — Vercel Edge joins them as a first-class no-adapter
target. When `vercel dev` becomes available locally the same probes can be
re-run against it with no code changes.
