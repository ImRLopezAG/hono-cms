import {
  createPlugin,
  type AuditLogEntry,
  type AuditOperation,
  type AuditStore,
  type AuthSession,
  type CMSEvents,
  type ContentRecord,
  type Plugin
} from "@hono-cms/core";
import { auditLogCleanupJob } from "./cleanup";
import { computeDiff } from "./diff";
import { mountAuditRoutes } from "./routes";
import { MemoryAuditStore } from "./store/memory";
import { AUDIT_LOG_TABLE, auditLogTable } from "./tables";

/** Plugin id under which the audit plugin self-registers on the registry. */
export const AUDIT_PLUGIN_ID = "audit";

/** Job name registered with `@hono-cms/jobs-runtime` when present. */
export const AUDIT_CLEANUP_JOB_NAME = "audit-log-cleanup";

export type AuditConfig = {
  /**
   * Persistent backend for audit entries. Defaults to an in-memory store —
   * production deployments should provide `createDrizzleAuditStore({ db, ... })`
   * or any custom implementation of `AuditStore`.
   */
  store?: AuditStore;
  /**
   * Days of history retained before the cleanup job deletes entries. Defaults
   * to 90. Values `<= 0` disable cleanup (the job becomes a no-op).
   */
  retentionDays?: number;
  /**
   * Extra field names that should be stripped from recorded diffs. Combined
   * with the always-on `password|token|secret|cookie|authorization` list.
   */
  excludeFields?: readonly string[];
  /**
   * Maximum bytes per serialized field before the value is replaced with a
   * `{ truncated: true, length }` stub. Defaults to 10 KiB.
   */
  maxFieldBytes?: number;
};

/**
 * Service exposed on the plugin registry (`ctx.plugins.get("audit")`) for
 * tests + admin tooling that wants direct access to the backing store.
 */
export type AuditService = {
  readonly store: AuditStore;
  readonly config: Required<Pick<AuditConfig, "retentionDays" | "excludeFields" | "maxFieldBytes">>;
};

/**
 * Build the audit plugin manifest.
 *
 * Subscribes to every documented mutation event on `ctx.events` (content
 * create/update/delete/publish/unpublish, media upload/delete, schema
 * collection add/update/remove) and writes one row per mutation through the
 * configured `AuditStore`. Exposes the store via the plugin registry so other
 * plugins / tests can reach it without re-instantiating.
 *
 * Mounts `GET /cms/audit-log` with admin-gated access. Anonymous callers
 * receive 401; non-admin sessions receive 403. Supports `?format=csv` for the
 * "download recent activity" workflow.
 *
 * If `@hono-cms/jobs-runtime` is also installed (detected via
 * `ctx.plugins.has("jobs")`), a job named `audit-log-cleanup` is registered
 * that runs {@link auditLogCleanupJob} against the configured store.
 *
 * ```ts
 * createCMS({
 *   plugins: [
 *     memoryJobs({}) && jobsRuntime({ adapter: memoryJobs({}) }), // U12 (optional)
 *     audit({ retentionDays: 30, excludeFields: ["ssn"] })
 *   ]
 * });
 * ```
 */
