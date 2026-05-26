/**
 * Per-scope rate-limit entry. Mirrors the legacy `RateLimitConfig` shape that
 * used to live under `core/src/types/config.ts` so the plugin reads as a
 * drop-in replacement for the old `cmsConfig.rateLimit.<scope>` block.
 *
 * - `limit`  — maximum requests allowed per window. Defaults to 100.
 * - `window` — duration string (`"30 s"`, `"1 m"`, `"1 h"`, etc.) as parsed
 *              by the active cache adapter. Defaults to `"1 m"`.
 * - `prefix` — optional bucket prefix override. Defaults to `"cms:<scope>"`
 *              so the plugin's six known scopes live in disjoint key spaces.
 */
export type RateLimitConfigEntry = {
  limit?: number;
  window?: string;
  prefix?: string;
};

/**
 * Back-compat alias kept for callers that previously imported
 * `RateLimitConfig` from `@hono-cms/core`. The shape is unchanged.
 */
export type RateLimitConfig = RateLimitConfigEntry;

/** Scope keys recognised by the `rateLimit()` factory. */
export type RateLimitScope =
  | "mutations"
  | "graphql"
  | "media"
  | "auth"
  | "admin"
  | "jobs";
