import type { Context, Hono } from "hono";
import type { Authorize, HonoCMSEnv } from "@hono-cms/core";
import type { DatabaseAdapter } from "@hono-cms/schema";
import { ROLES_TABLE, type PermissionMatrix, type RoleRow } from "../tables/roles";
import type { TokensIdentity } from "../protected";

/**
 * Mount the `/api/roles` CRUD routes onto the supplied app.
 *
 *   GET    /api/roles             — list all roles (admin-only)
 *   POST   /api/roles             — create role (admin-only)
 *   GET    /api/roles/:id         — fetch role
 *   PATCH  /api/roles/:id         — update role (admin-only; root-protected — see below)
 *   DELETE /api/roles/:id         — delete role (admin-only; root role cannot be deleted)
 *
 * Privilege-escalation guard: when a caller is *not* tagged with the `root`
 * namespace they cannot
 *
 *   (a) edit the root role, nor
 *   (b) grant wildcard `"*": { "*": true }` permissions through any other
 *       role.
 *
 * Both attempts return 403. This prevents a less-privileged admin from
 * minting themselves super-admin via a role rewrite.
 */
export function mountRoleRoutes(opts: {
  app: Hono<HonoCMSEnv>;
  db: DatabaseAdapter;
  authorize: Authorize;
}): void {
  const { app, db, authorize } = opts;

  app.get("/api/roles", async (c) => {
    if (!(await authorize("admin", null))) return c.json({ error: "forbidden" }, 403);
    const result = await db.list(ROLES_TABLE, { limit: 100 });
    return c.json({ items: result.items as RoleRow[] });
  });

  app.post("/api/roles", async (c) => {
    if (!(await authorize("admin", null))) return c.json({ error: "forbidden" }, 403);
    type Body = {
      name?: unknown;
      description?: unknown;
      permissions?: unknown;
    };
    const body = (await c.req.json().catch(() => ({}))) as Body;
    if (typeof body.name !== "string" || body.name.length === 0) {
      return c.json({ error: "bad_request", reason: "name_required" }, 400);
    }
    const permissions = (body.permissions ?? {}) as PermissionMatrix;
    if (!isPermissionMatrix(body.permissions ?? {})) {
      return c.json({ error: "bad_request", reason: "invalid_permissions" }, 400);
    }

    // Privilege escalation: non-root callers cannot mint wildcard roles.
    const identity = readIdentity(c);
    if (!isRootCaller(identity) && grantsFullWildcard(permissions)) {
      return c.json({ error: "forbidden", reason: "wildcard_requires_root" }, 403);
    }

    const existing = await db.list(ROLES_TABLE, { filters: { name: body.name }, limit: 1 });
    if (existing.items.length > 0) {
      return c.json({ error: "conflict", reason: "name_already_exists" }, 409);
    }
    const now = new Date().toISOString();
    const created = (await db.create(ROLES_TABLE, {
      name: body.name,
      description: typeof body.description === "string" ? body.description : null,
      permissions,
      createdAt: now,
      updatedAt: now
    })) as RoleRow;
    return c.json(created, 201);
  });

  app.get("/api/roles/:id", async (c) => {
    if (!(await authorize("admin", null))) return c.json({ error: "forbidden" }, 403);
    const id = c.req.param("id");
    const found = (await db.get(ROLES_TABLE, id)) as RoleRow | null;
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json(found);
  });

  app.patch("/api/roles/:id", async (c) => {
    if (!(await authorize("admin", null))) return c.json({ error: "forbidden" }, 403);
    const id = c.req.param("id");
    type Patch = {
      name?: unknown;
      description?: unknown;
      permissions?: unknown;
    };
    const patch = (await c.req.json().catch(() => ({}))) as Patch;
    const found = (await db.get(ROLES_TABLE, id)) as RoleRow | null;
    if (!found) return c.json({ error: "not_found" }, 404);

    const identity = readIdentity(c);
    const callerIsRoot = isRootCaller(identity);

    // Root-role guard: only root callers may edit the root role.
    if (found.name === "root" && !callerIsRoot) {
      return c.json({ error: "forbidden", reason: "root_role_protected" }, 403);
    }

    // Wildcard guard: non-root callers cannot grant wildcard permissions.
    if (
      patch.permissions !== undefined &&
      !callerIsRoot &&
      grantsFullWildcard(patch.permissions as PermissionMatrix)
    ) {
      return c.json({ error: "forbidden", reason: "wildcard_requires_root" }, 403);
    }

    if (patch.permissions !== undefined && !isPermissionMatrix(patch.permissions)) {
      return c.json({ error: "bad_request", reason: "invalid_permissions" }, 400);
    }

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (typeof patch.name === "string") updates.name = patch.name;
    if (typeof patch.description === "string") updates.description = patch.description;
    if (patch.permissions !== undefined) updates.permissions = patch.permissions;
    const updated = (await db.update(ROLES_TABLE, id, updates)) as RoleRow;
    return c.json(updated);
  });

  app.delete("/api/roles/:id", async (c) => {
    if (!(await authorize("admin", null))) return c.json({ error: "forbidden" }, 403);
    const id = c.req.param("id");
    const found = (await db.get(ROLES_TABLE, id)) as RoleRow | null;
    if (!found) return c.json({ error: "not_found" }, 404);
    if (found.name === "root") {
      return c.json({ error: "forbidden", reason: "root_role_protected" }, 403);
    }
    await db.delete(ROLES_TABLE, id);
    return c.json({ ok: true });
  });
}

function readIdentity(c: Context<HonoCMSEnv>): TokensIdentity | null {
  const v = (c as unknown as { get(key: string): unknown }).get("identity");
  return (v as TokensIdentity | undefined) ?? null;
}

function isRootCaller(identity: TokensIdentity | null): boolean {
  return identity?.namespace === "root";
}

function grantsFullWildcard(permissions: PermissionMatrix): boolean {
  if (!permissions || typeof permissions !== "object") return false;
  const wildcard = permissions["*"];
  if (!wildcard || typeof wildcard !== "object") return false;
  return wildcard["*"] === true;
}

function isPermissionMatrix(value: unknown): value is PermissionMatrix {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    for (const inner of Object.values(v as Record<string, unknown>)) {
      if (typeof inner !== "boolean") return false;
    }
  }
  return true;
}
