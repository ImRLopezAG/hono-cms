import type { Hono } from "hono";
import type { HonoCMSEnv, PluginContext } from "@hono-cms/core";
import type { CMSCollections } from "@hono-cms/schema";
import { publishDocument, unpublishDocument } from "./publish";
import { schedulePublish, unschedulePublish } from "./schedule";

/**
 * Mount the four `/api/<collection>/:id/{publish,unpublish,schedule,unschedule}`
 * routes for every collection currently declared on `ctx.collections`.
 *
 * Routes are wired once per install — content-type-builder (U22) is responsible
 * for re-mounting routes when collections are added at runtime, the same way it
 * does for the content CRUD routes. We don't subscribe to schema events from
 * here so the route set stays predictable across the install lifecycle.
 *
 * Each route:
 * - Returns 404 when the collection no longer exists OR no longer has
 *   `draftAndPublish` enabled (mirrors the legacy behaviour in
 *   `packages/core/src/create-cms.ts`).
 * - Pulls identity from `c.get("identity")` (auth-tokens) with a fallback to
 *   `c.get("session")` (legacy admin auth) so events carry actor metadata.
 * - Does *not* do its own access control: the kernel composes the AuthPlugin's
 *   `protected` middleware on top of the plugin's routes, and host-level
 *   authorize callbacks fire via the same path. Rate limiting is similarly
 *   handed off to the rate-limit plugin.
 */
export function mountDraftRoutes<Collections extends CMSCollections>(
  app: Hono<HonoCMSEnv>,
  ctx: PluginContext<Collections>
): void {
  for (const collectionName of Object.keys(ctx.collections)) {
    mountCollection(app, ctx, collectionName as keyof Collections & string);
  }
}

function mountCollection<Collections extends CMSCollections>(
  app: Hono<HonoCMSEnv>,
  ctx: PluginContext<Collections>,
  collectionName: keyof Collections & string
): void {
  const base = `/api/${collectionName}`;

  app.post(`${base}/:id/publish`, async (context) => {
    const liveColl = ctx.collections[collectionName];
    if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
    if (!liveColl.options.draftAndPublish) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    try {
      const record = await publishDocument({
        db: ctx.db,
        events: ctx.events,
        collection: collectionName,
        id: context.req.param("id"),
        identity: resolveIdentity(context),
        request: context.req.raw
      });
      return Response.json(record);
    } catch (error) {
      return notFoundOrRethrow(error);
    }
  });

  app.post(`${base}/:id/unpublish`, async (context) => {
    const liveColl = ctx.collections[collectionName];
    if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
    if (!liveColl.options.draftAndPublish) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    try {
      const record = await unpublishDocument({
        db: ctx.db,
        events: ctx.events,
        collection: collectionName,
        id: context.req.param("id"),
        identity: resolveIdentity(context),
        request: context.req.raw
      });
      return Response.json(record);
    } catch (error) {
      return notFoundOrRethrow(error);
    }
  });

  app.post(`${base}/:id/schedule`, async (context) => {
    const liveColl = ctx.collections[collectionName];
    if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
    if (!liveColl.options.draftAndPublish) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    let body: { publishAt?: unknown };
    try {
      body = await context.req.json<{ publishAt?: unknown }>();
    } catch {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    if (typeof body.publishAt !== "string" || !body.publishAt) {
      return Response.json(
        {
          error: "validation_error",
          issues: [{ path: ["publishAt"], message: "publishAt is required" }]
        },
        { status: 422 }
      );
    }
    const publishAt = new Date(body.publishAt);
    if (Number.isNaN(publishAt.valueOf())) {
      return Response.json(
        {
          error: "validation_error",
          issues: [{ path: ["publishAt"], message: "publishAt must be a valid ISO date" }]
        },
        { status: 422 }
      );
    }
    const record = await schedulePublish({
      db: ctx.db,
      collection: collectionName,
      id: context.req.param("id"),
      publishAt
    });
    return Response.json(record);
  });

  app.post(`${base}/:id/unschedule`, async (context) => {
    const liveColl = ctx.collections[collectionName];
    if (!liveColl) return Response.json({ error: "not_found" }, { status: 404 });
    if (!liveColl.options.draftAndPublish) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const record = await unschedulePublish({
      db: ctx.db,
      collection: collectionName,
      id: context.req.param("id")
    });
    return Response.json(record);
  });
}

/**
 * Pull whichever identity slot the active auth plugin populated.
 *
 * The `auth-tokens` plugin writes to `c.var.identity`; the legacy admin auth
 * (and the built-in `requireAccess` helper) writes to `c.var.session`. We
 * accept either so the plugin works in both auth wirings.
 */
function resolveIdentity(context: { get: (key: string) => unknown }): unknown {
  const identity = context.get("identity");
  if (identity) return identity;
  const session = context.get("session");
  if (session) return session;
  return null;
}

/**
 * The core helpers throw a plain `Error("Record ... was not found ...")` for
 * a missing document. Translate that into a 404 so the API surface is well-
 * defined; bubble everything else.
 */
function notFoundOrRethrow(error: unknown): Response {
  if (error instanceof Error && /was not found in/.test(error.message)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  throw error;
}
