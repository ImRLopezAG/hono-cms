import type { AuditDiff, AuditLogEntry, AuditLogQuery, AuditOperation, AuditStore, AuthSession, ContentRecord } from "./types/providers";

export type AuditConfig = {
  excludeFields?: readonly string[];
  maxFieldBytes?: number;
};

export class MemoryAuditStore implements AuditStore {
  private readonly entries: AuditLogEntry[] = [];

  async append(entry: AuditLogEntry): Promise<void> {
    this.entries.unshift(entry);
  }

  async list(query: AuditLogQuery = {}): Promise<{ items: AuditLogEntry[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    let rows = [...this.entries];
    if (query.collection) rows = rows.filter((entry) => entry.collection === query.collection);
    if (query.documentId) rows = rows.filter((entry) => entry.documentId === query.documentId);
    if (query.operation) rows = rows.filter((entry) => entry.operation === query.operation);
    if (query.actorId) rows = rows.filter((entry) => entry.actorId === query.actorId);
    if (query.actorEmail) rows = rows.filter((entry) => entry.actorEmail === query.actorEmail);
    if (query.from) rows = rows.filter((entry) => Date.parse(entry.createdAt) >= Date.parse(query.from ?? ""));
    if (query.to) rows = rows.filter((entry) => Date.parse(entry.createdAt) <= Date.parse(query.to ?? ""));
    const decoded = query.cursor ? decodeAuditCursor(query.cursor) : null;
    const start = decoded ? Math.max(rows.findIndex((entry) => entry.id === decoded.id) + 1, 0) : 0;
    const items = rows.slice(start, start + limit);
    const last = items.at(-1);
    return start + limit < rows.length && last ? { items, nextCursor: encodeAuditCursor(last.createdAt, last.id) } : { items };
  }

  async cleanup(olderThan: Date): Promise<number> {
    const before = this.entries.length;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      if (new Date(this.entries[index]?.createdAt ?? 0) < olderThan) {
        this.entries.splice(index, 1);
      }
    }
    return before - this.entries.length;
  }

  async health(): Promise<{ ok: boolean; details: { entries: number } }> {
    return { ok: true, details: { entries: this.entries.length } };
  }
}

export function computeDiff(before: ContentRecord | null, after: ContentRecord | null, config: AuditConfig = {}): AuditDiff {
  const exclude = new Set(["password", "token", "secret", "cookie", "authorization", ...(config.excludeFields ?? [])]);
  const maxFieldBytes = config.maxFieldBytes ?? 10 * 1024;
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const beforeDiff: Record<string, unknown> = {};
  const afterDiff: Record<string, unknown> = {};

  for (const key of keys) {
    if (exclude.has(key)) continue;
    const previous = before?.[key];
    const next = after?.[key];
    if (deepEqual(previous, next)) continue;
    beforeDiff[key] = truncate(previous, maxFieldBytes);
    afterDiff[key] = truncate(next, maxFieldBytes);
  }

  return {
    before: before ? beforeDiff : null,
    after: after ? afterDiff : null
  };
}

export async function auditLogCleanupJob(options: {
  store: AuditStore | null;
  retentionDays?: number;
  now?: Date;
}): Promise<{ deletedCount: number; olderThan?: string }> {
  const retentionDays = options.retentionDays ?? 90;
  if (retentionDays <= 0) {
    console.warn(`[hono-cms/audit] audit log cleanup skipped because retentionDays is ${retentionDays}.`);
    return { deletedCount: 0 };
  }

  const now = options.now ?? new Date();
  const olderThan = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deletedCount = await options.store?.cleanup?.(olderThan) ?? 0;
  return { deletedCount, olderThan: olderThan.toISOString() };
}

export async function writeAuditEntry(options: {
  store: AuditStore | null;
  operation: AuditOperation;
  collection: string;
  before: ContentRecord | null;
  after: ContentRecord | null;
  session: AuthSession | null;
  requestId: string;
  config?: AuditConfig;
}): Promise<void> {
  if (!options.store) return;
  const documentId = options.after?.id ?? options.before?.id;
  try {
    const entry: AuditLogEntry = {
      id: crypto.randomUUID(),
      operation: options.operation,
      collection: options.collection,
      actorRoles: options.session?.roles ?? [],
      requestId: options.requestId,
      diff: computeDiff(options.before, options.after, options.config),
      createdAt: new Date().toISOString()
    };
    if (documentId) entry.documentId = documentId;
    if (options.session?.userId) entry.actorId = options.session.userId;
    if (options.session?.email) entry.actorEmail = options.session.email;
    await options.store.append(entry);
  } catch (error) {
    console.warn("Failed to write audit log entry", error);
  }
}

export function auditEntriesToCSV(entries: readonly AuditLogEntry[]): string {
  const header = ["id", "createdAt", "operation", "collection", "documentId", "actorId", "actorEmail", "requestId"];
  const rows = entries.map((entry) => header.map((key) => csvCell(entry[key as keyof AuditLogEntry])).join(","));
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

function truncate(value: unknown, maxBytes: number): unknown {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxBytes) return value;
  return { truncated: true, length: serialized.length };
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function encodeAuditCursor(createdAt: string, id: string): string {
  const payload = `${createdAt}:${id}`;
  const bytes = new TextEncoder().encode(payload);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeAuditCursor(token: string): { createdAt: string; id: string } | null {
  try {
    const normalized = token.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const sep = decoded.indexOf(":");
    if (sep < 0) return null;
    const createdAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
