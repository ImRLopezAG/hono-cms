import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import type { CMSCollections } from "@hono-cms/schema";
import {
  createPluginContext,
  installPlugins,
  mergeSchemas,
  type HonoCMSEnv
} from "@hono-cms/core";
import { tokensAuth, TOKENS_AUTH_ID } from "../plugin";
import type { TokensAuthService } from "../plugin";
import { ROLES_TABLE, type RoleRow } from "../tables/roles";
import { API_KEYS_TABLE } from "../service/tokens";
import type { ApiKeyRow } from "../service/types";

let tmpDir: string;
let savedCwd: () => string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cms-tokens-integration-"));
  savedCwd = process.cwd;
  process.cwd = () => tmpDir;
});

afterEach(() => {
  process.cwd = savedCwd;
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("tokensAuth plugin — schema declaration", () => {
  it("declares both api_keys and roles tables via Plugin.schema", () => {
    const plugin = tokensAuth({});
    const merged = mergeSchemas([plugin]);
    expect(Array.from(merged.keys()).sort()).toEqual([API_KEYS_TABLE, ROLES_TABLE].sort());
    expect(merged.get(API_KEYS_TABLE)?.fields).toHaveProperty("tokenHash");
    expect(merged.get(API_KEYS_TABLE)?.fields).toHaveProperty("namespace");
    expect(merged.get(ROLES_TABLE)?.fields).toHaveProperty("permissions");
  });

  it("plugin id is exposed as TOKENS_AUTH_ID = 'auth-tokens'", () => {
    expect(TOKENS_AUTH_ID).toBe("auth-tokens");
    expect(tokensAuth({}).id).toBe("auth-tokens");
  });
});

describe("tokensAuth plugin — full install via installPlugins", () => {
  it("install creates the bootstrap key, file, and root role; exposes the service", async () => {
    const db = createMemoryDatabase({
      provider: "memory",
      collections: {} as CMSCollections
    });
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext({
      collections: {} as CMSCollections,
      db,
      env: {}
    });

    const plugin = tokensAuth({});
    await installPlugins([plugin], app, ctx);

    // Bootstrap key file written.
    expect(existsSync(join(tmpDir, ".cms-bootstrap-key"))).toBe(true);

    // Root role seeded.
    const rolesResult = await db.list(ROLES_TABLE, { filters: { name: "root" }, limit: 1 });
    expect(rolesResult.items.length).toBe(1);

    // Service registered.
    const registered = ctx.plugins.get<TokensAuthService & { bootstrap: { kind: string; key?: string } }>(TOKENS_AUTH_ID);
    expect(registered.service).toBeDefined();
    expect(registered.bootstrap.kind).toBe("generated");
    expect(typeof registered.bootstrap.key).toBe("string");
  });

  it("hitting GET /api/api-keys with the bootstrap key returns 200 + list", async () => {
    const db = createMemoryDatabase({
      provider: "memory",
      collections: {} as CMSCollections
    });
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext({ collections: {} as CMSCollections, db, env: {} });
    await installPlugins([tokensAuth({})], app, ctx);

    const registered = ctx.plugins.get<TokensAuthService & { bootstrap: { key?: string } }>(TOKENS_AUTH_ID);
    const bootstrapKey = registered.bootstrap.key as string;
    expect(bootstrapKey).toBeDefined();

    const res = await app.fetch(new Request("http://x/api/api-keys?namespace=root", {
      headers: { Authorization: `Bearer ${bootstrapKey}` }
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: ApiKeyRow[] };
    expect(body.items.length).toBe(1); // the bootstrap key row itself
  });

  it("POST /api/api-keys with the bootstrap key issues a second key in the caller-supplied namespace", async () => {
    const db = createMemoryDatabase({
      provider: "memory",
      collections: {} as CMSCollections
    });
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext({ collections: {} as CMSCollections, db, env: {} });
    await installPlugins([tokensAuth({})], app, ctx);

    const registered = ctx.plugins.get<TokensAuthService & { bootstrap: { key?: string } }>(TOKENS_AUTH_ID);
    const bootstrapKey = registered.bootstrap.key as string;

    const create = await app.fetch(new Request("http://x/api/api-keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${bootstrapKey}`, "content-type": "application/json" },
      body: JSON.stringify({ namespace: "ci", name: "build-bot" })
    }));
    expect(create.status).toBe(201);
    const body = (await create.json()) as { id: string; namespace: string; secret: string };
    expect(body.namespace).toBe("ci");
    expect(body.secret).toMatch(/^sk_/);
  });

  it("bootstrap-tagged key passes authorize('admin', null) by virtue of the root role", async () => {
    const db = createMemoryDatabase({
      provider: "memory",
      collections: {} as CMSCollections
    });
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext({ collections: {} as CMSCollections, db, env: {} });
    await installPlugins([tokensAuth({})], app, ctx);

    const registered = ctx.plugins.get<TokensAuthService & { bootstrap: { key?: string } }>(TOKENS_AUTH_ID);
    const bootstrapKey = registered.bootstrap.key as string;

    // GET /api/roles is admin-gated; hitting it with the bootstrap key
    // exercises both the protected middleware and the role-based authorize.
    const res = await app.fetch(new Request("http://x/api/roles", {
      headers: { Authorization: `Bearer ${bootstrapKey}` }
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: RoleRow[] };
    expect(body.items.find((r) => r.name === "root")).toBeDefined();
  });

  it("PATCH role permissions reflects in subsequent authorize() decisions (no stale cache)", async () => {
    const db = createMemoryDatabase({
      provider: "memory",
      collections: {} as CMSCollections
    });
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext({ collections: {} as CMSCollections, db, env: {} });
    await installPlugins([tokensAuth({})], app, ctx);

    const registered = ctx.plugins.get<TokensAuthService & { bootstrap: { key?: string } }>(TOKENS_AUTH_ID);
    const bootstrapKey = registered.bootstrap.key as string;

    // Create a "writer" role with `articles.read = true` only.
    await app.fetch(new Request("http://x/api/roles", {
      method: "POST",
      headers: { Authorization: `Bearer ${bootstrapKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "writer",
        permissions: { "*": { read: true, admin: true } }
      })
    }));

    // Mint a writer token (we control the API as root).
    const minted = await app.fetch(new Request("http://x/api/api-keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${bootstrapKey}`, "content-type": "application/json" },
      body: JSON.stringify({ namespace: "writer", name: "writer-1" })
    }));
    const mintedBody = (await minted.json()) as { secret: string };
    const writerKey = mintedBody.secret;

    // Writer can list api-keys (admin: true on "*").
    const list1 = await app.fetch(new Request("http://x/api/api-keys?namespace=writer", {
      headers: { Authorization: `Bearer ${writerKey}` }
    }));
    expect(list1.status).toBe(200);

    // Strip admin permission from the role.
    const writerRole = (
      await db.list(ROLES_TABLE, { filters: { name: "writer" }, limit: 1 })
    ).items[0] as RoleRow;
    await app.fetch(new Request(`http://x/api/roles/${writerRole.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${bootstrapKey}`, "content-type": "application/json" },
      body: JSON.stringify({ permissions: { "*": { read: true } } })
    }));

    // Now the writer token must be denied.
    const list2 = await app.fetch(new Request("http://x/api/api-keys?namespace=writer", {
      headers: { Authorization: `Bearer ${writerKey}` }
    }));
    expect(list2.status).toBe(403);
  });

  it("invalid token returns 401 even after install", async () => {
    const db = createMemoryDatabase({
      provider: "memory",
      collections: {} as CMSCollections
    });
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext({ collections: {} as CMSCollections, db, env: {} });
    await installPlugins([tokensAuth({})], app, ctx);

    const res = await app.fetch(new Request("http://x/api/api-keys?namespace=root", {
      headers: { Authorization: "Bearer sk_nope" }
    }));
    expect(res.status).toBe(401);
  });

  it("install passes capability validation (no requiresAdapter currently)", async () => {
    const db = createMemoryDatabase({
      provider: "memory",
      collections: {} as CMSCollections
    });
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext({ collections: {} as CMSCollections, db });
    await expect(installPlugins([tokensAuth({})], app, ctx)).resolves.toBeTruthy();
  });
});

describe("tokensAuth plugin — authorize wildcard precedence", () => {
  it("wildcard '*' collection applies to all collections", async () => {
    const db = createMemoryDatabase({
      provider: "memory",
      collections: {} as CMSCollections
    });
    const app = new Hono<HonoCMSEnv>();
    const ctx = createPluginContext({ collections: {} as CMSCollections, db, env: {} });
    await installPlugins([tokensAuth({})], app, ctx);

    const registered = ctx.plugins.get<TokensAuthService & { bootstrap: { key?: string } }>(TOKENS_AUTH_ID);
    const bootstrapKey = registered.bootstrap.key as string;

    // Create role with wildcard collection, action: read
    await app.fetch(new Request("http://x/api/roles", {
      method: "POST",
      headers: { Authorization: `Bearer ${bootstrapKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "reader",
        permissions: { "*": { read: true } }
      })
    }));
    const reader = await app.fetch(new Request("http://x/api/api-keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${bootstrapKey}`, "content-type": "application/json" },
      body: JSON.stringify({ namespace: "reader" })
    }));
    const readerBody = (await reader.json()) as { secret: string };

    // Reader cannot list api-keys (no admin permission).
    const denied = await app.fetch(new Request("http://x/api/api-keys?namespace=reader", {
      headers: { Authorization: `Bearer ${readerBody.secret}` }
    }));
    expect(denied.status).toBe(403);
  });
});
