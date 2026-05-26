# ElysiaJS host (examples/elysia-host)

**Runtime:** Bun 1.3.14 + ElysiaJS 1.4.28
**Date:** 2026-05-23
**Example:** [`examples/elysia-host`](../../examples/elysia-host)
**Adapter required:** **none** — `cms.fetch` is a Web-standard
`(Request) => Response` handler, which is exactly what Elysia's route handlers
already pass around.

## TL;DR

`@hono-cms/core` slots into a third-party Bun-native HTTP framework as a
child route with no adapter package:

```ts
import { Elysia } from "elysia";
import { cms } from "./cms";

new Elysia()
  .get("/", () => "Hono CMS via Elysia host")
  .all("/api/cms/*", ({ request }) => cms.fetch(stripPrefix(request, "/api/cms")))
  .listen(8792);
```

`stripPrefix` rewrites the URL pathname before delegating, so the CMS keeps
seeing its canonical `/cms/...` and `/api/...` paths. The helper is a local copy
of the one shipped in `@hono-cms/platform/next` — same shape, no Next.js
dependency.

## What the example covers

- Schema: `posts` (with `draftAndPublish: true`) + `authors` collections — same
  shape as the `bun-server` example so rows are directly comparable.
- Adapters: `@hono-cms/adapter-memory`, `@hono-cms/storage-memory`,
  `@hono-cms/cache` (memory), `@hono-cms/jobs` (workspace dep).
- Built-in stores: `MemoryMediaStore`, `MemoryApiKeyStore`.
- CORS: enabled with credentials, full method allow-list.
- Auth: static bearer tokens (`admin`, `editor`).
- OpenAPI: enabled with custom title `"Hono CMS (ElysiaJS host)"`.

## Mounting strategy

The Elysia app owns its own root (`GET /`) — a deliberate choice to prove the
CMS does not need to be at the root of the host. Anything under `/api/cms/*`
is forwarded into `cms.fetch`. The host could just as easily mount the CMS
under `/admin`, `/_cms`, or a versioned prefix; only `stripPrefix`'s `basePath`
argument changes.

`stripPrefix` (verbatim from `src/index.ts`):

```ts
function stripPrefix(request: Request, basePath: string): Request {
  const normalized = normalizeBasePath(basePath);
  if (!normalized) return request;
  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith(normalized)) return request;
  const rewritten = new URL(incoming);
  rewritten.pathname = incoming.pathname.slice(normalized.length) || "/";
  return new Request(rewritten, request);
}
```

## Live verification (real TCP socket)

Booted with `bun src/index.ts` in the background and ran curl against
`127.0.0.1:8792`.

| # | Request | Expected | Got |
|---|---------|----------|-----|
| 1 | `GET /` | `200` "Hono CMS via Elysia host" | `200` `Hono CMS via Elysia host` |
| 2 | `GET /api/cms/cms/health/live` | `200 {"status":"ok"}` | `200 {"status":"ok","version":"0.1.0","uptime_seconds":12}` |
| 3 | `GET /api/cms/cms/schema` (Bearer admin) | Includes `posts` + `authors` | `200` payload includes both `posts` (draftAndPublish) and `authors` collections |
| 4 | `POST /api/cms/api/posts` (Bearer admin, JSON body) | `201` with `status: "draft"` | `201 {"id":"3fb9939c-…","status":"draft","title":"Elysia post","slug":"elysia-post"}` |
| 5 | `POST /api/cms/api/posts/<id>/publish` (Bearer admin) | `200` with `status: "published"` | `200 {"id":"3fb9939c-…","status":"published","publishedAt":"2026-05-23T13:51:34.793Z",…}` |

## Automated tests

`src/index.test.ts` exercises the host with `app.handle(new Request(…))` —
Elysia's in-process handler. No TCP socket needed; Vitest runs under Node.

```
RUN  v4.1.7 /Users/imrlopez/dev/monorepo/cms/examples/elysia-host

Test Files  1 passed (1)
     Tests  5 passed (5)
```

The five tests cover: Elysia root returns the welcome string, CMS health
behind the prefix, schema introspection (posts + authors), draft create →
publish flip, and a control test confirming unprefixed paths fall through to
Elysia's 404 (so the CMS does not silently swallow other routes).

## Conclusion

ElysiaJS, a Bun-native third-party HTTP framework with its own router and
plugin model, hosts `createCMS` as a regular child handler with no adapter.
The only glue is a 10-line `stripPrefix` helper — the same trick the Next.js
adapter uses, generalized.

This complements the `bun-server` example: there, `Bun.serve({ fetch: cms.fetch })`
proves the framework-less path; here, Elysia proves the framework-hosted path.
Both work because the CMS exposes a Web-standard `fetch` handler.

## Files

- `examples/elysia-host/src/cms.ts`
- `examples/elysia-host/src/index.ts`
- `examples/elysia-host/src/index.test.ts`
- `examples/elysia-host/package.json`
- `examples/elysia-host/tsconfig.json`
- `examples/elysia-host/README.md`
