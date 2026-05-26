/**
 * `@hono-cms/drafts`
 *
 * Plugin that owns the draft/publish state machine — `publishDocument`,
 * `unpublishDocument`, `schedulePublish`, `unschedulePublish`, the
 * `scheduled-publish` background job, and the four
 * `/api/<collection>/:id/{publish,unpublish,schedule,unschedule}` routes per
 * draftable collection. Carved out of `@hono-cms/core` per
 * `docs/plans/2026-05-25-001-refactor-plugin-system-architecture-plan.md`
 * §U20.
 *
 * The primitive state-transition helpers (`normalizeDraftInput`,
 * `stripSystemDraftFields`) remain in core because the content REST routes
 * still need them at create/update time. This plugin layers event emission +
 * routes on top.
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

export {
  drafts,
  DRAFTS_PLUGIN_ID,
  SCHEDULED_PUBLISH_JOB_NAME,
  type DraftsConfig
} from "./plugin";

export { publishDocument, unpublishDocument } from "./publish";
export { schedulePublish, unschedulePublish, runScheduledPublishes } from "./schedule";
export { mountDraftRoutes } from "./routes";
