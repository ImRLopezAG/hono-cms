import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import type { TranslationProvider } from "@hono-cms/core";
import { MemoryTranslationStore } from "../store/memory";
import { translateDocument } from "../translate";

const schema = defineSchema({
  pages: defineCollection(
    "pages",
    {
      title: fields.string({ required: true }),
      body: fields.text()
    },
    { i18n: { locales: ["en", "es", "es-MX"], defaultLocale: "en" } }
  ),
  articles: defineCollection("articles", { title: fields.string({ required: true }) })
});

function stubProvider(
  translate: TranslationProvider["translate"] = async ({ fields }) =>
    Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, `[es] ${value}`]))
): TranslationProvider {
  return {
    provider: "test-provider",
    translate
  };
}

async function bootstrap() {
  const db = createMemoryDatabase({ provider: "memory", collections: schema });
  const store = new MemoryTranslationStore();
  const created = await db.create("pages", {
    title: "Hello",
    body: "World",
    locale: "en"
  });
  return { db, store, recordId: created.id };
}

describe("translateDocument", () => {
  it("returns 400 i18n_not_enabled for non-localized collections", async () => {
    const { db, store } = await bootstrap();
    const result = await translateDocument({
      collections: schema,
      db,
      store,
      provider: stubProvider(),
      collectionName: "articles",
      documentId: "missing",
      targetLocale: "es"
    });
    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "i18n_not_enabled" });
  });

  it("returns 422 unsupported_locale when targetLocale isn't configured", async () => {
    const { db, store, recordId } = await bootstrap();
    const result = await translateDocument({
      collections: schema,
      db,
      store,
      provider: stubProvider(),
      collectionName: "pages",
      documentId: recordId,
      targetLocale: "fr"
    });
    const res = result as Response;
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ error: "unsupported_locale" });
  });

  it("returns 422 when target equals source locale", async () => {
    const { db, store, recordId } = await bootstrap();
    const result = await translateDocument({
      collections: schema,
      db,
      store,
      provider: stubProvider(),
      collectionName: "pages",
      documentId: recordId,
      targetLocale: "en"
    });
    const res = result as Response;
    expect(res.status).toBe(422);
  });

  it("returns 404 when the source document doesn't exist", async () => {
    const { db, store } = await bootstrap();
    const result = await translateDocument({
      collections: schema,
      db,
      store,
      provider: stubProvider(),
      collectionName: "pages",
      documentId: "does-not-exist",
      targetLocale: "es"
    });
    const res = result as Response;
    expect(res.status).toBe(404);
  });

  it("persists a complete variant when the provider succeeds", async () => {
    const { db, store, recordId } = await bootstrap();
    const provider = stubProvider();
    const result = await translateDocument({
      collections: schema,
      db,
      store,
      provider,
      collectionName: "pages",
      documentId: recordId,
      targetLocale: "es"
    });
    expect(result).not.toBeInstanceOf(Response);
    const variant = result as Awaited<ReturnType<typeof translateDocument>> & { status?: string };
    expect((variant as any).status).toBe("complete");
    expect((variant as any).fields).toMatchObject({ title: "[es] Hello" });

    const stored = await store.getVariant("pages", recordId, "es");
    expect(stored?.status).toBe("complete");
    expect(stored?.translatedBy).toBe("ai");
    expect(stored?.provider).toBe("test-provider");
  });

  it("persists an error variant when the provider throws", async () => {
    const { db, store, recordId } = await bootstrap();
    const provider = stubProvider(async () => {
      throw new Error("provider exploded");
    });
    const result = await translateDocument({
      collections: schema,
      db,
      store,
      provider,
      collectionName: "pages",
      documentId: recordId,
      targetLocale: "es"
    });
    const variant = result as any;
    expect(variant.status).toBe("error");
    expect(variant.error).toContain("provider exploded");

    const stored = await store.getVariant("pages", recordId, "es");
    expect(stored?.status).toBe("error");
  });

  it("only sends localizable string fields to the provider", async () => {
    const { db, store, recordId } = await bootstrap();
    let received: Record<string, string> | null = null;
    const provider: TranslationProvider = {
      provider: "spy",
      async translate(input) {
        received = input.fields;
        return Object.fromEntries(Object.entries(input.fields).map(([k, v]) => [k, `[es] ${v}`]));
      }
    };
    await translateDocument({
      collections: schema,
      db,
      store,
      provider,
      collectionName: "pages",
      documentId: recordId,
      targetLocale: "es"
    });
    expect(received).toMatchObject({ title: "Hello", body: "World" });
    expect(received).not.toHaveProperty("locale");
  });
});
