import { createPlugin, type Plugin } from "@hono-cms/core";
import { corsMiddleware, corsPreflightResponse } from "./middleware";
import type { CorsConfig } from "./types";

/** Plugin id under which the cors plugin registers. */
export const CORS_PLUGIN_ID = "cors";

/**
 * Build the `Plugin` manifest for the CMS CORS layer. Wraps the ported
 * preflight + header helpers in two surfaces:
 *
 *   - a `"*"` middleware that mutates the response on the way out (handles
 *     simple cross-origin GET/POST etc),
 *   - an `app.options("*")` route that short-circuits preflight requests.
 *
 * Installing the plugin with no options applies the kernel's old defaults:
 * `origin: "*"`, the default allow-methods, and the default allow-headers.
 */
export function cors(opts: CorsConfig = {}): Plugin {
  return createPlugin({
    id: CORS_PLUGIN_ID,
    middlewares: [{ path: "*", middleware: corsMiddleware(opts) }],
    app: (app, _ctx) => {
      // Mount an OPTIONS catch-all so preflight requests never fall through
      // to the kernel's content/admin routes. `corsPreflightResponse` returns
      // `null` for non-preflight OPTIONS calls (no
      // `access-control-request-method` header), in which case we hand a
      // bare 204 back to satisfy Hono's expectation of a Response.
      app.options("*", (c) => {
        const preflight = corsPreflightResponse(opts, c.req.raw);
        if (preflight) return preflight;
        return new Response(null, { status: 204 });
      });
      return app;
    }
  });
}
