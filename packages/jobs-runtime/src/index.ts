/**
 * `@hono-cms/jobs-runtime`
 *
 * Plugin that owns the `/cms/jobs/<name>` HTTP surface and exposes a
 * `JobsService` on the plugin registry so other plugins can compose their
 * own background work without depending on a specific `JobsAdapter`
 * implementation.
 *
 * See `docs/plans/2026-05-25-001-refactor-plugin-system-architecture-plan.md`
 * §U12 for the migration rationale.
 */
export { jobsRuntime, JOBS_RUNTIME_ID, type JobsRuntimeOptions, type JobsService } from "./plugin";
export { runVerifiedJob } from "./dispatcher";
export { runScheduledPublish } from "./scheduled-publish";
export { mountJobRoute } from "./routes";
