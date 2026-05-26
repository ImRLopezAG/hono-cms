/**
 * `@hono-cms/audit`
 *
 * Plugin that owns the audit log feature: subscribes to mutation events on
 * `ctx.events`, persists one row per mutation through a pluggable
 * `AuditStore`, mounts `GET /cms/audit-log` (admin-gated, JSON or CSV), and
 * registers an `audit-log-cleanup` job with `@hono-cms/jobs-runtime` when
 * present.
 *
 * See `docs/plans/2026-05-25-001-refactor-plugin-system-architecture-plan.md`
 * §U16 for the migration rationale.
 */

export {
  audit,
  AUDIT_PLUGIN_ID,
  AUDIT_CLEANUP_JOB_NAME,
  type AuditConfig,
  type AuditService
} from "./plugin";

export { MemoryAuditStore, encodeAuditCursor, decodeAuditCursor } from "./store/memory";

export {
  createDrizzleAuditStore,
  type CreateDrizzleAuditStoreOptions,
  type DrizzleAuditDialect
} from "./store/drizzle";

export { auditLogCleanupJob, type AuditLogCleanupOptions, type AuditLogCleanupResult } from "./cleanup";

export { computeDiff, type ComputeDiffOptions } from "./diff";

export { auditEntriesToCSV } from "./csv";

export { AUDIT_LOG_TABLE, auditLogTable } from "./tables";

export { mountAuditRoutes, parseAuditQuery, type AuditQueryIssue } from "./routes";

// Re-export the public type surface so users can write `AuditStore` etc.
// without importing from `@hono-cms/core` directly.
export type {
  AuditDiff,
  AuditLogEntry,
  AuditLogQuery,
  AuditOperation,
  AuditStore
} from "@hono-cms/core";
