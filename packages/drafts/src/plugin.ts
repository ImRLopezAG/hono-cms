import { createPlugin, type Plugin } from "@hono-cms/core";
import { mountDraftRoutes } from "./routes";
import { runScheduledPublishes } from "./schedule";

/** Plugin id under which the drafts plugin self-registers on the registry. */
export const DRAFTS_PLUGIN_ID = "drafts";

/** Job name registered with `@hono-cms/jobs-runtime`. */
export const SCHEDULED_PUBLISH_JOB_NAME = "scheduled-publish";

/** Minimal handle on the jobs runtime service exposed by `@hono-cms/jobs-runtime`. */
type JobsService = {
  registerJob: (name: string, handler: (payload: unknown) => unknown | Promise<unknown>) => void;
};

export type DraftsConfig = {
  /**
   * Maximum number of due records the scheduled-publish job promotes per tick.
   * Defaults to 100 — matches the legacy core helper's default page size.
   */
  scheduledPublishLimit?: number;
};

/**
 * Build the drafts plugin.
 *
 * Owns:
 * - `POST /api/<collection>/:id/publish` + `/unpublish` + `/schedule` +
 *   `/unschedule` for every collection with `options.draftAndPublish` enabled.
 * - The `scheduled-publish` background job: scans all draft-and-publish
 *   collections for rows whose `publishedAt <= now`, promotes them via the
 *   plugin's own `publishDocument` (so `content:after-publish` events fire),
 *   and returns the list of promoted records.
 *
 * Composition:
 * - **Requires `@hono-cms/jobs-runtime`** (declared via `requires: ["jobs"]`)
 *   — the kernel rejects installs where the jobs plugin is missing or
 *   installed after `drafts()`. Pair the plugin with
 *   `jobsRuntime({ registerScheduledPublish: false })` so the built-in
 *   scheduled-publish job in the runtime doesn't conflict with this one.
 *
 * ```ts
 * createCMS({
 *   plugins: [
 *     jobsRuntime({ adapter: memoryJobs({}), registerScheduledPublish: false }),
 *     drafts()
 *   ]
 * });
 * ```
 */
export function drafts(opts: DraftsConfig = {}): Plugin {
  const scheduledPublishLimit = opts.scheduledPublishLimit ?? 100;

  return createPlugin({
    id: DRAFTS_PLUGIN_ID,
    requires: ["jobs"],

    app(app, ctx) {
      // Wire the background promotion job. Each promotion routes through this
      // plugin's `publishDocument`, so `content:after-publish` events fire for
      // scheduled promotions exactly the same way they fire for manual ones.
      const jobs = ctx.plugins.get<JobsService>("jobs");
      jobs.registerJob(SCHEDULED_PUBLISH_JOB_NAME, async () => {
        await runScheduledPublishes({
          db: ctx.db,
          collections: ctx.collections,
          events: ctx.events,
          limit: scheduledPublishLimit,
          now: new Date()
        });
      });

      // Mount the four HTTP routes per collection.
      mountDraftRoutes(app, ctx);
    }
  });
}
