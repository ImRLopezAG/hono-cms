import { createPlugin, type Plugin } from "@hono-cms/core";
import {
  createHotRouteRegistry,
  mountCatchAllDispatcher,
  type HotRouteHandler
} from "./hot-routes";
import { mountContentTypeRoutes } from "./routes";
import type { SchemaWriter } from "./writer";

/** Plugin id under which the content-type-builder self-registers. */
export const CONTENT_TYPE_BUILDER_PLUGIN_ID = "content-type-builder";

export type ContentTypeBuilderConfig = {
  /**
   * The writer that persists collection definitions to the project's schema
   * source. Without it the plugin still exposes read-only metadata at
   * `GET /cms/content-types`, but `POST/PUT/DELETE` short-circuit because
   * there's no way to write the change to disk.
   */
  writer: SchemaWriter;
  /**
   * Optional override for the per-collection route mounter on the content
   * sub-app. Defaults to a minimal CRUD set (see `hot-routes.ts`); host
   * applications that want the full kernel behaviour (caching, populate,
   * locale fallback, audit) wire that in here.
   */
  registerCollectionRoutes?: HotRouteHandler;
};

/**
 * Build the content-type-builder plugin.
 *
 * Owns:
 * - `GET/POST /cms/content-types` + `PUT/DELETE /cms/content-types/:name`:
 *   the admin CRUD surface for the collection set.
 * - `app.all('/api/*', dispatcher)`: the catch-all that forwards to a
 *   `TrieRouter`-backed sub-app so newly-added collections become reachable
 *   at runtime without a server restart.
 *
 * Composition contract:
 * - `mountPhase: "catchAll"` — the kernel's install pipeline (U4) groups
 *   plugins by phase and runs `early -> normal -> catchAll`. Only one
 *   plugin may declare `catchAll`. That guarantees this plugin's
 *   `/api/*` dispatcher is registered after every other plugin's
 *   explicit `/api/...` routes (media uploads, preview tokens, draft
 *   publish, etc.) so Hono's `RegExpRouter` prefers the specific routes
 *   and only falls back to the dispatcher for content-collection paths.
 * - On content-type CRUD the plugin:
 *   1. mutates `ctx.collections` in place (kernel-shared reference);
 *   2. calls `ctx.db.ensureCollection?.(name)` for adapters that maintain
 *      per-collection state;
 *   3. emits `schema:after-collection-{add,update,remove}` so the graphql
 *      plugin can rebuild its schema, openapi can drop its cache, drafts
 *      can re-wire publish routes, etc.
 *
 * Example usage:
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
export function contentTypeBuilder(opts: ContentTypeBuilderConfig): Plugin {
  return createPlugin({
    id: CONTENT_TYPE_BUILDER_PLUGIN_ID,
    mountPhase: "catchAll",
    app: (app, ctx) => {
      const registry = createHotRouteRegistry(
        ctx,
        opts.registerCollectionRoutes
          ? { handler: opts.registerCollectionRoutes }
          : {}
      );

      // Boot-time registration: wire every collection currently in the
      // schema so it's reachable through the catch-all dispatcher before
      // the first request lands.
      for (const collectionName of Object.keys(ctx.collections)) {
        registry.register(collectionName);
      }

      // Admin CRUD routes for `/cms/content-types`. These are conceptually a
      // `normal`-phase concern (they don't depend on plugin ordering), but
      // the whole plugin runs in the `catchAll` phase because of the
      // dispatcher mount below — keeping both together avoids leaking
      // catchAll-only ordering rules into a separate plugin.
      mountContentTypeRoutes(app, ctx, {
        writer: opts.writer,
        onCollectionChange: (name) => registry.register(name)
      });

      // Mount the catch-all LAST so every preceding `/api/<literal>`
      // route claims its path before the dispatcher sees it.
      mountCatchAllDispatcher(app, registry);
    }
  });
}
