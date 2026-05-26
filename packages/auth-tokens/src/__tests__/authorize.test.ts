import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import type { CMSCollections } from "@hono-cms/schema";
import { createPluginContext } from "@hono-cms/core";
import { createAuthorize, createIdentityScope, permissionLookup } from "../authorize";
import { ROLES_TABLE } from "../tables/roles";

async function setup() {
  const db = createMemoryDatabase({ provider: "memory", collections: {} as CMSCollections });
  const now = new Date().toISOString();
  await db.create(ROLES_TABLE, {
    name: "root",
    description: null,
    permissions: { "*": { "*": true } },
    createdAt: now,
    updatedAt: now
  });
  await db.create(ROLES_TABLE, {
    name: "editor",
    description: null,
    permissions: { articles: { read: true, create: true } },
    createdAt: now,
    updatedAt: now
  });
  await db.create(ROLES_TABLE, {
    name: "reader-all",
    description: null,
    permissions: { "*": { read: true } },
    createdAt: now,
    updatedAt: now
  });
  await db.create(ROLES_TABLE, {
    name: "comment-master",
    description: null,
    permissions: { comments: { "*": true } },
    createdAt: now,
    updatedAt: now
  });
  const scope = createIdentityScope();
  const ctx = createPluginContext({ collections: {} as CMSCollections, db });
  const authorize = createAuthorize({ ctx, scope });
  return { authorize, scope };
}

describe("permissionLookup precedence", () => {
  it("(1) exact match wins", () => {
    expect(permissionLookup({ articles: { read: true } }, "articles", "read")).toBe(true);
    expect(permissionLookup({ articles: { read: false } }, "articles", "read")).toBe(false);
  });

  it("(2) '*' collection + exact action", () => {
    expect(permissionLookup({ "*": { read: true } }, "articles", "read")).toBe(true);
  });

  it("(3) exact collection + '*' action", () => {
    expect(permissionLookup({ articles: { "*": true } }, "articles", "delete")).toBe(true);
  });

  it("(4) full wildcard *:*", () => {
    expect(permissionLookup({ "*": { "*": true } }, "any", "any")).toBe(true);
  });

  it("(5) explicit false → false", () => {
    expect(permissionLookup({}, "articles", "read")).toBe(false);
  });

  it("exact collection wins over '*'", () => {
    // Note: ?? short-circuits on `false`, so an explicit `false` overrides
    // wildcard fallbacks for the same (collection, action) pair.
    expect(permissionLookup({ articles: { read: false }, "*": { read: true } }, "articles", "read")).toBe(false);
  });
});

describe("createAuthorize end-to-end", () => {
  it("root identity → returns true for any (action, collection)", async () => {
    const { authorize, scope } = await setup();
    await scope.run({ subjectId: "x", namespace: "root", metadata: null }, async () => {
      expect(await authorize("read", "articles")).toBe(true);
      expect(await authorize("delete", "anything")).toBe(true);
      expect(await authorize("admin", null)).toBe(true);
    });
  });

  it("editor identity → read/create articles true; delete false", async () => {
    const { authorize, scope } = await setup();
    await scope.run({ subjectId: "x", namespace: "editor", metadata: null }, async () => {
      expect(await authorize("read", "articles")).toBe(true);
      expect(await authorize("create", "articles")).toBe(true);
      expect(await authorize("delete", "articles")).toBe(false);
      expect(await authorize("read", "comments")).toBe(false);
    });
  });

  it("identity with no matching role → returns false", async () => {
    const { authorize, scope } = await setup();
    await scope.run({ subjectId: "x", namespace: "ghost", metadata: null }, async () => {
      expect(await authorize("read", "articles")).toBe(false);
    });
  });

  it("identity null (anonymous) → returns false", async () => {
    const { authorize } = await setup();
    // No scope.run wrapping — scope.current() returns null.
    expect(await authorize("read", "articles")).toBe(false);
  });

  it("wildcard '*' collection role grants the action on any collection", async () => {
    const { authorize, scope } = await setup();
    await scope.run({ subjectId: "x", namespace: "reader-all", metadata: null }, async () => {
      expect(await authorize("read", "articles")).toBe(true);
      expect(await authorize("read", "comments")).toBe(true);
      expect(await authorize("read", "anything")).toBe(true);
      expect(await authorize("delete", "articles")).toBe(false);
    });
  });

  it("wildcard '*' action role grants any action on the matched collection", async () => {
    const { authorize, scope } = await setup();
    await scope.run({ subjectId: "x", namespace: "comment-master", metadata: null }, async () => {
      expect(await authorize("read", "comments")).toBe(true);
      expect(await authorize("delete", "comments")).toBe(true);
      expect(await authorize("read", "articles")).toBe(false);
    });
  });
});
