import type {
  AuditLogEntry,
  AuditLogQuery,
  AuditStore,
  HealthStatus
} from "@hono-cms/core";

/**
 * In-memory `AuditStore` used as the plugin's default backend.
 *
 * Provides the full `append` / `list` / `cleanup` / `health` surface so plugin
 * behavior can be exercised end-to-end without an external database. Not
 * recommended for production — entries are lost on process restart.
 */
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
    return start + limit < rows.length && last
      ? { items, nextCursor: encodeAuditCursor(last.createdAt, last.id) }
      : { items };
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

  async health(): Promise<HealthStatus> {
    return { ok: true, details: { entries: this.entries.length } };
  }
}

/**
 * Encode a `(createdAt, id)` cursor as URL-safe base64. Exposed for tests and
 * for downstream stores that want to stay wire-compatible.
 */
export function encodeAuditCursor(createdAt: string, id: string): string {
  const payload = `${createdAt}:${id}`;
  const bytes = new TextEncoder().encode(payload);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Inverse of {@link encodeAuditCursor}. Returns `null` on malformed input. */
export function decodeAuditCursor(token: string): { createdAt: string; id: string } | null {
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
