import type { Hono } from "hono";
import type { Authorize, HonoCMSEnv } from "@hono-cms/core";
import type { DatabaseAdapter } from "@hono-cms/schema";
import { API_KEYS_TABLE, type TokenService } from "../service/tokens";
import type { ApiKeyRow, CreateTokenInput } from "../service/types";

/**
 * Mount the `/api/api-keys` CRUD routes onto the supplied app.
 *
 * All routes are admin-only — each handler calls `authorize("admin", null)`
 * and returns 403 if the caller does not have the wildcard admin permission.
 *
 *   GET    /api/api-keys?namespace=... — list (omits `tokenHash`)
 *   POST   /api/api-keys               — create; response includes `secret` once
 *   GET    /api/api-keys/:id           — fetch single record
 *   PATCH  /api/api-keys/:id           — update name / metadata
 *   DELETE /api/api-keys/:id           — soft-delete (revokes the token)
 */
export function mountApiKeyRoutes(opts: {
  app: Hono<HonoCMSEnv>;
  db: DatabaseAdapter;
  service: TokenService;
  authorize: Authorize;
}): void {
  const { app, db, service, authorize } = opts;

  app.get("/api/api-keys", async (c) => {
    if (!(await authorize("admin", null))) return c.json({ error: "forbidden" }, 403);
    const namespace = c.req.query("namespace");
    if (!namespace) return c.json({ error: "bad_request", reason: "namespace_required" }, 400);
    const includeRevoked = c.req.query("includeRevoked") === "true";
    const rows = await service.list({ namespace, includeRevoked });
    return c.json({ items: rows.map(stripSensitive) });
  });

  app.post("/api/api-keys", async (c) => {
    if (!(await authorize("admin", null))) return c.json({ error: "forbidden" }, 403);
    type Body = {
      namespace?: unknown;
      name?: unknown;
      metadata?: unknown;
      expiresAt?: unknown;
      maxIdleMs?: unknown;
    };
    const body = (await c.req.json().catch(() => ({}))) as Body;
    if (typeof body.namespace !== "string" || body.namespace.length === 0) {
      return c.json({ error: "bad_request", reason: "namespace_required" }, 400);
    }
    const input: CreateTokenInput = { namespace: body.namespace, metadata: body.metadata };
    if (typeof body.name === "string") input.name = body.name;
    if (typeof body.expiresAt === "number") input.expiresAt = body.expiresAt;
    if (typeof body.maxIdleMs === "number") input.maxIdleMs = body.maxIdleMs;
    const created = await service.createToken(input);
    return c.json(
      {
        id: created.tokenId,
        namespace: body.namespace,
        name: typeof body.name === "string" ? body.name : "",
        secret: created.token,
        tokenPrefix: created.tokenPrefix
      },
      201
    );
  });

  app.get("/api/api-keys/:id", async (c) => {
    if (!(await authorize("admin", null))) return c.json({ error: "forbidden" }, 403);
    const id = c.req.param("id");
    const found = (await db.get(API_KEYS_TABLE, id)) as ApiKeyRow | null;
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json(stripSensitive(found));
  });

  app.patch("/api/api-keys/:id", async (c) => {
    if (!(await authorize("admin", null))) return c.json({ error: "forbidden" }, 403);
    const id = c.req.param("id");
    type Patch = { name?: unknown; metadata?: unknown };
    const patch = (await c.req.json().catch(() => ({}))) as Patch;
    const found = (await db.get(API_KEYS_TABLE, id)) as ApiKeyRow | null;
    if (!found) return c.json({ error: "not_found" }, 404);
    const updates: Record<string, unknown> = {};
    if (typeof patch.name === "string") updates.name = patch.name;
    if (patch.metadata !== undefined) updates.metadata = patch.metadata;
    if (Object.keys(updates).length === 0) return c.json(stripSensitive(found));
    const updated = (await db.update(API_KEYS_TABLE, id, updates)) as ApiKeyRow;
    return c.json(stripSensitive(updated));
  });

  app.delete("/api/api-keys/:id", async (c) => {
    if (!(await authorize("admin", null))) return c.json({ error: "forbidden" }, 403);
    const id = c.req.param("id");
    const ok = await service.invalidateById(id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });
}

/** Drop the secret-bearing column before returning a row to clients. */
function stripSensitive(row: ApiKeyRow): Omit<ApiKeyRow, "tokenHash"> {
  const { tokenHash: _hash, ...rest } = row;
  void _hash;
  return rest;
}
