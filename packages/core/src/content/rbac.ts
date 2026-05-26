import type { CMSConfig } from "../types/config";
import type { AuthSession } from "../types/providers";

export type Action = "create" | "read" | "update" | "delete" | "publish";

export function canAccess(config: Pick<CMSConfig, "collections" | "rbac">, session: AuthSession | null, action: Action, collection: string): boolean {
  if (action === "read" && config.rbac?.publicRead) return true;
  const collectionRbac = config.collections[collection]?.options.rbac;
  if (collectionRbac?.public?.includes(action)) return true;
  if (!session) return false;
  if (session.roles.includes("admin")) return true;
  if (collectionRbac?.authenticated?.includes(action)) return true;

  const rules = config.rbac?.rules ?? [];
  return rules.some((rule) =>
    rule.action === action &&
    rule.collection === collection &&
    rule.roles.some((role) => session.roles.includes(role))
  );
}
