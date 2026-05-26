import type { CacheAdapter } from "@hono-cms/core";
import type { PreviewTokenPayload, PreviewTokenResult } from "./types";

/**
 * Number of random bytes consumed per preview token. 16 bytes = 128 bits of
 * entropy, encoded as 32 hex chars. Shorter than `auth-tokens`' `sk_<48-hex>`
 * because preview tokens are short-lived (default 15 min TTL) and scoped to a
 * single document — the smaller entropy budget is documented in the U15 plan.
 */
const PREVIEW_TOKEN_BYTES = 16;

/**
 * Preview-token format. The `prev_` prefix mirrors the `sk_` convention from
 * `@hono-cms/auth-tokens` so server-side logs / scanners can distinguish a
 * preview token from an API key at a glance.
 */
const PREVIEW_TOKEN_PATTERN = /^prev_[0-9a-f]{32}$/;

/**
 * Cache key under which the token payload is stored. Centralised so
 * generate/verify/revoke can never drift apart.
 */
function cacheKey(token: string): string {
  return `preview:${token}`;
}

/**
 * Generate a fresh preview token and persist its payload in the cache under
 * `preview:<token>` with the configured TTL. Returns the token + expiry +
 * resolved preview URL the API surfaces to the caller.
 */
export async function generatePreviewToken(
  cache: CacheAdapter,
  input: {
    collection: string;
    documentId: string;
    previewUrlBase: string;
    ttlSeconds: number;
    now?: Date;
  }
): Promise<PreviewTokenResult> {
  const now = input.now ?? new Date();
  const token = `prev_${randomHex(PREVIEW_TOKEN_BYTES)}`;
  const payload: PreviewTokenPayload = {
    collection: input.collection,
    documentId: input.documentId,
    createdAt: now.toISOString()
  };
  await cache.set(cacheKey(token), payload, { ttl: input.ttlSeconds });
  const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000).toISOString();
  return {
    token,
    expiresAt,
    previewUrl: input.previewUrlBase ? buildPreviewUrl(input.previewUrlBase, token) : ""
  };
}

/**
 * Verify a token against the cache. Returns the payload on hit, `null` on:
 *
 *  - missing/invalid format (cheap reject before touching the cache);
 *  - cache miss (expired or unknown token);
 *  - malformed payload (defensive — guards against a corrupt cache entry).
 */
export async function verifyPreviewToken(
  cache: CacheAdapter | null,
  token: string | null | undefined
): Promise<PreviewTokenPayload | null> {
  if (!cache || !token || !PREVIEW_TOKEN_PATTERN.test(token)) return null;
  const payload = await cache.get<PreviewTokenPayload>(cacheKey(token));
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.collection !== "string" || typeof payload.documentId !== "string") return null;
  return payload;
}

/**
 * Delete a token from the cache. No-op when the token is missing or
 * malformed (defensive — prevents an attacker from probing for valid tokens
 * via the revoke endpoint).
 */
export async function revokePreviewToken(
  cache: CacheAdapter | null,
  token: string
): Promise<void> {
  if (!cache || !PREVIEW_TOKEN_PATTERN.test(token)) return;
  await cache.delete(cacheKey(token));
}

/**
 * Resolve the public preview URL for `token` given the configured base.
 *
 *  - If `base` contains `{{token}}`, substitute it (callers can express
 *    `https://site.example/preview/{{token}}` style URLs).
 *  - Otherwise treat `base` as a URL and set/replace its `token` query param.
 *  - If `base` is not a parseable URL, fall back to a naive `?token=` append
 *    so misconfigured callers still see a usable string in the response.
 */
function buildPreviewUrl(base: string, token: string): string {
  if (base.includes("{{token}}")) {
    return base.replaceAll("{{token}}", token);
  }
  try {
    const url = new URL(base);
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}token=${token}`;
  }
}

/**
 * Crypto-strong random hex string of length `bytesLength * 2`. Uses the
 * platform `crypto.getRandomValues` (no Node-specific import) so the helper
 * is runnable on edge / workers / browsers alike.
 */
function randomHex(bytesLength: number): string {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export { PREVIEW_TOKEN_PATTERN };
