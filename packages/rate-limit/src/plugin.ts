/**
 * `@hono-cms/rate-limit` plugin factory.
 *
 * Replaces the per-route `enforceRateLimit(...)` calls the kernel used to
 * sprinkle across `create-cms.ts` with a single declarative plugin that
 * mounts middleware on the well-known kernel path prefixes:
 *
 *   - mutations → `/api/*`               (POST/PATCH/PUT/DELETE only)
 *   - graphql   → `/graphql/*` + `/cms/graphql/*`  (mutations only)
 *   - media     → `/api/media/*`
 *   - auth      → `/api/api-keys/*` + `/api/roles/*`
 *   - admin     → `/cms/admin/*` + `/cms/settings/*`
 *   - jobs      → `/cms/jobs/*`
 *
 * The plugin declares `requires: ["cache"]` so the kernel's runtime fails
 * fast when consumers forget to install a cache backend ahead of it; the
 * adapter is resolved lazily inside the middleware closures so the cache
 * plugin's `app(app, ctx)` step has time to register the service.
 */

import type { MiddlewareHandler } from "hono";
import { createPlugin, type CacheAdapter, type Plugin } from "@hono-cms/core";
import { enforceRateLimit, isGraphQLMutationRequest } from "./enforce";
import type { RateLimitConfigEntry, RateLimitScope } from "./types";

/** Plugin id under which the rate-limit plugin registers. */
export const RATE_LIMIT_PLUGIN_ID = "rate-limit";

/**
 * User-facing options for {@link rateLimit}. Each scope is independent and
 * opt-in: omitting a scope means "do not enforce a limit on those routes".
 */
export type RateLimitOpts = {
  mutations?: RateLimitConfigEntry;
  graphql?: RateLimitConfigEntry;
  media?: RateLimitConfigEntry;
  auth?: RateLimitConfigEntry;
  admin?: RateLimitConfigEntry;
  jobs?: RateLimitConfigEntry;
  /**
   * When `true` (the default) and the cache plugin's adapter is missing or
   * its `checkRateLimit` call throws, the middleware logs a warning and lets
   * the request through. When `false`, the middleware returns 429 in those
   * cases — appropriate for environments that treat the cache as critical.
   */
  failOpen?: boolean;
};

/** HTTP methods the `mutations` scope guards. Reads are unrestricted. */
const MUTATION_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * Build the `Plugin` manifest for hono-cms rate limiting.
 *
 * Each opts entry causes the plugin to mount a single Hono middleware on the
 * corresponding path prefix(es). The middleware:
 *   1. Lazily resolves the cache adapter from `ctx.plugins.get("cache")`.
 *   2. For `mutations`, short-circuits read methods (GET/HEAD/OPTIONS).
 *   3. For `graphql`, short-circuits non-mutation operations.
 *   4. Calls {@link enforceRateLimit}; if it returns a 429 Response, returns
 *      it directly; otherwise calls `next()` to continue the kernel pipeline.
 */
export function rateLimit(opts: RateLimitOpts = {}): Plugin {
  return createPlugin({
    id: RATE_LIMIT_PLUGIN_ID,
    requires: ["cache"],
    app: (app, ctx) => {
      // Lazy resolver: the cache adapter is registered by the cache plugin's
      // own `app(app, ctx)` step, which runs strictly before this one thanks
      // to the `requires` ordering constraint enforced by `validateAndOrder`.
      const getCache = (): CacheAdapter | null => {
        if (!ctx.plugins.has("cache")) return null;
        return ctx.plugins.get("cache");
      };

      const failOpen = opts.failOpen ?? true;

      // Helper to build a per-scope middleware that delegates to the shared
      // enforce path. Defined once so each path prefix gets an identical body.
      const buildMiddleware = (
        scope: RateLimitScope,
        config: RateLimitConfigEntry,
        gate?: (req: Request) => boolean | Promise<boolean>
      ): MiddlewareHandler => {
        return async (c, next) => {
          if (gate) {
            const shouldEnforce = await gate(c.req.raw);
            if (!shouldEnforce) return next();
          }
          const limited = await enforceRateLimit({
            cache: getCache(),
            config,
            request: c.req.raw,
            scope,
            failOpen
          });
          if (limited) return limited;
          return next();
        };
      };

      if (opts.mutations) {
        const mw = buildMiddleware("mutations", opts.mutations, (req) =>
          MUTATION_METHODS.has(req.method)
        );
        // Mount on the kernel's REST surface. The `mutations` bucket guards
        // every write that flows through `/api/*` (CRUD, publish, media, etc).
        app.use("/api/*", mw);
      }

      if (opts.graphql) {
        const mw = buildMiddleware("graphql", opts.graphql, (req) =>
          isGraphQLMutationRequest(req)
        );
        // Both the public route and the legacy `/cms/graphql/*` alias get the
        // same middleware so the bucket follows the operation, not the URL.
        // Hono's `/path/*` matches `/path` (zero-or-more) too, so one
        // registration per prefix is enough — registering both `/p` and
        // `/p/*` would double-count every request to `/p`.
        app.use("/graphql/*", mw);
        app.use("/cms/graphql/*", mw);
      }

      if (opts.media) {
        const mw = buildMiddleware("media", opts.media);
        app.use("/api/media/*", mw);
      }

      if (opts.auth) {
        const mw = buildMiddleware("auth", opts.auth);
        // The kernel exposed two auth surfaces: api-key CRUD and role CRUD.
        // Both bucket under the same `auth` scope so brute-force attempts on
        // either route share a budget.
        app.use("/api/api-keys/*", mw);
        app.use("/api/roles/*", mw);
        // Better-Auth's mounted handler also lives under `/api/auth/*`; include
        // it for parity with the original kernel enforcement at create-cms.ts:77.
        app.use("/api/auth/*", mw);
      }

      if (opts.admin) {
        const mw = buildMiddleware("admin", opts.admin);
        app.use("/cms/admin/*", mw);
        app.use("/cms/settings/*", mw);
      }

      if (opts.jobs) {
        const mw = buildMiddleware("jobs", opts.jobs);
        app.use("/cms/jobs/*", mw);
      }
    }
  });
}
