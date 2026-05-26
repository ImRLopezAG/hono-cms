---
run: bun add elysia @hono-cms/core && bun src/index.ts
---

# ElysiaJS (Bun)

Elysia owns the app, CMS owns a sub-path. Mount a wildcard route and delegate to `cms.fetch` after stripping the prefix — same shape as the Next adapter, inlined in ~10 lines.

```ts
import { Elysia } from "elysia";
import { cms } from "./cms";

const strip = (req: Request, b = "/api/cms") => { const u = new URL(req.url); if (!u.pathname.startsWith(b)) return req; u.pathname = u.pathname.slice(b.length) || "/"; return new Request(u, req); };
new Elysia().get("/", () => "host").all("/api/cms/*", ({ request }) => cms.fetch(strip(request))).listen(8792);
```

- **Base path**: required. Strip `/api/cms` before forwarding. There is no platform helper for Elysia — inline a 5-line `stripPrefix`.
- **Example**: [`examples/elysia-host/src/index.ts`](../../examples/elysia-host/src/index.ts)
- **Matrix row**: [Bun + ElysiaJS](../cross-runtime-matrix.md#cross-runtime-verification-matrix)
- **Gotcha**: Elysia's `request` is already a Web `Request`, so no adapter overhead. Filesystem available (it's Bun) — `FileSchemaWriter` works. Detail: [`docs/cross-runtime/elysia-host.md`](../cross-runtime/elysia-host.md).
