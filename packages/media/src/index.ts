/**
 * `@hono-cms/media`
 *
 * Plugin that owns every `/api/media/*` route — direct upload, presigned
 * upload + confirm, folder CRUD, file streaming, list/get/update/delete. Ships
 * an in-memory `MediaStore` + `MediaFolderStore` for tests; production
 * deployments pass their own store through `mediaPlugin({ store })`.
 *
 * Storage stays a direct adapter (`ctx.storage`) — it's the data-store
 * interface for media, not a plugin. See
 * `docs/plans/2026-05-25-001-refactor-plugin-system-architecture-plan.md`
 * §U19 for the migration rationale.
 */

export {
  mediaPlugin,
  MEDIA_PLUGIN_ID,
  type MediaConfig,
  type MediaService
} from "./plugin";

export {
  MemoryMediaStore,
  MemoryMediaFolderStore,
  MediaPresignStore,
  matchesMediaQuery,
  type MediaPresignSession
} from "./store/memory";

export { uploadMediaObject } from "./upload";

export {
  createMediaPresign,
  confirmMediaUpload,
  type MediaPresignRequest,
  type MediaPresignResult,
  type MediaConfirmRequest
} from "./presign";

export { mountMediaRoutes, parseMediaListQuery, type MediaRouteOptions } from "./routes";

export {
  validateMediaContentType,
  safeFilename,
  type MediaSecurityOptions
} from "./content-safety";

export { assertStorageKey } from "./storage-key";

export {
  MEDIA_TABLE,
  MEDIA_FOLDERS_TABLE,
  mediaTable,
  mediaFoldersTable
} from "./tables";

export type { MediaListQuery } from "./types";

// Re-export the public type surface so users can write `MediaStore` etc.
// without importing from `@hono-cms/core` directly.
export type {
  MediaFolder,
  MediaFolderStore,
  MediaRecord,
  MediaStore,
  StorageAdapter,
  StoragePutOptions,
  StorageSignedUpload,
  StorageSignedUploadOptions,
  StoredObject
} from "@hono-cms/core";
