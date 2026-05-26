---
run: bun add @hono-cms/core @hono-cms/platform && vercel dev
---

# Vercel Edge

Edge route handlers receive Web `Request`. `createVercelHandler` is a one-liner pass-through to `cms.fetch`. `generateVercelJson` emits the `crons[]` config consumed by Vercel scheduled functions, which trigger `/cms/jobs/*` endpoints.

```ts
// app/api/cms/[...route]/route.ts (or pages/api equivalent)
import { createVercelHandler } from "@hono-cms/platform/vercel";
import { cms } from "@/cms";

export const runtime = "edge";
const handler = createVercelHandler(cms);
export const GET = handler, POST = handler, PUT = handler, PATCH = handler, DELETE = handler, OPTIONS = handler, HEAD = handler;
```

- **Base path**: not stripped by `createVercelHandler`. If you mount under `/api/cms`, either rewrite the path yourself (see [next.md](./next.md)) or mount at the project root.
- **Example**: [`examples/vercel-edge/src/route.ts`](../../examples/vercel-edge/src/route.ts)
- **Matrix row**: [Vercel Edge](../cross-runtime-matrix.md#cross-runtime-verification-matrix)
- **Gotcha**: edge runtime — **no Node-specific deps** (no `node:fs`), so no `FileSchemaWriter`. Configure `jobs: { provider: "vercel", secret }` and wire `vercelJson` output to your `vercel.json` so the platform calls `/cms/jobs/<name>` on schedule.
