import type { PluginTableDef } from "@hono-cms/core";

/** Logical table name under which the audit plugin declares its rows. */
export const AUDIT_LOG_TABLE = "audit_log";

/**
 * Schema declaration for the `audit_log` system table.
 *
 * The plugin's default `MemoryAuditStore` doesn't touch this table — it lives
 * entirely in process memory — but declaring it through `Plugin.schema` lets
 * users wire a drizzle-backed store (`createDrizzleAuditStore`) without
 * authoring a separate migration. The kernel's migration surface picks the
 * table up automatically.
 */
export const auditLogTable: PluginTableDef = {
  modelName: "AuditLog",
  fields: {
    id: { type: "string", required: true, unique: true },
    operation: { type: "string", required: true },
    collection: { type: "string" },
    documentId: { type: "string" },
    actorId: { type: "string" },
    actorEmail: { type: "string" },
    actorRoles: { type: "string", required: true },
    requestId: { type: "string", required: true },
    diffBefore: { type: "string" },
    diffAfter: { type: "string" },
    createdAt: { type: "date", required: true }
  }
};
