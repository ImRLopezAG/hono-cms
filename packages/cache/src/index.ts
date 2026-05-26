/**
 * `@hono-cms/cache` — explicit plugin factories for the bundled cache backends.
 *
 * Each named factory (`memoryCache`, `kvCache`, `upstashCache`) constructs a
 * concrete `CacheAdapter` and wraps it in a `Plugin` that self-registers under
 * the service id `"cache"`. Downstream plugins (`rate-limit`, `content-cache`,
 * `preview`) declare `requires: ["cache"]` and reach the adapter through
 * `ctx.plugins.get<CacheAdapter>("cache")` — they neither know nor care which
 * backend is installed.
 *
 * The legacy `registerProvider("cache", ...)` side-effects this file used to
 * run at module import have been removed: a cache adapter is now activated
 * only when its factory is called inside the user's `plugins: [...]` array.
 *
 * Bring-your-own-adapter escape hatch: {@link cachePlugin} wraps any object
 * implementing the `CacheAdapter` contract.
 */

import type { Plugin } from "@hono-cms/core";
import {
  KVCacheAdapter,
  createKVCache
} from "./adapters/kv";
import {
  MemoryCacheAdapter,
  createMemoryCache
} from "./adapters/memory";
import {
  UpstashCacheAdapter,
  createUpstashCache
} from "./adapters/upstash";
import type {
  KVCacheConfig,
  MemoryCacheConfig,
  UpstashCacheConfig
} from "./adapters/types";
import { cachePlugin } from "./plugin";

/**
 * In-process memory cache plugin.
 *
 * The constructor does NOT start a `setInterval` sweep — the timer is deferred
 * to the first `.set()`/`.checkRateLimit()` call so the plugin is safe to
 * include in Cloudflare Workers and other edge runtimes that reject async I/O
 * in global scope.
 */
export function memoryCache(_opts: MemoryCacheConfig = {}): Plugin {
  void _opts; // reserved for future tuning knobs (max entries, etc.)
  return cachePlugin(createMemoryCache());
}

/**
 * Cloudflare KV cache plugin.
 *
 * KV is eventually consistent — appropriate for content response caching, not
 * for rate limiting or session caching. The adapter logs a startup warning to
 * surface these caveats.
 */
export function kvCache(opts: KVCacheConfig): Plugin {
  return cachePlugin(createKVCache(opts));
}

/**
 * Upstash Redis cache plugin.
 *
 * Distributed and atomic — appropriate for production multi-process / edge
 * deployments. Supports atomic rate limiting via `@upstash/ratelimit`.
 */
export function upstashCache(opts: UpstashCacheConfig): Plugin {
  return cachePlugin(createUpstashCache(opts));
}

// Public re-exports: plugin wrapper, adapter classes, and factory option shapes.
export { CACHE_PLUGIN_ID, cachePlugin } from "./plugin";
export {
  KVCacheAdapter,
  MemoryCacheAdapter,
  UpstashCacheAdapter,
  createKVCache,
  createMemoryCache,
  createUpstashCache
};
export type {
  KVCacheConfig,
  KVNamespaceLike,
  MemoryCacheConfig,
  RateLimiterLike,
  UpstashCacheConfig,
  UpstashRedisLike
} from "./adapters/types";

/**
 * Transitional `registerProvider` shims for the legacy `createCMS({ cache: { provider: "memory" } })`
 * shape. The plugin manifest path is the preferred API and tests/examples should
 * migrate to it; the registry side-effect is removed entirely when the legacy
 * createCMS code path is deleted in the kernel cleanup pass (U23).
 */
import { registerProvider } from "@hono-cms/core";
registerProvider("cache", "memory", createMemoryCache);
registerProvider("cache", "kv", createKVCache);
registerProvider("cache", "upstash", createUpstashCache);
