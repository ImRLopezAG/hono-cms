import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "@hono-cms/storage-memory";
import { confirmMediaUpload, createMediaPresign } from "../presign";
import { MemoryMediaStore, type MediaPresignSession } from "../store/memory";

function makeStorage() {
  return createMemoryStorage({ provider: "memory" });
}

describe("createMediaPresign()", () => {
  it("returns a signed upload URL with method + headers + future expiry", async () => {
    const storage = makeStorage();
    const presign = await createMediaPresign(storage, {
      filename: "photo.png",
      contentType: "image/png",
      size: 1024
    });

    expect(presign.uploadId).toBeTruthy();
    expect(presign.key.startsWith("media/")).toBe(true);
    expect(presign.key.endsWith("-photo.png")).toBe(true);
    expect(presign.method).toBe("PUT");
    expect(presign.headers["content-type"]).toBe("image/png");
    expect(Date.parse(presign.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("validates filename + size + content type up front", async () => {
    const storage = makeStorage();
    await expect(
      createMediaPresign(storage, { filename: "", contentType: "image/png", size: 1 })
    ).rejects.toThrowError("filename is required");
    await expect(
      createMediaPresign(storage, { filename: "a.png", contentType: "image/png", size: 0 })
    ).rejects.toThrowError("size must be greater than zero");
    await expect(
      createMediaPresign(storage, { filename: "a.png", contentType: "image/png", size: 10 }, { maxSizeBytes: 5 })
    ).rejects.toThrowError("file exceeds max presigned upload size");
  });

  it("rejects SVG/HTML uploads unless allowActiveContent is true", async () => {
    const storage = makeStorage();
    await expect(
      createMediaPresign(storage, { filename: "x.svg", contentType: "image/svg+xml", size: 100 })
    ).rejects.toThrowError("active_content_not_allowed");

    const ok = await createMediaPresign(
      storage,
      { filename: "x.svg", contentType: "image/svg+xml", size: 100 },
      { allowActiveContent: true }
    );
    expect(ok.uploadId).toBeTruthy();
  });
});

describe("confirmMediaUpload()", () => {
  async function bootstrap() {
    const storage = makeStorage();
    const mediaStore = new MemoryMediaStore();
    // Pre-stage an object under the presign key. The session here is built by
    // hand to keep the test focused on `confirmMediaUpload` semantics.
    const filename = "photo.png";
    const contentType = "image/png";
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const key = `media/u-${filename}`;
    const stored = await storage.put(key, bytes, { contentType, metadata: { filename } });
    const session: MediaPresignSession = {
      uploadId: "u",
      key,
      filename,
      contentType,
      size: stored.size,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    return { storage, mediaStore, session, stored };
  }

  it("materialises a MediaRecord when the upload matches the session", async () => {
    const { storage, mediaStore, session, stored } = await bootstrap();
    const record = await confirmMediaUpload(mediaStore, storage, session, {
      uploadId: session.uploadId,
      key: session.key,
      filename: session.filename,
      contentType: session.contentType,
      size: session.size
    });
    expect(record.id).toBeTruthy();
    expect(record.key).toBe(session.key);
    expect(record.size).toBe(stored.size);
    expect(record.filename).toBe(session.filename);
  });

  it("rejects mismatched session fields", async () => {
    const { storage, mediaStore, session } = await bootstrap();
    await expect(
      confirmMediaUpload(mediaStore, storage, session, {
        uploadId: "different",
        key: session.key,
        filename: session.filename,
        contentType: session.contentType,
        size: session.size
      })
    ).rejects.toThrowError("presign_session_mismatch");

    await expect(
      confirmMediaUpload(mediaStore, storage, session, {
        uploadId: session.uploadId,
        key: session.key,
        filename: "OTHER",
        contentType: session.contentType,
        size: session.size
      })
    ).rejects.toThrowError("presign_metadata_mismatch");
  });

  it("rejects expired sessions", async () => {
    const { storage, mediaStore, session } = await bootstrap();
    const expired: MediaPresignSession = { ...session, expiresAt: new Date(Date.now() - 1000).toISOString() };
    await expect(
      confirmMediaUpload(mediaStore, storage, expired, {
        uploadId: expired.uploadId,
        key: expired.key,
        filename: expired.filename,
        contentType: expired.contentType,
        size: expired.size
      })
    ).rejects.toThrowError("presign_session_expired");
  });

  it("rejects when the object never landed in storage", async () => {
    const { mediaStore, session } = await bootstrap();
    const emptyStorage = makeStorage();
    await expect(
      confirmMediaUpload(mediaStore, emptyStorage, session, {
        uploadId: session.uploadId,
        key: session.key,
        filename: session.filename,
        contentType: session.contentType,
        size: session.size
      })
    ).rejects.toThrowError("media_object_not_found");
  });
});
