/**
 * `@hono-cms/i18n`
 *
 * Plugin that owns the locale fallback + translation runtime: declares the
 * `translations` system table, mounts `/cms/admin/i18n/backfill` admin routes,
 * registers the `translation` job with `@hono-cms/jobs-runtime`, and (opt-in)
 * fans out translation jobs from `content:after-publish` events.
 *
 * See `docs/plans/2026-05-25-001-refactor-plugin-system-architecture-plan.md`
 * §U18 for the migration rationale.
 */

export { i18n, I18N_PLUGIN_ID, type I18nConfig, type I18nService } from "./plugin";

export { MemoryTranslationStore } from "./store/memory";

export {
  createDrizzleTranslationStore,
  type CreateDrizzleTranslationStoreOptions,
  type DrizzleTranslationStoreDialect
} from "./store/drizzle";

export {
  getLocaleVariantWithFallback,
  localeFallbackChain,
  localizableFieldNames,
  overlayLocaleVariant,
  overlayLocaleVariants
} from "./overlay";

export { translateDocument, type TranslateDocumentInput } from "./translate";

export {
  createTranslationJob,
  enqueueTranslationJobs,
  TRANSLATION_JOB_ENDPOINT,
  TRANSLATION_JOB_NAME,
  type CreateTranslationJobOptions,
  type EnqueueTranslationOptions,
  type JobsEnqueue,
  type TranslationJobPayload
} from "./jobs";

export {
  mountI18nRoutes,
  resolveI18nBackfillTargets,
  type MountI18nRoutesOptions
} from "./routes";

export { TRANSLATIONS_TABLE, translationsTable } from "./tables";

// Re-export the public type surface so users can write `TranslationStore` etc.
// without importing from `@hono-cms/core` directly.
export type {
  LocaleVariant,
  LocaleVariantStatus,
  LocaleVariantTranslatedBy,
  TranslationProvider,
  TranslationStore
} from "@hono-cms/core";
