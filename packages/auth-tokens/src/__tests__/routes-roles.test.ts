import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import type { CMSCollections } from "@hono-cms/schema";
import { createPluginContext } from "@hono-cms/core";
import type { HonoCMSEnv } from "@hono-cms/core";
import { createAuthorize, createIdentityScope } from "../authorize";
import { createTokenService } from "../service/tokens";
import { createProtectedMiddleware } from "../protected";
import { mountRoleRoutes } from "../routes/roles";
import { ROLES_TABLE, type RoleRow } from "../tables/roles";

async function setup() {
  const db = createMemoryDatabase({ provider: "memory", collections: {} as CMSCollections });
  const service = createTokenService({ db });
  const scope = createIdentityScope();

  // Seed root + editor role + admin role (admin can manage roles but is not root).
  const now = new Date().toISOString();
  await db.create(ROLES_TABLE, {
    name: "root",
    description: null,
    permissions: { "*": { "*": true } },
    createdAt: now,
    updatedAt: now
  });
  await db.create(ROLES_TABLE, {
    name: "admin",
    description: null,
    // Admin can manage roles (admin permission) but cannot do everything.
    permissions: { "*": { admin: true, read: true } },
    createdAt: now,
    updatedAt: now
  });
  await db.create(ROLES_TABLE, {
    name: "viewer",
    description: null,
    permissions: { "*": { read: true } },
    createdAt: now,
    updatedAt: now
  });

  const root = await service.createToken({ namespace: "root" });
  const admin = await service.createToken({ namespace: "admin" });
  const viewer = await service.createToken({ namespace: "viewer" });

  const ctx = createPluginContext({ collections: {} as CMSCollections, db });
  const authorize = createAuthorize({ ctx, scope });

  const app = new Hono<HonoCMSEnv>();
  app.use("*", createProtectedMiddleware({ service, scope }));
  mountRoleRoutes({ app, db, authorize });

  return { app, db, root, admin, viewer };
}

describe("roles routes", () => {
  it("GET /api/roles returns 403 for non-admin token", async () => {
    const { app, viewer } = await setup();
    const res = await app.fetch(new Request("http://x/api/roles", {
      headers: { Authorization: `Bearer ${viewer.token}` }
    }));
    expect(res.status).toBe(403);
  });

  it("GET /api/roles returns 200 for admin token", async () => {
    const { app, admin } = await setup();
    const res = await app.fetch(new Request("http://x/api/roles", {
      headers: { Authorization: `Bearer ${admin.token}` }
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: RoleRow[] };
    expect(body.items.length).toBeGreaterThanOrEqual(3);
  });

  it("POST /api/roles with valid body creates a role", async () => {
    const { app, root } = await setup();
    const res = await app.fetch(new Request("http://x/api/roles", {
      method: "POST",
      headers: { Authorization: `Bearer ${root.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "editor",
        permissions: { articles: { read: true, create: true } }
      })
    }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as RoleRow;
    expect(body.name).toBe("editor");
    expect(body.permissions).toEqual({ articles: { read: true, create: true } });
  });

  it("POST /api/roles with duplicate name returns 409", async () => {
    const { app, root } = await setup();
    // "root" already exists.
    const res = await app.fetch(new Request("http://x/api/roles", {
      method: "POST",
      headers: { Authorization: `Bearer ${root.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "root", permissions: {} })
    }));
    expect(res.status).toBe(409);
  });

  it("POST /api/roles without name returns 400", async () => {
    const { app, root } = await setup();
    const res = await app.fetch(new Request("http://x/api/roles", {
      method: "POST",
      headers: { Authorization: `Bearer ${root.token}`, "content-type": "application/json" },
      body: JSON.stringify({ permissions: {} })
    }));
    expect(res.status).toBe(400);
  });

  it("PATCH /api/roles/:id editing the root role with non-root token returns 403", async () => {
    const { app, db, admin } = await setup();
    const roles = (await db.list(ROLES_TABLE, { filters: { name: "root" }, limit: 1 })).items;
    const rootRoleId = roles[0]?.id ?? "";

    const res = await app.fetch(new Request(`http://x/api/roles/${rootRoleId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ description: "tampered" })
    }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("root_role_protected");
  });

  it("PATCH /api/roles/:id granting *:* with non-root token returns 403", async () => {
    const { app, db, admin, root } = await setup();
    // Create a fresh role as root so we have an id to patch.
    await app.fetch(new Request("http://x/api/roles", {
      method: "POST",
      headers: { Authorization: `Bearer ${root.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "writer", permissions: { articles: { create: true } } })
    }));
    const writerId = (
      (await db.list(ROLES_TABLE, { filters: { name: "writer" }, limit: 1 })).items[0] as RoleRow
    )?.id ?? "";

    // Now try to escalate via admin.
    const res = await app.fetch(new Request(`http://x/api/roles/${writerId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ permissions: { "*": { "*": true } } })
    }));
    expect(res.status).toBe(403);
    expect((await res.json() as { reason: string }).reason).toBe("wildcard_requires_root");
  });

  it("PATCH /api/roles/:id editing root role with ROOT token succeeds", async () => {
    const { app, db, root } = await setup();
    const rootRole = (
      await db.list(ROLES_TABLE, { filters: { name: "root" }, limit: 1 })
    ).items[0] as RoleRow;
    const res = await app.fetch(new Request(`http://x/api/roles/${rootRole.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${root.token}`, "content-type": "application/json" },
      body: JSON.stringify({ description: "root role" })
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RoleRow;
    expect(body.description).toBe("root role");
  });

  it("DELETE /api/roles/:id on root returns 403 (cannot delete root)", async () => {
    const { app, db, root } = await setup();
    const rootRole = (
      await db.list(ROLES_TABLE, { filters: { name: "root" }, limit: 1 })
    ).items[0] as RoleRow;
    const res = await app.fetch(new Request(`http://x/api/roles/${rootRole.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${root.token}` }
    }));
    expect(res.status).toBe(403);
  });

  it("DELETE /api/roles/:id on a regular role succeeds", async () => {
    const { app, db, root } = await setup();
    await app.fetch(new Request("http://x/api/roles", {
      method: "POST",
      headers: { Authorization: `Bearer ${root.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "ephemeral", permissions: {} })
    }));
    const eph = (await db.list(ROLES_TABLE, { filters: { name: "ephemeral" }, limit: 1 })).items[0] as RoleRow;
    const res = await app.fetch(new Request(`http://x/api/roles/${eph.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${root.token}` }
    }));
    expect(res.status).toBe(200);
    expect((await db.list(ROLES_TABLE, { filters: { name: "ephemeral" }, limit: 1 })).items.length).toBe(0);
  });

  it("GET /api/roles/:id returns the role", async () => {
    const { app, db, root } = await setup();
    const rootRole = (
      await db.list(ROLES_TABLE, { filters: { name: "root" }, limit: 1 })
    ).items[0] as RoleRow;
    const res = await app.fetch(new Request(`http://x/api/roles/${rootRole.id}`, {
      headers: { Authorization: `Bearer ${root.token}` }
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RoleRow;
    expect(body.name).toBe("root");
  });
});
