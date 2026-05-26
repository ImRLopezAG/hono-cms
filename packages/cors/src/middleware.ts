import type { MiddlewareHandler } from "hono";
import type { CorsConfig, NormalizedCorsConfig } from "./types";

/**
 * Per-plugin accepted input. Mirrors the legacy kernel API where `cors: true`
 * meant "use defaults" and `cors: false`/`undefined` meant "disabled". The
 * plugin factory only takes a `CorsConfig` object today, but the helpers
 * still accept the legacy union so they stay byte-for-byte compatible with
 * the inline kernel logic they replaced.
 */
export type CorsInput = boolean | CorsConfig | undefined;

/**
 * Build the preflight response for `OPTIONS` requests that carry the
 * `access-control-request-method` header. Returns `null` when the request is
 * not a preflight (so the caller can fall through to the normal request
 * pipeline).
 *
 * Ported verbatim from `packages/core/src/create-cms.ts:2500-2512`.
 */
export function corsPreflightResponse(config: CorsInput, request: Request): Response | null {
  if (!config) return null;
  if (request.method !== "OPTIONS" || !request.headers.get("access-control-request-method")) return null;
  const response = new Response(null, { status: 204 });
  applyCorsHeaders(config, request, response);
  const normalized = normalizeCors(config);
  response.headers.set("access-control-allow-methods", normalized.methods.join(", "));
  response.headers.set(
    "access-control-allow-headers",
    request.headers.get("access-control-request-headers") ?? normalized.allowedHeaders.join(", ")
  );
  if (normalized.maxAge !== undefined) response.headers.set("access-control-max-age", String(normalized.maxAge));
  response.headers.append("vary", "Access-Control-Request-Method");
  response.headers.append("vary", "Access-Control-Request-Headers");
  return response;
}

/**
 * Mutate `response.headers` to carry the CORS allow/expose headers determined
 * by `config` and the current `request`. No-op when the configured origin
 * does not match the request.
 *
 * Ported verbatim from `packages/core/src/create-cms.ts:2514-2523`.
 */
export function applyCorsHeaders(
  config: CorsInput,
  request: Request,
  response: Pick<Response, "headers">
): void {
  if (!config) return;
  const normalized = normalizeCors(config);
  const origin = resolveCorsOrigin(normalized, request);
  if (!origin) return;
  response.headers.set("access-control-allow-origin", origin);
  response.headers.append("vary", "Origin");
  if (normalized.credentials) response.headers.set("access-control-allow-credentials", "true");
  if (normalized.exposedHeaders.length)
    response.headers.set("access-control-expose-headers", normalized.exposedHeaders.join(", "));
}

/**
 * Resolve the value the `Access-Control-Allow-Origin` header should carry,
 * or `null` when the request's origin is not allowed.
 *
 * Ported verbatim from `packages/core/src/create-cms.ts:2538-2552`.
 */
export function resolveCorsOrigin(
  config: NormalizedCorsConfig,
  request: Request
): string | null {
  const requestOrigin = request.headers.get("origin");
  if (typeof config.origin === "function") {
    const resolved = config.origin(requestOrigin, request);
    if (resolved === true) return requestOrigin ?? "*";
    if (resolved === false) return null;
    return resolved ?? null;
  }
  if (config.origin === true) return requestOrigin ?? (config.credentials ? null : "*");
  if (config.origin === false) return null;
  if (config.origin === "*") return config.credentials && requestOrigin ? requestOrigin : "*";
  if (typeof config.origin === "string") return requestOrigin === config.origin ? config.origin : null;
  if (Array.isArray(config.origin))
    return requestOrigin && config.origin.includes(requestOrigin) ? requestOrigin : null;
  return null;
}

/**
 * Fill in defaults. Ported verbatim from
 * `packages/core/src/create-cms.ts:2525-2536`.
 */
export function normalizeCors(config: Exclude<CorsInput, false | undefined>): NormalizedCorsConfig {
  const options = config === true ? {} : config;
  const result: NormalizedCorsConfig = {
    origin: options.origin ?? "*",
    credentials: options.credentials ?? false,
    methods: options.methods ?? ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: options.allowedHeaders ?? ["authorization", "content-type", "x-request-id", "x-filename"],
    exposedHeaders: options.exposedHeaders ?? []
  };
  if (options.maxAge !== undefined) result.maxAge = options.maxAge;
  return result;
}

/**
 * Hono middleware that applies CORS headers to the response *after* the
 * downstream handler has produced it. Preflight (`OPTIONS`) handling is done
 * by the dedicated `app.options("*")` route the plugin mounts in `app()`.
 */
export function corsMiddleware(config: CorsInput): MiddlewareHandler {
  return async (context, next) => {
    await next();
    applyCorsHeaders(config, context.req.raw, context.res);
  };
}
