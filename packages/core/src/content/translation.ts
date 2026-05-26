import type { CMSCollections, CollectionDefinition, ContentRecord, FieldsDefinition } from "@hono-cms/schema";
import type { DatabaseAdapter, JobsAdapter, LocaleVariant, TranslationProvider, TranslationStore } from "../types/providers";
import { localeFallbackChain } from "./i18n";

export class MemoryTranslationStore implements TranslationStore {
  private readonly variants = new Map<string, LocaleVariant>();

  async getVariant(collection: string, documentId: string, locale: string): Promise<LocaleVariant | null> {
    return this.variants.get(variantKey(collection, documentId, locale)) ?? null;
  }

  async listVariants(collection: string, documentId: string): Promise<LocaleVariant[]> {
    return [...this.variants.values()]
      .filter((variant) => variant.collection === collection && variant.documentId === documentId)
      .sort((a, b) => a.locale.localeCompare(b.locale));
  }

  async upsertVariant(input: Parameters<TranslationStore["upsertVariant"]>[0]): Promise<LocaleVariant> {
    const now = new Date().toISOString();
    const key = variantKey(input.collection, input.documentId, input.locale);
    const existing = this.variants.get(key);
    const next: LocaleVariant = {
      id: existing?.id ?? crypto.randomUUID(),
      collection: input.collection,
      documentId: input.documentId,
      locale: input.locale,
      fields: input.fields ?? existing?.fields ?? {},
      status: input.status,
      translatedBy: input.translatedBy,
      sourceUpdatedAt: input.sourceUpdatedAt ?? existing?.sourceUpdatedAt,
      error: input.error,
      provider: input.provider ?? existing?.provider,
      translatedAt: input.translatedAt ?? existing?.translatedAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.variants.set(key, next);
    return next;
  }

  async health(): Promise<{ ok: boolean; details: Record<string, number> }> {
    return { ok: true, details: { variants: this.variants.size } };
  }
}

export function localizableFieldNames(collection: CollectionDefinition<string, FieldsDefinition>): string[] {
  return Object.entries(collection.fields)
    .filter(([, field]) => !field.private && (field.localized === true || ((field.kind === "string" || field.kind === "text") && field.localized !== false)))
    .map(([name]) => name);
}

export function overlayLocaleVariant(record: ContentRecord, variant: LocaleVariant | null): ContentRecord {
  if (!variant || variant.status !== "complete") return record;
  return {
    ...record,
    ...variant.fields,
    locale: variant.locale,
    translatedBy: variant.translatedBy,
    translationStatus: variant.status,
    translatedAt: variant.translatedAt
  };
}

export async function getLocaleVariantWithFallback(
  store: TranslationStore | null,
  collection: CollectionDefinition<string, FieldsDefinition>,
  documentId: string,
  locale: string | undefined,
  fallback = true
): Promise<LocaleVariant | null> {
  if (!store || !collection.options.i18n || !locale || locale === collection.options.i18n.defaultLocale) return null;
  const candidates = fallback ? localeFallbackChain(collection, locale) : [locale];
  for (const candidate of candidates) {
    if (candidate === collection.options.i18n.defaultLocale) return null;
    const variant = await store.getVariant(collection.name, documentId, candidate);
    if (variant?.status === "complete") return variant;
  }
  return null;
}

export async function overlayLocaleVariants(
  store: TranslationStore | null,
  collection: CollectionDefinition<string, FieldsDefinition>,
  records: ContentRecord[],
  locale: string | undefined,
  fallback = true
): Promise<ContentRecord[]> {
  if (!store || !collection.options.i18n || !locale || locale === collection.options.i18n.defaultLocale) return records;
  return Promise.all(records.map(async (record) => overlayLocaleVariant(record, await getLocaleVariantWithFallback(store, collection, record.id, locale, fallback))));
}

export async function enqueueTranslationJobs(
  jobs: JobsAdapter | null,
  collection: CollectionDefinition<string, FieldsDefinition>,
  record: ContentRecord,
  options?: { enabled?: boolean; translateOnPublish?: boolean }
): Promise<void> {
  if (!jobs?.enqueue || !collection.options.i18n || options?.enabled !== true) return;
  if (options.translateOnPublish && record.status !== "published") return;
  for (const locale of collection.options.i18n.locales) {
    if (locale === collection.options.i18n.defaultLocale) continue;
    await jobs.enqueue("/cms/jobs/translation", { collection: collection.name, documentId: record.id, targetLocale: locale });
  }
}

export async function translateDocument<Collections extends CMSCollections>(input: {
  collections: Collections;
  db: DatabaseAdapter<Collections>;
  store: TranslationStore;
  provider: TranslationProvider;
  collectionName: keyof Collections & string;
  documentId: string;
  targetLocale: string;
  sourceLocale?: string;
}): Promise<LocaleVariant | Response> {
  const collection = input.collections[input.collectionName];
  if (!collection?.options.i18n) return Response.json({ error: "i18n_not_enabled" }, { status: 400 });
  const sourceLocale = input.sourceLocale ?? collection.options.i18n.defaultLocale;
  if (!collection.options.i18n.locales.includes(input.targetLocale)) {
    return Response.json({ error: "unsupported_locale", issues: [{ path: ["targetLocale"], message: `Locale "${input.targetLocale}" is not configured for "${collection.name}".` }] }, { status: 422 });
  }
  if (input.targetLocale === sourceLocale) {
    return Response.json({ error: "validation_error", issues: [{ path: ["targetLocale"], message: "targetLocale must be different from sourceLocale." }] }, { status: 422 });
  }

  const source = await input.db.get(input.collectionName, input.documentId);
  if (!source) return Response.json({ error: "not_found" }, { status: 404 });

  const fields = Object.fromEntries(
    localizableFieldNames(collection)
      .map((field) => [field, source[field]])
      .filter(([, value]) => typeof value === "string" && value.length > 0)
  ) as Record<string, string>;

  await input.store.upsertVariant({
    collection: input.collectionName,
    documentId: input.documentId,
    locale: input.targetLocale,
    status: "in_progress",
    translatedBy: "pending",
    sourceUpdatedAt: source.updatedAt
  });

  try {
    const translated = await input.provider.translate({
      collection: input.collectionName,
      documentId: input.documentId,
      sourceLocale,
      targetLocale: input.targetLocale,
      fields
    });
    return await input.store.upsertVariant({
      collection: input.collectionName,
      documentId: input.documentId,
      locale: input.targetLocale,
      fields: translated,
      status: "complete",
      translatedBy: "ai",
      sourceUpdatedAt: source.updatedAt,
      provider: input.provider.provider,
      translatedAt: new Date().toISOString()
    });
  } catch (error) {
    return await input.store.upsertVariant({
      collection: input.collectionName,
      documentId: input.documentId,
      locale: input.targetLocale,
      status: "error",
      translatedBy: "pending",
      sourceUpdatedAt: source.updatedAt,
      error: error instanceof Error ? error.message : String(error),
      provider: input.provider.provider
    });
  }
}

function variantKey(collection: string, documentId: string, locale: string): string {
  return `${collection}:${documentId}:${locale}`;
}
