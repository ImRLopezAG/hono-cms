import { describe, expect, test } from "vitest";
import { createS3Storage, type S3ClientLike } from "../index";

describe("S3StorageAdapter", () => {
  test("uses AWS SDK commands for object operations and presigned uploads", async () => {
    const sent: string[] = [];
    const client: S3ClientLike = {
      async send(command) {
        sent.push(command?.constructor?.name ?? "Unknown");
        if (command?.constructor?.name === "GetObjectCommand") {
          return { Body: new TextEncoder().encode("hello"), ContentType: "text/plain" };
        }
        return {};
      }
    };
    const storage = createS3Storage({
      provider: "s3",
      bucket: "cms-media",
      publicBaseUrl: "https://cdn.test",
      client,
      presigner: async () => "https://upload.test/signed"
    });

    await expect(storage.put("media/file.txt", "hello", { contentType: "text/plain" })).resolves.toMatchObject({
      url: "https://cdn.test/media/file.txt",
      size: 5
    });
    await expect(storage.get("media/file.txt").then((response) => response?.text())).resolves.toBe("hello");
    await expect(storage.createSignedUploadUrl({ key: "media/file.txt", contentType: "text/plain", size: 5, expiresInSeconds: 120 })).resolves.toMatchObject({
      uploadUrl: "https://upload.test/signed",
      method: "PUT"
    });
    await storage.delete("media/file.txt");
    expect(sent).toEqual(["PutObjectCommand", "GetObjectCommand", "DeleteObjectCommand"]);
  });

  test("rejects unsafe keys before sending AWS SDK commands", async () => {
    const sent: string[] = [];
    const client: S3ClientLike = {
      async send(command) {
        sent.push(command?.constructor?.name ?? "Unknown");
        return {};
      }
    };
    const storage = createS3Storage({
      provider: "s3",
      bucket: "cms-media",
      client,
      presigner: async () => "https://upload.test/signed"
    });

    await expect(storage.put("../escape.txt", "nope")).rejects.toThrow(/traversal/);
    await expect(storage.get("/absolute.txt")).rejects.toThrow(/relative path/);
    await expect(storage.createSignedUploadUrl({ key: "media//empty.txt", contentType: "text/plain", size: 4, expiresInSeconds: 60 })).rejects.toThrow(/empty/);
    expect(() => storage.publicUrl("media\\windows.txt")).toThrow(/relative path/);
    expect(sent).toEqual([]);
  });
});
