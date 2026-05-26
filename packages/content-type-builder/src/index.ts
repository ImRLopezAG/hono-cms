/**
 * `@hono-cms/content-type-builder`
 *
 * The single plugin allowed to declare `mountPhase: "catchAll"`. Carved out
 * of `@hono-cms/core` per
 * `docs/plans/2026-05-25-001-refactor-plugin-system-architecture-plan.md`
 * §U22.
 *
 * Owns:
 * - `/cms/content-types` admin CRUD surface (list/create/update/delete).
 * - The `TrieRouter`-backed content sub-app + the `app.all('/api/*', ...)`
 *   catch-all dispatcher. Because this plugin mounts last (the kernel
 *   guarantees that for the `catchAll` phase), every explicit `/api/...`
 *   route any other plugin registers takes precedence over the dispatcher,
 *   so the dispatcher only serves content-collection paths.
 *
 * Composition:
 *
 * ```ts
 * createCMS({
 *   plugins: [
 *     // ... other plugins ...
 *     contentTypeBuilder({
 *       writer: nodeFsCollectionWriter({ directory: './schema' })
 *     })
 *   ]
 * });
 * ```
 */

export {
  contentTypeBuilder,
  CONTENT_TYPE_BUILDER_PLUGIN_ID,
  type ContentTypeBuilderConfig
} from "./plugin";

export {
  createHotRouteRegistry,
  mountCatchAllDispatcher,
  type HotRouteHandler,
  type HotRouteRegistry
} from "./hot-routes";

export { mountContentTypeRoutes } from "./routes";

export type {
  SchemaWriter,
  SchemaWriteResult,
  SchemaWriteLifecycleInput,
  SchemaRemoveLifecycleInput
} from "./writer";
