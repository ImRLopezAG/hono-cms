import type { Hono, MiddlewareHandler } from "hono";
import type { CMSCollections } from "@hono-cms/schema";
import type { HonoCMSEnv } from "../types/instance";
import {
  CMSPluginError,
  type Authorize,
  type AuthPlugin,
  type CMSPluginCapabilities,
  type MountPhase,
  type Plugin,
  type PluginContext
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

export function validateAndOrder<Collections extends CMSCollections>(
  plugins: readonly Plugin<Collections>[]
): readonly Plugin<Collections>[] {
  const ids = new Map<string, number>();
  for (const [index, plugin] of plugins.entries()) {
    if (!plugin.id) {
      throw new CMSPluginError(`Plugin at index ${index} has no \`id\`.`);
    }
    if (ids.has(plugin.id)) {
      throw new CMSPluginError(
        `Duplicate plugin id "${plugin.id}" at indices ${ids.get(plugin.id)} and ${index}.`
      );
    }
    ids.set(plugin.id, index);
  }

  for (const [index, plugin] of plugins.entries()) {
    if (!plugin.requires) continue;
    for (const requiredId of plugin.requires) {
      const requiredIndex = ids.get(requiredId);
      if (requiredIndex === undefined) {
        throw new CMSPluginError(
          `Plugin "${plugin.id}" requires "${requiredId}" which is not installed. ` +
          `Add it to \`plugins: [...]\` before "${plugin.id}".`
        );
      }
      if (requiredIndex >= index) {
        throw new CMSPluginError(
          `Plugin "${plugin.id}" requires "${requiredId}" which appears later in the array ` +
          `(index ${requiredIndex} vs ${index}). Move "${requiredId}" before "${plugin.id}".`
        );
      }
    }
  }

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

  const grouped: Plugin<Collections>[] = [];
  for (const phase of PHASE_ORDER) {
    for (const plugin of plugins) {
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
