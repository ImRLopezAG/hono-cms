import type {
  DatabaseAdapter,
  LocaleVariant,
  TranslationProvider,
  TranslationStore
} from "@hono-cms/core";
import type { CMSCollections } from "@hono-cms/schema";
import { localizableFieldNames } from "./overlay";

export type TranslateDocumentInput<Collections extends CMSCollections> = {
  collections: Collections;
  db: DatabaseAdapter<Collections>;
  store: TranslationStore;
  provider: TranslationProvider;
  collectionName: keyof Collections & string;
  documentId: string;
  targetLocale: string;
  sourceLocale?: string;
};

/**
 * Run an end-to-end translation pass for a single document.
 *
 * Steps:
 * 1. Validate that the collection is localized and `targetLocale` is supported.
 * 2. Mark the target variant as `in_progress` in the store.
 * 3. Call the `TranslationProvider` for the localizable string fields.
 * 4. Persist the translated fields with `status: "complete"`. If the provider
 *    throws, the variant is persisted with `status: "error"` and the error
 *    message is surfaced via `variant.error`.
 *
 * Returns the persisted `LocaleVariant` on success, or a `Response` describing
 * the validation failure (400/422/404).
 */
export async function translateDocument<Collections extends CMSCollections>(
  input: TranslateDocumentInput<Collections>
): Promise<LocaleVariant | Response> {
  const collection = input.collections[input.collectionName];
  if (!collection?.options.i18n) {
    return Response.json({ error: "i18n_not_enabled" }, { status: 400 });
  }
  const sourceLocale = input.sourceLocale ?? collection.options.i18n.defaultLocale;
  if (!collection.options.i18n.locales.includes(input.targetLocale)) {
    return Response.json(
      {
        error: "unsupported_locale",
        issues: [
          {
            path: ["targetLocale"],
            message: `Locale "${input.targetLocale}" is not configured for "${collection.name}".`
          }
        ]
      },
      { status: 422 }
    );
  }
  if (input.targetLocale === sourceLocale) {
    return Response.json(
      {
        error: "validation_error",
        issues: [{ path: ["targetLocale"], message: "targetLocale must be different from sourceLocale." }]
      },
      { status: 422 }
    );
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
