import {
  createPlugin,
  type CacheAdapter,
  type JobEnqueueOptions,
  type JobHandler,
  type JobsAdapter,
  type Plugin,
  type PluginContext
} from "@hono-cms/core";
import type { CMSCollections } from "@hono-cms/schema";
import { mountJobRoute } from "./routes";
import { runScheduledPublish } from "./scheduled-publish";

/** Plugin id under which the jobs runtime self-registers on the plugin registry. */
export const JOBS_RUNTIME_ID = "jobs";

/**
 * Service exposed on the plugin registry under id `"jobs"`.
 *
 * Other plugins (`audit`, `webhooks`, `i18n`, `drafts`, etc.) compose their
 * own background work by calling:
 *
 * ```ts
 * const jobs = ctx.plugins.get<JobsService>("jobs");
 * jobs.registerJob("my-job", async (payload, jobCtx) => { ... });
 * ```
 *
 * The runtime owns:
 * - mounting `POST/GET /cms/jobs/<name>` for each registered job;
 * - verifying incoming requests through `adapter.verify` when configured;
 * - shaping 401/500 responses uniformly across every job.
 */
export type JobsService = {
  /**
   * Register a job handler under `name`. Mounts `POST /cms/jobs/<name>` (and
   * `GET` for cron-style probes) and routes verified requests to `handler`.
   * Throws if `name` is already registered.
   */
  registerJob(name: string, handler: JobHandler): void;
  /**
   * Dispatch a registered job in-process. Used by tests and by composite
   * "scheduled" handlers that fan out to multiple jobs.
   */
  dispatch(name: string, payload?: unknown): Promise<void>;
  /**
   * Enqueue an HTTP-style job (e.g. `/cms/jobs/webhook-retry`) through the
   * configured adapter. Delegates to `adapter.enqueue` when available;
   * falls back to in-process `dispatch` for adapters without an enqueue
   * primitive (memory, none).
   */
  enqueue(endpoint: string, body?: unknown, opts?: JobEnqueueOptions): Promise<void>;
  /** Read-only handle to the underlying adapter (for health checks, etc.). */
  readonly adapter: JobsAdapter;
};

export type JobsRuntimeOptions = {
  /** Backing `JobsAdapter` (e.g. `memoryJobs({})`, `qstashJobs({ ... })`). */
  adapter: JobsAdapter;
  /**
   * Optional base URL used for `enqueue` calls that pass a relative endpoint.
   * Defaults to `ctx.baseUrl`. Stored for completeness; current adapter
   * implementations resolve their own base URL at construction time.
   */
  baseUrl?: string;
  /**
   * Whether to register the built-in scheduled-publish job. Defaults to `true`.
   * Set to `false` if your app handles scheduled publishing through a custom
   * job name.
   */
  registerScheduledPublish?: boolean;
  /**
   * Whether to register the built-in cache-sweep job. The cache-sweep job is
   * only mounted when `ctx.plugins.has("cache")` is `true` at install time;
   * otherwise it's a silent no-op so cache-less deployments don't crash.
   * Defaults to `true`.
   */
  registerCacheSweep?: boolean;
};

/**
 * Build the jobs-runtime plugin.
 *
 * ```ts
 * createCMS({
 *   plugins: [
 *     memoryCache({}),                                  // optional, U11
 *     jobsRuntime({ adapter: memoryJobs({}) })          // U12
 *   ]
 * });
 * ```
 *
 * Cross-plugin job registration after install:
 *
 * ```ts
 * // inside another plugin's `app(app, ctx)`
 * const jobs = ctx.plugins.get<JobsService>("jobs");
 * jobs.registerJob("audit-log-cleanup", async () => { ... });
 * ```
 */
export function jobsRuntime(opts: JobsRuntimeOptions): Plugin {
  const adapter = opts.adapter;
  const registerScheduledPublish = opts.registerScheduledPublish ?? true;
  const registerCacheSweep = opts.registerCacheSweep ?? true;

  return createPlugin({
    id: JOBS_RUNTIME_ID,

    app(app, ctx) {
      const registered = new Set<string>();

      const registerJob: JobsService["registerJob"] = (name, handler) => {
        if (registered.has(name)) {
          throw new Error(`Job "${name}" is already registered.`);
        }
        registered.add(name);

        // Wire the handler through the adapter's in-process register hook so
        // `adapter.dispatch(name)` works for adapters that maintain their own
        // handler map (memory/none/qstash/etc.). Ignore "already registered"
        // races — the runtime's own Set is the source of truth.
        try {
          adapter.register(name, async (payload, jobCtx) => {
            await handler(payload, jobCtx);
          });
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("already registered")) {
            throw error;
          }
        }

        // Mount the HTTP entrypoint. The adapter's `verify` is consulted by
        // `runVerifiedJob` so requests without a valid signature are rejected
        // with `401` before the handler runs.
        mountJobRoute(app, adapter, name, async (payload) => {
          const result = await handler(payload, {
            cms: null,
            now: new Date()
          });
          // JobHandler returns `void | Promise<void>` by contract; surface a
          // generic 200 envelope so the HTTP response is well-defined.
          return result ?? { ok: true };
        });
      };

      const dispatch: JobsService["dispatch"] = async (name, payload) => {
        await adapter.dispatch(name, payload);
      };

      const enqueue: JobsService["enqueue"] = async (endpoint, body, enqueueOpts) => {
        if (typeof adapter.enqueue === "function") {
          await adapter.enqueue(endpoint, body, enqueueOpts);
          return;
        }
        // Fallback: dispatch in-process by stripping the `/cms/jobs/` prefix.
        const name = endpoint.replace(/^\/?cms\/jobs\//, "").replace(/^\//, "");
        await adapter.dispatch(name, body);
      };

      const service: JobsService = {
        registerJob,
        dispatch,
        enqueue,
        adapter
      };
      ctx.plugins.register(JOBS_RUNTIME_ID, service);

      // Built-in jobs. Each is registered through the same `registerJob` API
      // so it ends up on the adapter + the HTTP surface + the runtime's
      // tracking Set.
      if (registerScheduledPublish) {
        registerJob("scheduled-publish", async () => {
          const cache = resolveCache(ctx);
          const cacheArg = cache ?? null;
          await runScheduledPublish({
            db: ctx.db,
            collections: ctx.collections,
            cache: cacheArg
          });
        });
      }

      // Cache-sweep is *optional* — only registered when a cache plugin has
      // already published its service on the registry. Skipping silently keeps
      // cache-less deployments (e.g. workers-without-KV) functional.
      if (registerCacheSweep && ctx.plugins.has("cache")) {
        registerJob("cache-sweep", async () => {
          const cache = resolveCache(ctx);
          if (cache && typeof cache.sweep === "function") {
            await cache.sweep();
          }
        });
      }
    }
  });
}

function resolveCache<Collections extends CMSCollections>(
  ctx: PluginContext<Collections>
): CacheAdapter | null {
  if (!ctx.plugins.has("cache")) return null;
  try {
    const cache = ctx.plugins.get<CacheAdapter>("cache");
    return cache ?? null;
  } catch {
    return null;
  }
}
