/**
 * Next.js App Router catch-all that forwards to the plugin-shape CMS.
 *
 * The CMS factory is async (plugin registration is async), so we
 * lazily instantiate it on the first request and cache the promise
 * thereafter. This keeps module-load side-effect-free for Edge/Vercel
 * runtimes and avoids top-level `await` in route files.
 */
import { createNextRouteHandlers, type NextRouteHandler, type NextRouteHandlers } from "@hono-cms/platform/next";
import { createNextExampleCMS } from "../../../../src/cms";

export const dynamic = "force-dynamic";

let cachedHandlers: NextRouteHandlers | null = null;
let initPromise: Promise<NextRouteHandlers> | null = null;

async function getHandlers(): Promise<NextRouteHandlers> {
  if (cachedHandlers) return cachedHandlers;
  if (!initPromise) {
    initPromise = createNextExampleCMS().then((cms) =>
      createNextRouteHandlers(cms, { basePath: "/api/cms" })
    );
  }
  cachedHandlers = await initPromise;
  return cachedHandlers;
}

function dispatch(method: keyof NextRouteHandlers): NextRouteHandler {
  return async (request: Request) => {
    const handlers = await getHandlers();
    return handlers[method](request);
  };
}

export const GET = dispatch("GET");
export const POST = dispatch("POST");
export const PUT = dispatch("PUT");
export const PATCH = dispatch("PATCH");
export const DELETE = dispatch("DELETE");
export const OPTIONS = dispatch("OPTIONS");
export const HEAD = dispatch("HEAD");
