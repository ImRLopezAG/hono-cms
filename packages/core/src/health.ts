import type { HealthStatus } from "./types/providers";

export type HealthChecker = {
  name: string;
  check: () => Promise<HealthStatus>;
};

export type HealthReport = {
  status: "ok" | "degraded";
  version: string;
  uptime_seconds: number;
  checks: Record<string, { status: "ok" | "error"; latency_ms?: number; error?: string; details?: Record<string, unknown> }>;
};

export async function runHealthChecks(checkers: readonly HealthChecker[], options: { startedAt: number; version: string; timeoutMs?: number }): Promise<HealthReport> {
  const pairs = await Promise.all(checkers.map(async (checker) => [checker.name, await runOne(checker, options.timeoutMs ?? 2000)] as const));
  const checks = Object.fromEntries(pairs);
  const ok = Object.values(checks).every((check) => check.status === "ok");
  return {
    status: ok ? "ok" : "degraded",
    version: options.version,
    uptime_seconds: Math.max(0, Math.round((Date.now() - options.startedAt) / 1000)),
    checks
  };
}

async function runOne(checker: HealthChecker, timeoutMs: number): Promise<HealthReport["checks"][string]> {
  const started = performance.now();
  try {
    const result = await withTimeout(checker.check(), timeoutMs);
    const base: HealthReport["checks"][string] = {
      status: result.ok ? "ok" : "error",
      latency_ms: result.latencyMs ?? Math.round(performance.now() - started)
    };
    if (!result.ok) base.error = sanitizeError(result.message ?? "health check failed");
    if (result.details) base.details = result.details;
    return base;
  } catch (error) {
    return {
      status: "error",
      latency_ms: Math.round(performance.now() - started),
      error: sanitizeError(error instanceof Error ? error.message : "health check failed")
    };
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("check timed out")), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function sanitizeError(message: string): string {
  return message
    .replace(/:\/\/[^:@/]+:[^@/]+@/g, "://REDACTED:REDACTED@")
    .replace(/(password|token|secret|key)=([^&\s]+)/gi, "$1=REDACTED")
    .slice(0, 300);
}
