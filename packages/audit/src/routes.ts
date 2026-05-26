import type { Hono } from "hono";
import type {
  AuditLogQuery,
  AuditOperation,
  AuditStore,
  HonoCMSEnv
} from "@hono-cms/core";
import { auditEntriesToCSV } from "./csv";

const AUDIT_OPERATIONS = new Set<AuditOperation>([
  "create",
  "update",
  "delete",
  "publish",
  "unpublish",
  "media_upload",
  "media_delete",
  "schema_change"
]);

/**
 * Issue surfaced for malformed query parameters. Mirrors the shape used by the
 * core's `parseQueryParams` so admin UIs can render the messages uniformly.
 */
export type AuditQueryIssue = {
  path: string[];
  message: string;
};

/**
 * Mount `GET /cms/audit-log` onto the supplied app.
 *
 * Admin-gated: anonymous callers receive 401, non-admin sessions receive 403.
 * Validates the query string up-front, returns 422 with `{ error, issues }` on
 * malformed input, and supports `?format=csv` to stream the same result set as
 * a CSV download.
 */
export function mountAuditRoutes(app: Hono<HonoCMSEnv>, store: AuditStore | null): void {
  app.get("/cms/audit-log", async (context) => {
    const session = context.get("session");
    if (!session) return context.json({ error: "unauthorized" }, 401);
    if (!session.roles.includes("admin")) return context.json({ error: "forbidden" }, 403);
    if (!store) return context.json({ items: [] });

    const url = new URL(context.req.url);
    const parsed = parseAuditQuery(url);
    if (parsed.issues.length) {
      return context.json({ error: "validation_error", issues: parsed.issues }, 422);
    }
    const result = await store.list(parsed.query);
    if (parsed.query.format === "csv") {
      return new Response(auditEntriesToCSV(result.items), {
        headers: { "content-type": "text/csv; charset=utf-8" }
      });
    }
    return context.json(result);
  });
}

/**
 * Parse the `?...` query string for `GET /cms/audit-log`. Validates every
 * field against the documented contract (operations whitelist, date parseable,
 * `from <= to`, integer limit between 1 and 100, csv|json format).
 *
 * Exported for the plugin's tests; downstream callers should generally use the
 * route directly.
 */
export function parseAuditQuery(url: URL): {
  query: AuditLogQuery;
  issues: AuditQueryIssue[];
} {
  const query: AuditLogQuery = {};
  const issues: AuditQueryIssue[] = [];

  const collection = url.searchParams.get("collection");
  const documentId = url.searchParams.get("documentId");
  const operation = url.searchParams.get("operation");
  const actorId = url.searchParams.get("actorId");
  const actorEmail = url.searchParams.get("actorEmail");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const cursor = url.searchParams.get("cursor");
  const format = url.searchParams.get("format");

  if (collection) query.collection = collection;
  if (documentId) query.documentId = documentId;
  if (operation) {
    if (AUDIT_OPERATIONS.has(operation as AuditOperation)) {
      query.operation = operation as AuditOperation;
    } else {
      issues.push({ path: ["operation"], message: "operation is not supported" });
    }
  }
  if (actorId) query.actorId = actorId;
  if (actorEmail) query.actorEmail = actorEmail;
  if (from) {
    if (Number.isNaN(Date.parse(from))) {
      issues.push({ path: ["from"], message: "from must be a valid date-time" });
    } else {
      query.from = from;
    }
  }
  if (to) {
    if (Number.isNaN(Date.parse(to))) {
      issues.push({ path: ["to"], message: "to must be a valid date-time" });
    } else {
      query.to = to;
    }
  }
  if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) {
    issues.push({ path: ["from", "to"], message: "from must be before to" });
  }
  if (cursor) query.cursor = cursor;
  if (format) {
    if (format === "csv" || format === "json") query.format = format;
    else issues.push({ path: ["format"], message: "format must be json or csv" });
  }

  const rawLimit = url.searchParams.get("limit");
  const limit = Number(rawLimit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    issues.push({ path: ["limit"], message: "limit must be an integer between 1 and 100" });
  } else {
    query.limit = limit;
  }

  return { query, issues };
}
