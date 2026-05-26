export type ProviderFactory<Config, Provider> = (config: Config) => Provider;

const registries = new Map<string, Map<string, ProviderFactory<unknown, unknown>>>();

export function registerProvider<Config, Provider>(kind: string, name: string, factory: ProviderFactory<Config, Provider>): void {
  const registry = registries.get(kind) ?? new Map<string, ProviderFactory<unknown, unknown>>();
  registry.set(name, factory as ProviderFactory<unknown, unknown>);
  registries.set(kind, registry);
}

export function resolveProvider<Config extends { provider: string }, Provider>(kind: string, config: Config): Provider {
  const factory = registries.get(kind)?.get(config.provider);
  if (!factory) {
    throw new Error(`No ${kind} provider registered for "${config.provider}". Import its package before createCMS().`);
  }
  return factory(config) as Provider;
}

export function clearProvidersForTest(): void {
  registries.clear();
}
