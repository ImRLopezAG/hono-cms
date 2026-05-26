import { handler } from "./route";

/**
 * Live-boot launcher for the Vercel Edge example.
 *
 * `vercel dev` would be the canonical way to exercise this example end-to-end,
 * but it requires the Vercel CLI to be installed locally. Since the Vercel
 * Edge route handler exported by `route.ts` is a Web standard
 * `(Request) => Response | Promise<Response>` — by the contract Vercel itself
 * documents for Edge functions — we can plug it directly into `Bun.serve` and
 * exercise the same handler over a real TCP socket. The Bun runtime is
 * Web-standard compliant for `Request`/`Response`, so this is a faithful
 * proxy for the Vercel Edge invocation contract.
 *
 * No adapter, no shim: the same `handler` function that Vercel would call in
 * production is what answers HTTP here.
 */
const port = Number(process.env.PORT ?? 8793);

const server = Bun.serve({
  port,
  fetch: handler
});

// eslint-disable-next-line no-console
console.log(`[vercel-edge] Hono CMS (Vercel Edge handler) listening on http://${server.hostname}:${server.port}`);
// eslint-disable-next-line no-console
console.log("[vercel-edge] Try:");
// eslint-disable-next-line no-console
console.log(`  curl http://127.0.0.1:${server.port}/cms/health/live`);
// eslint-disable-next-line no-console
console.log(`  curl http://127.0.0.1:${server.port}/api/posts`);

export { server };
