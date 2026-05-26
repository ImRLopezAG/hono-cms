/**
 * `@hono-cms/core` public surface — plugin-manifest kernel only.
 *
 * Everything cross-cutting (cors, openapi, graphql, audit, webhooks,
 * i18n, media, jobs-runtime, preview, content-type-builder, drafts,
 * rate-limit, content-cache, auth-tokens) ships as its own plugin
 * package. Direct adapters (db, storage, mediaStore, cache, jobs) live
 * in `packages/adapter-*` / `packages/storage-*` / `packages/cache` /
 * `packages/jobs`.
 *
 * See CONTEXT.md and docs/adr/0001-plugin-manifest-architecture.md
 * for the full vocabulary.
 */
export { createCMS } from "./create-cms";
export type { CMSConfig, CMSInstance } from "./create-cms";

export { createPlugin, createAuthPlugin } from "./plugins/factories";
export { createServiceRegistry } from "./plugins/service-registry";
export { createEventBus } from "./plugins/event-bus";
export { createHookRegistry } from "./plugins/hook-registry";
export { createPluginContext } from "./plugins/context";
export {
  installPlugins,
  validateAndOrder,
  validatePluginCapabilities
} from "./plugins/runtime";
export type { InstallResult } from "./plugins/runtime";
export {
  mergeSchemas,
  toSystemTablesSnapshot,
  assertNoCollectionConflicts
} from "./plugins/schema-merge";

export { CMSPluginError } from "./plugins/types";
export type {
  AuthPlugin,
  Authorize,
  AuthorizeAction,
  Awaitable,
  CMSEvents,
  CMSPluginCapabilities,
  FieldDef,
  FieldType,
  HookDeclaration,
  HookMatcher,
  HookRegistry,
  Identity,
  LifecycleHookContext,
  LifecycleHookEvent,
  LifecycleHookHandler,
  MiddlewareDeclaration,
  MountPhase,
  Plugin,
  PluginContext,
  PluginEvents,
  PluginServices,
  PluginTableDef,
  RateLimitDeclaration,
  SchemaExtension
} from "./plugins/types";

export { runHealthChecks, sanitizeError, withTimeout } from "./health";
export type { HealthChecker, HealthReport } from "./health";

export { assertStorageKey } from "./storage-key";

// Plugin-package transitional re-exports (slated for removal once each
// plugin self-contains these utilities).
export { createOpenAPISpec } from "./openapi";
export { buildCollectionRouteConfigs } from "./openapi-content-routes";
export { MemoryMediaStore, MemoryMediaFolderStore, MediaPresignStore, confirmMediaUpload, createMediaPresign, uploadMediaObject } from "./media";
export type {
  AuthSession,
  AuditDiff,
  AuditLogEntry,
  AuditLogQuery,
  AuditOperation,
  AuditStore,
  MediaListQuery,
  TranslationProvider,
  TranslationStore,
  LocaleVariant,
  LocaleVariantStatus,
  LocaleVariantTranslatedBy,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEvent,
  WebhookRecord,
  WebhookRecordAttemptInput,
  WebhookStore,
  WebhookTarget
} from "./types/providers";
export { auditEntriesToCSV, auditLogCleanupJob, computeDiff, MemoryAuditStore, writeAuditEntry } from "./audit";
export { createDrizzleAuditStore } from "./audit/drizzle-audit-store";
export type { CreateDrizzleAuditStoreOptions, DrizzleAuditDialect } from "./audit/drizzle-audit-store";
export { createHmacSignature, deliverWebhook, dispatchWebhooks, matchesEventPattern, MemoryWebhookStore, runWebhookRetrySweep, serializeWebhook, webhookDeliveryCleanupJob } from "./webhooks";
export { generatePreviewToken, revokePreviewToken, verifyPreviewToken } from "./content/preview";
export { normalizeDraftInput, publishDocument, runScheduledPublishes, schedulePublish, stripSystemDraftFields, unpublishDocument, unschedulePublish } from "./content/publish";
export { MemoryTranslationStore, localizableFieldNames, overlayLocaleVariant, overlayLocaleVariants, translateDocument } from "./content/translation";
export { createDrizzleTranslationStore } from "./content/drizzle-translation-store";
export { MAX_POPULATE_DEPTH, MAX_POPULATE_NODES, parsePopulateParams, populateRecords } from "./content/populate";

// Shared content utilities consumed by adapter packages and a few plugins
// during the transition. These are pure helpers without slot-based config
// coupling, so they survive U23.
export {
  InvalidCursorError,
  applyListQuery,
  decodeCursor,
  encodeCursor,
  parseQueryParams,
  publicListResult
} from "./content/query";

export type { HonoCMSEnv } from "./types/instance";
export type {
  CacheAdapter,
  ContentRecord,
  ContentStatus,
  DatabaseAdapter,
  HealthStatus,
  JobContext,
  JobEnqueueOptions,
  JobHandler,
  JobsAdapter,
  ListQuery,
  ListResult,
  MediaFolder,
  MediaFolderStore,
  MediaRecord,
  MediaStore,
  RateLimitOptions,
  RateLimitResult,
  StorageAdapter,
  StoragePutOptions,
  StorageSignedUpload,
  StorageSignedUploadOptions,
  StoredObject
} from "./types/providers";
