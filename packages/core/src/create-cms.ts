/**
 * `createCMS` — the plugin manifest kernel.
 *
 * Replacement for the 2,553-line legacy monolith. Takes a
 * `plugins: Plugin[]` array, mounts the minimum content REST surface,
 * and wires the AuthPlugin's `protected` middleware + `authorize`
 * policy around it. Everything cross-cutting lives in plugins.
 *
 * See ADR 0001 for the manifest architecture and ADR 0002 for the
 * scope cut (organizations, built-in auth, better-auth glue removed).
 */
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { CMSCollections, ContentRecord } from "@hono-cms/schema";
import { runHealthChecks } from "./health";
import { createPluginContext } from "./plugins/context";
import { installPlugins, type InstallResult } from "./plugins/runtime";
import type { Plugin, PluginContext } from "./plugins/types";
import type { HonoCMSEnv } from "./types/instance";
import type { DatabaseAdapter, MediaStore, StorageAdapter } from "./types/providers";

export type CMSConfig<Collections extends CMSCollections = CMSCollections> = {
  collections: Collections;
  /** Direct adapter only — no more `provider:` discriminator. */
  db: DatabaseAdapter<Collections>;
  /** Direct adapter. Storage is consumed by the media plugin via `ctx.storage`. */
  storage?: StorageAdapter;
  /** Direct adapter. */
  mediaStore?: MediaStore;
  /** Environment values that plugins read via `ctx.env`. */
  env?: Record<string, unknown>;
  /** Public base URL — used by jobs / media-presign plugins for callbacks. */
  baseUrl?: string;
  /**
   * Plugin manifest array. Order is install order; mountPhase grouping
   * (`early` → `normal` → `catchAll`) applies. See ADR 0001.
   */
  plugins: readonly Plugin<Collections>[];
};

export type CMSInstance<Collections extends CMSCollections = CMSCollections> =
  Hono<HonoCMSEnv> & {
    readonly collections: Collections;
    readonly db: DatabaseAdapter<Collections>;
    readonly storage?: StorageAdapter;
    readonly mediaStore?: MediaStore;
    readonly ctx: PluginContext<Collections>;
    readonly installed: InstallResult<Collections>;
  };

export async function createCMS<Collections extends CMSCollections>(
  config: CMSConfig<Collections>
): Promise<CMSInstance<Collections>> {
  const startedAt = Date.now();
  const collections = { ...config.collections };
  const ctx = createPluginContext({
    collections,
    db: config.db,
    storage: config.storage,
    mediaStore: config.mediaStore,
    env: config.env ?? {},
    baseUrl: config.baseUrl
  });

  const app = new Hono<HonoCMSEnv>();
  const installed = await installPlugins(config.plugins, app, ctx);

  app.get("/cms/health/live", (c) =>
    c.json({
      status: "ok",
      uptime_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000))
    })
  );

  app.get("/cms/health/ready", (c) => c.json({ status: "ok" }));

  app.get("/cms/health", async (c) => {
    const checkers = [
      { name: "db", check: () => config.db.health?.() ?? Promise.resolve({ ok: true as const }) },
      ...(config.storage?.health
        ? [{ name: "storage" as const, check: () => config.storage!.health!() }]
        : []),
      ...(config.mediaStore?.health
        ? [{ name: "media" as const, check: () => config.mediaStore!.health!() }]
        : [])
    ];
    const report = await runHealthChecks(checkers, { startedAt, version: "0.1.0" });
    return c.json(report);
  });

  const protectedMw: MiddlewareHandler<HonoCMSEnv> = installed.authPlugin
    ? installed.authPlugin.protected
    : async (_c, next) => { await next(); };

  for (const collectionName of Object.keys(collections)) {
    mountContentRoutes(app, collectionName, config.db, ctx, installed, protectedMw);
  }

  const instance = app as CMSInstance<Collections>;
  Object.defineProperty(instance, "collections", { value: collections, enumerable: true });
  Object.defineProperty(instance, "db", { value: config.db, enumerable: true });
  Object.defineProperty(instance, "storage", { value: config.storage, enumerable: true });
  Object.defineProperty(instance, "mediaStore", { value: config.mediaStore, enumerable: true });
  Object.defineProperty(instance, "ctx", { value: ctx, enumerable: false });
  Object.defineProperty(instance, "installed", { value: installed, enumerable: false });
  return instance;
}

