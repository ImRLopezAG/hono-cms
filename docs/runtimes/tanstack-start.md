---
run: bun add @hono-cms/core @tanstack/react-router && vite dev
---

# TanStack Start

File-based server routes at `src/routes/api/cms/$.ts` accept Web `Request` via `createFileRoute(...).server.handlers`. Strip the `/api/cms` prefix before delegating to `cms.fetch` — same pattern as the Next adapter.

```ts
// src/routes/api/cms/$.ts
import { createFileRoute } from "@tanstack/react-router";
import { cms } from "../../../cms";

const h = async ({ request }: { request: Request }) => {
  const u = new URL(request.url);
  u.pathname = u.pathname.replace(/^\/api\/cms/, "") || "/";
  return cms.fetch(new Request(u, request));
};
export const Route = createFileRoute("/api/cms/$")({ server: { handlers: { GET: h, POST: h, PUT: h, PATCH: h, DELETE: h, OPTIONS: h, HEAD: h } } });
```

- **Base path**: required. Strip `/api/cms` inline (no platform helper yet).
- **Example**: [`examples/tanstack-start/src/routes/api/cms/$.ts`](../../examples/tanstack-start/src/routes/api/cms/$.ts) + [`examples/tanstack-start/src/cms.ts`](../../examples/tanstack-start/src/cms.ts)
- **Matrix row**: [TanStack Start](../cross-runtime-matrix.md#cross-runtime-verification-matrix)
- **Gotcha**: pin `@tanstack/react-router` >= 1.168 for the modern `server.handlers` shape (legacy vinxi v1.120 is incompatible with the admin's router-plugin). Detail: [`docs/cross-runtime/tanstack-start.md`](../cross-runtime/tanstack-start.md).
