import type { PluginTableDef } from "@hono-cms/core";

/**
 * Schema declaration for the `api_keys` table.
 *
 * Declared here for the kernel's migration surface; row reads/writes flow
 * through {@link DatabaseAdapter} (`ctx.db.list/create/update/delete`) so the
 * service stays portable across every database provider.
 */
export const apiKeysTable: PluginTableDef = {
  modelName: "ApiKey",
  fields: {
    id: { type: "string", required: true, unique: true },
    tokenHash: { type: "string", required: true, unique: true },
    tokenPrefix: { type: "string", required: true },
    namespace: { type: "string", required: true },
    name: { type: "string" },
    metadata: { type: "json" },
    expiresAt: { type: "date", required: true },
    maxIdleMs: { type: "number", required: true },
    lastUsedAt: { type: "date", required: true },
    revoked: { type: "boolean", required: true },
    replacedBy: { type: "string" },
    createdAt: { type: "date", required: true },
    updatedAt: { type: "date", required: true }
  }
};
