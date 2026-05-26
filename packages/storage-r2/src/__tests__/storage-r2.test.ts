import { describe, expect, test } from "vitest";
import { createR2Storage, type R2BucketBinding } from "../index";

describe("R2StorageAdapter", () => {
  test("stores, reads, presigns, and deletes through a Workers R2 binding", async () => {
    const objects = new Map<string, { body: Uint8Array; contentType?: string }>();
    const bucket: R2BucketBinding = {
      async put(key, value, options) {
        const entry: { body: Uint8Array; contentType?: string } = {
          body: value instanceof Uint8Array ? value : new TextEncoder().encode(String(value))
        };
        if (options?.httpMetadata?.contentType) entry.contentType = options.httpMetadata.contentType;
        objects.set(key, entry);
      },
      async get(key) {
        const object = objects.get(key);
        if (!object) return null;
        const result = {
          body: new Response(new Uint8Array(object.body)).body ?? new ReadableStream(),
          size: object.body.byteLength
        };
        return object.contentType ? { ...result, httpMetadata: { contentType: object.contentType } } : result;
      },
      async delete(key) {
        objects.delete(key);
      }
    };

    const storage = createR2Storage({ provider: "r2", bucket, publicBaseUrl: "https://cdn.test" });
    await expect(storage.put("media/hello world.txt", "hello", { contentType: "text/plain" })).resolves.toMatchObject({
      key: "media/hello world.txt",
      url: "https://cdn.test/media/hello%20world.txt",
      size: 5,
      contentType: "text/plain"
    });
    const file = await storage.get("media/hello world.txt");
    expect(await file?.text()).toBe("hello");
    await expect(storage.createSignedUploadUrl({ key: "media/new.txt", contentType: "text/plain", size: 5, expiresInSeconds: 60 })).resolves.toMatchObject({
      uploadUrl: "https://cdn.test/media/new.txt",
      method: "PUT"
    });
    await storage.delete("media/hello world.txt");
    await expect(storage.get("media/hello world.txt")).resolves.toBeNull();
  });

  test("rejects unsafe keys before calling the R2 binding", async () => {
    const calls: string[] = [];
    const bucket: R2BucketBinding = {
      async put(key) {
        calls.push(`put:${key}`);
      },
      async get(key) {
        calls.push(`get:${key}`);
        return null;
      },
      async delete(key) {
        calls.push(`delete:${key}`);
      }
    };
    const storage = createR2Storage({ provider: "r2", bucket, publicBaseUrl: "https://cdn.test" });

    await expect(storage.put("../escape.txt", "nope")).rejects.toThrow(/traversal/);
    await expect(storage.get("/absolute.txt")).rejects.toThrow(/relative path/);
    await expect(storage.createSignedUploadUrl({ key: "media//empty.txt", contentType: "text/plain", size: 4, expiresInSeconds: 60 })).rejects.toThrow(/empty/);
    expect(() => storage.publicUrl("media\\windows.txt")).toThrow(/relative path/);
    expect(calls).toEqual([]);
  });
});
