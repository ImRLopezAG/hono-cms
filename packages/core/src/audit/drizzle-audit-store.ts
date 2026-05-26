import { and, desc, eq, gte, lte, lt, or, sql } from "drizzle-orm";
import { index as pgIndex, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { index as sqliteIndex, sqliteTable, text as sqliteText } from "drizzle-orm/sqlite-core";
import type { AuditLogEntry, AuditLogQuery, AuditOperation, AuditStore } from "../types/providers";

export type DrizzleAuditDialect = "sqlite" | "postgres";

export type CreateDrizzleAuditStoreOptions = {
  dialect: DrizzleAuditDialect;
  tableName?: string;
};

const DEFAULT_TABLE_NAME = "audit_log";
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

type AuditTable = ReturnType<typeof buildSqliteTable> | ReturnType<typeof buildPostgresTable>;

type AuditRow = {
  id: string;
  operation: string;
  collection: string | null;
  documentId: string | null;
  actorId: string | null;
  actorEmail: string | null;
  actorRoles: string | null;
  requestId: string;
  diffBefore: string | null;
  diffAfter: string | null;
  createdAt: string;
};

export function createDrizzleAuditStore(db: any, options: CreateDrizzleAuditStoreOptions): AuditStore {
  const tableName = options.tableName ?? DEFAULT_TABLE_NAME;
  const table = options.dialect === "postgres" ? buildPostgresTable(tableName) : buildSqliteTable(tableName);

  return {
    async append(entry: AuditLogEntry): Promise<void> {
      try {
        const row: AuditRow = {
          id: entry.id,
          operation: entry.operation,
          collection: entry.collection ?? null,
          documentId: entry.documentId ?? null,
          actorId: entry.actorId ?? null,
          actorEmail: entry.actorEmail ?? null,
          actorRoles: JSON.stringify(entry.actorRoles ?? []),
          requestId: entry.requestId,
          diffBefore: entry.diff.before == null ? null : JSON.stringify(entry.diff.before),
          diffAfter: entry.diff.after == null ? null : JSON.stringify(entry.diff.after),
          createdAt: entry.createdAt
        };
        await db.insert(table).values(row);
      } catch (error) {
        console.warn("[hono-cms/audit] failed to append audit log entry", error);
      }
    },

    async list(query: AuditLogQuery = {}): Promise<{ items: AuditLogEntry[]; nextCursor?: string }> {
      const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

      const filters: any[] = [];
      if (query.collection) filters.push(eq(table.collection, query.collection));
      if (query.documentId) filters.push(eq(table.documentId, query.documentId));
      if (query.operation) filters.push(eq(table.operation, query.operation));
      if (query.actorId) filters.push(eq(table.actorId, query.actorId));
      if (query.actorEmail) filters.push(eq(table.actorEmail, query.actorEmail));
      if (query.from) filters.push(gte(table.createdAt, query.from));
      if (query.to) filters.push(lte(table.createdAt, query.to));

      if (query.cursor) {
        const decoded = decodeCursor(query.cursor);
        if (decoded) {
          // (createdAt, id) DESC -- next page WHERE createdAt < c OR (createdAt = c AND id < cid)
          const cursorFilter = or(
            lt(table.createdAt, decoded.createdAt),
            and(eq(table.createdAt, decoded.createdAt), lt(table.id, decoded.id))
          );
          if (cursorFilter) filters.push(cursorFilter);
        }
      }

      const whereClause = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);

      let builder: any = db.select().from(table);
      if (whereClause) builder = builder.where(whereClause);
      builder = builder.orderBy(desc(table.createdAt), desc(table.id)).limit(limit + 1);

      const rows = (await builder) as AuditRow[];

      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      const items = sliced.map(rowToEntry);
      const last = sliced.at(-1);

      if (hasMore && last) {
        return { items, nextCursor: encodeCursor(last.createdAt, last.id) };
      }
      return { items };
    },

    async cleanup(olderThan: Date): Promise<number> {
      try {
        const cutoff = olderThan.toISOString();
        const result = await db.delete(table).where(lt(table.createdAt, cutoff));
        return extractAffectedCount(result);
      } catch (error) {
        console.warn("[hono-cms/audit] failed to cleanup audit log entries", error);
        return 0;
      }
    },

    async health(): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
      try {
        await db.execute ? await db.execute(sql`SELECT 1`) : await db.run?.(sql`SELECT 1`);
        return { ok: true, details: { table: tableName } };
      } catch (error) {
        return { ok: false, details: { table: tableName, error: error instanceof Error ? error.message : String(error) } };
      }
    }
  };
}