function mountContentRoutes<Collections extends CMSCollections>(
  app: Hono<HonoCMSEnv>,
  collection: string,
  db: DatabaseAdapter<Collections>,
  ctx: PluginContext<Collections>,
  installed: InstallResult<Collections>,
  protectedMw: MiddlewareHandler<HonoCMSEnv>
): void {
  const base = `/api/${collection}`;

  app.use(`${base}/*`, protectedMw);
  app.use(base, protectedMw);

  app.get(base, async (c) => {
    if (!(await installed.authorize("read", collection))) {
      return c.json({ error: "forbidden" }, 403);
    }
    const url = new URL(c.req.url);
    const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
    const result = await db.list(collection as keyof Collections & string, { limit });
    return c.json(result);
  });

  app.get(`${base}/:id`, async (c) => {
    if (!(await installed.authorize("read", collection))) {
      return c.json({ error: "forbidden" }, 403);
    }
    const record = await db.get(collection as keyof Collections & string, c.req.param("id"));
    if (!record) return c.json({ error: "not_found" }, 404);
    return c.json(record);
  });

  app.post(base, async (c) => {
    if (!(await installed.authorize("create", collection))) {
      return c.json({ error: "forbidden" }, 403);
    }
    const input = (await c.req.json()) as Record<string, unknown>;
    const record = await db.create(collection as keyof Collections & string, input);
    await ctx.events.emit("content:after-create", {
      collection,
      record,
      identity: c.get("identity") ?? null,
      request: c.req.raw
    });
    return c.json(record, 201);
  });

  app.patch(`${base}/:id`, async (c) => {
    const id = c.req.param("id");
    if (!(await installed.authorize("update", collection))) {
      return c.json({ error: "forbidden" }, 403);
    }
    const before = await db.get(collection as keyof Collections & string, id);
    if (!before) return c.json({ error: "not_found" }, 404);
    const patch = (await c.req.json()) as Record<string, unknown>;
    const record = (await db.update(collection as keyof Collections & string, id, patch)) as ContentRecord;
    await ctx.events.emit("content:after-update", {
      collection,
      record,
      before,
      identity: c.get("identity") ?? null,
      request: c.req.raw
    });
    return c.json(record);
  });

  app.put(`${base}/:id`, async (c) => {
    const id = c.req.param("id");
    if (!(await installed.authorize("update", collection))) {
      return c.json({ error: "forbidden" }, 403);
    }
    const before = await db.get(collection as keyof Collections & string, id);
    if (!before) return c.json({ error: "not_found" }, 404);
    const replacement = (await c.req.json()) as Record<string, unknown>;
    const record = (await db.update(collection as keyof Collections & string, id, replacement)) as ContentRecord;
    await ctx.events.emit("content:after-update", {
      collection,
      record,
      before,
      identity: c.get("identity") ?? null,
      request: c.req.raw
    });
    return c.json(record);
  });

  app.delete(`${base}/:id`, async (c) => {
    const id = c.req.param("id");
    if (!(await installed.authorize("delete", collection))) {
      return c.json({ error: "forbidden" }, 403);
    }
    const before = await db.get(collection as keyof Collections & string, id);
    await db.delete(collection as keyof Collections & string, id);
    await ctx.events.emit("content:after-delete", {
      collection,
      id,
      record: before,
      identity: c.get("identity") ?? null,
      request: c.req.raw
    });
    return c.json({ ok: true });
  });
}
