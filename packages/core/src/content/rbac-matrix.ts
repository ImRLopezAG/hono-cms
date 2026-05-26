import type { CMSConfig } from "../types/config";
import type { Action } from "./rbac";

/**
 * Aggregates the static RBAC configuration into a read-only matrix that
 * the admin UI can display. RBAC in Hono CMS is config-driven (see
 * `rbac.ts`), so this is purely a derived view — there is no write path.
 *
 * The matrix surfaces:
 *   - `roles`: a sorted, de-duplicated list of every role that appears
 *     anywhere in the rules. The implicit `admin` role is always
 *     included because the runtime grants it unrestricted access.
 *   - `rules`: the global `cms.config.rbac.rules` array, normalized as
 *     plain objects (no `readonly` wrappers) for JSON serialization.
 *   - `collections`: one entry per collection in the schema, surfacing
 *     the per-collection `options.rbac.public` and `options.rbac.authenticated`
 *     allow-lists so the UI can render them as their own column.
 *   - `publicRead`: whether the global `rbac.publicRead` escape hatch is
 *     enabled (any unauthenticated request can read any collection).
 */
export const RBAC_ACTIONS: readonly Action[] = ["create", "read", "update", "delete", "publish"];

export type RBACMatrixRule = {
  action: Action;
  collection: string;
  roles: string[];
};

export type RBACMatrixCollection = {
  name: string;
  public: Action[];
  authenticated: Action[];
};

export type RBACMatrix = {
  roles: string[];
  rules: RBACMatrixRule[];
  collections: RBACMatrixCollection[];
  publicRead: boolean;
};

export function buildRBACMatrix(config: Pick<CMSConfig, "collections" | "rbac">): RBACMatrix {
  const rules: RBACMatrixRule[] = (config.rbac?.rules ?? []).map((rule) => ({
    action: rule.action,
    collection: rule.collection,
    roles: [...rule.roles]
  }));

  const collections: RBACMatrixCollection[] = Object.entries(config.collections)
    .map(([name, collection]) => ({
      name,
      public: [...(collection.options.rbac?.public ?? [])] as Action[],
      authenticated: [...(collection.options.rbac?.authenticated ?? [])] as Action[]
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const roleSet = new Set<string>(["admin"]);
  for (const rule of rules) {
    for (const role of rule.roles) roleSet.add(role);
  }
  const roles = [...roleSet].sort((a, b) => {
    if (a === "admin") return -1;
    if (b === "admin") return 1;
    return a.localeCompare(b);
  });

  return {
    roles,
    rules,
    collections,
    publicRead: Boolean(config.rbac?.publicRead)
  };
}