export function audit(opts: AuditConfig = {}): Plugin {
  const store = opts.store ?? new MemoryAuditStore();
  const config = {
    retentionDays: opts.retentionDays ?? 90,
    excludeFields: opts.excludeFields ?? [],
    maxFieldBytes: opts.maxFieldBytes ?? 10 * 1024
  } satisfies AuditService["config"];

  return createPlugin({
    id: AUDIT_PLUGIN_ID,

    schema: {
      [AUDIT_LOG_TABLE]: auditLogTable
    },

    async app(app, ctx) {
      // Expose the store on the plugin registry so tests, admin tooling, and
      // sibling plugins can reach it without re-instantiating. The producer's
      // richer `AuditService` includes `config`; core's canonical contract
      // narrows to `store`, so we assign through a variable to satisfy both
      // excess-property checks and structural assignment.
      const service: AuditService = { store, config };
      ctx.plugins.register(AUDIT_PLUGIN_ID, service);

      // Mount the read API. The route file owns query parsing + admin gating.
      mountAuditRoutes(app, store);

      // ---- Event subscriptions -------------------------------------------
      //
      // Each handler is wrapped in `safeWrite` so a malformed event payload
      // can never break the mutation that emitted it. `writeEntry` itself
      // swallows store errors and logs a warning.

      ctx.events.on("content:after-create", async (payload: CMSEvents["content:after-create"]) => {
        await writeEntry({
          store,
          operation: "create",
          collection: payload.collection,
          before: null,
          after: payload.record,
          identity: payload.identity,
          request: payload.request,
          config: { excludeFields: config.excludeFields, maxFieldBytes: config.maxFieldBytes }
        });
      });

      ctx.events.on("content:after-update", async (payload: CMSEvents["content:after-update"]) => {
        await writeEntry({
          store,
          operation: "update",
          collection: payload.collection,
          before: payload.before,
          after: payload.record,
          identity: payload.identity,
          request: payload.request,
          config: { excludeFields: config.excludeFields, maxFieldBytes: config.maxFieldBytes }
        });
      });

      ctx.events.on("content:after-delete", async (payload: CMSEvents["content:after-delete"]) => {
        await writeEntry({
          store,
          operation: "delete",
          collection: payload.collection,
          before: payload.record,
          after: null,
          identity: payload.identity,
          request: payload.request,
          config: { excludeFields: config.excludeFields, maxFieldBytes: config.maxFieldBytes }
        });
      });

      ctx.events.on("content:after-publish", async (payload: CMSEvents["content:after-publish"]) => {
        await writeEntry({
          store,
          operation: "publish",
          collection: payload.collection,
          before: null,
          after: payload.record,
          identity: payload.identity,
          request: payload.request,
          config: { excludeFields: config.excludeFields, maxFieldBytes: config.maxFieldBytes }
        });
      });

      ctx.events.on("content:after-unpublish", async (payload: CMSEvents["content:after-unpublish"]) => {
        await writeEntry({
          store,
          operation: "unpublish",
          collection: payload.collection,
          before: payload.record,
          after: null,
          identity: payload.identity,
          request: payload.request,
          config: { excludeFields: config.excludeFields, maxFieldBytes: config.maxFieldBytes }
        });
      });

      ctx.events.on("media:after-upload", async (payload: CMSEvents["media:after-upload"]) => {
        await writeEntry({
          store,
          operation: "media_upload",
          collection: "media",
          before: null,
          after: payload.record as ContentRecord,
          identity: payload.identity,
          request: payload.request,
          config: { excludeFields: config.excludeFields, maxFieldBytes: config.maxFieldBytes }
        });
      });

      ctx.events.on("media:after-delete", async (payload: CMSEvents["media:after-delete"]) => {
        await writeEntry({
          store,
          operation: "media_delete",
          collection: "media",
          before: payload.record as ContentRecord,
          after: null,
          identity: payload.identity,
          request: payload.request,
          config: { excludeFields: config.excludeFields, maxFieldBytes: config.maxFieldBytes }
        });
      });

      ctx.events.on("schema:after-collection-add", async (payload: CMSEvents["schema:after-collection-add"]) => {
        await writeEntry({
          store,
          operation: "schema_change",
          collection: payload.name,
          before: null,
          after: { name: payload.name, collection: payload.collection } as unknown as ContentRecord,
          identity: null,
          request: null,
          config: { excludeFields: config.excludeFields, maxFieldBytes: config.maxFieldBytes }
        });
      });

      ctx.events.on("schema:after-collection-update", async (payload: CMSEvents["schema:after-collection-update"]) => {
        await writeEntry({
          store,
          operation: "schema_change",
          collection: payload.name,
          before: { name: payload.name, collection: payload.before } as unknown as ContentRecord,
          after: { name: payload.name, collection: payload.after } as unknown as ContentRecord,
          identity: null,
          request: null,
          config: { excludeFields: config.excludeFields, maxFieldBytes: config.maxFieldBytes }
        });
      });

      ctx.events.on("schema:after-collection-remove", async (payload: CMSEvents["schema:after-collection-remove"]) => {
        await writeEntry({
          store,
          operation: "schema_change",
          collection: payload.name,
          before: { name: payload.name } as unknown as ContentRecord,
          after: null,
          identity: null,
          request: null,
          config: { excludeFields: config.excludeFields, maxFieldBytes: config.maxFieldBytes }
        });
      });

      // ---- Optional cleanup job -----------------------------------------
      //
      // Registered through the jobs-runtime service if (and only if) the jobs
      // plugin is installed. The plugin keeps working as a no-op in
      // jobs-less deployments — admins just need to schedule cleanup
      // themselves in that case.
      if (ctx.plugins.has("jobs")) {
        try {
          const jobs = ctx.plugins.get("jobs");
          if (typeof jobs?.registerJob === "function") {
            jobs.registerJob(AUDIT_CLEANUP_JOB_NAME, async () => {
              await auditLogCleanupJob({ store, retentionDays: config.retentionDays });
            });
          }
        } catch (error) {
          console.warn("[hono-cms/audit] failed to register audit-log-cleanup job", error);
        }
      }
    }
  });
}

/**
 * Internal: assemble an `AuditLogEntry` and hand it to the store. Catches and
 * logs all errors so a misbehaving store can never break the mutation that
 * triggered the event.
 */
async function writeEntry(args: {
  store: AuditStore;
  operation: AuditOperation;
  collection: string;
  before: ContentRecord | null;
  after: ContentRecord | null;
  identity: unknown;
  request: Request | null;
  config: { excludeFields: readonly string[]; maxFieldBytes: number };
}): Promise<void> {
  try {
    const session = coerceSession(args.identity);
    const documentId =
      typeof args.after?.id === "string"
        ? args.after.id
        : typeof args.before?.id === "string"
          ? args.before.id
          : undefined;

    const entry: AuditLogEntry = {
      id: crypto.randomUUID(),
      operation: args.operation,
      collection: args.collection,
      actorRoles: session?.roles ?? [],
      requestId: args.request ? requestId(args.request) : crypto.randomUUID(),
      diff: computeDiff(args.before, args.after, args.config),
      createdAt: new Date().toISOString()
    };
    if (documentId !== undefined) entry.documentId = documentId;
    if (session?.userId) entry.actorId = session.userId;
    if (session?.email) entry.actorEmail = session.email;

    await args.store.append(entry);
  } catch (error) {
    console.warn("[hono-cms/audit] failed to write audit log entry", error);
  }
}

/**
 * Best-effort coercion from the event-bus `identity` payload to an
 * `AuthSession`. Returns `null` when the identity isn't shaped like a session
 * — the event still produces an entry, just without actor metadata.
 */
function coerceSession(identity: unknown): AuthSession | null {
  if (!identity || typeof identity !== "object") return null;
  const candidate = identity as Partial<AuthSession>;
  if (typeof candidate.userId !== "string") return null;
  const roles = Array.isArray(candidate.roles) ? candidate.roles.map((role) => String(role)) : [];
  const session: AuthSession = { userId: candidate.userId, roles };
  if (typeof candidate.email === "string") session.email = candidate.email;
  return session;
}

function requestId(request: Request): string {
  return request.headers.get("x-request-id") ?? crypto.randomUUID();
}
