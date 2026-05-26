import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import {
  createPluginContext,
  installPlugins,
  type AuthSession,
  type HonoCMSEnv
} from "@hono-cms/core";
import { createMemoryStorage } from "@hono-cms/storage-memory";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { mediaPlugin, type MediaService } from "../plugin";

const articles = defineSchema({
  articles: defineCollection("articles", {
    title: fields.string({ required: true }),
    hero: fields.media()
  })
});

const EDITOR: AuthSession = { userId: "u1", roles: ["editor"], email: "e@test.local" };
const ANON: AuthSession | null = null;

type Bootstrap = ReturnType<typeof bootstrap> extends Promise<infer T> ? T : never;

async function bootstrap(
  pluginOpts: Parameters<typeof mediaPlugin>[0] = {},
  session: AuthSession | null = EDITOR
) {
  const db = createMemoryDatabase({ provider: "memory", collections: articles });
  const storage = createMemoryStorage({ provider: "memory" });
  const app = new Hono<HonoCMSEnv>();
  // Stand-in for the auth plugin: stamp every request with the chosen session
  // so the media routes' `requireEditor` check has something to look at.
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  const ctx = createPluginContext({ collections: articles, db, storage, env: {} });
  await installPlugins([mediaPlugin(pluginOpts)], app, ctx);
  const service = ctx.plugins.get<MediaService>("media");
  return { app, ctx, db, storage, service };
}

function multipart(filename: string, body: Uint8Array, contentType = "application/octet-stream"): Request {
  const file = new File([body], filename, { type: contentType });
  const form = new FormData();
  form.set("file", file);
  return new Request("https://test.local/api/media", { method: "POST", body: form });
}

describe("media routes — auth gating", () => {
  it("returns 403 to anonymous callers", async () => {
    const { app } = await bootstrap({}, ANON);
    const res = await app.request("/api/media");
    expect(res.status).toBe(403);
  });

  it("returns 403 to viewer-only callers", async () => {
    const { app } = await bootstrap({}, { userId: "u", roles: ["viewer"] });
    const res = await app.request("/api/media");
    expect(res.status).toBe(403);
  });
});

describe("POST /api/media — direct multipart upload", () => {
  it("creates a record and emits media:after-upload", async () => {
    const events: Array<Record<string, unknown>> = [];
    const { app, ctx, storage } = await bootstrap();
    ctx.events.on("media:after-upload", async (payload) => {
      events.push(payload.record);
    });

    const res = await app.request(multipart("hello.png", new Uint8Array([1, 2, 3]), "image/png"));
    expect(res.status).toBe(201);
    const record = await res.json();
    expect(record.filename).toBe("hello.png");
    expect(record.contentType).toBe("image/png");
    expect(record.size).toBe(3);
    expect(record.id).toBeTruthy();

    // Object actually landed in storage.
    const stored = await storage.head(record.key);
    expect(stored).not.toBeNull();
    expect(stored?.size).toBe(3);

    // Event fired exactly once with the record payload.
    expect(events.length).toBe(1);
    expect(events[0]!.id).toBe(record.id);
  });

  it("rejects SVG uploads by default and accepts them when allowActiveContent: true", async () => {
    const { app } = await bootstrap();
    const blocked = await app.request(multipart("vector.svg", new Uint8Array([1]), "image/svg+xml"));
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error).toBe("upload_failed");

    const { app: app2 } = await bootstrap({ allowActiveContent: true });
    const ok = await app2.request(multipart("vector.svg", new Uint8Array([1]), "image/svg+xml"));
    expect(ok.status).toBe(201);
  });

  it("returns 503 when storage is not configured", async () => {
    const db = createMemoryDatabase({ provider: "memory", collections: articles });
    const app = new Hono<HonoCMSEnv>();
    app.use("*", async (c, next) => {
      c.set("session", EDITOR);
      await next();
    });
    const ctx = createPluginContext({ collections: articles, db, env: {} });
    await installPlugins([mediaPlugin()], app, ctx);

    const res = await app.request(multipart("a.png", new Uint8Array([1]), "image/png"));
    expect(res.status).toBe(503);
  });
});

