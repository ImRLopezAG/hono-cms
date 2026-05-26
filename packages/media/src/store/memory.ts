import type {
  CacheAdapter,
  HealthStatus,
  MediaFolder,
  MediaFolderStore,
  MediaRecord,
  MediaStore
} from "@hono-cms/core";
import type { MediaListQuery } from "../types";


/**
 * In-memory `MediaStore` used as the plugin's default backend.
 *
 * Exercises the full media surface (list/get/create/update/delete + folders)
 * without an external database. Not recommended for production — records are
 * lost on process restart. Production deployments should provide a custom
 * `MediaStore` (e.g. drizzle-backed) via `mediaPlugin({ store })`.
 */
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

  async update(
    id: string,
    patch: Partial<Pick<MediaRecord, "folderId" | "filename" | "metadata">>
  ): Promise<MediaRecord | null> {
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

  async health(): Promise<HealthStatus> {
    return { ok: true, details: { records: this.records.size, folders: this.folders.size } };
  }
}

/**
 * In-memory `MediaFolderStore` — stores folders as a flat list with parent
 * references and a derived `path` (built from ancestor names so the admin UI
 * can render breadcrumbs cheaply). Cascades deletes through descendants when
 * `force: true` is supplied, detaching affected media records to the root.
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

  async update(
    id: string,
    patch: { name?: string; parentId?: string | null }
  ): Promise<MediaFolder | null> {
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

/**
 * Internal filter helper, exported so other in-memory test fixtures or
 * downstream stores can reuse the same matching rules.
 */
export function matchesMediaQuery(record: MediaRecord, query: MediaListQuery): boolean {
  const search = query.q?.trim().toLocaleLowerCase();
  if (search) {
    const haystack = [
      record.filename,
      record.key,
      record.url,
      record.contentType,
      ...Object.values(record.metadata ?? {})
    ]
      .filter((value): value is string => typeof value === "string")
      .join("\n")
      .toLocaleLowerCase();
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
  )
    return "document";
  return "other";
}

/**
 * Presign session record produced by `createMediaPresign` and consumed by
 * `confirmMediaUpload` after the client has uploaded the bytes directly to
 * storage. Defined here (instead of `presign.ts`) so the store can own the
 * type alongside its persistence wrapper.
 */
export type MediaPresignSession = {
  uploadId: string;
  key: string;
  filename: string;
  contentType: string;
  size: number;
  expiresAt: string;
};

/**
 * Persists pending presigned-upload sessions until the client confirms (or the
 * TTL expires). Backed by an injected `CacheAdapter` when present so multi-
 * instance deployments can share state; falls back to a per-process Map
 * otherwise.
 */
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
