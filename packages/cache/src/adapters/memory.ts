import type { CacheAdapter } from "@hono-cms/core";

type Entry = {
  value: unknown;
  expiresAt?: number;
};

/**
 * In-process cache adapter. Suitable for development and single-isolate
 * deployments; not distributed, so use Upstash/Redis or another shared
 * provider in production multi-process or edge fan-outs.
 *
 * The cleanup `setInterval` is intentionally deferred until the first
 * `set()`/`checkRateLimit()` call. Cloudflare Workers and other edge
 * runtimes reject async I/O (including timers) in global scope, so this
 * adapter must be safe to instantiate at module top-level while still
 * sweeping expired entries once a request lands. See
 * `docs/cross-runtime/cloudflare-worker.md` for the constraint.
 */
export class MemoryCacheAdapter implements CacheAdapter {
  readonly provider = "memory";
  private readonly entries = new Map<string, Entry>();
  private readonly rateLimits = new Map<string, number[]>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor() {
    const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
    if (proc?.env?.NODE_ENV === "production") {
      console.warn("[hono-cms/cache] Memory cache provider selected in production. This provider is not distributed; use Upstash Redis for multi-process or edge deployments.");
    }
    // Defer setInterval until first request — Cloudflare Workers / edge runtimes
    // disallow async I/O (incl. setTimeout/setInterval) in global scope.
  }

  private ensureCleanupTimer(): void {
    if (this.destroyed) return;
    if (this.cleanupTimer !== null) return;
    if (typeof setInterval !== "function") return;
    const handle = setInterval(() => {
      void this.sweep();
    }, 60_000);
    if (typeof handle === "object" && handle !== null && "unref" in handle && typeof (handle as { unref: () => void }).unref === "function") {
      (handle as { unref: () => void }).unref();
    }
    this.cleanupTimer = handle;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T = unknown>(key: string, value: T, options: { ttl?: number } = {}): Promise<void> {
    this.ensureCleanupTimer();
    const entry: Entry = { value };
    if (options.ttl) entry.expiresAt = Date.now() + options.ttl * 1000;
    this.entries.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async deletePattern(pattern: string): Promise<void> {
    const wildcard = pattern.endsWith("*");
    const prefix = wildcard ? pattern.slice(0, -1) : pattern;
    for (const key of this.entries.keys()) {
      if (wildcard ? key.startsWith(prefix) : key === pattern) this.entries.delete(key);
    }
  }

  async sweep(): Promise<{ swept: number }> {
    const now = Date.now();
    let swept = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt && entry.expiresAt <= now) {
        this.entries.delete(key);
        swept += 1;
      }
    }
    for (const [key, timestamps] of this.rateLimits) {
      const recent = timestamps.filter((timestamp) => timestamp > now);
      if (recent.length === 0) {
        this.rateLimits.delete(key);
        swept += timestamps.length;
      } else if (recent.length !== timestamps.length) {
        this.rateLimits.set(key, recent);
        swept += timestamps.length - recent.length;
      }
    }
    return { swept };
  }

  async checkRateLimit(identifier: string, options: { limit: number; window: string; prefix?: string }): Promise<{ success: boolean; remaining: number; resetAt?: string }> {
    this.ensureCleanupTimer();
    const windowMs = parseWindowMs(options.window);
    const now = Date.now();
    const key = `${options.prefix ?? "rate-limit"}:${identifier}`;
    const recent = (this.rateLimits.get(key) ?? []).filter((timestamp) => timestamp > now);
    const resetAt = new Date(recent[0] ?? now + windowMs).toISOString();
    if (recent.length >= options.limit) {
      this.rateLimits.set(key, recent);
      return { success: false, remaining: 0, resetAt };
    }
    recent.push(now + windowMs);
    this.rateLimits.set(key, recent);
    return { success: true, remaining: Math.max(0, options.limit - recent.length), resetAt };
  }

  async health(): Promise<{ ok: boolean; details: { entries: number } }> {
    return { ok: true, details: { entries: this.entries.size } };
  }
}

function parseWindowMs(window: string): number {
  const match = window.trim().match(/^(\d+)\s*(ms|s|m|h)$/);
  if (!match?.[1] || !match[2]) throw new Error(`Unsupported rate limit window "${window}". Use values like "30 s", "1 m", or "1 h".`);
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60_000;
  return amount * 3_600_000;
}

/** Convenience factory; identical to `new MemoryCacheAdapter()`. */
export function createMemoryCache(): MemoryCacheAdapter {
  return new MemoryCacheAdapter();
}
