import type { Hono } from "hono";
import type { AdapterCapabilities, CMSCollections } from "@hono-cms/schema";
import type { CMSConfig } from "./types/config";
import type { HonoCMSEnv } from "./types/instance";
import type { DatabaseAdapter } from "./types/providers";
import { CMSPluginError as ManifestCMSPluginError } from "./plugins/types";

export type CMSPluginCapabilities<Collections extends CMSCollections = CMSCollections> = {
  reads?: readonly (keyof Collections & string)[];
  writes?: readonly ((keyof Collections & string) | "media")[];
  requiresEnv?: readonly string[];
  requiresAdapter?: readonly (keyof AdapterCapabilities)[];
};

export type CMSPluginContext<Collections extends CMSCollections = CMSCollections> = {
  collections: Collections;
  db: DatabaseAdapter<Collections>;
};

/**
 * @deprecated Legacy plugin function shape. Use the manifest-style
 * `Plugin` from `@hono-cms/core/plugins/types` instead. Will be removed
 * after the plugin-system refactor lands.
 */
export type CMSPlugin<Collections extends CMSCollections = CMSCollections> = {
  (app: Hono<HonoCMSEnv>, context: CMSPluginContext<Collections>): Hono<HonoCMSEnv> | void;
  name?: string;
  capabilities?: CMSPluginCapabilities<Collections>;
};

/**
 * Re-export of the manifest CMSPluginError so legacy callers keep compiling.
 */
export const CMSPluginError = ManifestCMSPluginError;
export type CMSPluginErrorType = InstanceType<typeof ManifestCMSPluginError>;

export function definePlugin<Collections extends CMSCollections>(
  plugin: CMSPlugin<Collections>,
  capabilities?: CMSPluginCapabilities<Collections>
): CMSPlugin<Collections> {
  if (capabilities) plugin.capabilities = capabilities;
  return plugin;
}

export function applyPlugins<Collections extends CMSCollections>(
  app: Hono<HonoCMSEnv>,
  plugins: readonly CMSPlugin<Collections>[] | undefined,
  context: CMSPluginContext<Collections>,
  config: Pick<CMSConfig<Collections>, "env">
): Hono<HonoCMSEnv> {
  let current = app;
  for (const plugin of plugins ?? []) {
    validatePluginCapabilities(plugin, context, config.env);
    const next = plugin(current, context);
    if (next) current = next;
  }
  return current;
}

export function validatePluginCapabilities<Collections extends CMSCollections>(
  plugin: CMSPlugin<Collections>,
  context: CMSPluginContext<Collections>,
  env: CMSConfig<Collections>["env"]
): void {
  const label = plugin.name ? `Plugin "${plugin.name}"` : "Plugin";
  const capabilities = plugin.capabilities;
  if (!capabilities) return;

  for (const collection of capabilities.reads ?? []) {
    if (!context.collections[collection]) {
      throw new CMSPluginError(`${label} declares read access to unknown collection "${collection}".`);
    }
  }

  for (const collection of capabilities.writes ?? []) {
    if (collection !== "media" && !context.collections[collection]) {
      throw new CMSPluginError(`${label} declares write access to unknown collection "${collection}".`);
    }
  }

  for (const capability of capabilities.requiresAdapter ?? []) {
    if (!context.db.capabilities?.[capability]) {
      throw new CMSPluginError(`${label} requires database adapter capability "${capability}".`);
    }
  }

  for (const name of capabilities.requiresEnv ?? []) {
    if (!hasEnvValue(name, env)) {
      throw new CMSPluginError(`${label} requires environment value "${name}".`);
    }
  }
}

function hasEnvValue(name: string, env: CMSConfig["env"]): boolean {
  if (env && env[name] !== undefined && env[name] !== "") return true;
  const processEnv = typeof process === "undefined" ? undefined : process.env;
  if (processEnv?.[name]) return true;
  const globalEnv = globalThis as typeof globalThis & Record<string, unknown>;
  return globalEnv[name] !== undefined && globalEnv[name] !== "";
}
