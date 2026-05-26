import type { CacheAdapter, MediaFolder, MediaFolderStore, MediaListQuery, MediaRecord, MediaStore, StorageAdapter, StoredObject } from "./types/providers";

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

export class MemoryMediaStore implements MediaStore {
  private readonly records = new Map<string, MediaRecord>();
  readonly folders: MemoryMediaFolderStore;

  constructor() {
    this.folders = new MemoryMediaFolderStore(this.records);
  }

  async list(query: MediaListQuery = {}): Promise<{ items: MediaRecord[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const sorted = [...this.records.values()]
      .filter((record) => matchesMediaQuery(record, query))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const start = query.cursor ? sorted.findIndex((record) => record.id === query.cursor) + 1 : 0;
    const rows = sorted.slice(Math.max(start, 0), Math.max(start, 0) + limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return rows.length > limit && last ? { items, nextCursor: last.id } : { items };
  }

  async get(id: string): Promise<MediaRecord | null> {
    return this.records.get(id) ?? null;
  }

  async create(input: Omit<MediaRecord, "id" | "createdAt" | "updatedAt">): Promise<MediaRecord> {
    const now = new Date().toISOString();
    const record: MediaRecord = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    this.records.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Pick<MediaRecord, "folderId" | "filename" | "metadata">>): Promise<MediaRecord | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const next: MediaRecord = { ...existing, ...patch, updatedAt: now };
    this.records.set(id, next);
    return next;
  }

  async delete(id: string): Promise<MediaRecord | null> {
    const record = this.records.get(id) ?? null;
    this.records.delete(id);
    return record;
  }

  async health(): Promise<{ ok: boolean; details: { records: number; folders: number } }> {
    return { ok: true, details: { records: this.records.size, folders: this.folders.size } };
  }
}

/**
 * In-memory MediaFolderStore — stores folders as a flat list with parent
 * references and a derived `path` (built from ancestor names so the admin UI
 * can render breadcrumbs cheaply).
 */
export class MemoryMediaFolderStore implements MediaFolderStore {
  private readonly folders = new Map<string, MediaFolder>();

  constructor(private readonly mediaRecords: Map<string, MediaRecord>) {}

  get size(): number {
    return this.folders.size;
  }

