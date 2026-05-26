import type { ContentRecord, LocaleVariant, TranslationStore } from "@hono-cms/core";
import type { CollectionDefinition, FieldsDefinition } from "@hono-cms/schema";

/**
 * Compute the ordered chain of locales to try when serving content for the
 * supplied `locale` against the supplied `collection`.
 *
 * Walk order:
 * 1. The requested locale itself (if configured for the collection).
 * 2. The language-only fallback (e.g. `es` for `es-MX`) if configured.
 * 3. The collection's `defaultLocale`.
 *
 * Duplicates are removed while preserving first-encountered order, so callers
 * can iterate the chain without re-checking visited locales.
 */
export function localeFallbackChain(
  collection: CollectionDefinition<string, FieldsDefinition>,
  locale: string | null | undefined
): string[] {
  if (!collection.options.i18n) return [];
  const configured = new Set(collection.options.i18n.locales);
  const chain: string[] = [];
  const requested = locale ?? collection.options.i18n.defaultLocale;
  if (configured.has(requested)) chain.push(requested);
  const language = requested.split("-")[0];
  if (language && language !== requested && configured.has(language)) chain.push(language);
  chain.push(collection.options.i18n.defaultLocale);
  return [...new Set(chain)];
}

/**
 * Return the localizable field names for a collection. A field is localizable
 * when it is not `private` and either explicitly marks `localized: true` or is
 * a `string`/`text` field that hasn't opted out via `localized: false`.
 */
export function localizableFieldNames(
  collection: CollectionDefinition<string, FieldsDefinition>
): string[] {
  return Object.entries(collection.fields)
    .filter(([, field]) =>
      !field.private &&
      (field.localized === true || ((field.kind === "string" || field.kind === "text") && field.localized !== false))
    )
    .map(([name]) => name);
}

/**
 * Overlay a single `LocaleVariant` onto a base-locale `ContentRecord`. Only
 * variants with `status === "complete"` are applied; otherwise the original
 * record is returned untouched.
 *
 * Annotates the result with `locale`, `translatedBy`, `translationStatus` and
 * `translatedAt` so admin UIs can surface the translation provenance.
 */
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

/**
 * Resolve the best available `LocaleVariant` for `(collection, documentId)`
 * given the requested `locale`. Walks the fallback chain produced by
 * {@link localeFallbackChain} unless `fallback === false`, in which case only
 * the requested locale is consulted.
 *
 * Returns `null` when no completed variant exists, the store/locale isn't
 * configured, or the request targets the default locale (which is served from
 * the base record).
 */
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

/**
 * Bulk overlay helper for list-style responses. Resolves the best available
 * variant per record (with fallback) and returns a new array with each record
 * overlayed. Records without a completed variant are left untouched so callers
 * fall through to the base-locale content automatically.
 */
export async function overlayLocaleVariants(
  store: TranslationStore | null,
  collection: CollectionDefinition<string, FieldsDefinition>,
  records: ContentRecord[],
  locale: string | undefined,
  fallback = true
): Promise<ContentRecord[]> {
  if (!store || !collection.options.i18n || !locale || locale === collection.options.i18n.defaultLocale) return records;
  return Promise.all(
    records.map(async (record) =>
      overlayLocaleVariant(record, await getLocaleVariantWithFallback(store, collection, record.id, locale, fallback))
    )
  );
}
