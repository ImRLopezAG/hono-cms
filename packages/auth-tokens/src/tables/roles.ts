import type { PluginTableDef } from "@hono-cms/core";

/**
 * Schema declaration for the `roles` table.
 *
 * The `permissions` JSON column carries a `{ [collection]: { [action]: bool } }`
 * matrix with wildcard support (`"*"`) for both keys — see
 * `authorize.ts` for the lookup order.
 */
export const rolesTable: PluginTableDef = {
  modelName: "Role",
  fields: {
    id: { type: "string", required: true, unique: true },
    name: { type: "string", required: true, unique: true },
    description: { type: "string" },
    permissions: { type: "json", required: true },
    createdAt: { type: "date", required: true },
    updatedAt: { type: "date", required: true }
  }
};

/**
 * Plain-object shape stored in the `roles` table.
 *
 * `permissions` mirrors the JSON column: `{ [collection]: { [action]: bool } }`
 * with the `"*"` wildcard for both keys.
 */
export type RoleRow = {
  id: string;
  name: string;
  description: string | null;
  permissions: PermissionMatrix;
  createdAt: string;
  updatedAt: string;
};

export type PermissionMatrix = Record<string, Record<string, boolean>>;

export const ROLES_TABLE = "roles";
