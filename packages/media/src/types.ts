/**
 * Local mirror of the `MediaListQuery` shape the kernel's `MediaStore`
 * surface uses. `@hono-cms/core` keeps this type internal (the public
 * `MediaStore` type embeds it via `Parameters<MediaStore["list"]>[0]`); we
 * re-declare it here so the plugin's route + store code can name the type
 * without reaching into core internals.
 *
 * Kept in lockstep with `packages/core/src/types/providers.ts` —
 * any change in the shape over there needs a corresponding change here.
 */
export type MediaListQuery = {
  cursor?: string;
  limit?: number;
  q?: string;
  type?: "image" | "video" | "audio" | "document" | "other" | (string & {});
  from?: string;
  to?: string;
  /**
   * Filter media records by folder.
   * - A string folder id returns only records inside that folder.
   * - `null` returns only records at the root (no folder).
   * - `undefined` (default) returns records across all folders.
   */
  folderId?: string | null;
};
