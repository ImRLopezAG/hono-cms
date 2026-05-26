import type { Hono } from "hono";
import type { CMSCollections } from "@hono-cms/schema";
import type {
  AuthSession,
  ContentRecord,
  DatabaseAdapter,
  HonoCMSEnv,
  MediaRecord,
  MediaStore,
  PluginContext
} from "@hono-cms/core";
import type { MediaListQuery } from "./types";
import type { MediaSecurityOptions } from "./content-safety";
import { confirmMediaUpload, createMediaPresign } from "./presign";
import { MediaPresignStore, type MediaPresignSession } from "./store/memory";
import { uploadMediaObject } from "./upload";

export type MediaRouteOptions = {
  store: MediaStore;
  presignExpirySeconds?: number;
  maxPresignUploadSizeBytes?: number;
  allowActiveContent?: boolean;
};

type QueryValidationIssue = { path: string[]; message: string };

/**
 * Mount the 12 `/api/media/*` routes on the supplied Hono app.
 *
 * Sessions are read from `c.get("session")` (populated by the auth plugin's
 * `protected` middleware). Editor/admin gating is enforced inside each route
 * — anonymous and viewer-only callers receive 403. Mutating routes emit
 * `media:after-upload` / `media:after-delete` on `ctx.events` so plugins like
 * audit / webhooks can react.
 */
