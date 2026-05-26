import type {
  MediaRecord,
  MediaStore,
  StorageAdapter,
  StoredObject
} from "@hono-cms/core";
import { safeFilename, validateMediaContentType, type MediaSecurityOptions } from "./content-safety";
import type { MediaPresignSession } from "./store/memory";

export type MediaPresignRequest = {
  filename: string;
  contentType: string;
  size: number;
};

export type MediaConfirmRequest = {
  uploadId: string;
  key: string;
  filename: string;
  contentType: string;
  size: number;
  metadata?: Record<string, string>;
  folderId?: string | null;
};

export type MediaPresignResult = MediaPresignSession & {
  uploadUrl: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
};

/**
 * Mint a presigned upload URL for direct browser-to-storage transfers.
 *
 * The plugin validates the requested MIME type up front (same active-content
 * blocklist used for direct uploads) and refuses sizes that exceed
 * `maxSizeBytes` (default 1 GiB). When the configured `StorageAdapter` doesn't
 * implement `createSignedUploadUrl`, we degrade gracefully to a `PUT` against
 * the adapter's public URL — the kernel keeps moving and the operator can
 * surface a clearer error later.
 */
export async function createMediaPresign(
  storage: StorageAdapter,
  input: MediaPresignRequest,
  options: { expiresInSeconds?: number; maxSizeBytes?: number; allowActiveContent?: boolean } = {}
): Promise<MediaPresignResult> {
  validatePresignInput(input, options.maxSizeBytes, options);
  const expiresInSeconds = options.expiresInSeconds ?? 3600;
  const uploadId = crypto.randomUUID();
  const key = `media/${uploadId}-${safeFilename(input.filename)}`;
  const signed = await storage.createSignedUploadUrl?.({
    key,
    contentType: input.contentType,
    size: input.size,
    expiresInSeconds,
    metadata: { filename: input.filename, uploadId }
  }) ?? {
    uploadUrl: storage.publicUrl?.(key) ?? key,
    method: "PUT" as const,
    headers: { "content-type": input.contentType }
  };
  return {
    ...input,
    uploadId,
    key,
    uploadUrl: signed.uploadUrl,
    method: signed.method ?? "PUT",
    headers: signed.headers ?? { "content-type": input.contentType },
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString()
  };
}

/**
 * Confirm a previously presigned upload after the bytes have landed in
 * storage. Validates that the confirmation matches the session, that the
 * object actually exists in storage with the declared size, and that the
 * recorded content type still matches the one the session was minted with.
 * On success materialises the `MediaRecord` via the supplied store.
 */
export async function confirmMediaUpload(
  mediaStore: MediaStore,
  storage: StorageAdapter,
  session: MediaPresignSession,
  input: MediaConfirmRequest
): Promise<MediaRecord> {
  if (input.uploadId !== session.uploadId || input.key !== session.key) {
    throw new Error("presign_session_mismatch");
  }
  if (
    input.filename !== session.filename ||
    input.contentType !== session.contentType ||
    input.size !== session.size
  ) {
    throw new Error("presign_metadata_mismatch");
  }
  if (Date.parse(session.expiresAt) <= Date.now()) throw new Error("presign_session_expired");
  const stored = await readStoredObject(storage, input.key);
  if (!stored) throw new Error("media_object_not_found");
  if (stored.size !== input.size) throw new Error("media_object_size_mismatch");
  if (stored.contentType && stored.contentType.split(";")[0]?.trim() !== input.contentType) {
    throw new Error("media_object_content_type_mismatch");
  }
  return await mediaStore.create({
    key: input.key,
    url: stored.url,
    filename: input.filename,
    size: stored.size,
    contentType: stored.contentType ?? input.contentType,
    metadata: input.metadata ?? stored.metadata ?? { filename: input.filename },
    folderId: input.folderId ?? null
  });
}

async function readStoredObject(storage: StorageAdapter, key: string): Promise<StoredObject | null> {
  if (storage.head) return await storage.head(key);
  const response = await storage.get(key);
  if (!response) return null;
  const bytes = await response.arrayBuffer();
  const stored: StoredObject = {
    key,
    url: storage.publicUrl?.(key) ?? key,
    size: bytes.byteLength
  };
  const contentType = response.headers.get("content-type");
  if (contentType) stored.contentType = contentType;
  return stored;
}

function validatePresignInput(
  input: MediaPresignRequest,
  maxSizeBytes = 1024 * 1024 * 1024,
  options: MediaSecurityOptions = {}
): void {
  if (!input.filename.trim()) throw new Error("filename is required");
  validateMediaContentType(input.contentType, options);
  if (!Number.isFinite(input.size) || input.size <= 0) throw new Error("size must be greater than zero");
  if (input.size > maxSizeBytes) throw new Error("file exceeds max presigned upload size");
}
