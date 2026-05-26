import type { MediaRecord, StorageAdapter } from "@hono-cms/core";
import { safeFilename, validateMediaContentType, type MediaSecurityOptions } from "./content-safety";

/**
 * Read an incoming `Request` body, validate the declared MIME type against the
 * active-content blocklist, and write the bytes to storage under a
 * `media/<uuid>-<safe-filename>` key. Returns the partial `MediaRecord` shape
 * the plugin's store needs to materialise a row.
 *
 * Accepts both `multipart/form-data` (admin UI uploads) and raw body uploads
 * (server-to-server style). For raw uploads the filename is read from the
 * `x-filename` header.
 */
export async function uploadMediaObject(
  storage: StorageAdapter,
  request: Request,
  options: MediaSecurityOptions = {}
): Promise<Omit<MediaRecord, "id" | "createdAt" | "updatedAt">> {
  const { body, filename, contentType } = await readUpload(request);
  validateMediaContentType(contentType, options);
  const key = `media/${crypto.randomUUID()}-${safeFilename(filename)}`;
  const stored = await storage.put(key, body, {
    contentType,
    metadata: { filename }
  });
  return { ...stored, filename };
}

async function readUpload(
  request: Request
): Promise<{ body: Blob | ArrayBuffer; filename: string; contentType: string }> {
  const contentType = request.headers.get("content-type") ?? "application/octet-stream";
  if (contentType.includes("multipart/form-data")) {
    const data = await request.formData();
    const file = data.get("file");
    if (!(file instanceof File)) throw new Error("multipart upload requires a file field");
    return {
      body: file,
      filename: file.name || "upload.bin",
      contentType: file.type || "application/octet-stream"
    };
  }
  const filename = request.headers.get("x-filename") ?? "upload.bin";
  return { body: await request.arrayBuffer(), filename, contentType };
}
