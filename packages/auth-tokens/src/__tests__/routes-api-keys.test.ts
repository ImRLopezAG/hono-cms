import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import type { CMSCollections } from "@hono-cms/schema";
import { createIdentityScope, createAuthorize } from "../authorize";
import { createPluginContext } from "@hono-cms/core";
import { createTokenService, API_KEYS_TABLE } from "../service/tokens";
import { createProtectedMiddleware } from "../protected";
import { mountApiKeyRoutes } from "../routes/api-keys";
import { ROLES_TABLE } from "../tables/roles";
import type { HonoCMSEnv } from "@hono-cms/core";

async function setup() {
  const db = createMemoryDatabase({ provider: "memory", collections: {} as CMSCollections });
  const service = createTokenService({ db });
  const scope = createIdentityScope();

  // Seed a root role + an admin token + a non-admin token.
  const now = new Date().toISOString();
  await db.create(ROLES_TABLE, {
    name: "root",
    description: null,
    permissions: { "*": { "*": true } },
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

  const root = await service.createToken({ namespace: "root", name: "admin-key" });
  const viewer = await service.createToken({ namespace: "viewer", name: "viewer-key" });

  const ctx = createPluginContext({ collections: {} as CMSCollections, db });
  const authorize = createAuthorize({ ctx, scope });

  const app = new Hono<HonoCMSEnv>();
  app.use("*", createProtectedMiddleware({ service, scope }));
  mountApiKeyRoutes({ app, db, service, authorize });

  return { app, db, service, root, viewer };
}

describe("api-keys routes", () => {
  it("GET /api/api-keys returns 401 without auth", async () => {
    const { app } = await setup();
    const res = await app.fetch(new Request("http://x/api/api-keys?namespace=root"));
    expect(res.status).toBe(401);
  });

  it("GET /api/api-keys returns 403 for non-admin caller", async () => {
    const { app, viewer } = await setup();
    const res = await app.fetch(new Request("http://x/api/api-keys?namespace=viewer", {
      headers: { Authorization: `Bearer ${viewer.token}` }
    }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("GET /api/api-keys with admin token returns list without tokenHash", async () => {
    const { app, root } = await setup();
    const res = await app.fetch(new Request("http://x/api/api-keys?namespace=root", {
      headers: { Authorization: `Bearer ${root.token}` }
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ tokenHash?: string; id: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).not.toHaveProperty("tokenHash");
    expect(body.items[0]?.id).toBe(root.tokenId);
  });

  it("POST /api/api-keys returns the secret once; subsequent GETs do not", async () => {
    const { app, root } = await setup();
    const create = await app.fetch(new Request("http://x/api/api-keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${root.token}`, "content-type": "application/json" },
      body: JSON.stringify({ namespace: "ci-runner", name: "build-bot" })
    }));
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string; secret: string; tokenPrefix: string };
    expect(created.secret).toMatch(/^sk_[0-9a-f]{48}$/);
    expect(created.tokenPrefix).toMatch(/^sk_.{4}\.\.\..{4}$/);

    // GET single key — secret should not be present in the response.
    const get = await app.fetch(new Request(`http://x/api/api-keys/${created.id}`, {
      headers: { Authorization: `Bearer ${root.token}` }
    }));
    expect(get.status).toBe(200);
    const fetched = (await get.json()) as Record<string, unknown>;
    expect(fetched).not.toHaveProperty("secret");
    expect(fetched).not.toHaveProperty("tokenHash");
  });

  it("POST /api/api-keys without namespace returns 400", async () => {
    const { app, root } = await setup();
    const res = await app.fetch(new Request("http://x/api/api-keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${root.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "no-namespace" })
    }));
    expect(res.status).toBe(400);
  });

  it("DELETE /api/api-keys/:id revokes the token (soft-delete)", async () => {
    const { app, db, root } = await setup();
    const created = await app.fetch(new Request("http://x/api/api-keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${root.token}`, "content-type": "application/json" },
      body: JSON.stringify({ namespace: "ci-runner" })
    }));
    const body = (await created.json()) as { id: string };

    const del = await app.fetch(new Request(`http://x/api/api-keys/${body.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${root.token}` }
    }));
    expect(del.status).toBe(200);

    // Row still exists; revoked flag set.
    const row = (await db.get(API_KEYS_TABLE, body.id)) as { revoked: boolean } | null;
    expect(row?.revoked).toBe(true);
  });

  it("PATCH /api/api-keys/:id updates name and metadata", async () => {
    const { app, root } = await setup();
    const created = await app.fetch(new Request("http://x/api/api-keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${root.token}`, "content-type": "application/json" },
      body: JSON.stringify({ namespace: "ci-runner", name: "old" })
    }));
    const body = (await created.json()) as { id: string };

    const patch = await app.fetch(new Request(`http://x/api/api-keys/${body.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${root.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "new", metadata: { rotated: true } })
    }));
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { name: string; metadata: Record<string, unknown> };
    expect(patched.name).toBe("new");
    expect(patched.metadata).toEqual({ rotated: true });
  });

  it("DELETE /api/api-keys/:id on unknown id returns 404", async () => {
    const { app, root } = await setup();
    const res = await app.fetch(new Request("http://x/api/api-keys/does-not-exist", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${root.token}` }
    }));
    expect(res.status).toBe(404);
  });
});
