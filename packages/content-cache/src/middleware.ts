import type { CacheAdapter } from "@hono-cms/core";

/**
 * Internal envelope written to the cache. We store the JSON body separate
 * from the etag so a `304 Not Modified` short-circuit only needs to
 * round-trip the etag, not the body.
 */
type CachedContentResponse = {
  body: unknown;
  etag: string;
};

/* -------------------------------------------------------------------------- */
/* Request normalization                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Produce a stable string representation of a request suitable for use as a
 * cache key component. Query parameters are alpha-sorted (and ties broken on
 * value) so that `?a=1&b=2` and `?b=2&a=1` hit the same cache entry.
 *
 * Ported verbatim from `packages/core/src/content/cache.ts:normalizedRequestCacheSource`.
 */
export function normalizedRequestCacheSource(request: Request): string {
  const url = new URL(request.url);
  const params = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey === rightKey) return leftValue.localeCompare(rightValue);
    return leftKey.localeCompare(rightKey);
  });
  const query = new URLSearchParams(params).toString();
  return `${request.method.toUpperCase()} ${url.pathname}${query ? `?${query}` : ""}`;
}

/* -------------------------------------------------------------------------- */
/* Identity scoping                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Compute a stable identity scope string for the current request. Anonymous
 * requests share a single `anon` bucket; authenticated requests are bucketed
 * by `userId` (with role hash mixed in so that role changes invalidate
 * cached projections without colliding with other users).
 *
 * This is what keeps "different users see different cached content" — without
 * it, a logged-out CDN cache could leak admin-only field projections back to
 * the public.
 */
export async function identityScope(session: unknown): Promise<string> {
  if (!isSessionLike(session)) return "anon";
  const roleSig = await sha256(session.roles.slice().sort().join(","));
  return `u:${session.userId}:r:${roleSig.slice(0, 12)}`;
}

function isSessionLike(value: unknown): value is { userId: string; roles: readonly string[] } {
  if (!value || typeof value !== "object") return false;
  const rec = value as { userId?: unknown; roles?: unknown };
  return typeof rec.userId === "string" && Array.isArray(rec.roles);
}

/* -------------------------------------------------------------------------- */
/* Read / write the response envelope                                         */
/* -------------------------------------------------------------------------- */

/**
 * Attempt to serve a cached response for the given (collection, source,
 * identity) tuple. Returns `null` on miss, a 304 when the inbound
 * `if-none-match` matches the stored etag, or a 200 with the cached body.
 *
 * Ported from `packages/core/src/content/cache.ts:readContentCache`, with
 * identity scoping added per U14 spec.
 */
export async function readContentCache(
  cache: CacheAdapter,
  keyPrefix: string,
  collection: string,
  source: string,
  identity: string,
  ifNoneMatch: string | null
): Promise<Response | null> {
  const key = await contentCacheKey(cache, keyPrefix, collection, source, identity);
  const entry = await cache.get<CachedContentResponse>(key);
  if (!entry) return null;
  if (ifNoneMatch === entry.etag) {
    return new Response(null, {
      status: 304,
      headers: { etag: entry.etag, "x-cms-cache": "hit" }
    });
  }
  return Response.json(entry.body, {
    headers: { etag: entry.etag, "x-cms-cache": "hit" }
  });
}

/**
 * Persist `body` under the cache key derived from
 * (collection, source, identity), then return a 200 JSON response carrying
 * the freshly-computed etag and `x-cms-cache: miss` header.
 *
 * Ported from `packages/core/src/content/cache.ts:writeContentCache`.
 */
export async function writeContentCache(
  cache: CacheAdapter,
  keyPrefix: string,
  collection: string,
  source: string,
  identity: string,
  body: unknown,
  ttlSeconds: number
): Promise<Response> {
  const etag = await createETag(body);
  const key = await contentCacheKey(cache, keyPrefix, collection, source, identity);
  await cache.set<CachedContentResponse>(key, { body, etag }, { ttl: ttlSeconds });
  const headers = new Headers();
  headers.set("etag", etag);
  headers.set("x-cms-cache", "miss");
  return Response.json(body, { headers });
}

/* -------------------------------------------------------------------------- */
/* Invalidation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Bump the per-collection version stamp so that previously-issued cache keys
 * become unreachable. This is cheaper than enumerating + deleting matching
 * keys on cache backends that lack a `deletePattern` (e.g. Cloudflare KV's
 * eventual consistency model).
 *
 * Ported from `packages/core/src/content/cache.ts:invalidateContentCache`.
 */
export async function invalidateContentCache(
  cache: CacheAdapter,
  keyPrefix: string,
  collection: string
): Promise<void> {
  await cache.set(contentCacheVersionKey(keyPrefix, collection), crypto.randomUUID());
}

/* -------------------------------------------------------------------------- */
/* Key builders + hashing                                                     */
/* -------------------------------------------------------------------------- */

async function contentCacheKey(
  cache: CacheAdapter,
  keyPrefix: string,
  collection: string,
  source: string,
  identity: string
): Promise<string> {
  const version = (await cache.get<number | string>(contentCacheVersionKey(keyPrefix, collection))) ?? 0;
  const hashed = await sha256(`${identity}|${source}`);
  return `${keyPrefix}:${collection}:v${version}:${hashed}`;
}

function contentCacheVersionKey(keyPrefix: string, collection: string): string {
  return `${keyPrefix}-version:${collection}`;
}

/**
 * Deterministic JSON-ish serializer. Object keys are sorted before being
 * stringified so that semantically-identical bodies produce identical etags
 * regardless of key insertion order.
 *
 * Ported verbatim from `packages/core/src/content/cache.ts:stableStringify`.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function createETag(body: unknown): Promise<string> {
  return `"${await sha256(stableStringify(body))}"`;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
