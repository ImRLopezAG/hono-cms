import { describe, expect, it } from "vitest";
import { defineCollection, fields } from "@hono-cms/schema";
import type { ContentRecord, LocaleVariant, TranslationStore } from "@hono-cms/core";
import {
  getLocaleVariantWithFallback,
  localeFallbackChain,
  localizableFieldNames,
  overlayLocaleVariant,
  overlayLocaleVariants
} from "../overlay";
import { MemoryTranslationStore } from "../store/memory";

const pages = defineCollection(
  "pages",
  {
    title: fields.string({ required: true }),
    body: fields.text(),
    slug: fields.string({ localized: false }),
    apiKey: fields.string({ private: true })
  },
  { i18n: { locales: ["en", "es", "es-MX"], defaultLocale: "en" } }
);

const nonLocalized = defineCollection("articles", {
  title: fields.string({ required: true })
});

function variant(overrides: Partial<LocaleVariant> = {}): LocaleVariant {
  return {
    id: "v1",
    collection: "pages",
    documentId: "p1",
    locale: "es",
    fields: { title: "Hola" },
    status: "complete",
    translatedBy: "ai",
    translatedAt: "2024-01-01T00:00:00.000Z",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides
  };
}

function record(overrides: Partial<ContentRecord> = {}): ContentRecord {
  return {
    id: "p1",
    title: "Hello",
    body: "World",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides
  } as ContentRecord;
}

describe("localeFallbackChain", () => {
  it("returns [] for collections without i18n", () => {
    expect(localeFallbackChain(nonLocalized as any, "es")).toEqual([]);
  });

  it("returns [requested, language, default] for region-tagged locale", () => {
    expect(localeFallbackChain(pages as any, "es-MX")).toEqual(["es-MX", "es", "en"]);
  });

  it("de-duplicates entries when language === requested", () => {
    expect(localeFallbackChain(pages as any, "es")).toEqual(["es", "en"]);
  });

  it("falls back to defaultLocale when requested isn't configured", () => {
    expect(localeFallbackChain(pages as any, "fr")).toEqual(["en"]);
  });
});

describe("localizableFieldNames", () => {
  it("includes string/text fields by default and excludes private/localized:false", () => {
    expect(localizableFieldNames(pages as any).sort()).toEqual(["body", "title"]);
  });
});

describe("overlayLocaleVariant", () => {
  it("returns the record untouched when the variant is null", () => {
    const r = record();
    expect(overlayLocaleVariant(r, null)).toBe(r);
  });

  it("returns the record untouched when the variant is not complete", () => {
    const r = record();
    expect(overlayLocaleVariant(r, variant({ status: "in_progress" }))).toBe(r);
  });

  it("overlays variant fields and annotates locale metadata", () => {
    const merged = overlayLocaleVariant(record(), variant());
    expect(merged.title).toBe("Hola");
    expect(merged.locale).toBe("es");
    expect((merged as any).translatedBy).toBe("ai");
    expect((merged as any).translationStatus).toBe("complete");
  });
});

describe("getLocaleVariantWithFallback", () => {
  it("returns null for non-localized collections", async () => {
    const store = new MemoryTranslationStore();
    const v = await getLocaleVariantWithFallback(store, nonLocalized as any, "id", "es");
    expect(v).toBeNull();
  });

  it("returns null when target locale is the default", async () => {
    const store = new MemoryTranslationStore();
    const v = await getLocaleVariantWithFallback(store, pages as any, "p1", "en");
    expect(v).toBeNull();
  });

  it("returns the requested-locale variant when available", async () => {
    const store = new MemoryTranslationStore();
    await store.upsertVariant({
      collection: "pages",
      documentId: "p1",
      locale: "es",
      fields: { title: "Hola" },
      status: "complete",
      translatedBy: "ai"
    });
    const v = await getLocaleVariantWithFallback(store, pages as any, "p1", "es");
    expect(v?.locale).toBe("es");
    expect(v?.status).toBe("complete");
  });

  it("walks the fallback chain when requested variant is missing", async () => {
    const store = new MemoryTranslationStore();
    await store.upsertVariant({
      collection: "pages",
      documentId: "p1",
      locale: "es",
      fields: { title: "Hola" },
      status: "complete",
      translatedBy: "ai"
    });
    const v = await getLocaleVariantWithFallback(store, pages as any, "p1", "es-MX");
    expect(v?.locale).toBe("es");
  });

  it("skips fallback when fallback === false", async () => {
    const store = new MemoryTranslationStore();
    await store.upsertVariant({
      collection: "pages",
      documentId: "p1",
      locale: "es",
      fields: { title: "Hola" },
      status: "complete",
      translatedBy: "ai"
    });
    const v = await getLocaleVariantWithFallback(store, pages as any, "p1", "es-MX", false);
    expect(v).toBeNull();
  });

  it("ignores in-progress variants in the chain", async () => {
    const store = new MemoryTranslationStore();
    await store.upsertVariant({
      collection: "pages",
      documentId: "p1",
      locale: "es",
      status: "in_progress",
      translatedBy: "pending"
    });
    const v = await getLocaleVariantWithFallback(store, pages as any, "p1", "es");
    expect(v).toBeNull();
  });
});

describe("overlayLocaleVariants", () => {
  it("returns the same array when locale is default", async () => {
    const store = new MemoryTranslationStore();
    const recs = [record({ id: "p1" }), record({ id: "p2" })];
    const out = await overlayLocaleVariants(store, pages as any, recs, "en");
    expect(out).toBe(recs);
  });

  it("overlays each record with its variant", async () => {
    const store = new MemoryTranslationStore();
    await store.upsertVariant({
      collection: "pages",
      documentId: "p1",
      locale: "es",
      fields: { title: "Hola" },
      status: "complete",
      translatedBy: "ai"
    });
    const recs = [record({ id: "p1" }), record({ id: "p2" })];
    const out = await overlayLocaleVariants(store, pages as any, recs, "es");
    expect(out[0]?.title).toBe("Hola");
    expect(out[1]?.title).toBe("Hello"); // no variant -> untouched
  });

  it("returns records unchanged when store is null", async () => {
    const recs = [record({ id: "p1" })];
    const out = await overlayLocaleVariants(null as unknown as TranslationStore, pages as any, recs, "es");
    expect(out).toBe(recs);
  });
});
