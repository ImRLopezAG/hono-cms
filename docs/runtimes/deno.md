---
run: deno run -A --unstable-sloppy-imports server.ts
---

# Deno

Deno's `Deno.serve` accepts a Web `(Request) => Response` handler — same shape as Bun and Cloudflare. Zero adapter; pass `cms.fetch` directly. **No live example yet** (the matrix doesn't probe Deno), but the pattern is identical to Bun.

```ts
import { createCMS } from "npm:@hono-cms/core";
import { createMemoryDatabase } from "npm:@hono-cms/adapter-memory";

const cms = createCMS({ /* collections, db, storage, cache, auth, ... */ });
Deno.serve({ port: 8793 }, cms.fetch);
```

- **Base path**: none. CMS owns the whole port.
- **Example**: none yet — the same wiring as [`examples/bun-server/src/index.ts`](../../examples/bun-server/src/index.ts) applies (swap `Bun.serve` for `Deno.serve`).
- **Matrix row**: not yet verified. Add a row to [`docs/cross-runtime-matrix.md`](../cross-runtime-matrix.md) once a live boot is automated.
- **Gotcha**: use `npm:` specifiers (or an import map) to resolve `@hono-cms/*` packages. Filesystem-touching adapters (`FileSchemaWriter`) require `--allow-read` / `--allow-write`; the `-A` flag in `run` above grants all permissions for dev. No Node-specific deps if you keep storage/jobs in-memory.
