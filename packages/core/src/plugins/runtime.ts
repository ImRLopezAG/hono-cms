import type { Hono, MiddlewareHandler } from "hono";
import type { CMSCollections } from "@hono-cms/schema";
import type { HonoCMSEnv } from "../types/instance";
import { mergeSchemas } from "./schema-merge";
import {
  CMSPluginError,
  type Authorize,
  type AuthPlugin,
  type CMSPluginCapabilities,
  type MountPhase,
  type Plugin,
  type PluginContext,
  type PluginTableDef
} from "./types";

export type InstallResult<Collections extends CMSCollections> = {
  authPlugin?: AuthPlugin<Collections> | undefined;
  authorize: Authorize;
  trustedOrigins: readonly string[];
  rateLimits: ReadonlyArray<{ pluginId: string; declaration: NonNullable<Plugin["rateLimit"]>[number] }>;
  onRequest: ReadonlyArray<(req: Request) => Promise<Response | Request | void>>;
  onResponse: ReadonlyArray<(res: Response) => Promise<Response | void>>;
  installedIds: readonly string[];
};

function isAuthPlugin<Collections extends CMSCollections>(
  plugin: Plugin<Collections>
): plugin is AuthPlugin<Collections> {
  return typeof (plugin as AuthPlugin<Collections>).protected === "function";
}

function phaseOf<Collections extends CMSCollections>(plugin: Plugin<Collections>): MountPhase {
  return plugin.mountPhase ?? "normal";
}

const PHASE_ORDER: readonly MountPhase[] = ["early", "normal", "catchAll"];

/**
 * Validate the plugin array and return a stable install order.
 *
 * Auto-orders plugins by their `requires` graph using Kahn's algorithm —
 * users no longer need to hand-order the array. Phase ordering
 * (`early -> normal -> catchAll`) is applied on top of the topological
 * sort, so within a phase the topo order is preserved.
 *
 * Validation, in order:
 *   1. Every plugin has an `id`, no duplicates.
 *   2. Every `requires` entry references a plugin that's installed.
 *   3. No `requires` cycle exists.
 *   4. No cross-phase requirement violation (e.g. `early` cannot require
 *      `normal` — phases run in fixed order, so the require could never
 *      be satisfied).
 *   5. At most one AuthPlugin.
 *   6. At most one `mountPhase: "catchAll"`.
 */
