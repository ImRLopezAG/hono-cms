---
run: bun add @hono-cms/core @hono-cms/platform && node server.js
---

# Node.js (`node:http`)

`createCMS` returns a Web `(Request) => Response` handler. Node's `http` server doesn't speak Web Fetch natively, so use `createNodeHandler` from `@hono-cms/platform/node` to bridge `IncomingMessage` <-> `Request`.

```ts
import { createServer } from "node:http";
import { createCMS } from "@hono-cms/core";
import { createNodeHandler } from "@hono-cms/platform/node";

const cms = createCMS({ /* collections, db, storage, cache, auth, ... */ });
createServer(createNodeHandler(cms)).listen(8787);
```

- **Base path**: none required. Mount the bridge on the root server; the CMS owns `/cms/*` and `/api/*`.
- **Example**: [`examples/newsroom/src/dev-server.ts`](../../examples/newsroom/src/dev-server.ts)
- **Matrix row**: [Node.js + Vite admin](../cross-runtime-matrix.md#cross-runtime-verification-matrix)
- **Gotcha**: Node 18+ required (uses `Readable.toWeb`/`Readable.fromWeb`). `FileSchemaWriter` works because filesystem is available — the live content-type builder persists generated collections to disk.
