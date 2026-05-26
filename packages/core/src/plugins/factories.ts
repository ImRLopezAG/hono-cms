import type { CMSCollections } from "@hono-cms/schema";
import {
  CMSPluginError,
  type AuthPlugin,
  type Plugin
} from "./types";

function assertId(plugin: { id?: unknown }): asserts plugin is { id: string } {
  if (typeof plugin.id !== "string" || plugin.id.length === 0) {
    throw new CMSPluginError("Plugin requires a non-empty `id` string.");
  }
}

export function createPlugin<
  P extends Plugin<Collections>,
  Collections extends CMSCollections = CMSCollections
>(plugin: P): P {
  assertId(plugin);
  return plugin;
}

export function createAuthPlugin<
  P extends AuthPlugin<Collections>,
  Collections extends CMSCollections = CMSCollections
>(plugin: P): P {
  assertId(plugin);
  if (typeof plugin.protected !== "function") {
    throw new CMSPluginError(
      `AuthPlugin "${plugin.id}" must declare a \`protected\` middleware function.`
    );
  }
  return plugin;
}