export function validateAndOrder<Collections extends CMSCollections>(
  plugins: readonly Plugin<Collections>[]
): readonly Plugin<Collections>[] {
  // -- 1. ID validation -------------------------------------------------------
  const idToIndex = new Map<string, number>();
  for (const [index, plugin] of plugins.entries()) {
    if (!plugin.id) {
      throw new CMSPluginError(`Plugin at index ${index} has no \`id\`.`);
    }
    if (idToIndex.has(plugin.id)) {
      throw new CMSPluginError(
        `Duplicate plugin id "${plugin.id}" at indices ${idToIndex.get(plugin.id)} and ${index}.`
      );
    }
    idToIndex.set(plugin.id, index);
  }

  // -- 2. Missing-dep validation ---------------------------------------------
  for (const plugin of plugins) {
    for (const requiredId of plugin.requires ?? []) {
      if (!idToIndex.has(requiredId)) {
        throw new CMSPluginError(
          `Plugin "${plugin.id}" requires "${requiredId}" which is not installed. ` +
          `Add it to \`plugins: [...]\`.`
        );
      }
    }
  }

  // -- 3. AuthPlugin / catchAll cardinality ---------------------------------
  const authPlugins = plugins.filter((p) => isAuthPlugin(p));
  if (authPlugins.length > 1) {
    throw new CMSPluginError(
      `Exactly one AuthPlugin is allowed in \`plugins: [...]\`. Found ${authPlugins.length}: ${authPlugins
        .map((p) => `"${p.id}"`)
        .join(", ")}.`
    );
  }

  const catchAlls = plugins.filter((p) => phaseOf(p) === "catchAll");
  if (catchAlls.length > 1) {
    throw new CMSPluginError(
      `Only one plugin may declare \`mountPhase: "catchAll"\`. Found ${catchAlls.length}: ${catchAlls
        .map((p) => `"${p.id}"`)
        .join(", ")}.`
    );
  }

  // -- 4. Cross-phase require check -----------------------------------------
  // Phases run in fixed order (early -> normal -> catchAll), so a require
  // that points to a later phase can never be satisfied. Reject explicitly
  // rather than silently violate the require after re-grouping.
  const phaseRank: Record<MountPhase, number> = { early: 0, normal: 1, catchAll: 2 };
  for (const plugin of plugins) {
    for (const requiredId of plugin.requires ?? []) {
      const required = plugins[idToIndex.get(requiredId)!]!;
      if (phaseRank[phaseOf(required)] > phaseRank[phaseOf(plugin)]) {
        throw new CMSPluginError(
          `Plugin "${plugin.id}" (phase "${phaseOf(plugin)}") requires "${requiredId}" ` +
          `(phase "${phaseOf(required)}") which runs in a later phase. Move "${requiredId}" ` +
          `to an equal-or-earlier phase, or drop the require.`
        );
      }
    }
  }

  // -- 5. Topological sort (Kahn's algorithm) -------------------------------
  // Build adjacency: edges go from required -> requirer (so an in-edge means
  // "I have an unmet dependency").
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const plugin of plugins) {
    inDegree.set(plugin.id, 0);
    dependents.set(plugin.id, []);
  }
  for (const plugin of plugins) {
    for (const requiredId of plugin.requires ?? []) {
      inDegree.set(plugin.id, (inDegree.get(plugin.id) ?? 0) + 1);
      dependents.get(requiredId)!.push(plugin.id);
    }
  }

  // Stable topo: walk the original array in order. When a plugin's
  // dependencies are all satisfied, push it and decrement its dependents'
  // counts in the same pass — so a plugin that only depends on the *previous*
  // entry naturally lands in its original slot. This preserves user-array
  // ordering for plugins whose dependencies happen to already precede them
  // (the common case), and only relocates plugins whose required predecessor
  // appears later.
  const sorted: Plugin<Collections>[] = [];
  const consumed = new Set<string>();
  while (sorted.length < plugins.length) {
    let progress = false;
    for (const plugin of plugins) {
      if (consumed.has(plugin.id)) continue;
      if ((inDegree.get(plugin.id) ?? 0) !== 0) continue;
      sorted.push(plugin);
      consumed.add(plugin.id);
      progress = true;
      for (const dep of dependents.get(plugin.id) ?? []) {
        inDegree.set(dep, (inDegree.get(dep) ?? 0) - 1);
      }
    }
    if (!progress) {
      const stuck = plugins
        .filter((p) => !consumed.has(p.id))
        .map((p) => `"${p.id}"`)
        .join(", ");
      throw new CMSPluginError(
        `Circular \`requires\` dependency among plugins: ${stuck}. ` +
        `Break the cycle by removing one of the entries from a plugin's \`requires\` array.`
      );
    }
  }

  // -- 6. Re-apply phase grouping on top of the topo order ------------------
  const grouped: Plugin<Collections>[] = [];
  for (const phase of PHASE_ORDER) {
    for (const plugin of sorted) {
      if (phaseOf(plugin) === phase) grouped.push(plugin);
    }
  }
  return grouped;
}

