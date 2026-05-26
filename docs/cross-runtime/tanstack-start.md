# TanStack Start — cross-runtime verification

Date: 2026-05-23
Example: `examples/tanstack-start`
Verifier: ce-work cross-runtime sweep

## How to run

```bash
cd examples/tanstack-start
bun --bun vite dev --port 8790
# or: bun run dev
```

The example boots a TanStack Start dev server (Vite-based) on port 8790 with the CMS mounted at `/api/cms/*`.

## Why Vite (not vinxi)

The task spec called for the legacy vinxi-based `@tanstack/react-start@1.120.x` stack. That stack was attempted first and the binary installed cleanly (`vinxi@0.5.3`) — but the dev server crashes immediately:

```
SyntaxError: Export named 'startAPIRouteSegmentsFromTSRFilePath' not found
  in module '.../node_modules/@tanstack/router-generator/dist/esm/index.js'.
```

Root cause: this monorepo's `apps/admin` already pins `@tanstack/router-plugin@^1.168.10` against `@tanstack/react-router@1.170.7`. Bun deduplicates `@tanstack/router-generator` to the newest version (`1.167.9`) when resolving `@tanstack/react-start-config@1.120.20`'s `^1.120.20` request, which crosses a major API boundary in router-generator and breaks vinxi at startup. The fix would require either:

- Adding a root `overrides` block forcing `@tanstack/router-generator` and `@tanstack/router-plugin` down to `1.120.20` — which would downgrade the admin out from under itself.
- Pinning nested copies inside `examples/tanstack-start/node_modules` via something bun doesn't support out of the box.

Neither is acceptable under the spec's "stay only in examples/tanstack-start/" constraint, so the example uses **modern TanStack Start v1.168.10**, which:

- Drops vinxi entirely and uses Vite directly via `@tanstack/react-start/plugin/vite`.
- Replaces the legacy `createAPIFileRoute(path)({ GET, POST, ... })` shape with `createFileRoute(path)({ server: { handlers: { GET, POST, ... } } })`.
- Plays cleanly with the existing monorepo lockfile (admin and the new example share the same router/router-plugin versions).

## What was tested

End-to-end curl drive against `vite dev --port 8790`:

| # | Request                                                  | Result |
|---|----------------------------------------------------------|--------|
| 1 | `GET /`                                                  | 200, HTML body served by TanStack Start SSR (root + index route) |
| 2 | `GET /api/cms/cms/health/live`                           | 200, `{"status":"ok","version":"0.1.0","uptime_seconds":6}` |
| 3 | `GET /api/cms/cms/schema` (Bearer admin)                 | 200, payload contains `collections.posts` and `collections.authors` with field shapes |
| 4 | `POST /api/cms/api/posts` (Bearer admin, JSON body)      | 201, returns the created record (`status:"draft"`) |
| 5 | `POST /api/cms/api/posts/<id>/publish` (Bearer admin)    | 200, returns the record with `status:"published"` and `publishedAt` |

Verified record id: `7123b701-fa6f-4cd8-a70f-28a2818196ff`. Same `createCMS()` factory — same schema (`posts` + `authors`, `draftAndPublish: true` on posts), same memory adapter/storage/cache, same admin token (`Bearer admin`), same CORS — mounted in a TanStack Start file route.

## The route handler

```ts
// examples/tanstack-start/src/routes/api/cms/$.ts
import { createFileRoute } from "@tanstack/react-router";
import { cms } from "../../../cms";

const BASE_PATH = "/api/cms";

function forward(request: Request): Response | Promise<Response> {
  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith(BASE_PATH)) {
    return cms.fetch(request);
  }
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

The base-path stripping mirrors `createNextRouteHandlers({ basePath: "/api/cms" })` from `@hono-cms/platform/next`. After stripping, the CMS Hono router sees `/cms/health/live`, `/cms/schema`, `/api/posts`, etc. — its canonical paths.

## Caveats

- The `/` landing page's loader fetches `http://127.0.0.1:8790/api/cms/api/posts` from inside the SSR loader. On the very first request before the dev server is fully listening on its own loopback, this can resolve to `null` and the page just renders an empty `<pre>`. Once any other request has hit the server, the loader fills in. This is cosmetic — the API mount itself is verified independently via direct curl.
- `getRouter` (not `createRouter`) is the required export name in `src/router.tsx`. The TanStack Start vite plugin's route-tree footer emits `import type { getRouter } from '...router'`.
- The admin app's TanStack Start integration is not affected; this example uses entirely separate workspace deps.