export function mountMediaRoutes<Collections extends CMSCollections>(
  app: Hono<HonoCMSEnv>,
  ctx: PluginContext<Collections>,
  opts: MediaRouteOptions
): void {
  const { store: mediaStore } = opts;
  const securityOptions: MediaSecurityOptions =
    opts.allowActiveContent === true ? { allowActiveContent: true } : {};
  // Presign sessions are kept in-process. A future revision may accept a
  // `CacheAdapter` from the kernel via `ctx.plugins.get("cache")`.
  const mediaPresigns = new MediaPresignStore(null);
  const presignExpirySeconds = opts.presignExpirySeconds ?? 3600;
  const presignOptions: { expiresInSeconds: number; maxSizeBytes?: number; allowActiveContent?: boolean } = {
    expiresInSeconds: presignExpirySeconds
  };
  if (opts.maxPresignUploadSizeBytes !== undefined) presignOptions.maxSizeBytes = opts.maxPresignUploadSizeBytes;
  if (opts.allowActiveContent === true) presignOptions.allowActiveContent = true;

  app.get("/api/media/folders", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const folderStore = mediaStore.folders;
    if (!folderStore) return Response.json({ items: [] });
    const items = await folderStore.list();
    return Response.json({ items });
  });

  app.post("/api/media/folders", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const folderStore = mediaStore.folders;
    if (!folderStore) return Response.json({ error: "folders_not_supported" }, { status: 501 });
    const body = await context.req
      .json<{ name?: string; parentId?: string | null }>()
      .catch(() => ({} as { name?: string; parentId?: string | null }));
    if (!body.name || !body.name.trim()) {
      return Response.json(
        { error: "validation_error", issues: [{ path: ["name"], message: "name is required" }] },
        { status: 422 }
      );
    }
    try {
      const folder = await folderStore.create({ name: body.name, parentId: body.parentId ?? null });
      return Response.json(folder, { status: 201 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "folder_create_failed" },
        { status: 400 }
      );
    }
  });

  app.patch("/api/media/folders/:id", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const folderStore = mediaStore.folders;
    if (!folderStore) return Response.json({ error: "folders_not_supported" }, { status: 501 });
    const id = context.req.param("id");
    const body = await context.req
      .json<{ name?: string; parentId?: string | null }>()
      .catch(() => ({} as { name?: string; parentId?: string | null }));
    const patch: { name?: string; parentId?: string | null } = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.parentId !== undefined) patch.parentId = body.parentId;
    try {
      const updated = await folderStore.update(id, patch);
      if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json(updated);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "folder_update_failed" },
        { status: 400 }
      );
    }
  });

  app.delete("/api/media/folders/:id", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const folderStore = mediaStore.folders;
    if (!folderStore) return Response.json({ error: "folders_not_supported" }, { status: 501 });
    const id = context.req.param("id");
    const force = new URL(context.req.url).searchParams.get("force") === "true";
    const result = await folderStore.delete(id, { force });
    if (!result.ok) {
      if (result.reason === "not_found") return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({ error: "folder_not_empty" }, { status: 409 });
    }
    return new Response(null, { status: 204 });
  });

  app.get("/api/media", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const url = new URL(context.req.url);
    const query = parseMediaListQuery(url);
    if (query instanceof Response) return query;
    return Response.json(await mediaStore.list(query));
  });

  app.post("/api/media", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const storage = ctx.storage;
    if (!storage) return Response.json({ error: "storage_not_configured" }, { status: 503 });
    const folderIdParam = new URL(context.req.url).searchParams.get("folderId");
    const folderId =
      folderIdParam && folderIdParam !== "null" && folderIdParam !== "" ? folderIdParam : null;
    if (folderId && mediaStore.folders && !(await mediaStore.folders.get(folderId))) {
      return Response.json({ error: "folder_not_found" }, { status: 404 });
    }
    try {
      const uploaded = await uploadMediaObject(storage, context.req.raw, securityOptions);
      const record = await mediaStore.create({ ...uploaded, folderId });
      await ctx.events.emit("media:after-upload", {
        record: record as unknown as Record<string, unknown>,
        identity: context.get("session"),
        request: context.req.raw
      });
      return Response.json(record, { status: 201 });
    } catch (error) {
      return Response.json(
        { error: "upload_failed", message: error instanceof Error ? error.message : "upload failed" },
        { status: 400 }
      );
    }
  });

  app.post("/api/media/presign", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const storage = ctx.storage;
    if (!storage) return Response.json({ error: "storage_not_configured" }, { status: 503 });
    try {
      const body = await context.req.json<{
        filename?: string;
        contentType?: string;
        mimeType?: string;
        size?: number;
      }>();
      const presign = await createMediaPresign(
        storage,
        {
          filename: body.filename ?? "",
          contentType: body.contentType ?? body.mimeType ?? "",
          size: Number(body.size)
        },
        presignOptions
      );
      await mediaPresigns.set(
        {
          uploadId: presign.uploadId,
          key: presign.key,
          filename: presign.filename,
          contentType: presign.contentType,
          size: presign.size,
          expiresAt: presign.expiresAt
        },
        presignExpirySeconds
      );
      return Response.json(presign);
    } catch (error) {
      return Response.json(
        { error: "presign_failed", message: error instanceof Error ? error.message : "presign failed" },
        { status: 400 }
      );
    }
  });

  app.post("/api/media/confirm", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const storage = ctx.storage;
    if (!storage) return Response.json({ error: "storage_not_configured" }, { status: 503 });
    const body = await context.req.json<{
      uploadId?: string;
      key?: string;
      filename?: string;
      contentType?: string;
      mimeType?: string;
      size?: number;
      metadata?: Record<string, string>;
      folderId?: string | null;
    }>();
    if (!body.uploadId) {
      return Response.json(
        { error: "validation_error", issues: [{ path: ["uploadId"], message: "uploadId is required" }] },
        { status: 422 }
      );
    }
    const session: MediaPresignSession | null = await mediaPresigns.get(body.uploadId);
    if (!session) return Response.json({ error: "presign_session_not_found" }, { status: 400 });
    if (body.folderId && mediaStore.folders && !(await mediaStore.folders.get(body.folderId))) {
      return Response.json({ error: "folder_not_found" }, { status: 404 });
    }
    try {
      const confirmInput: {
        uploadId: string;
        key: string;
        filename: string;
        contentType: string;
        size: number;
        metadata?: Record<string, string>;
        folderId?: string | null;
      } = {
        uploadId: body.uploadId,
        key: body.key ?? "",
        filename: body.filename ?? "",
        contentType: body.contentType ?? body.mimeType ?? "",
        size: Number(body.size)
      };
      if (body.metadata) confirmInput.metadata = body.metadata;
      if (body.folderId !== undefined) confirmInput.folderId = body.folderId;
      const confirmed = await confirmMediaUpload(mediaStore, storage, session, confirmInput);
      await mediaPresigns.delete(body.uploadId);
      await ctx.events.emit("media:after-upload", {
        record: confirmed as unknown as Record<string, unknown>,
        identity: context.get("session"),
        request: context.req.raw
      });
      return Response.json(confirmed, { status: 201 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "confirm_failed" },
        { status: 400 }
      );
    }
  });

  app.get("/api/media/:id", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const record = await mediaStore.get(context.req.param("id"));
    return record ? Response.json(record) : Response.json({ error: "not_found" }, { status: 404 });
  });

  app.get("/api/media/:id/file", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const storage = ctx.storage;
    if (!storage) return Response.json({ error: "storage_not_configured" }, { status: 503 });
    const record = await mediaStore.get(context.req.param("id"));
    if (!record) return Response.json({ error: "not_found" }, { status: 404 });
    return (await storage.get(record.key)) ?? Response.json({ error: "not_found" }, { status: 404 });
  });

  app.patch("/api/media/:id", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    if (!mediaStore.update) {
      return Response.json({ error: "media_update_not_supported" }, { status: 501 });
    }
    const id = context.req.param("id");
    const body = await context.req
      .json<{ folderId?: string | null; filename?: string; metadata?: Record<string, string> }>()
      .catch(
        () => ({} as { folderId?: string | null; filename?: string; metadata?: Record<string, string> })
      );
    const patch: Partial<Pick<MediaRecord, "folderId" | "filename" | "metadata">> = {};
    if (body.folderId !== undefined) {
      const folderStore = mediaStore.folders;
      if (body.folderId !== null && folderStore && !(await folderStore.get(body.folderId))) {
        return Response.json({ error: "folder_not_found" }, { status: 404 });
      }
      patch.folderId = body.folderId;
    }
    if (body.filename !== undefined) patch.filename = body.filename;
    if (body.metadata !== undefined) patch.metadata = body.metadata;
    const updated = await mediaStore.update(id, patch);
    if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(updated);
  });

  app.delete("/api/media/:id", async (context) => {
    const denied = requireEditor(context.get("session"));
    if (denied) return denied;
    const mediaId = context.req.param("id");
    const references = await findMediaReferences(ctx.db, ctx.collections, mediaId);
    if (references.length) {
      return Response.json({ error: "media_in_use", references }, { status: 409 });
    }
    const record = await mediaStore.delete(mediaId);
    if (!record) return new Response(null, { status: 204 });
    await ctx.storage?.delete(record.key);
    await ctx.events.emit("media:after-delete", {
      record: record as unknown as Record<string, unknown>,
      identity: context.get("session"),
      request: context.req.raw
    });
    return new Response(null, { status: 204 });
  });
}

