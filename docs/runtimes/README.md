# Hosting `@hono-cms/core` per runtime

`createCMS` returns a Web `(Request) => Response` handler. Each runtime below shows the 5-line wiring to host it. The CMS is byte-identical across all of them — only the host shim differs.

| Runtime | Adapter | Base-path strip | Doc |
|---|---|---|---|
| Node.js (`node:http`) | `@hono-cms/platform/node` | no | [node.md](./node.md) |
| Next.js App Router | `@hono-cms/platform/next` | yes | [next.md](./next.md) |
| TanStack Start | inline (no helper yet) | yes | [tanstack-start.md](./tanstack-start.md) |
| Cloudflare Workers | `@hono-cms/platform/cloudflare` | no | [cloudflare-worker.md](./cloudflare-worker.md) |
| Vercel Edge | `@hono-cms/platform/vercel` | optional | [vercel-edge.md](./vercel-edge.md) |
| Bun (`Bun.serve`) | none — direct | no | [bun.md](./bun.md) |
| ElysiaJS (Bun) | inline (no helper yet) | yes | [elysia.md](./elysia.md) |
| Deno (`Deno.serve`) | none — direct | no | [deno.md](./deno.md) |
| Hono (parent app) | inline | yes if mounted | [hono-standalone.md](./hono-standalone.md) |

## One-sentence pitch per runtime

- **[Node.js](./node.md)** — Most portable host; use when you need filesystem access for `FileSchemaWriter` and don't mind shipping a long-running process.
- **[Next.js](./next.md)** — Drop into an existing App Router project via a catch-all route handler; CMS lives at `/api/cms/*` alongside your app code.
- **[TanStack Start](./tanstack-start.md)** — File-based server route at `src/routes/api/cms/$.ts`; same Web-Request handler, same base-path strip as Next.
- **[Cloudflare Workers](./cloudflare-worker.md)** — Globally edge-deployed; pair with D1/R2 adapters when you outgrow in-memory. No filesystem -> no live content-type builder.
- **[Vercel Edge](./vercel-edge.md)** — Pass-through handler plus `vercel.json` cron generator for scheduled `/cms/jobs/*` execution.
- **[Bun](./bun.md)** — The zero-adapter case: `Bun.serve({ fetch: cms.fetch })`. Fastest path from `createCMS` to a running server.
- **[Elysia](./elysia.md)** — Compose a Bun-native framework around the CMS; useful when you already have an Elysia API and want to bolt the CMS onto a sub-path.
- **[Deno](./deno.md)** — `Deno.serve(cms.fetch)`. Same Web-handler shape as Bun, served from Deno's native HTTP API via `npm:` specifiers.
- **[Hono standalone](./hono-standalone.md)** — Wrap the CMS in a parent Hono app when you want host-level routes (marketing pages, custom APIs) alongside `/api/cms/*`.

## Why this works

See [`docs/cross-runtime-matrix.md`](../cross-runtime-matrix.md) for the live verification matrix proving each runtime above boots and serves the same end-to-end probes (`/cms/health/live`, `/cms/schema`, `POST /api/posts`, `POST /api/posts/<id>/publish`, `/cms/audit-log`).
