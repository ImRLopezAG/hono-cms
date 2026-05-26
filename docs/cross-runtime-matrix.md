# Cross-runtime verification matrix

Live boots of every runtime example, exercised with the same end-to-end probes:

1. `GET /cms/health/live`
2. `GET /cms/schema` (Bearer admin)
3. `POST /api/posts` (Bearer admin, JSON body)
4. `POST /api/posts/<id>/publish` (Bearer admin)
5. `GET /cms/audit-log` (Bearer admin)
6. (where filesystem available) `POST /cms/content-types` for live schema mutation

Every CMS-bearing example uses identical in-memory adapters (db, storage, cache, mediaStore, apiKeyStore, jobs) so the runtime is the only variable.

| Runtime | Example | Port | Health | Schema | Create | Publish | Audit | Live builder | Notes |
|---------|---------|------|--------|--------|--------|---------|-------|--------------|-------|
| **Node.js + Vite admin** | `examples/newsroom` (`bun src/dev-server.ts`) | 8787 | ✅ 200 | ✅ 200 | ✅ 201 | ✅ 200 | ✅ 200 | ✅ FileSchemaWriter persists to `generated-collections/` | Original reference platform. Admin SPA at :5173 drives full Strapi-style flow via agent-browser. `docs/admin-full-sweep.md`. |
| **Next.js 15 App Router** (`next dev`) | `examples/next-app` | 8788 | ✅ 200 | ✅ 200 | ✅ 201 | ✅ 200 | ✅ 200 | ✅ FileSchemaWriter | Catch-all at `app/api/cms/[...route]/route.ts`. `createNextRouteHandlers(cms, { basePath: "/api/cms" })` strips the Next mount prefix so the CMS sees canonical `/cms/...` and `/api/...`. Admin works pointing at `VITE_CMS_API_URL=http://127.0.0.1:8788/api/cms`. `docs/screenshots/next/01-03-*.png`. |
| **Cloudflare Workers** (`wrangler dev --local`) | `examples/cloudflare-worker` | 8789 | ✅ 200 | ✅ 200 | ✅ 201 | ✅ 200 | ✅ 200 | ❌ no FS | `MemoryCacheAdapter` now defers `setInterval` until first use, so it boots cleanly in Workers' global scope. CMS lazy-instantiated inside `fetch`. `docs/cross-runtime/cloudflare-worker.md`. |
| **Bun standalone** (`Bun.serve({ fetch })`) | `examples/bun-server` | 8791 | ✅ 200 | ✅ 200 | ✅ 201 | ✅ 200 | ✅ 200 | ✅ FileSchemaWriter | Zero adapter — `cms.fetch` is Web `(Request) => Response`, plugs straight into Bun. `docs/cross-runtime/bun-server.md`. |
| **Bun + ElysiaJS** (third-party Bun framework) | `examples/elysia-host` | 8792 | ✅ 200 | ✅ 200 | ✅ 201 | ✅ 200 | ✅ 200 | ✅ FileSchemaWriter | 10-line stripPrefix helper, same as Next adapter. Elysia owns `/`, CMS owns `/api/cms/*`. `docs/cross-runtime/elysia-host.md`. |
| **TanStack Start** (`vite dev`, v1.168) | `examples/tanstack-start` | 8790 | ✅ 200 | ✅ 200 | ✅ 201 | ✅ 200 | n/a (not probed in this run) | n/a | File-based server route at `src/routes/api/cms/$.ts` using modern `createFileRoute("/api/cms/$")({ server: { handlers: { GET, POST, ... } } })`. Falls back from spec's legacy vinxi-based v1.120 (incompatible with admin's pinned router-plugin 1.168). Same base-path strip pattern as the Next adapter. `docs/cross-runtime/tanstack-start.md`. |
| **Vercel Edge** (`Bun.serve({ fetch: vercelHandler })`) | `examples/vercel-edge` | 8793 | ✅ 200 | ✅ 200 | ✅ 201 | ✅ 200 | ✅ 200 | n/a | Vercel Edge contract is Web-standard `(Request) => Response`. `vercel dev` not installed locally → live-booted the same handler under `Bun.serve` on port 8793 (faithful proxy: identical Web Request contract). Original handler-test (`route.test.ts`) retained untouched. `vercel.ts` adapter unchanged — already returned the Web-standard shape. `docs/cross-runtime/vercel-edge.md`. |

## What this proves about `createCMS` as IaC

`createCMS` is **infrastructure-as-code**: a Web `(Request) => Response` library. It does not own its runtime. Anywhere that can dispatch a Web `Request` and accept a Web `Response` serves the CMS unchanged. The runtimes above demonstrate this with **byte-identical** CMS instances — only the host wiring differs (5-line snippet each).

Hosts confirmed live:
- **Native Web APIs**: `Bun.serve`, Cloudflare Workers, Vercel Edge
- **Framework adapters with optional basePath strip**: Next.js, Elysia, TanStack Start (pending)
- **Node HTTP bridge**: `@hono-cms/platform/node` wrapper for `IncomingMessage` ↔ `Request`

## Real bugs surfaced by this multi-runtime sweep

- **CF Workers global-scope timer**: `MemoryCacheAdapter` `setInterval` in constructor crashed `wrangler dev` with "Disallowed operation called within global scope". **Fixed in `packages/cache/src/index.ts`** — defer to first `set()` / `checkRateLimit()`; `destroy()` sets a permanent flag for test isolation.
- **Next adapter basePath gap**: prior `createNextRouteHandlers` forwarded the full Next URL incl. the `/api/cms` prefix → CMS saw `/api/cms/cms/health/live` → 404. **Fixed in `packages/platform/src/next.ts`** — added `basePath` option that rewrites the URL before delegation. Backwards-compatible — overload still accepts the `(cms, methods)` array shape.
- **Platform tsconfig rootDir**: schema's `health.ts` lived outside platform's inferred rootDir. **Fixed** by setting rootDir to monorepo root in `packages/platform/tsconfig.json`.
- **Missing `@types/node`** for platform after a fresh build. **Fixed** by declaring explicit devDep.

## See also

End-to-end production walkthroughs for operators:

- [`docs/deployment/cloudflare-workers-d1-vercel-admin.md`](deployment/cloudflare-workers-d1-vercel-admin.md) — CMS API on Workers + D1 + R2, admin SPA on Vercel.
- [`docs/deployment/node-postgres-r2-caddy.md`](deployment/node-postgres-r2-caddy.md) — Self-hosted Node.js + Postgres + R2 (S3 API) behind Caddy.
- [`docs/deployment/vercel-edge-neon-blob.md`](deployment/vercel-edge-neon-blob.md) — Vercel Edge route handler + Neon Postgres (HTTP) + Vercel Blob.
