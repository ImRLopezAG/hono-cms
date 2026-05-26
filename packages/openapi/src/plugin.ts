import { createPlugin, type Plugin } from "@hono-cms/core";
import { applyCorsHeaders, corsPreflightResponse, normalizeCors } from "./cors";
import { renderDocs } from "./docs";
import { assembleOpenAPISpec, hashText } from "./spec";
import type { OpenAPIConfig, OpenAPIPathItem, OpenAPIService, OpenAPISpec } from "./types";

/** Plugin id under which the openapi plugin registers. */
export const OPENAPI_PLUGIN_ID = "openapi";

const DEFAULT_SPEC_PATH = "/cms/openapi.json";
const DEFAULT_DOCS_PATH = "/cms/docs";

type CachedView = {
  spec: OpenAPISpec;
  json: string;
  etag: string;
};

/**
 * Build the `Plugin` manifest for the `/openapi.json` + `/docs` routes.
 *
 * Behaviour (ported from `packages/core/src/create-cms.ts:263-280, 1445-1458,
 * 2229-2275`):
 *
 *   1. The plugin keeps a lazily-built cached spec view (JSON + ETag).
 *   2. It subscribes to `schema:after-collection-add|remove|update` so the
 *      cache is dropped whenever a collection mutates and the next request
 *      re-assembles from the live `ctx.collections`.
 *   3. It registers a service on `ctx.plugins.get("openapi")` so other
 *      plugins can merge their routes into the spec via `addPath()` and force
 *      a refresh via `refresh()`.
 *   4. `GET /openapi.json` serves the cached JSON with ETag handling
 *      (`If-None-Match` => `304`).
 *   5. `GET /docs` serves Scalar-CDN HTML pointed at the configured spec
 *      path. Omitted in production unless an explicit docs path is set.
 *   6. `OPTIONS` preflight on both paths returns CORS headers when
 *      `opts.cors` is set.
 */
export function openapi(opts: OpenAPIConfig = {}): Plugin {
  const specPath = opts.path ?? opts.specPath ?? DEFAULT_SPEC_PATH;
  const explicitDocs = opts.docs !== undefined || opts.docsPath !== undefined;
  const docsPath = opts.production && !explicitDocs
    ? undefined
    : (opts.docs ?? opts.docsPath ?? DEFAULT_DOCS_PATH);

  return createPlugin({
    id: OPENAPI_PLUGIN_ID,
    app: (app, ctx) => {
      // Plugins call `addPath(path, methods)` to inject their routes into the
      // served spec. Keyed by path so repeated calls overwrite — the latest
      // call wins, matching how plugin install ordering works elsewhere.
      const extraPaths = new Map<string, OpenAPIPathItem>();

      // Cached spec view. `null` means "rebuild on next read"; we don't eagerly
      // build at install time because plugin install order can register more
      // paths after `openapi()` runs and we want them to land in the cache.
      let cached: CachedView | null = null;

      const buildView = (): CachedView => {
        const spec = assembleOpenAPISpec({
          collections: ctx.collections,
          config: opts,
          extraPaths
        });
        const json = JSON.stringify(spec);
        const etag = `"${hashText(json)}"`;
        return { spec, json, etag };
      };

      const view = (): CachedView => {
        if (cached) return cached;
        cached = buildView();
        return cached;
      };

      const service: OpenAPIService = {
        refresh() {
          cached = null;
        },
        getSpec() {
          return view().spec;
        },
        addPath(path, methods) {
          const existing = extraPaths.get(path);
          extraPaths.set(path, existing ? { ...existing, ...methods } : methods);
          cached = null;
        }
      };

      ctx.plugins.register(OPENAPI_PLUGIN_ID, service);

      // Schema mutation events drop the cache so the next read reflects the
      // new collection set. The handlers are sync — they never throw — so we
      // ignore the unsubscribe handles.
      ctx.events.on("schema:after-collection-add", () => {
        cached = null;
      });
      ctx.events.on("schema:after-collection-remove", () => {
        cached = null;
      });
      ctx.events.on("schema:after-collection-update", () => {
        cached = null;
      });

      // Build response headers for the spec route. The header set includes
      // ETag, content-type, cache-control, and (when CORS is configured) the
      // resolved `access-control-allow-*` values.
      const baseHeaders = (request: Request, etag: string): Headers => {
        const headers = new Headers({
          "content-type": "application/json; charset=utf-8",
          "cache-control": opts.production ? "public, max-age=3600" : "no-store",
          "access-control-allow-methods": "GET, OPTIONS",
          etag
        });
        // Match the kernel's legacy default: when no CORS plugin is wired up
        // we still send `access-control-allow-origin: *` so the spec is
        // trivially reachable from browser fetches. Configured CORS replaces
        // this with the resolved origin (or omits it when no origin matches).
        if (!opts.cors) headers.set("access-control-allow-origin", "*");
        else applyCorsHeaders(opts.cors, request, { headers });
        return headers;
      };

      const preflightHeaders = (request: Request): Headers => {
        const headers = baseHeaders(request, "");
        headers.delete("content-type");
        headers.delete("cache-control");
        headers.delete("etag");
        headers.set("access-control-allow-methods", "GET, OPTIONS");
        headers.set("access-control-allow-headers", "authorization, content-type, if-none-match");
        const maxAge = opts.cors ? normalizeCors(opts.cors).maxAge : undefined;
        headers.set("access-control-max-age", String(maxAge ?? 3600));
        return headers;
      };

      // `app.options` / `app.get` mount the spec route. The `corsPreflightResponse`
      // helper returns null for non-preflight OPTIONS (no
      // `access-control-request-method` header), so we fall back to the
      // hand-crafted preflight response with our spec-specific allow-headers.
      app.options(specPath, (c) => {
        const preflight = corsPreflightResponse(opts.cors, c.req.raw);
        if (preflight) return preflight;
        return new Response(null, { status: 200, headers: preflightHeaders(c.req.raw) });
      });
      app.get(specPath, (c) => {
        const current = view();
        const headers = baseHeaders(c.req.raw, current.etag);
        if (c.req.header("if-none-match") === current.etag) {
          return new Response(null, { status: 304, headers });
        }
        return new Response(current.json, { headers });
      });

      if (docsPath) {
        app.options(docsPath, (c) => {
          const preflight = corsPreflightResponse(opts.cors, c.req.raw);
          if (preflight) return preflight;
          return new Response(null, { status: 200, headers: preflightHeaders(c.req.raw) });
        });
        app.get(docsPath, (c) => {
          const response = c.html(renderDocs(specPath, {
            ...(opts.title !== undefined ? { title: opts.title } : {})
          }));
          applyCorsHeaders(opts.cors, c.req.raw, response);
          return response;
        });
      }

      return app;
    }
  });
}