  async list(): Promise<MediaFolder[]> {
    return [...this.folders.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async get(id: string): Promise<MediaFolder | null> {
    return this.folders.get(id) ?? null;
  }

  async create(input: { name: string; parentId?: string | null }): Promise<MediaFolder> {
    const name = normalizeFolderName(input.name);
    const parentId = input.parentId ?? null;
    if (parentId && !this.folders.has(parentId)) throw new Error("parent_not_found");
    const siblings = [...this.folders.values()].filter((folder) => folder.parentId === parentId);
    if (siblings.some((folder) => folder.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error("folder_name_conflict");
    }
    const now = new Date().toISOString();
    const folder: MediaFolder = {
      id: crypto.randomUUID(),
      name,
      parentId,
      path: this.buildPath(parentId, name),
      createdAt: now,
      updatedAt: now
    };
    this.folders.set(folder.id, folder);
    return folder;
  }

  async update(id: string, patch: { name?: string; parentId?: string | null }): Promise<MediaFolder | null> {
    const existing = this.folders.get(id);
    if (!existing) return null;
    const nextName = patch.name !== undefined ? normalizeFolderName(patch.name) : existing.name;
    const nextParent = patch.parentId !== undefined ? patch.parentId : existing.parentId;
    if (nextParent === id) throw new Error("cannot_move_into_self");
    if (nextParent && !this.folders.has(nextParent)) throw new Error("parent_not_found");
    if (nextParent && this.isDescendant(id, nextParent)) throw new Error("cannot_move_into_descendant");
    const siblings = [...this.folders.values()].filter(
      (folder) => folder.parentId === nextParent && folder.id !== id
    );
    if (siblings.some((folder) => folder.name.toLocaleLowerCase() === nextName.toLocaleLowerCase())) {
      throw new Error("folder_name_conflict");
    }
    const now = new Date().toISOString();
    const updated: MediaFolder = {
      ...existing,
      name: nextName,
      parentId: nextParent,
      path: this.buildPath(nextParent, nextName),
      updatedAt: now
    };
    this.folders.set(id, updated);
    this.recomputeDescendantPaths(id);
    return this.folders.get(id) ?? updated;
  }

  async delete(
    id: string,
    options: { force?: boolean } = {}
  ): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_empty" }> {
    const folder = this.folders.get(id);
    if (!folder) return { ok: false, reason: "not_found" };
    const descendantIds = this.collectDescendantIds(id);
    const allIds = new Set([id, ...descendantIds]);
    const hasMedia = [...this.mediaRecords.values()].some(
      (record) => record.folderId && allIds.has(record.folderId)
    );
    const hasChildren = descendantIds.length > 0;
    if ((hasChildren || hasMedia) && !options.force) {
      return { ok: false, reason: "not_empty" };
    }
    // Cascade: detach affected media records and remove descendant folders.
    if (options.force) {
      for (const [recordId, record] of this.mediaRecords) {
        if (record.folderId && allIds.has(record.folderId)) {
          this.mediaRecords.set(recordId, { ...record, folderId: null, updatedAt: new Date().toISOString() });
        }
      }
      for (const descendantId of descendantIds) this.folders.delete(descendantId);
    }
    this.folders.delete(id);
    return { ok: true };
  }

  private buildPath(parentId: string | null, name: string): string {
    if (!parentId) return `/${name}`;
    const parent = this.folders.get(parentId);
    if (!parent) return `/${name}`;
    return `${parent.path}/${name}`;
  }

  private isDescendant(ancestorId: string, candidateId: string): boolean {
    let cursor: string | null = candidateId;
    while (cursor) {
      if (cursor === ancestorId) return true;
      const node = this.folders.get(cursor);
      cursor = node?.parentId ?? null;
    }
    return false;
  }

  private collectDescendantIds(rootId: string): string[] {
    const out: string[] = [];
    const stack: string[] = [rootId];
    while (stack.length) {
      const current = stack.pop() as string;
      for (const folder of this.folders.values()) {
        if (folder.parentId === current) {
          out.push(folder.id);
          stack.push(folder.id);
        }
      }
    }
    return out;
  }

  private recomputeDescendantPaths(rootId: string): void {
    const queue: string[] = [rootId];
    while (queue.length) {
      const currentId = queue.shift() as string;
      const current = this.folders.get(currentId);
      if (!current) continue;
      for (const folder of [...this.folders.values()]) {
        if (folder.parentId === currentId) {
          this.folders.set(folder.id, { ...folder, path: `${current.path}/${folder.name}` });
          queue.push(folder.id);
        }
      }
    }
  }
}

function normalizeFolderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("folder_name_required");
  if (trimmed.length > 120) throw new Error("folder_name_too_long");
  if (/[\\/]/.test(trimmed)) throw new Error("folder_name_invalid");
  return trimmed;
}

export function matchesMediaQuery(record: MediaRecord, query: MediaListQuery): boolean {
  const search = query.q?.trim().toLocaleLowerCase();
  if (search) {
    const haystack = [
      record.filename,
      record.key,
      record.url,
      record.contentType,
      ...Object.values(record.metadata ?? {})
    ].filter((value): value is string => typeof value === "string").join("\n").toLocaleLowerCase();
    if (!haystack.includes(search)) return false;
  }

  if (query.type && mediaTypeCategory(record.contentType) !== query.type) return false;
  if (query.from && Date.parse(record.createdAt) < Date.parse(query.from)) return false;
  if (query.to && Date.parse(record.createdAt) > Date.parse(query.to)) return false;
  if (query.folderId !== undefined) {
    const recordFolder = record.folderId ?? null;
    if (query.folderId === null) {
      if (recordFolder !== null) return false;
    } else if (recordFolder !== query.folderId) {
      return false;
    }
  }
  return true;
}

function mediaTypeCategory(contentType: string | undefined): "image" | "video" | "audio" | "document" | "other" {
  const mime = contentType?.split(";")[0]?.trim().toLocaleLowerCase() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (
    mime === "application/pdf" ||
    mime.startsWith("text/") ||
    mime.includes("document") ||
    mime.includes("spreadsheet") ||
    mime.includes("presentation")
  ) return "document";
  return "other";
}

export async function uploadMediaObject(storage: StorageAdapter, request: Request, options: MediaSecurityOptions = {}): Promise<Omit<MediaRecord, "id" | "createdAt" | "updatedAt">> {
  const { body, filename, contentType } = await readUpload(request);
  validateMediaContentType(contentType, options);
  const key = `media/${crypto.randomUUID()}-${safeFilename(filename)}`;
  const stored = await storage.put(key, body, {
    contentType,
    metadata: { filename }
  });
  return { ...stored, filename };
}

export type MediaPresignRequest = {
  filename: string;
  contentType: string;
  size: number;
};

export type MediaPresignSession = MediaPresignRequest & {
  uploadId: string;
  key: string;
  expiresAt: string;
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

export class MediaPresignStore {
  private readonly sessions = new Map<string, MediaPresignSession>();

  constructor(private readonly cache: CacheAdapter | null) {}

  async set(session: MediaPresignSession, ttl: number): Promise<void> {
    if (this.cache) {
      await this.cache.set(`media-presign:${session.uploadId}`, session, { ttl });
      return;
    }
    this.sessions.set(session.uploadId, session);
  }

  async get(uploadId: string): Promise<MediaPresignSession | null> {
    if (this.cache) return await this.cache.get<MediaPresignSession>(`media-presign:${uploadId}`);
    const session = this.sessions.get(uploadId) ?? null;
    if (session && Date.parse(session.expiresAt) <= Date.now()) {
      this.sessions.delete(uploadId);
      return null;
    }
    return session;
  }

  async delete(uploadId: string): Promise<void> {
    if (this.cache) {
      await this.cache.delete(`media-presign:${uploadId}`);
      return;
    }
    this.sessions.delete(uploadId);
  }
}

export async function createMediaPresign(storage: StorageAdapter, input: MediaPresignRequest, options: { expiresInSeconds?: number; maxSizeBytes?: number; allowActiveContent?: boolean } = {}): Promise<MediaPresignSession & { uploadUrl: string; method: "PUT" | "POST"; headers: Record<string, string> }> {
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

export async function confirmMediaUpload(mediaStore: MediaStore, storage: StorageAdapter, session: MediaPresignSession, input: MediaConfirmRequest): Promise<MediaRecord> {
  if (input.uploadId !== session.uploadId || input.key !== session.key) throw new Error("presign_session_mismatch");
  if (input.filename !== session.filename || input.contentType !== session.contentType || input.size !== session.size) throw new Error("presign_metadata_mismatch");
  if (Date.parse(session.expiresAt) <= Date.now()) throw new Error("presign_session_expired");
  const stored = await readStoredObject(storage, input.key);
  if (!stored) throw new Error("media_object_not_found");
  if (stored.size !== input.size) throw new Error("media_object_size_mismatch");
  if (stored.contentType && stored.contentType.split(";")[0]?.trim() !== input.contentType) throw new Error("media_object_content_type_mismatch");
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

async function readUpload(request: Request): Promise<{ body: Blob | ArrayBuffer; filename: string; contentType: string }> {
  const contentType = request.headers.get("content-type") ?? "application/octet-stream";
  if (contentType.includes("multipart/form-data")) {
    const data = await request.formData();
    const file = data.get("file");
    if (!(file instanceof File)) throw new Error("multipart upload requires a file field");
    return { body: file, filename: file.name || "upload.bin", contentType: file.type || "application/octet-stream" };
  }
  const filename = request.headers.get("x-filename") ?? "upload.bin";
  return { body: await request.arrayBuffer(), filename, contentType };
}

function safeFilename(filename: string): string {
  return filename.replaceAll(/[^a-zA-Z0-9._-]/g, "-").replaceAll(/-+/g, "-").slice(0, 120) || "upload.bin";
}

function validatePresignInput(input: MediaPresignRequest, maxSizeBytes = 1024 * 1024 * 1024, options: MediaSecurityOptions = {}): void {
  if (!input.filename.trim()) throw new Error("filename is required");
  validateMediaContentType(input.contentType, options);
  if (!Number.isFinite(input.size) || input.size <= 0) throw new Error("size must be greater than zero");
  if (input.size > maxSizeBytes) throw new Error("file exceeds max presigned upload size");
}

function validateMediaContentType(contentType: string, options: MediaSecurityOptions): void {
  const mime = contentType.split(";")[0]?.trim().toLocaleLowerCase() ?? "";
  if (!mime.includes("/")) throw new Error("contentType must be a valid MIME type");
  if (!options.allowActiveContent && ACTIVE_CONTENT_TYPES.has(mime)) throw new Error("active_content_not_allowed");
}
