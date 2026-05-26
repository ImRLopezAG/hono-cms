import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import type { CMSCollections } from "@hono-cms/schema";
import { createTokenService, API_KEYS_TABLE } from "../service/tokens";
import { createIdentityScope } from "../authorize";
import { createProtectedMiddleware } from "../protected";
import type { ApiKeyRow } from "../service/types";

function setup() {
  const db = createMemoryDatabase({ provider: "memory", collections: {} as CMSCollections });
  const service = createTokenService({ db });
  const scope = createIdentityScope();
  const middleware = createProtectedMiddleware({ service, scope });

  const app = new Hono();
  app.use("*", middleware);
  app.get("/whoami", (c) => {
    const identity = (c as unknown as { get(k: string): unknown }).get("identity");
    return c.json({ identity });
  });
  return { app, db, service, scope };
}

describe("protected middleware", () => {
  it("populates ctx.var.identity for a valid Bearer token", async () => {
    const { app, service } = setup();
    const { token, tokenId } = await service.createToken({
      namespace: "root",
      metadata: { source: "test" }
    });
    const res = await app.fetch(new Request("http://x/whoami", {
      headers: { Authorization: `Bearer ${token}` }
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: { subjectId: string; namespace: string; metadata: unknown } };
    expect(body.identity).toEqual({
      subjectId: tokenId,
      namespace: "root",
      metadata: { source: "test" }
    });
  });

  it("accepts X-Api-Key as a fallback header", async () => {
    const { app, service } = setup();
    const { token } = await service.createToken({ namespace: "editor" });
    const res = await app.fetch(new Request("http://x/whoami", {
      headers: { "X-Api-Key": token }
    }));
    expect(res.status).toBe(200);
  });

  it("touches lastUsedAt on successful auth", async () => {
    const { app, db, service } = setup();
    const { token, tokenId } = await service.createToken({ namespace: "root" });
    const before = (await db.get(API_KEYS_TABLE, tokenId)) as ApiKeyRow;
    // Wait one ms so the touch produces a strictly-later timestamp.
    await new Promise((r) => setTimeout(r, 5));
    await app.fetch(new Request("http://x/whoami", {
      headers: { Authorization: `Bearer ${token}` }
    }));
    const after = (await db.get(API_KEYS_TABLE, tokenId)) as ApiKeyRow;
    expect(new Date(after.lastUsedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before.lastUsedAt).getTime()
    );
  });

  it("returns 401 with { error: unauthorized } when no token is supplied", async () => {
    const { app } = setup();
    const res = await app.fetch(new Request("http://x/whoami"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 with reason: invalid for unknown token", async () => {
    const { app } = setup();
    const res = await app.fetch(new Request("http://x/whoami", {
      headers: { Authorization: "Bearer sk_unknown" }
    }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", reason: "invalid" });
  });

  it("returns 401 with reason: expired for an expired token", async () => {
    const { app, service } = setup();
    const { token } = await service.createToken({
      namespace: "root",
      expiresAt: Date.now() - 60_000
    });
    const res = await app.fetch(new Request("http://x/whoami", {
      headers: { Authorization: `Bearer ${token}` }
    }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", reason: "expired" });
  });

  it("returns 401 with reason: revoked for a revoked token", async () => {
    const { app, service } = setup();
    const { token } = await service.createToken({ namespace: "root" });
    await service.invalidate(token);
    const res = await app.fetch(new Request("http://x/whoami", {
      headers: { Authorization: `Bearer ${token}` }
    }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", reason: "revoked" });
  });

  it("scope.current() is populated during request handling", async () => {
    const { service, scope } = setup();
    const { token } = await service.createToken({ namespace: "root" });

    // Build a fresh app that asserts scope.current() inside the handler.
    const app = new Hono();
    app.use("*", createProtectedMiddleware({ service, scope }));
    app.get("/scope", (c) => {
      const fromScope = scope.current();
      return c.json({ namespace: fromScope?.namespace });
    });
    const res = await app.fetch(new Request("http://x/scope", {
      headers: { Authorization: `Bearer ${token}` }
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { namespace: string };
    expect(body.namespace).toBe("root");
  });

  it("scope.current() reverts to null after the request completes", async () => {
    const { app, scope, service } = setup();
    const { token } = await service.createToken({ namespace: "root" });
    await app.fetch(new Request("http://x/whoami", {
      headers: { Authorization: `Bearer ${token}` }
    }));
    expect(scope.current()).toBeNull();
  });
});
