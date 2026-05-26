# Cloudflare Worker Example

This example mounts Hono CMS as a Cloudflare Worker-style module export using the Web `Request`/`Response` API.

```ts
import worker from "./src/worker";

export default worker;
```

The example uses the memory adapter for local tests. A real Worker can swap the `db` config to `@hono-cms/adapter-d1` and storage to R2 while keeping the same Worker export shape.
