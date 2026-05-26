# Hono CMS — TanStack Start example

This example mounts the same `createCMS()` instance from `@hono-cms/core` through a TanStack Start file-based server route. The route at `src/routes/api/cms/$.ts` catches every request under `/api/cms/*`, strips the `/api/cms` base path, and forwards the `Request` straight into `cms.fetch` so the CMS sees its canonical `/cms/*` and `/api/*` paths.

## Run

```bash
cd examples/tanstack-start
bun --bun vite dev --port 8790
# or
bun run dev
```

## Try it

```bash
# 1) Landing page (TanStack Start UI route + loader)
curl -s http://localhost:8790/ | head

# 2) Liveness probe — public
curl -s http://localhost:8790/api/cms/cms/health/live
# -> {"status":"ok","version":"0.1.0","uptime_seconds":...}

# 3) Schema — requires admin
curl -s -H "authorization: Bearer admin" http://localhost:8790/api/cms/cms/schema
# -> {"collections":{"posts":{...},"authors":{...}}}

# 4) Create a post
curl -s -X POST \
  -H "authorization: Bearer admin" \
  -H "content-type: application/json" \
  -d '{"title":"TSS post","slug":"tss-post"}' \
  http://localhost:8790/api/cms/api/posts
# -> 201 with the new record

# 5) Publish it
POST_ID=...   # paste id from step 4
curl -s -X POST -H "authorization: Bearer admin" \
  http://localhost:8790/api/cms/api/posts/$POST_ID/publish
# -> {"status":"published",...}
```

## Route handler shape

```ts
// src/routes/api/cms/$.ts
import { createFileRoute } from "@tanstack/react-router";
import { cms } from "../../../cms";

const BASE_PATH = "/api/cms";

function forward(request: Request) {
  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith(BASE_PATH)) return cms.fetch(request);
  const rewritten = new URL(incoming);
  rewritten.pathname = incoming.pathname.slice(BASE_PATH.length) || "/";
  return cms.fetch(new Request(rewritten, request));
}

const handler = async ({ request }: { request: Request }) => forward(request);

export const Route = createFileRoute("/api/cms/$")({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
      PUT: handler,
      PATCH: handler,
      DELETE: handler,
      OPTIONS: handler,
      HEAD: handler
    }
  }
});
```

The same forwarding strategy used by `createNextRouteHandlers({ basePath: "/api/cms" })` in `@hono-cms/platform/next`: rewrite the URL, then hand the Web `Request` to `cms.fetch`.

## What was tested

Smoke-tested end-to-end with curl against `vite dev --port 8790`:

| Step                                                       | Result |
| ---------------------------------------------------------- | ------ |
| `GET /`                                                    | 200 (HTML rendered by `__root.tsx` + `index.tsx`) |
| `GET /api/cms/cms/health/live`                             | 200 `{"status":"ok",...}` |
| `GET /api/cms/cms/schema` (Bearer admin)                   | 200 contains `posts` + `authors` |
| `POST /api/cms/api/posts` (Bearer admin)                   | 201 with new record id |
| `POST /api/cms/api/posts/<id>/publish` (Bearer admin)      | 200 `"status":"published"` |

## Notes on the stack

- The example uses **modern TanStack Start (Vite-based, v1.168.10)** rather than the legacy vinxi-based v1.120.x. The newer stack uses Vite directly via `@tanstack/react-start/plugin/vite` and has dropped vinxi entirely. The legacy `createAPIFileRoute` shape is replaced by `createFileRoute(path)({ server: { handlers: {...} } })`. See `docs/cross-runtime/tanstack-start.md` for the version-conflict rationale.
- The CMS uses the in-memory adapter/storage/cache stack with admin token `"admin"` and `publicRead: true`. CORS is wide-open for local development.
- `getRouter` (not `createRouter`) must be exported from `src/router.tsx` — the TanStack Start plugin discovers it by name.
