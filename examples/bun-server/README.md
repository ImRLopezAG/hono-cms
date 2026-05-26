# Bun.serve example

Boots `@hono-cms/core` directly via Bun's native `Bun.serve({ fetch })` API — no
Hono Node adapter, no Express, no third-party framework. The CMS instance is a
standard Web `(Request) => Response` handler, which is exactly what `Bun.serve`
consumes.

```ts
import { cms } from "./src/cms";

Bun.serve({ port: 8791, fetch: cms.fetch });
```

## Run it

```sh
# from the workspace root
bun install

# from this directory
cd examples/bun-server
PORT=8791 bun src/index.ts
```

Then poke the CMS:

```sh
curl http://127.0.0.1:8791/cms/health/live
curl http://127.0.0.1:8791/cms/openapi.json | head

curl -X POST http://127.0.0.1:8791/api/posts \
  -H 'authorization: Bearer admin' \
  -H 'content-type: application/json' \
  -d '{"title":"Bun-native CMS","slug":"bun-native-cms","body":"hi"}'

curl -X POST http://127.0.0.1:8791/api/posts/<id>/publish \
  -H 'authorization: Bearer admin'

curl 'http://127.0.0.1:8791/cms/audit-log?collection=posts' \
  -H 'authorization: Bearer admin'
```

## Test it

```sh
bun test src/index.test.ts
```

The test suite spins up `Bun.serve({ port: 0, fetch: cms.fetch })`, runs the
same checks against a real TCP socket, and shuts the server down on completion.

## Auth tokens

The example wires up the built-in static token adapter with:

| Token    | userId       | roles    |
|----------|--------------|----------|
| `admin`  | `bun-admin`  | `admin`  |
| `editor` | `bun-editor` | `editor` |

Pass them as `Authorization: Bearer admin` (or `editor`).
