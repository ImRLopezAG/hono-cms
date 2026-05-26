---
run: bun add @hono-cms/core @hono-cms/platform && next dev
---

# Next.js (App Router)

Next 13+ route handlers accept Web `Request` directly. Mount a catch-all and delegate to `cms.fetch`. The base-path strip is mandatory because Next's URL still includes `/api/cms`.

```ts
// app/api/cms/[...route]/route.ts
import { createNextRouteHandlers } from "@hono-cms/platform/next";
import { cms } from "@/cms";

const h = createNextRouteHandlers(cms, { basePath: "/api/cms" });
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = h;
export const dynamic = "force-dynamic";
```

- **Base path**: required. `basePath: "/api/cms"` rewrites `/api/cms/cms/health/live` -> `/cms/health/live` before delegating.
- **Example**: [`examples/next-app/app/api/cms/[...route]/route.ts`](../../examples/next-app/app/api/cms/%5B...route%5D/route.ts) + [`examples/next-app/src/cms.ts`](../../examples/next-app/src/cms.ts)
- **Matrix row**: [Next.js 15 App Router](../cross-runtime-matrix.md#cross-runtime-verification-matrix)
- **Gotcha**: `export const dynamic = "force-dynamic"` — Next will otherwise cache GETs and break admin auth. Node runtime gives you `FileSchemaWriter`; Edge runtime does not (see [vercel-edge.md](./vercel-edge.md)).