function buildSqliteTable(name: string) {
  return sqliteTable(name, {
    id: sqliteText("id").primaryKey(),
    operation: sqliteText("operation").notNull(),
    collection: sqliteText("collection"),
    documentId: sqliteText("document_id"),
    actorId: sqliteText("actor_id"),
    actorEmail: sqliteText("actor_email"),
    actorRoles: sqliteText("actor_roles").notNull(),
    requestId: sqliteText("request_id").notNull(),
    diffBefore: sqliteText("diff_before"),
    diffAfter: sqliteText("diff_after"),
    createdAt: sqliteText("created_at").notNull()
  }, (t) => ({
    createdAtIdx: sqliteIndex("audit_log_created_at_idx").on(t.createdAt),
    collectionIdx: sqliteIndex("audit_log_collection_idx").on(t.collection),
    documentIdIdx: sqliteIndex("audit_log_document_id_idx").on(t.documentId)
  }));
}

function buildPostgresTable(name: string) {
  return pgTable(name, {
    id: pgText("id").primaryKey(),
    operation: pgText("operation").notNull(),
    collection: pgText("collection"),
    documentId: pgText("document_id"),
    actorId: pgText("actor_id"),
    actorEmail: pgText("actor_email"),
    actorRoles: pgText("actor_roles").notNull(),
    requestId: pgText("request_id").notNull(),
    diffBefore: pgText("diff_before"),
    diffAfter: pgText("diff_after"),
    createdAt: pgText("created_at").notNull()
  }, (t) => ({
    createdAtIdx: pgIndex("audit_log_created_at_idx").on(t.createdAt),
    collectionIdx: pgIndex("audit_log_collection_idx").on(t.collection),
    documentIdIdx: pgIndex("audit_log_document_id_idx").on(t.documentId)
  }));
}

function rowToEntry(row: AuditRow): AuditLogEntry {
  const entry: AuditLogEntry = {
    id: row.id,
    operation: row.operation as AuditOperation,
    actorRoles: parseJsonArray(row.actorRoles),
    requestId: row.requestId,
    diff: {
      before: parseJsonObject(row.diffBefore),
      after: parseJsonObject(row.diffAfter)
    },
    createdAt: row.createdAt
  };
  if (row.collection != null) entry.collection = row.collection;
  if (row.documentId != null) entry.documentId = row.documentId;
  if (row.actorId != null) entry.actorId = row.actorId;
  if (row.actorEmail != null) entry.actorEmail = row.actorEmail;
  return entry;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function encodeCursor(createdAt: string, id: string): string {
  const payload = `${createdAt}:${id}`;
  const bytes = new TextEncoder().encode(payload);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(token: string): { createdAt: string; id: string } | null {
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

function extractAffectedCount(result: unknown): number {
  if (!result) return 0;
  if (typeof result === "number") return result;
  if (Array.isArray(result)) return result.length;
  const candidate = result as { rowsAffected?: number; rowCount?: number; changes?: number; count?: number };
  if (typeof candidate.rowsAffected === "number") return candidate.rowsAffected;
  if (typeof candidate.rowCount === "number") return candidate.rowCount;
  if (typeof candidate.changes === "number") return candidate.changes;
  if (typeof candidate.count === "number") return candidate.count;
  return 0;
}
