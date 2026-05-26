import { createPlugin, type CacheAdapter, type Plugin } from "@hono-cms/core";
import type { MiddlewareHandler } from "hono";
import type { HonoCMSEnv } from "@hono-cms/core";
import { subscribeInvalidationEvents } from "./invalidation";
import {
  identityScope,
  normalizedRequestCacheSource,
  readContentCache,
  writeContentCache
} from "./middleware";
import type { ContentCacheConfig } from "./types";

/** Plugin id under which the content-cache plugin registers. */
export const CONTENT_CACHE_PLUGIN_ID = "content-cache";

const DEFAULT_TTL_SECONDS = 30;
const DEFAULT_KEY_PREFIX = "content-cache";

/**
 * Regex matching the collection content routes the kernel mounts:
 *   - `GET /api/<collection>`
 *   - `GET /api/<collection>/<id>`
 *
 * The plugin restricts caching to **list** and **get** endpoints; auxiliary
 * routes (`/api/<coll>/:id/locales`, etc.) bypass this middleware so that
 * locale variants are never served from a stale cache entry keyed only by
 * the parent record's URL.
 *
 * Capture group 1 is the collection slug.
 */
const CONTENT_LIST_OR_GET = /^\/api\/([^/]+)(?:\/[^/]+)?\/?$/;

/**
 * Build the `Plugin` manifest for the CMS content-cache layer.
 *
 * Behavior at runtime:
 *
 * 1. Registers a `GET`-only middleware on `/api/*`. On each request the
 *    middleware normalizes the URL, mixes in an identity scope (so logged-in
 *    and anonymous users get separate cache entries), and looks the entry up
 *    via the cache adapter exposed by `@hono-cms/cache`.
 * 2. On a cache hit, returns the stored body (or a 304 when the inbound
 *    `if-none-match` matches the stored etag) without calling the kernel
 *    handler.
 * 3. On a miss, lets the request through, then captures the resulting 200
 *    JSON body and writes it back to cache under the same key, with the
 *    configured TTL.
 * 4. Subscribes to `content:after-{create,update,delete,publish,unpublish}`
 *    on `ctx.events`. Each subscription bumps the affected collection's
 *    cache-version stamp, instantly invalidating all previously-cached
 *    responses for that collection without scanning keys.
 *
 * Requires the `cache` plugin to be installed first — the kernel's
 * `validateAndOrder` enforces this via the `requires: ["cache"]` declaration.
 */
export function contentCache(opts: ContentCacheConfig = {}): Plugin {
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const keyPrefix = opts.keyPrefix ?? DEFAULT_KEY_PREFIX;

  return createPlugin({
    id: CONTENT_CACHE_PLUGIN_ID,
    requires: ["cache"],
    app: (app, ctx) => {
      const cache = ctx.plugins.get<CacheAdapter>("cache");

      // 1) Cache invalidation — wired against the event bus.
      subscribeInvalidationEvents(ctx, cache, keyPrefix);

      // 2) Read-through cache middleware. Hono's `.use(path, mw)` matches the
      // path prefix; the middleware itself filters down to GET + the
      // list/get URL shape so that we never cache POST/PATCH/DELETE
      // responses (and never short-circuit non-content routes).
      app.use("/api/*", buildContentCacheMiddleware({ cache, ttlSeconds, keyPrefix }));
    }
  });
}

type MiddlewareDeps = {
  cache: CacheAdapter;
  ttlSeconds: number;
  keyPrefix: string;
};

/**
 * Hono middleware factory. Extracted from the plugin's `app(...)` body so
 * that tests can install the middleware against a bare Hono app without
 * going through the full plugin runtime.
 */
export function buildContentCacheMiddleware(deps: MiddlewareDeps): MiddlewareHandler<HonoCMSEnv> {
  const { cache, ttlSeconds, keyPrefix } = deps;

  return async (context, next) => {
    const raw = context.req.raw;
    if (raw.method !== "GET") return next();

    const url = new URL(raw.url);
    const match = CONTENT_LIST_OR_GET.exec(url.pathname);
    if (!match || !match[1]) return next();
    const collection = match[1];

    // TTL of 0 disables caching but still lets invalidation events run; this
    // mirrors the kernel's old "set the slot to false to opt-out" knob.
    if (ttlSeconds <= 0) return next();

    const session = context.get("session") ?? null;
    const identity = await identityScope(session);
    const cacheSource = normalizedRequestCacheSource(raw);
    const ifNoneMatch = context.req.header("if-none-match") ?? null;

    const cached = await readContentCache(cache, keyPrefix, collection, cacheSource, identity, ifNoneMatch);
    if (cached) {
      // Hand the cached Response back through Hono. Setting `context.res`
      // signals to Hono that the middleware produced the response and the
      // downstream handler must NOT run.
      return cached;
    }

    await next();

    const response = context.res;
    if (!response) return;
    // Only cache successful JSON responses — anything else (4xx/5xx/non-JSON)
    // shouldn't poison the cache.
    if (response.status !== 200) return;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) return;

    // Clone before reading: Hono returns the original response to the caller,
    // and `Response.json()`/`.body` is a one-shot stream.
    const cloned = response.clone();
    let body: unknown;
    try {
      body = await cloned.json();
    } catch {
      return;
    }

    const cachedResponse = await writeContentCache(
      cache,
      keyPrefix,
      collection,
      cacheSource,
      identity,
      body,
      ttlSeconds
    );

    // Swap the response so the caller sees the etag + `x-cms-cache: miss`
    // headers, matching the pre-refactor kernel behavior.
    context.res = cachedResponse;
  };
}
