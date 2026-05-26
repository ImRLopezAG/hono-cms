import type { CacheAdapter } from "../types/providers";

export type ContentCacheOptions = false | {
  ttlSeconds?: number;
};

type CachedContentResponse = {
  body: unknown;
  etag: string;
};

const DEFAULT_TTL_SECONDS = 60;

export function contentCacheTtl(options: ContentCacheOptions | undefined): number | null {
  if (options === false) return null;
  return options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
}

export function normalizedRequestCacheSource(request: Request): string {
  const url = new URL(request.url);
  const params = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey === rightKey) return leftValue.localeCompare(rightValue);
    return leftKey.localeCompare(rightKey);
  });
  const query = new URLSearchParams(params).toString();
  return `${request.method.toUpperCase()} ${url.pathname}${query ? `?${query}` : ""}`;
}

export async function readContentCache(
  cache: CacheAdapter | null,
  collection: string,
  source: string,
  ifNoneMatch: string | null
): Promise<Response | null> {
  if (!cache) return null;
  const key = await contentCacheKey(cache, collection, source);
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

export async function writeContentCache(
  cache: CacheAdapter | null,
  collection: string,
  source: string,
  body: unknown,
  ttlSeconds: number | null
): Promise<Response> {
  const headers = new Headers();
  if (!cache || ttlSeconds === null) return Response.json(body);
  const etag = await createETag(body);
  const key = await contentCacheKey(cache, collection, source);
  await cache.set<CachedContentResponse>(key, { body, etag }, { ttl: ttlSeconds });
  headers.set("etag", etag);
  headers.set("x-cms-cache", "miss");
  return Response.json(body, { headers });
}

export async function invalidateContentCache(cache: CacheAdapter | null, collection: string): Promise<void> {
  if (!cache) return;
  await cache.set(contentCacheVersionKey(collection), crypto.randomUUID());
}

/**
 * Value-based cache helpers used by Apollo resolvers, which cannot work in
 * terms of `Response` objects because the HTTP envelope is assembled outside
 * the resolver. These mirror `readContentCache`/`writeContentCache` but only
 * deal with the cached body + etag pair.
 */
export async function readContentCacheEntry(
  cache: CacheAdapter | null,
  collection: string,
  source: string
): Promise<{ body: unknown; etag: string } | null> {
  if (!cache) return null;
  const key = await contentCacheKey(cache, collection, source);
  const entry = await cache.get<CachedContentResponse>(key);
  return entry ?? null;
}

export async function writeContentCacheEntry(
  cache: CacheAdapter | null,
  collection: string,
  source: string,
  body: unknown,
  ttlSeconds: number | null
): Promise<{ etag: string }> {
  const etag = await createETag(body);
  if (!cache || ttlSeconds === null) return { etag };
  const key = await contentCacheKey(cache, collection, source);
  await cache.set<CachedContentResponse>(key, { body, etag }, { ttl: ttlSeconds });
  return { etag };
}

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

async function contentCacheKey(cache: CacheAdapter, collection: string, source: string): Promise<string> {
  const version = await cache.get<number | string>(contentCacheVersionKey(collection)) ?? 0;
  return `content:${collection}:v${version}:${await sha256(source)}`;
}

function contentCacheVersionKey(collection: string): string {
  return `content-cache-version:${collection}`;
}

async function createETag(body: unknown): Promise<string> {
  return `"${await sha256(stableStringify(body))}"`;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
