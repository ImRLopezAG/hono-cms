import { describe, expect, it, vi } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { createEventBus } from "@hono-cms/core";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { publishDocument, unpublishDocument } from "../publish";

const schema = defineSchema({
  articles: defineCollection(
    "articles",
    {
      title: fields.string({ required: true })
    },
    { draftAndPublish: true }
  )
});

describe("publishDocument", () => {
  it("flips a draft record to status: 'published' and stamps publishedAt", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const events = createEventBus();
    const created = await db.create("articles", { title: "T", status: "draft" });

    const record = await publishDocument({
      db,
      events,
      collection: "articles",
      id: created.id
    });

    expect(record.status).toBe("published");
    expect(record.publishedAt).toBeTypeOf("string");
  });

  it("emits content:after-publish with the promoted record", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const events = createEventBus();
    const listener = vi.fn();
    events.on("content:after-publish", listener);

    const created = await db.create("articles", { title: "T", status: "draft" });
    await publishDocument({
      db,
      events,
      collection: "articles",
      id: created.id,
      identity: { userId: "u1", roles: ["editor"] }
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const payload = listener.mock.calls[0]![0] as {
      collection: string;
      record: { id: string; status: string };
      identity: { userId: string };
    };
    expect(payload.collection).toBe("articles");
    expect(payload.record.id).toBe(created.id);
    expect(payload.record.status).toBe("published");
    expect(payload.identity.userId).toBe("u1");
  });

  it("is idempotent for already-published records (no extra publishedAt change)", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const events = createEventBus();
    const created = await db.create("articles", {
      title: "T",
      status: "published",
      publishedAt: "2026-01-01T00:00:00.000Z"
    });

    const record = await publishDocument({
      db,
      events,
      collection: "articles",
      id: created.id
    });

    expect(record.status).toBe("published");
    expect(record.publishedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("throws when the document does not exist", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const events = createEventBus();
    await expect(
      publishDocument({ db, events, collection: "articles", id: "missing" })
    ).rejects.toThrow(/was not found/);
  });
});

describe("unpublishDocument", () => {
  it("reverts a published record to draft and clears publishedAt", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const events = createEventBus();
    const created = await db.create("articles", {
      title: "T",
      status: "published",
      publishedAt: new Date().toISOString()
    });

    const record = await unpublishDocument({
      db,
      events,
      collection: "articles",
      id: created.id
    });

    expect(record.status).toBe("draft");
    expect(record.publishedAt).toBeNull();
  });

  it("emits content:after-unpublish with the reverted record", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: schema });
    const events = createEventBus();
    const listener = vi.fn();
    events.on("content:after-unpublish", listener);

    const created = await db.create("articles", {
      title: "T",
      status: "published",
      publishedAt: new Date().toISOString()
    });
    await unpublishDocument({
      db,
      events,
      collection: "articles",
      id: created.id
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const payload = listener.mock.calls[0]![0] as { collection: string; record: { id: string } };
    expect(payload.collection).toBe("articles");
    expect(payload.record.id).toBe(created.id);
  });
});
