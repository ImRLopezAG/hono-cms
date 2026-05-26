import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createLocalStorage } from "../index";

describe("LocalStorageAdapter", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
  });

  test("stores, serves, signs, and deletes objects from a local root", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hono-cms-local-storage-"));
    try {
      const storage = createLocalStorage({ provider: "local", rootDir, publicBaseUrl: "http://localhost:3000/assets" });
      const stored = await storage.put("media/hello world.txt", "hello local", {
        contentType: "text/plain",
        metadata: { filename: "hello world.txt" }
      });
      expect(stored).toMatchObject({
        key: "media/hello world.txt",
        url: "http://localhost:3000/assets/media/hello%20world.txt",
        size: 11,
        contentType: "text/plain",
        metadata: { filename: "hello world.txt" }
      });

      const response = await storage.get("media/hello world.txt");
      expect(response?.headers.get("content-type")).toBe("text/plain");
      expect(await response?.text()).toBe("hello local");

      await expect(storage.createSignedUploadUrl({
        key: "media/direct.txt",
        contentType: "text/plain",
        size: 12,
        expiresInSeconds: 60
      })).resolves.toMatchObject({
        method: "PUT",
        headers: { "content-type": "text/plain" }
      });
      expect(storage.publicUrl("media/direct.txt")).toBe("http://localhost:3000/assets/media/direct.txt");

      await storage.delete("media/hello world.txt");
      await expect(storage.get("media/hello world.txt")).resolves.toBeNull();
      await expect(storage.health()).resolves.toMatchObject({ ok: true, details: { rootDir } });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("rejects keys that escape the storage root", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hono-cms-local-storage-"));
    try {
      const storage = createLocalStorage({ provider: "local", rootDir });
      await expect(storage.put("../escape.txt", "nope")).rejects.toThrow(/traversal/);
      await expect(storage.get("/absolute.txt")).rejects.toThrow(/relative path/);
      await expect(storage.createSignedUploadUrl({ key: "media//empty.txt", contentType: "text/plain", size: 4, expiresInSeconds: 60 })).rejects.toThrow(/empty/);
      expect(() => storage.publicUrl("media\\windows.txt")).toThrow(/relative path/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("fails closed in production unless explicitly allowed", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hono-cms-local-storage-"));
    try {
      process.env.NODE_ENV = "production";
      expect(() => createLocalStorage({ provider: "local", rootDir })).toThrow(/cannot be used in production/);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(() => createLocalStorage({ provider: "local", rootDir, allowInProduction: true })).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Local storage provider selected in production"));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
