/**
 * Legacy shared types retained for downstream plugin packages that
 * still narrow the opaque `Identity` via a role/permission shape. New
 * code should prefer the manifest types from `@hono-cms/core/plugins/types`.
 */

export type RBACRule = {
  action: "create" | "read" | "update" | "delete" | "publish";
  collection: string;
  roles: readonly string[];
};

export type HookContext = {
  collection: string;
  id?: string;
  session: { userId: string; roles: string[] } | null;
  request: Request;
};

export type HookFunction = (
  input: Record<string, unknown>,
  context: HookContext
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
