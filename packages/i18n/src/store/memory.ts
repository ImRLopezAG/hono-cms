import type {
  HealthStatus,
  LocaleVariant,
  TranslationStore
} from "@hono-cms/core";

/**
 * In-memory `TranslationStore` used as the plugin's default backend.
 *
 * Provides the full `getVariant` / `listVariants` / `upsertVariant` / `health`
 * surface so plugin behavior can be exercised end-to-end without an external
 * database. Not recommended for production — entries are lost on process
 * restart.
 */
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

  async health(): Promise<HealthStatus> {
    return { ok: true, details: { variants: this.variants.size } };
  }
}

function variantKey(collection: string, documentId: string, locale: string): string {
  return `${collection}:${documentId}:${locale}`;
}