function requireEditor(session: AuthSession | null): Response | null {
  return session?.roles.some((role) => role === "admin" || role === "editor")
    ? null
    : Response.json({ error: "forbidden" }, { status: 403 });
}

/**
 * Parse the `?...` query string for `GET /api/media`. Mirrors the validation
 * the core handler historically applied (limit between 1 and 100, dates
 * parseable, `from <= to`, etc.). Returns a 422 `Response` on validation
 * failure so the caller can short-circuit.
 */
export function parseMediaListQuery(url: URL): MediaListQuery | Response {
  const issues: QueryValidationIssue[] = [];
  const rawLimit = url.searchParams.get("limit");
  const limit = Number(rawLimit ?? 50);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    issues.push({ path: ["limit"], message: "limit must be an integer between 1 and 100" });
  }
  if (from && Number.isNaN(Date.parse(from))) {
    issues.push({ path: ["from"], message: "from must be a valid date-time" });
  }
  if (to && Number.isNaN(Date.parse(to))) {
    issues.push({ path: ["to"], message: "to must be a valid date-time" });
  }
  if (
    from &&
    to &&
    !Number.isNaN(Date.parse(from)) &&
    !Number.isNaN(Date.parse(to)) &&
    Date.parse(from) > Date.parse(to)
  ) {
    issues.push({ path: ["from", "to"], message: "from must be before to" });
  }
  if (issues.length) return Response.json({ error: "validation_error", issues }, { status: 422 });

  const query: MediaListQuery = { limit };
  const cursor = url.searchParams.get("cursor");
  const q = url.searchParams.get("q") ?? url.searchParams.get("search");
  const type = url.searchParams.get("type") ?? url.searchParams.get("mimeType");
  const folderId = url.searchParams.get("folderId");
  if (cursor) query.cursor = cursor;
  if (q?.trim()) query.q = q.trim();
  if (type?.trim()) query.type = type.trim();
  if (from) query.from = new Date(from).toISOString();
  if (to) query.to = new Date(to).toISOString();
  if (folderId !== null) {
    // `?folderId=` (empty string) or `?folderId=null` means "root only".
    query.folderId = folderId === "" || folderId === "null" ? null : folderId;
  }
  return query;
}

/**
 * Walk every collection that has a `media`-kind field and find references to
 * the given media id. Used by `DELETE /api/media/:id` to surface a 409 with
 * the in-use locations instead of orphaning collection rows.
 */
async function findMediaReferences<Collections extends CMSCollections>(
  db: DatabaseAdapter<Collections>,
  collections: Collections,
  mediaId: string
): Promise<Array<{ collection: string; field: string; id: string }>> {
  const references: Array<{ collection: string; field: string; id: string }> = [];
  for (const collection of Object.values(collections) as Array<{
    name: string;
    fields: Record<string, { kind: string }>;
  }>) {
    const mediaFields = Object.entries(collection.fields).filter(([, field]) => field.kind === "media");
    if (!mediaFields.length) continue;
    let cursor: string | undefined;
    do {
      const result = await db.list(
        collection.name as keyof Collections & string,
        cursor ? { cursor, limit: 100 } : { limit: 100 }
      );
      for (const record of result.items) {
        for (const [fieldName] of mediaFields) {
          if (recordReferencesMedia(record, fieldName, mediaId)) {
            references.push({ collection: collection.name, field: fieldName, id: record.id });
          }
        }
      }
      cursor = result.nextCursor;
    } while (cursor);
  }
  return references;
}

function recordReferencesMedia(record: ContentRecord, fieldName: string, mediaId: string): boolean {
  const value = record[`${fieldName}Id`] ?? record[fieldName];
  if (typeof value === "string") return value === mediaId;
  if (Array.isArray(value)) return value.some((item) => mediaReferenceId(item) === mediaId);
  return mediaReferenceId(value) === mediaId;
}

function mediaReferenceId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}
