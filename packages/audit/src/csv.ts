import type { AuditLogEntry } from "@hono-cms/core";

const HEADER = [
  "id",
  "createdAt",
  "operation",
  "collection",
  "documentId",
  "actorId",
  "actorEmail",
  "requestId"
] as const;

/**
 * Serialize audit log entries to a CSV string with a fixed header order.
 *
 * Diff payloads and roles are intentionally omitted — CSV is the spreadsheet
 * format for the admin "download recent activity" workflow; structured fields
 * should be queried through the JSON endpoint.
 */
export function auditEntriesToCSV(entries: readonly AuditLogEntry[]): string {
  const rows = entries.map((entry) =>
    HEADER.map((key) => csvCell(entry[key as keyof AuditLogEntry])).join(",")
  );
  return `${HEADER.join(",")}\n${rows.join("\n")}\n`;
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}
