import type { Hono } from "hono";
import { Hono as HonoClass } from "hono";
import { TrieRouter } from "hono/router/trie-router";
import type { HonoCMSEnv, PluginContext } from "@hono-cms/core";
import type {
  CMSCollections,
  CollectionDefinition,
  FieldsDefinition
} from "@hono-cms/schema";

/**
 * Build the content sub-app + catch-all dispatcher.
 *
 * Hot-registration plumbing (Gap-A runtime fix), ported verbatim from
 * `packages/core/src/create-cms.ts:1017-1075`:
 *
 *   content-collection routes are registered on a dedicated sub-app backed by
 *   a `TrieRouter`, which accepts late `.add()` calls. The main `app` uses
 *   Hono's default `SmartRouter` which bakes its matcher on first request and
 *   therefore cannot accept new routes at runtime.
 *
 *   The main app reaches the sub-app via a single catch-all
 *   `app.all('/api/*', dispatcher)` registered after all explicit `/api/...`
 *   routes other plugins set up. Hono's RegExpRouter prefers the most specific
 *   match, so the catch-all only fires for content-collection paths that no
 *   other plugin claimed.
 *
 * The plugin mounts during the `catchAll` install phase — the kernel
 * guarantees this runs strictly after `early` and `normal` phase plugins, so
 * every `/api/...` literal route any other plugin (media, preview, drafts,
 * graphql, etc.) registers has already landed on `app` when the dispatcher
 * is wired up here.
 *
 * The returned `register` function installs the per-collection content
 * CRUD handlers on the trie. It's idempotent — re-registering an existing
 * collection just refreshes the validator state (TrieRouter cannot
 * un-register routes, so unregister works via the `liveCollection()`
 * short-circuit inside each handler).
 *
 * The actual content-CRUD handlers live in the kernel today (the broader
 * carve-out lands in a later unit); for now this plugin owns only the trie
 * sub-app + dispatcher pattern, and exposes the same `register(name)` hook
 * the kernel used to call inline.
 */
export type HotRouteHandler = (
  contentApp: Hono<HonoCMSEnv>,
  ctx: PluginContext,
  collectionName: string,
  collection: CollectionDefinition<string, FieldsDefinition>
) => void;

export type HotRouteRegistry = {
  /** Install routes for a collection. Safe to call repeatedly. */
  register(collectionName: string): void;
  /** Internal handle on the content sub-app — exposed for tests. */
  contentApp: Hono<HonoCMSEnv>;
};

export function createHotRouteRegistry(
  ctx: PluginContext,
  opts: { handler?: HotRouteHandler } = {}
): HotRouteRegistry {
  const contentApp = new HonoClass<HonoCMSEnv>({ router: new TrieRouter() });
  const registered = new Set<string>();
  const handler = opts.handler;

  const register = (collectionName: string): void => {
    const collection = ctx.collections[collectionName] as
      | CollectionDefinition<string, FieldsDefinition>
      | undefined;
    if (!collection) {
      // Collection was dropped before we got a chance to register; treat the
      // call as a no-op. Existing handlers stay on the trie and short-circuit
      // via the `liveCollection()` guard.
      return;
    }
    if (registered.has(collectionName)) {
      // Re-registration: a custom handler may want to refresh its validator
      // state. Re-run it so renames + field changes propagate.
      handler?.(contentApp, ctx, collectionName, collection);
      return;
    }
    registered.add(collectionName);
    if (handler) {
      handler(contentApp, ctx, collectionName, collection);
    } else {
      mountDefaultCollectionRoutes(contentApp, ctx, collectionName);
    }
  };

  return { register, contentApp };
}

/**
 * Mount the catch-all dispatcher on the main app.
 *
 * Must be the LAST `app.all('/api/*', ...)` registered — Hono's
 * RegExpRouter prefers the most specific match, so explicit
 * `/api/<literal>` routes registered earlier still win for their own paths.
 */
export function mountCatchAllDispatcher(
  app: Hono<HonoCMSEnv>,
  registry: HotRouteRegistry
): void {
  app.all("/api/*", async (context) => {
    return registry.contentApp.fetch(context.req.raw);
  });
}

/**
 * Default collection-routes handler.
 *
 * Mounts a minimal `GET /api/<name>` + `POST /api/<name>` + `GET/PATCH/DELETE
 * /api/<name>/:id` set against `ctx.db`. The full kernel handlers (with
 * caching, populate, locale fallback, audit, hooks) remain in core during
 * U22 — a later unit will move them here. The minimal set is enough to
 * prove the dispatch pipeline works end-to-end after a hot collection
 * mutation.
 */
function mountDefaultCollectionRoutes<Collections extends CMSCollections>(
  contentApp: Hono<HonoCMSEnv>,
  ctx: PluginContext<Collections>,
  collectionName: string
): void {
  const base = `/api/${collectionName}`;

  const liveCollection = ():
    | CollectionDefinition<string, FieldsDefinition>
    | null => {
    const current = ctx.collections[collectionName as keyof Collections] as
      | CollectionDefinition<string, FieldsDefinition>
      | undefined;
    return current ?? null;
  };

  contentApp.get(base, async () => {
    if (!liveCollection()) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const result = await ctx.db.list(collectionName, {});
    return Response.json(result);
  });

  contentApp.post(base, async (context) => {
    if (!liveCollection()) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const body = await context.req.json<Record<string, unknown>>().catch(() => ({}));
    const record = await ctx.db.create(collectionName, body);
    return Response.json(record, { status: 201 });
  });

  contentApp.get(`${base}/:id`, async (context) => {
    if (!liveCollection()) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const record = await ctx.db.get(collectionName, context.req.param("id"));
    if (!record) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(record);
  });

  contentApp.patch(`${base}/:id`, async (context) => {
    if (!liveCollection()) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const body = await context.req.json<Record<string, unknown>>().catch(() => ({}));
    const record = await ctx.db.update(
      collectionName,
      context.req.param("id"),
      body
    );
    return Response.json(record);
  });

  contentApp.delete(`${base}/:id`, async (context) => {
    if (!liveCollection()) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    await ctx.db.delete(collectionName, context.req.param("id"));
    return new Response(null, { status: 204 });
  });
}
