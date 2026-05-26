/**
 * `@hono-cms/content-cache` — read-through cache for collection list / get
 * routes.
 *
 * Wraps `GET /api/<collection>` and `GET /api/<collection>/:id` with a
 * cache-adapter-backed middleware that:
 *
 *   - keys entries by `(collection, normalized URL, identity scope)` so that
 *     two users with different roles can hit the same URL without leaking
 *     each other's field projections,
 *   - invalidates on `content:after-{create,update,delete,publish,unpublish}`
 *     events by bumping a per-collection version stamp,
 *   - supports the standard `If-None-Match` / `ETag` conditional-GET dance.
 *
 * Depends on `@hono-cms/cache` (declared via `requires: ["cache"]`).
 */

export { contentCache, CONTENT_CACHE_PLUGIN_ID, buildContentCacheMiddleware } from "./plugin";
export {
  identityScope,
  invalidateContentCache,
  normalizedRequestCacheSource,
  readContentCache,
  stableStringify,
  writeContentCache
} from "./middleware";
export {
  INVALIDATING_EVENTS,
  subscribeInvalidationEvents
} from "./invalidation";
export type { InvalidatingEvent } from "./invalidation";
export type { ContentCacheConfig } from "./types";
