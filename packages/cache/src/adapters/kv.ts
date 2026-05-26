import type { CacheAdapter } from "@hono-cms/core";
import type { KVCacheConfig, KVNamespaceLike } from "./types";

/**
 * Cloudflare KV-backed cache.
 *
 * KV is eventually consistent, so this provider is suitable for content
 * response caching, not security-sensitive session caching or atomic
 * distributed rate limiting. Pattern deletion is intentionally a warned
 * no-op and entries expire by TTL.
 */
export class KVCacheAdapter implements CacheAdapter {
  readonly provider = "kv";

  constructor(private readonly binding: KVNamespaceLike) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = await this.binding.get(key, "text");
    return value === null ? null : JSON.parse(value) as T;
  }

  async set<T = unknown>(key: string, value: T, options: { ttl?: number } = {}): Promise<void> {
    const serialized = JSON.stringify(value);
    if (options.ttl === undefined) {
      await this.binding.put(key, serialized);
      return;
    }
    const expirationTtl = Math.max(60, options.ttl);
    if (expirationTtl !== options.ttl) {
      console.warn(`[hono-cms/cache] KV provider requires expirationTtl >= 60 seconds. Clamped ${options.ttl}s to 60s for key "${key}".`);
    }
    await this.binding.put(key, serialized, { expirationTtl });
  }

  async delete(key: string): Promise<void> {
    await this.binding.delete(key);
  }

  async deletePattern(pattern: string): Promise<void> {
    console.warn(`[hono-cms/cache] KV provider does not support deletePattern. Pattern: ${pattern}. Keys will expire by TTL.`);
  }

  async sweep(): Promise<{ swept: number }> {
    return { swept: 0 };
  }

  async checkRateLimit(): Promise<{ success: boolean; remaining: number }> {
    console.warn("[hono-cms/cache] KV provider does not support atomic rate limiting. Rate limiting is disabled.");
    return { success: true, remaining: 999 };
  }

  async health(): Promise<{ ok: boolean; details: { provider: string; rateLimiting: "disabled" } }> {
    return { ok: true, details: { provider: this.provider, rateLimiting: "disabled" } };
  }
}

/**
 * Wrap a Cloudflare KV binding into a `CacheAdapter`.
 *
 * Emits a startup warning to surface the consistency / rate-limit caveats —
 * downstream plugins that require atomic rate limiting (`@hono-cms/rate-limit`)
 * should detect a non-`upstash` provider and fall open with their own log.
 */
export function createKVCache(config: KVCacheConfig): KVCacheAdapter {
  console.warn("[hono-cms/cache] KV provider selected. Session caching should fall back to in-memory because KV is eventually consistent. Rate limiting is disabled.");
  return new KVCacheAdapter(config.binding);
}
