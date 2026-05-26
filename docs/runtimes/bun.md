---
run: bun add @hono-cms/core && bun src/index.ts
---

# Bun (`Bun.serve`)

The zero-adapter case. `cms.fetch` is `(Request) => Response | Promise<Response>` — exactly what `Bun.serve({ fetch })` expects. No platform package, no bridge, no prefix strip.

```ts
import { cms } from "./cms";

const server = Bun.serve({ port: Number(process.env.PORT ?? 8791), fetch: cms.fetch });
console.log(`listening on http://${server.hostname}:${server.port}`);
```

- **Base path**: none. CMS owns the whole port.
- **Example**: [`examples/bun-server/src/index.ts`](../../examples/bun-server/src/index.ts)
- **Matrix row**: [Bun standalone](../cross-runtime-matrix.md#cross-runtime-verification-matrix)
- **Gotcha**: none. Filesystem is available, so `FileSchemaWriter` persists generated collections normally. Detail: [`docs/cross-runtime/bun-server.md`](../cross-runtime/bun-server.md).
