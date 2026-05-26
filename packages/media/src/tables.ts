import type { PluginTableDef } from "@hono-cms/core";

/** Logical table name for the media records owned by this plugin. */
export const MEDIA_TABLE = "media";

/** Logical table name for the media folder tree owned by this plugin. */
export const MEDIA_FOLDERS_TABLE = "media_folders";

/**
 * Schema declaration for the `media` system table.
 *
 * The default `MemoryMediaStore` keeps everything in process memory and never
 * touches this table — declaring it here lets Drizzle-backed stores reuse the
 * kernel's migration surface without writing a separate migration.
 */
export const mediaTable: PluginTableDef = {
  modelName: "Media",
  fields: {
    id: { type: "string", required: true, unique: true },
    key: { type: "string", required: true, unique: true },
    url: { type: "string", required: true },
    filename: { type: "string", required: true },
    size: { type: "number", required: true },
    contentType: { type: "string" },
    metadata: { type: "json" },
    folderId: { type: "string", references: { table: MEDIA_FOLDERS_TABLE } },
    createdAt: { type: "date", required: true },
    updatedAt: { type: "date", required: true }
  }
};

/**
 * Schema declaration for the `media_folders` table. Folders form a tree via
 * the `parentId` self-reference; `path` is a denormalized cache built from the
 * ancestor chain so admin UIs can render breadcrumbs cheaply.
 */
export const mediaFoldersTable: PluginTableDef = {
  modelName: "MediaFolder",
  fields: {
    id: { type: "string", required: true, unique: true },
    name: { type: "string", required: true },
    parentId: { type: "string", references: { table: MEDIA_FOLDERS_TABLE } },
    path: { type: "string", required: true },
    createdAt: { type: "date", required: true },
    updatedAt: { type: "date", required: true }
  }
};
