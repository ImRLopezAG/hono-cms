import type { PluginTableDef } from "@hono-cms/core";

/** Logical table name under which the i18n plugin declares its rows. */
export const TRANSLATIONS_TABLE = "translations";

/**
 * Schema declaration for the `translations` (a.k.a. `locale_variants`) system
 * table.
 *
 * The plugin's default `MemoryTranslationStore` doesn't touch this table — it
 * lives entirely in process memory — but declaring it through `Plugin.schema`
 * lets users wire a drizzle-backed store (`createDrizzleTranslationStore`)
 * without authoring a separate migration. The kernel's migration surface picks
 * the table up automatically.
 */
export const translationsTable: PluginTableDef = {
  modelName: "LocaleVariant",
  fields: {
    id: { type: "string", required: true, unique: true },
    collection: { type: "string", required: true },
    documentId: { type: "string", required: true },
    locale: { type: "string", required: true },
    fields: { type: "string", required: true },
    status: { type: "string", required: true },
    translatedBy: { type: "string", required: true },
    sourceUpdatedAt: { type: "string" },
    error: { type: "string" },
    provider: { type: "string" },
    translatedAt: { type: "string" },
    createdAt: { type: "date", required: true },
    updatedAt: { type: "date", required: true }
  }
};
