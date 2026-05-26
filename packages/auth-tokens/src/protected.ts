import type { MiddlewareHandler } from "hono";
import type { IdentityScope } from "./authorize";
import type { TokenService } from "./service/tokens";

/**
 * Identity shape stamped onto `c.var.identity` by {@link createProtectedMiddleware}.
 *
 * Kept opaque to the kernel: downstream plugins / authorize functions consume
 * the `namespace` field for role/scope lookups.
 */
export type TokensIdentity = {
  subjectId: string;
  namespace: string;
  metadata: unknown;
};

/**
 * Build the auth-tokens `protected` middleware.
 *
 * Reads the bearer token from `Authorization: Bearer <token>` (preferred) or
 * the `X-Api-Key` header as a fallback. Calls into the token service to
 * validate. On success it:
 *
 *  1. Touches `lastUsedAt` (the validate path also rejects expired / idle
 *     timed-out tokens).
 *  2. Stamps `c.var.identity = { subjectId, namespace, metadata }`.
 *  3. Enters the {@link IdentityScope} so any in-route `authorize()` call
 *     sees the right identity.
 *
 * On failure: 401 with a JSON body describing the reason — admin tooling
 * uses this to render a useful error.
 */
export function createProtectedMiddleware(opts: {
  service: TokenService;
  scope: IdentityScope;
}): MiddlewareHandler {
  const { service, scope } = opts;
  return async (ctx, next) => {
    const token = readToken(ctx.req.raw);
    if (!token) {
      return ctx.json({ error: "unauthorized" }, 401);
    }

    const result = await service.validate(token);
    if (!result.ok) {
      return ctx.json({ error: "unauthorized", reason: result.reason }, 401);
    }

    const identity: TokensIdentity = {
      subjectId: result.tokenId,
      namespace: result.namespace,
      metadata: result.metadata
    };
    // Cast through unknown because the kernel's HonoCMSEnv typing predates
    // the plugin-supplied `identity` slot; routes look it up by name.
    (ctx as unknown as { set: (key: string, value: unknown) => void }).set("identity", identity);

    await scope.run(identity, async () => {
      await next();
    });
  };
}

/**
 * Extract the bearer token from a `Request`.
 *
 * Tries `Authorization: Bearer <token>` first (the documented contract), then
 * falls back to `X-Api-Key` for clients that find header-prefixed schemes
 * awkward to set (curl-from-bash, browser fetch from restricted contexts).
 * Returns `null` if neither header is present.
 */
export function readToken(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) return match[1].trim();
  }
  const apiKey = request.headers.get("x-api-key") ?? request.headers.get("X-Api-Key");
  if (apiKey) return apiKey.trim();
  return null;
}
