import { describe, expect, test, vi } from "vitest";
import { createVercelBlobStorage, type VercelBlobClient } from "../index";

describe("VercelBlobStorageAdapter", () => {
  test("stores, reads through blob metadata URL, and deletes blobs", async () => {
    const client: VercelBlobClient = {
      put: vi.fn(async (pathname: string) => ({
        url: `https://blob.test/${pathname}`,
        downloadUrl: `https://blob.test/${pathname}?download=1`,
        pathname,
        contentType: "text/plain",
        contentDisposition: "inline",
        contentLength: 5,
        uploadedAt: new Date("2026-05-22T00:00:00.000Z"),
        access: "public",
        etag: "etag"
      })),
      head: vi.fn(async (pathname: string) => ({
        url: `https://blob.test/${pathname}`,
        downloadUrl: `https://blob.test/${pathname}?download=1`,
        pathname,
        size: 5,
        contentType: "text/plain",
        contentDisposition: "inline",
        cacheControl: "public",
        uploadedAt: new Date("2026-05-22T00:00:00.000Z"),
        etag: "etag"
      })),
      del: vi.fn(async () => undefined)
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("hello", { headers: { "content-type": "text/plain" } })));

    const storage = createVercelBlobStorage({ provider: "vercel-blob", token: "token", client });
    await expect(storage.put("media/file.txt", "hello", { contentType: "text/plain" })).resolves.toMatchObject({
      key: "media/file.txt",
      url: "https://blob.test/media/file.txt",
      size: 5
    });
    await expect(storage.get("media/file.txt").then((response) => response?.text())).resolves.toBe("hello");
    await storage.delete("media/file.txt");
    expect(client.del).toHaveBeenCalledWith("media/file.txt", { token: "token" });
    vi.unstubAllGlobals();
  });

  test("rejects unsafe keys before calling Vercel Blob", async () => {
    const client: VercelBlobClient = {
      put: vi.fn(),
      head: vi.fn(),
      del: vi.fn()
    };
    const storage = createVercelBlobStorage({ provider: "vercel-blob", token: "token", client });

    await expect(storage.put("../escape.txt", "nope")).rejects.toThrow(/traversal/);
    await expect(storage.get("/absolute.txt")).rejects.toThrow(/relative path/);
    await expect(storage.createSignedUploadUrl({ key: "media//empty.txt", contentType: "text/plain", size: 4, expiresInSeconds: 60 })).rejects.toThrow(/empty/);
    expect(() => storage.publicUrl("media\\windows.txt")).toThrow(/relative path/);
    expect(client.put).not.toHaveBeenCalled();
    expect(client.head).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
  });
});