describe("POST /api/media/presign + /confirm", () => {
  it("returns a signed URL, then confirms after the bytes land in storage", async () => {
    const { app, storage, service } = await bootstrap();

    const presignRes = await app.request("/api/media/presign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "photo.png", contentType: "image/png", size: 4 })
    });
    expect(presignRes.status).toBe(200);
    const presign = await presignRes.json();
    expect(presign.uploadUrl).toBeTruthy();
    expect(presign.uploadId).toBeTruthy();

    // Simulate the client uploading the bytes directly to storage.
    await storage.put(presign.key, new Uint8Array([1, 2, 3, 4]), {
      contentType: "image/png",
      metadata: { filename: "photo.png", uploadId: presign.uploadId }
    });

    const confirmRes = await app.request("/api/media/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        uploadId: presign.uploadId,
        key: presign.key,
        filename: "photo.png",
        contentType: "image/png",
        size: 4
      })
    });
    expect(confirmRes.status).toBe(201);
    const record = await confirmRes.json();
    expect(record.id).toBeTruthy();
    const list = await service.store.list();
    expect(list.items.length).toBe(1);
  });

  it("rejects confirm with an unknown uploadId", async () => {
    const { app } = await bootstrap();
    const res = await app.request("/api/media/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        uploadId: "missing",
        key: "media/x",
        filename: "x.png",
        contentType: "image/png",
        size: 1
      })
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("presign_session_not_found");
  });
});

describe("/api/media/folders — CRUD", () => {
  let app: Bootstrap["app"];
  beforeEach(async () => {
    ({ app } = await bootstrap());
  });

  it("lists / creates / patches / deletes folders", async () => {
    // List empty.
    let res = await app.request("/api/media/folders");
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual([]);

    // Create root folder.
    res = await app.request("/api/media/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Inbox" })
    });
    expect(res.status).toBe(201);
    const folder = await res.json();
    expect(folder.name).toBe("Inbox");
    expect(folder.path).toBe("/Inbox");

    // Validation: missing name → 422.
    res = await app.request("/api/media/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(422);

    // Patch.
    res = await app.request(`/api/media/folders/${folder.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" })
    });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Renamed");

    // Delete.
    res = await app.request(`/api/media/folders/${folder.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    res = await app.request("/api/media/folders");
    expect((await res.json()).items).toEqual([]);
  });
});

describe("GET /api/media/:id/file — streams from storage", () => {
  it("returns the underlying object", async () => {
    const { app } = await bootstrap();
    const upload = await app.request(multipart("a.png", new Uint8Array([7, 8, 9]), "image/png"));
    const record = await upload.json();

    const fileRes = await app.request(`/api/media/${record.id}/file`);
    expect(fileRes.status).toBe(200);
    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    expect(Array.from(bytes)).toEqual([7, 8, 9]);
  });

  it("returns 404 when the media id is unknown", async () => {
    const { app } = await bootstrap();
    const res = await app.request("/api/media/does-not-exist/file");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/media/:id — in-use guard", () => {
  it("returns 409 when a collection row references the media", async () => {
    const { app, db } = await bootstrap();
    const upload = await app.request(multipart("a.png", new Uint8Array([1, 2]), "image/png"));
    const media = await upload.json();

    // Seed an article that references the media via the `hero` field.
    await db.create("articles", { title: "Hello", heroId: media.id } as any);

    const res = await app.request(`/api/media/${media.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("media_in_use");
    expect(Array.isArray(body.references)).toBe(true);
    expect(body.references[0]).toMatchObject({ collection: "articles", field: "hero" });
  });

  it("204s and emits media:after-delete on success", async () => {
    const events: Array<Record<string, unknown>> = [];
    const { app, ctx } = await bootstrap();
    ctx.events.on("media:after-delete", async (payload) => {
      events.push(payload.record);
    });
    const upload = await app.request(multipart("a.png", new Uint8Array([1, 2]), "image/png"));
    const media = await upload.json();

    const res = await app.request(`/api/media/${media.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(events.length).toBe(1);
    expect(events[0]!.id).toBe(media.id);
  });
});

describe("GET /api/media — list + validation", () => {
  it("returns 422 on a bad limit", async () => {
    const { app } = await bootstrap();
    const res = await app.request("/api/media?limit=9999");
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("validation_error");
  });

  it("returns the seeded records sorted newest-first", async () => {
    const { app } = await bootstrap();
    await app.request(multipart("a.png", new Uint8Array([1]), "image/png"));
    await app.request(multipart("b.png", new Uint8Array([2]), "image/png"));
    const res = await app.request("/api/media");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(2);
  });
});

describe("GET /api/media/:id and PATCH /api/media/:id", () => {
  it("returns 404 for unknown id", async () => {
    const { app } = await bootstrap();
    const res = await app.request("/api/media/nope");
    expect(res.status).toBe(404);
  });

  it("PATCH updates filename + metadata", async () => {
    const { app } = await bootstrap();
    const upload = await app.request(multipart("a.png", new Uint8Array([1, 2]), "image/png"));
    const media = await upload.json();

    const res = await app.request(`/api/media/${media.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "renamed.png", metadata: { alt: "logo" } })
    });
    expect(res.status).toBe(200);
    const next = await res.json();
    expect(next.filename).toBe("renamed.png");
    expect(next.metadata).toMatchObject({ alt: "logo" });
  });
});
