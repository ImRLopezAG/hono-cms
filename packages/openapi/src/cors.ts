/**
 * Self-contained CORS helpers used by the openapi plugin for the spec/docs
 * routes. Ported verbatim from `packages/core/src/create-cms.ts:2500-2552` so
 * this plugin does not pull in `@hono-cms/cors` as a hard dependency.
 *
 * If callers want their spec routes to share the global CORS policy they can
 * pass the same config object to both `cors(...)` and `openapi({ cors: ... })`.
 */
import type { CorsConfig } from "./types";

export type CorsInput = boolean | CorsConfig | undefined;
export type NormalizedCorsConfig = Required<Omit<CorsConfig, "maxAge">> & { maxAge?: number };

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

export function resolveCorsOrigin(config: NormalizedCorsConfig, request: Request): string | null {
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