export function validatePluginCapabilities<Collections extends CMSCollections>(
  plugin: Plugin<Collections>,
  ctx: PluginContext<Collections>
): void {
  const capabilities: CMSPluginCapabilities<Collections> | undefined = plugin.capabilities;
  if (!capabilities) return;
  const label = `Plugin "${plugin.id}"`;

  for (const collection of capabilities.reads ?? []) {
    if (!ctx.collections[collection]) {
      throw new CMSPluginError(`${label} declares read access to unknown collection "${String(collection)}".`);
    }
  }

  for (const collection of capabilities.writes ?? []) {
    if (collection !== "media" && !ctx.collections[collection as string]) {
      throw new CMSPluginError(`${label} declares write access to unknown collection "${String(collection)}".`);
    }
  }

  for (const cap of capabilities.requiresAdapter ?? []) {
    if (!ctx.db.capabilities?.[cap]) {
      throw new CMSPluginError(`${label} requires database adapter capability "${cap}".`);
    }
  }

  for (const name of capabilities.requiresEnv ?? []) {
    if (!hasEnvValue(name, ctx.env)) {
      throw new CMSPluginError(`${label} requires environment value "${name}".`);
    }
  }
}

function hasEnvValue(name: string, env: Record<string, unknown> | undefined): boolean {
  if (env && env[name] !== undefined && env[name] !== "") return true;
  const processEnv = typeof process === "undefined" ? undefined : process.env;
  if (processEnv?.[name]) return true;
  const globalEnv = globalThis as typeof globalThis & Record<string, unknown>;
  return globalEnv[name] !== undefined && globalEnv[name] !== "";
}

export async function installPlugins<Collections extends CMSCollections>(
  plugins: readonly Plugin<Collections>[],
  app: Hono<HonoCMSEnv>,
  ctx: PluginContext<Collections>
): Promise<InstallResult<Collections>> {
  const ordered = validateAndOrder(plugins);

  // Merge plugin-declared internal tables into ctx.systemTables so plugins
  // installed later can introspect what tables exist. ctx.systemTables is
  // exposed as ReadonlyMap on the public type but the underlying Map is
  // mutable here.
  const merged = mergeSchemas(ordered);
  const tablesMap = ctx.systemTables as Map<string, PluginTableDef>;
  for (const [name, def] of merged.entries()) tablesMap.set(name, def);

  let authPlugin: AuthPlugin<Collections> | undefined;
  let authorize: Authorize = () => true;
  const trustedOrigins = new Set<string>();
  const rateLimits: Array<{ pluginId: string; declaration: NonNullable<Plugin["rateLimit"]>[number] }> = [];
  const onRequest: Array<(req: Request) => Promise<Response | Request | void>> = [];
  const onResponse: Array<(res: Response) => Promise<Response | void>> = [];
  const installedIds: string[] = [];

  for (const plugin of ordered) {
    validatePluginCapabilities(plugin, ctx);

    if (isAuthPlugin(plugin)) authPlugin = plugin;

    if (plugin.middlewares) {
      for (const decl of plugin.middlewares) {
        if (typeof decl.path === "string") {
          app.use(decl.path, decl.middleware as MiddlewareHandler);
        } else {
          // Hono accepts string or RegExp as path matcher via use signature
          app.use(decl.path as unknown as string, decl.middleware as MiddlewareHandler);
        }
      }
    }

    if (plugin.app) {
      const next = await plugin.app(app, ctx);
      // Returned Hono is discarded — mutations to the passed app are preserved.
      void next;
    }

    if (plugin.installAuthorize) {
      authorize = plugin.installAuthorize(ctx);
    }

    for (const origin of plugin.trustedOrigins ?? []) trustedOrigins.add(origin);

    for (const decl of plugin.rateLimit ?? []) {
      rateLimits.push({ pluginId: plugin.id, declaration: decl });
    }

    if (plugin.onRequest) {
      const handler = plugin.onRequest;
      onRequest.push(async (req) => handler(req, ctx));
    }

    if (plugin.onResponse) {
      const handler = plugin.onResponse;
      onResponse.push(async (res) => handler(res, ctx));
    }

    installedIds.push(plugin.id);
  }

  return {
    authPlugin,
    authorize,
    trustedOrigins: Array.from(trustedOrigins),
    rateLimits,
    onRequest,
    onResponse,
    installedIds
  };
}
