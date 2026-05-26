/**
 * Content-safety filter for media uploads.
 *
 * Browsers will happily execute SVG / HTML / XML files served out of the media
 * bucket if they're requested from the same origin as the admin UI, so we
 * default-reject those types. Operators that genuinely need them (e.g. SVG
 * illustrations on a static site that serves media from a separate origin or
 * with `Content-Disposition: attachment`) can opt in via `allowActiveContent`.
 */

const ACTIVE_CONTENT_TYPES = new Set([
  "application/javascript",
  "application/ecmascript",
  "application/xhtml+xml",
  "application/xml",
  "image/svg+xml",
  "text/ecmascript",
  "text/html",
  "text/javascript",
  "text/xml"
]);

export type MediaSecurityOptions = {
  allowActiveContent?: boolean;
};

/**
 * Validate a MIME type against the active-content blocklist. Throws
 * `active_content_not_allowed` for SVG/HTML/JS/XML unless
 * `options.allowActiveContent` is true. Also rejects strings that don't look
 * like MIME types at all (no `/`).
 */
export function validateMediaContentType(contentType: string, options: MediaSecurityOptions = {}): void {
  const mime = contentType.split(";")[0]?.trim().toLocaleLowerCase() ?? "";
  if (!mime.includes("/")) throw new Error("contentType must be a valid MIME type");
  if (!options.allowActiveContent && ACTIVE_CONTENT_TYPES.has(mime)) {
    throw new Error("active_content_not_allowed");
  }
}

/** Sanitize a filename for embedding in a storage object key. */
export function safeFilename(filename: string): string {
  return filename.replaceAll(/[^a-zA-Z0-9._-]/g, "-").replaceAll(/-+/g, "-").slice(0, 120) || "upload.bin";
}
