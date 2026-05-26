---
run: bun add @hono-cms/core @hono-cms/platform && wrangler dev --local
---

# Cloudflare Workers

Workers speak Web Fetch natively. Wrap with `createCloudflareExport` to also pipe `scheduled(event, env, ctx)` for cron-triggered jobs. Workers forbid async I/O and timers in module scope, so lazy-instantiate the CMS inside `fetch`.

```ts
import { createCloudflareExport } from "@hono-cms/platform/cloudflare";
import { createCloudflareExampleCMS } from "./cms";

let cached: ReturnType<typeof createCloudflareExport> | null = null;
const get = () => (cached ??= createCloudflareExport(createCloudflareExampleCMS()));
export default { fetch: (r, e, c) => get().fetch(r, e, c), scheduled: (ev, e, c) => get().scheduled!(ev, e, c) };
```

- **Base path**: none. Mount at the worker root.
- **Example**: [`examples/cloudflare-worker/src/worker.ts`](../../examples/cloudflare-worker/src/worker.ts)
- **Matrix row**: [Cloudflare Workers](../cross-runtime-matrix.md#cross-runtime-verification-matrix)
- **Gotcha**: **no filesystem** — omit `contentTypeBuilder.writer`; the live content-type builder cannot persist. **No Node-specific deps** (no `node:fs`, `node:path`, etc.). `MemoryCacheAdapter` defers `setInterval` until first use, so it boots cleanly in Workers' global scope (fix in `packages/cache/src/index.ts`). Detail: [`docs/cross-runtime/cloudflare-worker.md`](../cross-runtime/cloudflare-worker.md).
