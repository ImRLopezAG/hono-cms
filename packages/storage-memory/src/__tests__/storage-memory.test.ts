import { describe, expect, test } from "vitest";
import { createMemoryStorage } from "../index";

describe("MemoryStorageAdapter", () => {
  test("stores, reads, presigns, and deletes in memory", async () => {
    const storage = createMemoryStorage({ provider: "memory", publicBaseUrl: "memory://test" });

    await expect(storage.put("media/file.txt", "hello", { contentType: "text/plain" })).resolves.toMatchObject({
      key: "media/file.txt",
      url: "memory://test/media%2Ffile.txt",
      size: 5,
      contentType: "text/plain"
    });
    await expect(storage.get("media/file.txt").then((response) => response?.text())).resolves.toBe("hello");
    await expect(storage.createSignedUploadUrl({ key: "media/new.txt", contentType: "text/plain", size: 5, expiresInSeconds: 60 })).resolves.toMatchObject({
      method: "PUT",
      headers: { "content-type": "text/plain" }
    });
    await storage.delete("media/file.txt");
    await expect(storage.get("media/file.txt")).resolves.toBeNull();
  });

  test("rejects unsafe keys before touching in-memory objects", async () => {
    const storage = createMemoryStorage({ provider: "memory" });

    await expect(storage.put("../escape.txt", "nope")).rejects.toThrow(/traversal/);
    await expect(storage.get("/absolute.txt")).rejects.toThrow(/relative path/);
    await expect(storage.createSignedUploadUrl({ key: "media//empty.txt", contentType: "text/plain", size: 4, expiresInSeconds: 60 })).rejects.toThrow(/empty/);
    expect(() => storage.publicUrl("media\\windows.txt")).toThrow(/relative path/);
    await expect(storage.health()).resolves.toMatchObject({ ok: true, details: { objects: 0 } });
  });
});
