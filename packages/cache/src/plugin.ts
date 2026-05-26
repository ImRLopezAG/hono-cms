import { createPlugin, type CacheAdapter, type Plugin } from "@hono-cms/core";

/** Plugin id under which every cache adapter self-registers on the plugin service registry. */
export const CACHE_PLUGIN_ID = "cache";

/**
 * Wrap any pre-built `CacheAdapter` in the standard cache plugin manifest.
 *
 * Bring-your-own-adapter escape hatch used by `memoryCache` / `kvCache` /
 * `upstashCache` and exposed publicly for users who implement the
 * `CacheAdapter` contract themselves (e.g. a custom Redis client, an in-house
 * memcached binding, or a fake for tests).
 *
 * Downstream plugins (`rate-limit`, `content-cache`, `preview`) declare
 * `requires: ["cache"]` and reach the adapter via
 * `ctx.plugins.get<CacheAdapter>("cache")` regardless of which factory built
 * it.
 */
export function cachePlugin(adapter: CacheAdapter): Plugin {
  return createPlugin({
    id: CACHE_PLUGIN_ID,
    app: (_app, ctx) => {
      ctx.plugins.register(CACHE_PLUGIN_ID, adapter);
    }
  });
}
