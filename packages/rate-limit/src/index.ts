/**
 * `@hono-cms/rate-limit` — declarative rate-limiting plugin for hono-cms.
 *
 * Use alongside a cache plugin (`@hono-cms/cache`) in `plugins: [...]`:
 *
 *     plugins: [
 *       memoryCache({}),
 *       rateLimit({
 *         mutations: { limit: 50, window: "1 m" },
 *         auth:      { limit: 10, window: "10 s" }
 *       })
 *     ]
 *
 * The plugin reaches the cache via `ctx.plugins.get("cache")` and mounts a
 * thin Hono middleware on each scope's well-known path prefix.
 */

export { rateLimit, RATE_LIMIT_PLUGIN_ID } from "./plugin";
export type { RateLimitOpts } from "./plugin";
export {
  enforceRateLimit,
  clientIdentifier,
  retryAfterSeconds,
  isGraphQLMutationRequest
} from "./enforce";
export type { EnforceOpts, EnforceResult } from "./enforce";
export type { RateLimitConfig, RateLimitConfigEntry, RateLimitScope } from "./types";
