import type { CMSCollections } from "@hono-cms/schema";
import type { CMSConfig, ProviderConfig } from "../types/config";
import type { AuthAdapter, CacheAdapter, DatabaseAdapter, JobsAdapter, StorageAdapter } from "../types/providers";
import { createApiKeyAuth, createStaticTokenAuth, type BuiltInAuthConfig } from "../auth";
import { createBetterAuth, createBetterAuthAdapter, isAuthConfig } from "../auth/better-auth";
import { resolveProvider } from "./registry";

export function createDatabaseAdapter<Collections extends CMSCollections>(config: CMSConfig<Collections>["db"]): DatabaseAdapter<Collections> {
  return isAdapter(config, "list") ? config : resolveProvider<ProviderConfig, DatabaseAdapter<Collections>>("db", config);
}

export function createStorageAdapter(config: CMSConfig["storage"]): StorageAdapter | null {
  if (!config) return null;
  return isAdapter(config, "put") ? config : resolveProvider<ProviderConfig, StorageAdapter>("storage", config);
}

export function createCacheAdapter(config: CMSConfig["cache"]): CacheAdapter | null {
  if (!config) return null;
  return isAdapter(config, "get") ? config : resolveProvider<ProviderConfig, CacheAdapter>("cache", config);
}

export function createJobsAdapter(config: CMSConfig["jobs"], baseUrl?: string): JobsAdapter | null {
  if (!config) return null;
  if (isProviderConfig(config, "none")) return null;
  if (isAdapter(config, "dispatch")) return config;
  const resolvedConfig = baseUrl && isProviderConfig(config) && !("baseUrl" in config)
    ? Object.assign({}, config, { baseUrl }) as ProviderConfig
    : config;
  return resolveProvider<ProviderConfig, JobsAdapter>("jobs", resolvedConfig);
}

export function createAuthAdapter(config: CMSConfig["auth"], db?: DatabaseAdapter): AuthAdapter {
  if (config && isAdapter(config, "sessionFromRequest")) return config;
  if (isApiKeyAuthConfig(config)) return createApiKeyAuth(config);
  if (isStaticTokenAuthConfig(config)) return createStaticTokenAuth(config);
  if (isAuthConfig(config)) {
    if (!db) throw new Error("better-auth config requires the resolved CMS database adapter");
    return createBetterAuthAdapter(createBetterAuth(config, db));
  }
  return createStaticTokenAuth();
}

function isAdapter<T extends string>(value: unknown, method: T): value is Record<T, unknown> {
  return typeof value === "object" && value !== null && method in value;
}

function isProviderConfig(value: unknown, provider?: string): value is ProviderConfig {
  if (typeof value !== "object" || value === null || !("provider" in value)) return false;
  return provider === undefined || (value as { provider?: unknown }).provider === provider;
}

function isApiKeyAuthConfig(config: CMSConfig["auth"]): config is Extract<BuiltInAuthConfig, { provider: "api-key" }> {
  return typeof config === "object" && config !== null && "provider" in config && config.provider === "api-key";
}

function isStaticTokenAuthConfig(config: CMSConfig["auth"]): config is Extract<BuiltInAuthConfig, { provider?: "static-token" }> {
  if (!config || typeof config !== "object") return !config;
  return "tokens" in config || ("provider" in config && config.provider === "static-token");
}
