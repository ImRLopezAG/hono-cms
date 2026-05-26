import type { Authorize, AuthorizeAction, PluginContext } from "@hono-cms/core";
import { ROLES_TABLE, type PermissionMatrix, type RoleRow } from "./tables/roles";
import type { TokensIdentity } from "./protected";

/**
 * Identity scoping for `authorize()`.
 *
 * The kernel's {@link Authorize} signature is `(action, collection, resource) => bool`
 * — there is no Hono `Context` argument. We need the *current* request's
 * identity (stamped by `protected`) to resolve a role; the cleanest portable
 * channel that survives concurrent requests is `AsyncLocalStorage`, which is
 * implemented identically on Node, Bun, Deno, and Workers (Workers ships
 * it through `node:async_hooks` since 2023). If a runtime ever ships
 * without it we fall back to a single-slot module variable — only safe
 * under strictly single-tenant request handling.
 */
export type IdentityScope = {
  run<T>(identity: TokensIdentity | null, fn: () => Promise<T>): Promise<T>;
  current(): TokensIdentity | null;
};

export function createIdentityScope(): IdentityScope {
  type ALSClass = new () => {
    run<T>(store: TokensIdentity | null, fn: () => Promise<T>): Promise<T>;
    getStore(): TokensIdentity | null | undefined;
  };

  const AsyncLocalStorageCtor = tryGetAsyncLocalStorage() as ALSClass | null;
  if (AsyncLocalStorageCtor) {
    const als = new AsyncLocalStorageCtor();
    return {
      async run(identity, fn) {
        return als.run(identity, fn);
      },
      current() {
        return als.getStore() ?? null;
      }
    };
  }

  let slot: TokensIdentity | null = null;
  return {
    async run(identity, fn) {
      const previous = slot;
      slot = identity;
      try {
        return await fn();
      } finally {
        slot = previous;
      }
    },
    current() {
      return slot;
    }
  };
}

function tryGetAsyncLocalStorage(): unknown {
  type GlobalLike = typeof globalThis & {
    AsyncLocalStorage?: unknown;
    require?: (s: string) => { AsyncLocalStorage?: unknown };
    process?: NodeJS.Process & { getBuiltinModule?: (s: string) => unknown };
  };
  const g = globalThis as GlobalLike;
  if (g.AsyncLocalStorage) return g.AsyncLocalStorage;
  if (typeof g.require === "function") {
    try {
      const mod = g.require("node:async_hooks");
      if (mod?.AsyncLocalStorage) return mod.AsyncLocalStorage;
    } catch {
      // fall through
    }
  }
  if (typeof g.process !== "undefined" && typeof g.process.getBuiltinModule === "function") {
    try {
      const mod = g.process.getBuiltinModule("async_hooks") as { AsyncLocalStorage?: unknown } | undefined;
      if (mod?.AsyncLocalStorage) return mod.AsyncLocalStorage;
    } catch {
      // fall through
    }
  }
  return null;
}

/**
 * Build the {@link Authorize} function backed by the `roles` table.
 *
 * Lookup order (mirrors Strapi RBAC):
 *
 *   1. `permissions[collection]?.[action]`     — exact match
 *   2. `permissions["*"]?.[action]`            — action on any collection
 *   3. `permissions[collection]?.["*"]`        — any action on this collection
 *   4. `permissions["*"]?.["*"]`               — full wildcard (root role)
 *   5. `false`                                  — explicit deny
 *
 * The identity backing each call is resolved through the supplied scope. Per
 * request, the protected middleware wraps `next()` in `scope.run(identity, ...)`
 * so any `authorize()` issued from inside route handlers sees the right value.
 * Per-request role caching is intentionally deferred (KTD-4); each call
 * issues one DB read.
 */
export function createAuthorize(opts: {
  ctx: PluginContext;
  scope: IdentityScope;
}): Authorize {
  const { ctx, scope } = opts;
  return async (action: AuthorizeAction, collection: string | null) => {
    const identity = scope.current();
    if (!identity) return false;
    const ns = identity.namespace;
    if (typeof ns !== "string" || ns.length === 0) return false;

    const result = await ctx.db.list(ROLES_TABLE, { filters: { name: ns }, limit: 1 });
    const role = result.items[0] as RoleRow | undefined;
    if (!role) return false;
    const permissions = role.permissions ?? {};

    return permissionLookup(permissions, collection ?? "*", action);
  };
}

/**
 * Walk the permission matrix in the documented precedence order.
 *
 * Exported for unit testing and for plugins that want to reuse the same
 * semantics on their own role tables.
 */
export function permissionLookup(
  permissions: PermissionMatrix,
  collection: string,
  action: string
): boolean {
  return (
    permissions[collection]?.[action] ??
    permissions["*"]?.[action] ??
    permissions[collection]?.["*"] ??
    permissions["*"]?.["*"] ??
    false
  );
}
