import { CMSPluginError, type CMSPluginServices, type PluginServices } from "./types";

/**
 * Runtime is a single `Map<string, unknown>`. The typed surface comes from the
 * `CMSPluginServices` interface, which producing plugins augment via
 * `declare module "@hono-cms/core"`. The cast in `get`/`register` is unavoidable
 * because the registry value itself is heterogeneous — TS narrows for the
 * caller, not for the storage.
 */
export function createServiceRegistry(): PluginServices {
  const services = new Map<string, unknown>();
  return {
    get<K extends string>(id: K): K extends keyof CMSPluginServices ? CMSPluginServices[K] : unknown {
      if (!services.has(id)) {
        throw new CMSPluginError(
          `Plugin service "${id}" is not installed. Add the plugin that provides it to \`plugins: [...]\`.`
        );
      }
      return services.get(id) as K extends keyof CMSPluginServices ? CMSPluginServices[K] : unknown;
    },
    has(id: string): boolean {
      return services.has(id);
    },
    register<K extends string>(
      id: K,
      value: K extends keyof CMSPluginServices ? CMSPluginServices[K] : unknown
    ): void {
      services.set(id, value);
    }
  };
}
