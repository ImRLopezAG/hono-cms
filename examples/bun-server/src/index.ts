import { createBunExampleCMS } from "./cms";

/**
 * `createPluginCMS` is async because plugin install ordering, schema
 * merging, and the `app(app, ctx)` lifecycle hook all happen inside
 * `installPlugins`. We resolve the CMS up front, then hand its `fetch`
 * to `Bun.serve` — the runtime contract is the same Web standard
 * handler the legacy kernel produced.
 */
const port = Number(process.env.PORT ?? 8791);
const cms = await createBunExampleCMS();

const server = Bun.serve({
  port,
  fetch: cms.fetch
});

console.log(`[bun-server] Hono CMS listening on http://${server.hostname}:${server.port}`);
console.log("[bun-server] Try:");
console.log(`  curl http://127.0.0.1:${server.port}/cms/health/live`);
console.log(`  curl http://127.0.0.1:${server.port}/api/posts`);

export { server };
