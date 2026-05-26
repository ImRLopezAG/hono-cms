# Hono CMS Next.js App Router Example

This example mounts a CMS instance through a Next.js App Router catch-all route:

```ts
// app/api/cms/[...route]/route.ts
import { createNextRouteHandlers } from "@hono-cms/platform/next";
import { cms } from "../../../../src/cms";

export const runtime = "edge";

const handlers = createNextRouteHandlers(cms);

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PUT = handlers.PUT;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
export const OPTIONS = handlers.OPTIONS;
export const HEAD = handlers.HEAD;
```

The route uses the same Web `Request`/`Response` API as Cloudflare Workers, Vercel Edge, and Node bridge tests.
