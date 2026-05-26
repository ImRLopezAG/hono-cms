import { CMSPluginError, type PluginServices } from "./types";

export function createServiceRegistry(): PluginServices {
  const services = new Map<string, unknown>();
  return {
    get<T = unknown>(id: string): T {
      if (!services.has(id)) {
        throw new CMSPluginError(
          `Plugin service "${id}" is not installed. Add the plugin that provides it to \`plugins: [...]\`.`
        );
      }
      return services.get(id) as T;
    },
    has(id: string): boolean {
      return services.has(id);
    },
    register(id: string, value: unknown): void {
      services.set(id, value);
    }
  };
}
