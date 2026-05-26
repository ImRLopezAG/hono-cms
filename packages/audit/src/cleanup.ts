import type { AuditStore } from "@hono-cms/core";

export type AuditLogCleanupOptions = {
  store: AuditStore | null;
  /** Days of history retained. Values `<= 0` short-circuit the job. */
  retentionDays?: number;
  /** Override the wall clock for tests. */
  now?: Date;
};

export type AuditLogCleanupResult = {
  deletedCount: number;
  olderThan?: string;
};

const DEFAULT_RETENTION_DAYS = 90;

/**
 * Delete audit rows older than `retentionDays`. Designed for use both as a
 * standalone helper and as a registered job inside `@hono-cms/jobs-runtime`.
 *
 * Returns the number of rows deleted and the ISO cutoff that was applied so
 * the caller can surface it in job telemetry. Stores that don't implement
 * `cleanup` are silently treated as "nothing to do".
 */
export async function auditLogCleanupJob(
  options: AuditLogCleanupOptions
): Promise<AuditLogCleanupResult> {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (retentionDays <= 0) {
    console.warn(`[hono-cms/audit] audit log cleanup skipped because retentionDays is ${retentionDays}.`);
    return { deletedCount: 0 };
  }

  const now = options.now ?? new Date();
  const olderThan = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deletedCount = (await options.store?.cleanup?.(olderThan)) ?? 0;
  return { deletedCount, olderThan: olderThan.toISOString() };
}
