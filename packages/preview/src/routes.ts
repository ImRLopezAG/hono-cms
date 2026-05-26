import type { Hono } from "hono";
import type { CacheAdapter, HonoCMSEnv } from "@hono-cms/core";
import { generatePreviewToken, revokePreviewToken, verifyPreviewToken } from "./tokens";
import type { PreviewConfig } from "./types";

/**
 * Mount the three preview-token routes on `app`.
 *
 * The mounts are split into their own module (rather than inlined in
 * `plugin.ts`) so the plugin file stays small and the route handlers can be
 * unit-tested through `app.request(...)` without rebuilding the full plugin
 * manifest.
 */
export function mountPreviewRoutes(
  app: Hono<HonoCMSEnv>,
  opts: { cache: CacheAdapter; config: Required<PreviewConfig> }
): void {
  const { cache, config } = opts;

  /**
   * `POST /api/preview-tokens`
   *
   * Issues a new preview token for the requested `{ collection, documentId }`
   * pair. Identity is mandatory — an anonymous caller is rejected with 403
   * before any cache write happens.
   *
   * Returns `201 { token, expiresAt, previewUrl }` on success.
   */
  app.post("/api/preview-tokens", async (context) => {
    if (!hasIdentity(context)) {
      return context.json({ error: "forbidden" }, 403);
    }
    let body: { collection?: unknown; documentId?: unknown };
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_body" }, 400);
    }
    if (typeof body.collection !== "string" || typeof body.documentId !== "string") {
      return context.json(
        {
          error: "validation_error",
          issues: [
            {
              path: ["collection", "documentId"],
              message: "collection and documentId are required"
            }
          ]
        },
        422
      );
    }
    const result = await generatePreviewToken(cache, {
      collection: body.collection,
      documentId: body.documentId,
      previewUrlBase: config.url,
      ttlSeconds: config.tokenTtlSeconds
    });
    return context.json(result, 201);
  });

  /**
   * `GET /api/preview-tokens/:token/verify`
   *
   * Returns `200 { ok: true, collection, documentId }` for a live token,
   * `404 { ok: false }` for any combination of unknown / expired / malformed
   * tokens — never leak which case caused the miss.
   */
  app.get("/api/preview-tokens/:token/verify", async (context) => {
    const payload = await verifyPreviewToken(cache, context.req.param("token"));
    if (!payload) {
      return context.json({ ok: false, error: "not_found" }, 404);
    }
    return context.json({
      ok: true,
      collection: payload.collection,
      documentId: payload.documentId
    });
  });

  /**
   * `DELETE /api/preview-tokens/:token`
   *
   * Idempotent revoke. Always returns 204 — including for unknown tokens —
   * so the endpoint can't be used as an oracle for token existence.
   */
  app.delete("/api/preview-tokens/:token", async (context) => {
    if (!hasIdentity(context)) {
      return context.json({ error: "forbidden" }, 403);
    }
    await revokePreviewToken(cache, context.req.param("token"));
    return new Response(null, { status: 204 });
  });
}

/**
 * Identity probe used by the create + revoke routes.
 *
 * Accepts either the legacy admin `session` slot (still stamped by the
 * built-in admin auth plugin) or the post-U7 `identity` slot stamped by
 * `@hono-cms/auth-tokens`. Either non-null value counts as authenticated —
 * fine-grained role checks belong in the host app's `authorize` callback,
 * not in this plugin.
 */
function hasIdentity(context: { get: (key: string) => unknown }): boolean {
  const session = context.get("session");
  if (session) return true;
  const identity = context.get("identity");
  if (identity) return true;
  return false;
}
