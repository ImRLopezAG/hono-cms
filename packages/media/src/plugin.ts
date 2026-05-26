import { createPlugin, type MediaStore, type Plugin } from "@hono-cms/core";
import { mountMediaRoutes } from "./routes";
import { MemoryMediaStore } from "./store/memory";
import {
  MEDIA_FOLDERS_TABLE,
  MEDIA_TABLE,
  mediaFoldersTable,
  mediaTable
} from "./tables";

/** Plugin id under which the media plugin self-registers on the registry. */
export const MEDIA_PLUGIN_ID = "media";

export type MediaConfig = {
  /**
   * Persistent backend for media records + folders. Defaults to
   * `new MemoryMediaStore()` — fine for tests but lost on process restart.
   */
  store?: MediaStore;
  /**
   * Lifetime of a presigned-upload session before `POST /api/media/confirm`
   * starts returning `presign_session_expired`. Defaults to one hour.
   */
  presignExpirySeconds?: number;
  /**
   * Hard upper bound (in bytes) on file size accepted by
   * `POST /api/media/presign`. Defaults to 1 GiB.
   */
  maxPresignUploadSizeBytes?: number;
  /**
   * Opt in to accepting SVG / HTML / XML / JS uploads. Disabled by default —
   * those formats can execute in the browser when served from the same origin
   * as the admin UI.
   */
  allowActiveContent?: boolean;
};

/**
 * Service exposed on the plugin registry (`ctx.plugins.get("media")`) so
 * tests + admin tooling that wants direct access to the backing store can
 * reach it without re-instantiating.
 */
export type MediaService = {
  readonly store: MediaStore;
  readonly config: Required<Pick<MediaConfig, "presignExpirySeconds" | "maxPresignUploadSizeBytes" | "allowActiveContent">>;
};

/**
 * Build the media plugin manifest.
 *
 * Declares the `media` + `media_folders` system tables, mounts the 12
 * `/api/media/*` routes (upload, presign, confirm, folder CRUD, file
 * streaming), and emits `media:after-upload` / `media:after-delete` on the
 * shared event bus so audit / webhooks / etc. can react.
 *
 * Direct uploads and presign flows both consume `ctx.storage` — storage
 * remains a direct adapter on the kernel rather than a plugin in its own
 * right because it's the data-store interface for media.
 *
 * ```ts
 * createCMS({
 *   storage: createMemoryStorage({ provider: "memory" }),
 *   plugins: [mediaPlugin({ allowActiveContent: false })]
 * });
 * ```
 */
export function mediaPlugin(opts: MediaConfig = {}): Plugin {
  const store = opts.store ?? new MemoryMediaStore();
  const config: MediaService["config"] = {
    presignExpirySeconds: opts.presignExpirySeconds ?? 3600,
    maxPresignUploadSizeBytes: opts.maxPresignUploadSizeBytes ?? 1024 * 1024 * 1024,
    allowActiveContent: opts.allowActiveContent ?? false
  };

  return createPlugin({
    id: MEDIA_PLUGIN_ID,

    schema: {
      [MEDIA_TABLE]: mediaTable,
      [MEDIA_FOLDERS_TABLE]: mediaFoldersTable
    },

    app(app, ctx) {
      ctx.plugins.register(MEDIA_PLUGIN_ID, {
        store,
        config
      } satisfies MediaService);

      mountMediaRoutes(app, ctx, {
        store,
        presignExpirySeconds: config.presignExpirySeconds,
        maxPresignUploadSizeBytes: config.maxPresignUploadSizeBytes,
        allowActiveContent: config.allowActiveContent
      });
    }
  });
}
