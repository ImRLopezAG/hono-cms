---
run: bun add hono @hono-cms/core && bun src/index.ts
---

# Hono (standalone parent app)

When you want a parent Hono app to own root routes (marketing, health checks, custom APIs) and delegate `/api/cms/*` to the CMS. `cms.fetch` is the same Web handler — `app.all("*", c => cms.fetch(c.req.raw))` plugs it in.

```ts
import { Hono } from "hono";
import { cms } from "./cms";

const app = new Hono();
app.get("/", c => c.text("host app"));
app.all("/api/cms/*", c => { const u = new URL(c.req.url); u.pathname = u.pathname.replace(/^\/api\/cms/, "") || "/"; return cms.fetch(new Request(u, c.req.raw)); });
export default { fetch: app.fetch }; // or Bun.serve({ fetch: app.fetch })
```

- **Base path**: required if you mount under a prefix (e.g. `/api/cms`). Strip inline — same pattern as Elysia/TanStack Start.
- **Example**: none in `examples/` (the elysia example demonstrates the equivalent for a different framework). Closest reference: [`examples/elysia-host/src/index.ts`](../../examples/elysia-host/src/index.ts).
- **Matrix row**: not separately verified — every runtime row already exercises a Hono-shaped `(Request) => Response`, so wrapping in a parent Hono app is functionally identical.
- **Gotcha**: don't double-mount Hono middleware that conflicts with the CMS's own (auth, CORS, rate-limiting). Let the parent app handle host-level concerns; configure CMS-level concerns inside `createCMS({...})`.
