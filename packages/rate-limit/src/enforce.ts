/**
 * Rate-limit enforcement helpers ported verbatim from the original
 * `packages/core/src/create-cms.ts` so behavior is byte-for-byte equivalent
 * to the pre-plugin kernel: same client-identifier resolution, same default
 * limit (100), same default window ("1 m"), same default prefix
 * (`cms:<scope>`), and the same 429 response shape with `Retry-After`,
 * `x-ratelimit-remaining`, and `x-ratelimit-reset` headers.
 */

import type { CacheAdapter } from "@hono-cms/core";
import type { RateLimitConfigEntry, RateLimitScope } from "./types";

/** Result returned by {@link enforceRateLimit}. `null` means "allow the request through". */
export type EnforceResult = Response | null;

/** Options bag for {@link enforceRateLimit}. Mirrors the legacy core signature. */
export type EnforceOpts = {
  /**
   * Cache adapter resolved from `ctx.plugins.get("cache")`. Nullable so the
   * plugin can fall open when the cache plugin has not been installed (caller
   * decides how to react to `null`).
   */
  cache: CacheAdapter | null | undefined;
  /** Per-scope configuration the user passed into `rateLimit({ <scope>: ... })`. */
  config: RateLimitConfigEntry | undefined;
  /** Inbound `Request` to identify the caller from. */
  request: Request;
  /** Logical scope ("auth", "media", etc.); also feeds the default key prefix. */
  scope: RateLimitScope;
  /**
   * When `true` (the default) and the cache adapter is missing or its
   * `checkRateLimit` call throws, the request is allowed through and a
   * `console.warn` is emitted. When `false`, the request is rejected with the
   * same 429 shape used for genuine limit hits.
   */
  failOpen?: boolean;
};

/**
 * Core enforcement entry point. Returns:
 *  - `null` when no limit is configured for the scope.
 *  - `null` when the cache surface is available and the call succeeds within
 *    the configured limit.
 *  - `Response` (429) when the call exceeds the limit OR `failOpen: false`
 *    and the cache surface is unavailable / throws.
 *  - `null` (with a warning) when `failOpen` is `true` (default) and the
 *    cache surface is unavailable / throws.
 */
export async function enforceRateLimit(
  opts: EnforceOpts
): Promise<EnforceResult> {
  const { cache, config, request, scope } = opts;
  const failOpen = opts.failOpen ?? true;

  // No config for this scope → nothing to enforce.
  if (!config) return null;

  // Cache plugin not installed or adapter lacks checkRateLimit.
  if (!cache?.checkRateLimit) {
    if (failOpen) {
      console.warn(
        `[@hono-cms/rate-limit] cache.checkRateLimit unavailable for scope "${scope}" — failing open. ` +
        `Install a cache plugin that implements checkRateLimit() or pass failOpen: false to reject.`
      );
      return null;
    }
    return rateLimitedResponse(undefined);
  }

  try {
    const result = await cache.checkRateLimit(clientIdentifier(request), {
      limit: config.limit ?? 100,
      window: config.window ?? "1 m",
      prefix: config.prefix ?? `cms:${scope}`
    });
    if (result.success) return null;
    return rateLimitedResponse(result);
  } catch (err) {
    if (failOpen) {
      console.warn(
        `[@hono-cms/rate-limit] cache.checkRateLimit threw for scope "${scope}" — failing open.`,
        err
      );
      return null;
    }
    return rateLimitedResponse(undefined);
  }
}

/**
 * Build the 429 JSON response. Extracted so both the "limit exceeded" path
 * and the "fail-closed cache error" path produce an identical envelope.
 */
function rateLimitedResponse(
  result: { remaining: number; resetAt?: string } | undefined
): Response {
  const headers = new Headers({
    "retry-after": retryAfterSeconds(result?.resetAt),
    "x-ratelimit-remaining": String(result?.remaining ?? 0)
  });
  if (result?.resetAt) headers.set("x-ratelimit-reset", result.resetAt);
  return Response.json({ error: "rate_limited" }, { status: 429, headers });
}

/**
 * Resolve a stable client identifier from a Request. Mirrors the original
 * kernel helper: Cloudflare's `cf-connecting-ip` wins, then the first entry
 * of `x-forwarded-for`, then `x-real-ip`, falling back to `"unknown"` so
 * requests still bucket somewhere even when no proxy headers are present.
 */
export function clientIdentifier(request: Request): string {
  return request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")
    ?? "unknown";
}

/** Convert a `resetAt` ISO timestamp into a `Retry-After` (seconds) header value. */
export function retryAfterSeconds(resetAt: string | undefined): string {
  if (!resetAt) return "60";
  const seconds = Math.ceil((Date.parse(resetAt) - Date.now()) / 1000);
  return String(Math.max(1, seconds));
}

/**
 * Detect whether a GraphQL request is a mutation (so the `graphql` scope can
 * skip queries the same way the legacy kernel did). Ported verbatim.
 */
export async function isGraphQLMutationRequest(request: Request): Promise<boolean> {
  try {
    if (request.method === "GET") {
      return /^\s*mutation\b/.test(new URL(request.url).searchParams.get("query") ?? "");
    }
    const body = await request.clone().json() as { query?: unknown };
    return typeof body.query === "string" && /^\s*mutation\b/.test(body.query);
  } catch {
    return false;
  }
}
