import { cms } from "./cms";

/**
 * The whole point of this example: `cms.fetch` is a Web standard
 * `(Request) => Response | Promise<Response>` handler, which is exactly what
 * `Bun.serve({ fetch })` accepts. No adapter, no shim, no third-party framework.
 */
const port = Number(process.env.PORT ?? 8791);

const server = Bun.serve({
  port,
  fetch: cms.fetch
});

console.log(`[bun-server] Hono CMS listening on http://${server.hostname}:${server.port}`);
console.log("[bun-server] Try:");
console.log(`  curl http://127.0.0.1:${server.port}/cms/health/live`);
console.log(`  curl http://127.0.0.1:${server.port}/api/posts`);

export { server };
