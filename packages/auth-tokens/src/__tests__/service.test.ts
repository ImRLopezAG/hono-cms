import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import type { CMSCollections } from "@hono-cms/schema";
import { createTokenService, API_KEYS_TABLE } from "../service/tokens";
import type { ApiKeyRow } from "../service/types";

function makeDb() {
  // The memory adapter lazily allocates tables on first access, so passing
  // an empty `collections` object is enough — `ctx.db.list("api_keys", ...)`
  // creates the bucket on demand.
  return createMemoryDatabase({ provider: "memory", collections: {} as CMSCollections });
}

function makeService() {
  const db = makeDb();
  return { db, service: createTokenService({ db }) };
}

describe("token service createToken", () => {
  it("returns { token, tokenPrefix, tokenId }; raw token starts with sk_ and is 51 chars", async () => {
    const { service } = makeService();
    const result = await service.createToken({ namespace: "root" });
    expect(result.token).toMatch(/^sk_[0-9a-f]{48}$/);
    expect(result.token.length).toBe(51);
    expect(result.tokenPrefix).toMatch(/^sk_[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/);
    expect(typeof result.tokenId).toBe("string");
  });

  it("hash in DB matches the SHA-256 of the raw token", async () => {
    const { db, service } = makeService();
    const result = await service.createToken({ namespace: "root" });
    const rows = (await db.list(API_KEYS_TABLE, { limit: 10 })).items as ApiKeyRow[];
    const row = rows.find((r) => r.id === result.tokenId);
    expect(row).toBeDefined();
    // Replicate SHA-256 hex digest here so the test is independent of
    // hashing.ts internals.
    const expected = await sha256Hex(result.token);
    expect(row?.tokenHash).toBe(expected);
  });

  it("custom prefix is honored", async () => {
    const db = makeDb();
    const service = createTokenService({ db, prefix: "tk_" });
    const result = await service.createToken({ namespace: "root" });
    expect(result.token.startsWith("tk_")).toBe(true);
  });

  it("name and metadata round-trip", async () => {
    const { db, service } = makeService();
    const { tokenId } = await service.createToken({
      namespace: "root",
      name: "ci-runner",
      metadata: { runId: "abc123" }
    });
    const row = (await db.get(API_KEYS_TABLE, tokenId)) as ApiKeyRow | null;
    expect(row?.name).toBe("ci-runner");
    expect(row?.metadata).toEqual({ runId: "abc123" });
  });
});

describe("token service validate", () => {
  it("returns ok:true with namespace/metadata/tokenId after createToken", async () => {
    const { service } = makeService();
    const { token, tokenId } = await service.createToken({
      namespace: "root",
      metadata: { tag: "v1" }
    });
    const result = await service.validate(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.namespace).toBe("root");
      expect(result.metadata).toEqual({ tag: "v1" });
      expect(result.tokenId).toBe(tokenId);
    }
  });

  it("returns invalid for an unknown token string", async () => {
    const { service } = makeService();
    const result = await service.validate("sk_not_a_real_token");
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("returns expired when the token is past expiresAt", async () => {
    const { service } = makeService();
    const { token } = await service.createToken({
      namespace: "root",
      expiresAt: Date.now() - 60_000
    });
    const result = await service.validate(token);
    expect(result).toMatchObject({ ok: false, reason: "expired", namespace: "root" });
  });

  it("returns idle_timeout when lastUsedAt is older than maxIdleMs", async () => {
    const { db, service } = makeService();
    const { token, tokenId } = await service.createToken({ namespace: "root", maxIdleMs: 1000 });
    // Rewind lastUsedAt by 1 hour.
    await db.update(API_KEYS_TABLE, tokenId, {
      lastUsedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    });
    const result = await service.validate(token);
    expect(result).toMatchObject({ ok: false, reason: "idle_timeout", namespace: "root" });
  });

  it("returns revoked for a revoked token", async () => {
    const { service } = makeService();
    const { token } = await service.createToken({ namespace: "root" });
    await service.invalidate(token);
    const result = await service.validate(token);
    expect(result).toMatchObject({ ok: false, reason: "revoked", namespace: "root" });
  });

  it("touches lastUsedAt on successful validation", async () => {
    vi.useFakeTimers();
    const { db, service } = makeService();
    const { token, tokenId } = await service.createToken({ namespace: "root" });
    const before = (await db.get(API_KEYS_TABLE, tokenId)) as ApiKeyRow;
    // Advance time so the new touch differs from the create timestamp.
    vi.advanceTimersByTime(10_000);
    await service.validate(token);
    const after = (await db.get(API_KEYS_TABLE, tokenId)) as ApiKeyRow;
    expect(new Date(after.lastUsedAt).getTime()).toBeGreaterThan(new Date(before.lastUsedAt).getTime());
    vi.useRealTimers();
  });
});

describe("token service refresh", () => {
  it("creates a new token, revokes the old, sets replacedBy", async () => {
    const { db, service } = makeService();
    const created = await service.createToken({ namespace: "root", name: "ci", metadata: { x: 1 } });
    const refreshed = await service.refresh(created.token);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;

    expect(refreshed.token).not.toBe(created.token);
    const oldRow = (await db.get(API_KEYS_TABLE, created.tokenId)) as ApiKeyRow;
    expect(oldRow.revoked).toBe(true);
    expect(oldRow.replacedBy).toBe(refreshed.tokenId);

    const newRow = (await db.get(API_KEYS_TABLE, refreshed.tokenId)) as ApiKeyRow;
    expect(newRow.revoked).toBe(false);
    expect(newRow.namespace).toBe("root");
    expect(newRow.metadata).toEqual({ x: 1 });
    expect(newRow.name).toBe("ci");
  });

  it("returns invalid for unknown token", async () => {
    const { service } = makeService();
    const result = await service.refresh("sk_bogus");
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("returns revoked for already-revoked token", async () => {
    const { service } = makeService();
    const { token } = await service.createToken({ namespace: "root" });
    await service.invalidate(token);
    const result = await service.refresh(token);
    expect(result).toEqual({ ok: false, reason: "revoked" });
  });
});

describe("token service invalidateAll", () => {
  it("revokes only matching-namespace tokens; returns the count", async () => {
    const { db, service } = makeService();
    const root1 = await service.createToken({ namespace: "root" });
    const root2 = await service.createToken({ namespace: "root" });
    const editor = await service.createToken({ namespace: "editor" });

    const count = await service.invalidateAll({ namespace: "root" });
    expect(count).toBe(2);

    const r1 = (await db.get(API_KEYS_TABLE, root1.tokenId)) as ApiKeyRow;
    const r2 = (await db.get(API_KEYS_TABLE, root2.tokenId)) as ApiKeyRow;
    const e = (await db.get(API_KEYS_TABLE, editor.tokenId)) as ApiKeyRow;
    expect(r1.revoked).toBe(true);
    expect(r2.revoked).toBe(true);
    expect(e.revoked).toBe(false);
  });

  it("invalidates all live tokens when namespace is omitted", async () => {
    const { service } = makeService();
    await service.createToken({ namespace: "root" });
    await service.createToken({ namespace: "editor" });
    const count = await service.invalidateAll({});
    expect(count).toBe(2);
  });
});

describe("token service list / touch / cleanup", () => {
  it("list returns live tokens for the namespace", async () => {
    const { service } = makeService();
    const live = await service.createToken({ namespace: "root" });
    const other = await service.createToken({ namespace: "root" });
    await service.invalidate(other.token);
    const rows = await service.list({ namespace: "root" });
    expect(rows.map((r) => r.id).sort()).toEqual([live.tokenId].sort());
  });

  it("list with includeRevoked=true returns revoked rows too", async () => {
    const { service } = makeService();
    const live = await service.createToken({ namespace: "root" });
    const dead = await service.createToken({ namespace: "root" });
    await service.invalidate(dead.token);
    const rows = await service.list({ namespace: "root", includeRevoked: true });
    expect(rows.map((r) => r.id).sort()).toEqual([live.tokenId, dead.tokenId].sort());
  });

  it("touch updates lastUsedAt without expiry/idle checks", async () => {
    vi.useFakeTimers();
    const { db, service } = makeService();
    const { token, tokenId } = await service.createToken({ namespace: "root" });
    vi.advanceTimersByTime(5_000);
    const ok = await service.touch(token);
    expect(ok).toBe(true);
    const row = (await db.get(API_KEYS_TABLE, tokenId)) as ApiKeyRow;
    expect(new Date(row.lastUsedAt).getTime()).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("invalidateById revokes the row", async () => {
    const { db, service } = makeService();
    const { tokenId } = await service.createToken({ namespace: "root" });
    const ok = await service.invalidateById(tokenId);
    expect(ok).toBe(true);
    const row = (await db.get(API_KEYS_TABLE, tokenId)) as ApiKeyRow;
    expect(row.revoked).toBe(true);
  });

  it("cleanup deletes revoked tokens older than threshold", async () => {
    const { db, service } = makeService();
    // Create a token and immediately backdate it so cleanup grabs it.
    const oldOne = await service.createToken({ namespace: "root" });
    await service.invalidate(oldOne.token);
    await db.update(API_KEYS_TABLE, oldOne.tokenId, {
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    });
    const freshOne = await service.createToken({ namespace: "root" });
    await service.invalidate(freshOne.token);
    const deleted = await service.cleanup();
    expect(deleted).toBe(1);
    const remaining = (await db.list(API_KEYS_TABLE, { limit: 10 })).items as ApiKeyRow[];
    expect(remaining.find((r) => r.id === oldOne.tokenId)).toBeUndefined();
    expect(remaining.find((r) => r.id === freshOne.tokenId)).toBeDefined();
  });

  it("cleanup deletes tokens whose expiresAt is in the past beyond threshold", async () => {
    const { db, service } = makeService();
    const { tokenId } = await service.createToken({ namespace: "root" });
    // Set expiresAt 60 days ago (default threshold is 30 days).
    await db.update(API_KEYS_TABLE, tokenId, {
      expiresAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    });
    const deleted = await service.cleanup();
    expect(deleted).toBe(1);
  });
});

beforeEach(() => {
  vi.useRealTimers();
});

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
