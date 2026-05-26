/**
 * Configuration types for the `@hono-cms/cors` plugin.
 *
 * Ported verbatim from `packages/core/src/types/config.ts:17-31` so the
 * plugin owns its public surface without re-importing from core. Keep these
 * two declarations in sync until the kernel drops its inline `cors:` config
 * key in favor of `plugins: [cors(...)]`.
 */

export type CorsOrigin =
  | boolean
  | "*"
  | string
  | readonly string[]
  | ((origin: string | null, request: Request) => boolean | string | null | undefined);

export type CorsConfig = {
  origin?: CorsOrigin;
  credentials?: boolean;
  methods?: readonly string[];
  allowedHeaders?: readonly string[];
  exposedHeaders?: readonly string[];
  maxAge?: number;
};

/**
 * Internal shape used by the helpers — all defaults filled in, `maxAge`
 * preserved as optional.
 */
export type NormalizedCorsConfig = Required<Omit<CorsConfig, "maxAge">> & { maxAge?: number };
