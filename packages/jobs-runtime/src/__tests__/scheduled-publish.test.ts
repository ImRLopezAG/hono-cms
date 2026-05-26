import { describe, expect, it, vi } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import type { CacheAdapter } from "@hono-cms/core";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { runScheduledPublish } from "../scheduled-publish";

const schema = defineSchema({
  articles: defineCollection(
    "articles",
    {
      title: fields.string({ required: true })
    },
    { draftAndPublish: true }
  )
});

describe("runScheduledPublish", () => {
  it("flips draft records with publishedAt <= now to status: 'published'", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    const due = await db.create("articles", { title: "Due", status: "draft", publishedAt: past });
    const pending = await db.create("articles", { title: "Pending", status: "draft", publishedAt: future });

    const result = await runScheduledPublish({ db, collections: schema });

    expect(result.published).toBe(1);

    const dueAfter = await db.get("articles", due.id);
    expect(dueAfter?.status).toBe("published");

    const pendingAfter = await db.get("articles", pending.id);
    expect(pendingAfter?.status).toBe("draft");
  });

  it("invalidates cache for touched collections when a cache adapter is supplied", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const past = new Date(Date.now() - 60_000).toISOString();
    await db.create("articles", { title: "Due", status: "draft", publishedAt: past });

    const set = vi.fn(async () => {});
    const cache: CacheAdapter = {
      provider: "fake",
      async get() { return null; },
      set,
      async delete() {}
    };

    const result = await runScheduledPublish({ db, collections: schema, cache });

    expect(result.published).toBe(1);
    // Cache invalidation flips the content-cache version key.
    const cacheSetCalls = set.mock.calls.filter((args) => String(args[0]).startsWith("content-cache-version:"));
    expect(cacheSetCalls.length).toBeGreaterThan(0);
  });

  it("returns 0 published when no records are due", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const future = new Date(Date.now() + 60_000).toISOString();
    await db.create("articles", { title: "Pending", status: "draft", publishedAt: future });

    const result = await runScheduledPublish({ db, collections: schema });
    expect(result.published).toBe(0);
    expect(result.records).toEqual([]);
  });

  it("is a no-op when cache is null", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const past = new Date(Date.now() - 60_000).toISOString();
    await db.create("articles", { title: "Due", status: "draft", publishedAt: past });

    const result = await runScheduledPublish({ db, collections: schema, cache: null });
    expect(result.published).toBe(1);
  });
});
