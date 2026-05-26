import type { CollectionDefinition, ContentRecord, FieldsDefinition, QueryParams } from "@hono-cms/schema";

export function isLocalizedCollection(collection: CollectionDefinition<string, FieldsDefinition>): boolean {
  return Boolean(collection.options.i18n);
}

export function defaultLocale(collection: CollectionDefinition<string, FieldsDefinition>): string | null {
  return collection.options.i18n?.defaultLocale ?? null;
}

export function localeFromRequest(collection: CollectionDefinition<string, FieldsDefinition>, url: URL): string | null {
  if (!collection.options.i18n) return null;
  return url.searchParams.get("locale") ?? collection.options.i18n.defaultLocale;
}

export function localeValidationError(collection: CollectionDefinition<string, FieldsDefinition>, locale: string | null): Response | null {
  if (!locale || !collection.options.i18n) return null;
  return collection.options.i18n.locales.includes(locale)
    ? null
    : Response.json({ error: "unsupported_locale", issues: [{ path: ["locale"], message: `Locale "${locale}" is not configured for "${collection.name}".` }] }, { status: 422 });
}

export function localeFallbackChain(collection: CollectionDefinition<string, FieldsDefinition>, locale: string | null | undefined): string[] {
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

export function withDefaultLocale(
  collection: CollectionDefinition<string, FieldsDefinition>,
  input: Record<string, unknown>,
  locale: string | null
): Record<string, unknown> {
  if (!collection.options.i18n) return input;
  return { ...input, locale: locale ?? collection.options.i18n.defaultLocale };
}

export async function listWithLocaleFallback(
  list: (query: QueryParams) => Promise<{ items: ContentRecord[]; nextCursor?: string; total?: number }>,
  collection: CollectionDefinition<string, FieldsDefinition>,
  query: QueryParams
): Promise<{ items: ContentRecord[]; nextCursor?: string; total?: number }> {
  if (!collection.options.i18n || !query.locale || query.locale === collection.options.i18n.defaultLocale) {
    return list(query);
  }

  if (query.fallback === false) return list(query);

  for (const locale of localeFallbackChain(collection, query.locale)) {
    const localized = await list({ ...query, locale });
    if (localized.items.length > 0) return localized;
  }
  return list({ ...query, locale: collection.options.i18n.defaultLocale });
}
