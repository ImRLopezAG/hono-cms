import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import {
  createPluginContext,
  installPlugins,
  mergeSchemas,
  type HonoCMSEnv,
  type MediaStore
} from "@hono-cms/core";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { MEDIA_FOLDERS_TABLE, MEDIA_TABLE } from "../tables";
import {
  MEDIA_PLUGIN_ID,
  mediaPlugin,
  type MediaService
} from "../plugin";
import { MemoryMediaStore } from "../store/memory";

const articles = defineSchema({
  articles: defineCollection("articles", {
    title: fields.string({ required: true })
  })
});

function bootstrap() {
  const db = createMemoryDatabase({ provider: "memory", collections: articles });
  const app = new Hono<HonoCMSEnv>();
  const ctx = createPluginContext({ collections: articles, db, env: {} });
  return { app, ctx, db };
}

describe("mediaPlugin() — plugin shape", () => {
  it("declares the media + media_folders system tables", () => {
    const merged = mergeSchemas([mediaPlugin()]);
    expect(merged.has(MEDIA_TABLE)).toBe(true);
    expect(merged.has(MEDIA_FOLDERS_TABLE)).toBe(true);
    expect(merged.get(MEDIA_TABLE)?.fields).toHaveProperty("filename");
    expect(merged.get(MEDIA_TABLE)?.fields).toHaveProperty("contentType");
    expect(merged.get(MEDIA_FOLDERS_TABLE)?.fields).toHaveProperty("path");
  });

  it("plugin id is exposed as MEDIA_PLUGIN_ID = 'media'", () => {
    expect(MEDIA_PLUGIN_ID).toBe("media");
    expect(mediaPlugin().id).toBe("media");
  });

  it("registers the MediaService on the plugin registry after install", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins([mediaPlugin()], app, ctx);
    const service = ctx.plugins.get("media");
    expect(service.store).toBeInstanceOf(MemoryMediaStore);
    expect(service.config.presignExpirySeconds).toBe(3600);
    expect(service.config.maxPresignUploadSizeBytes).toBe(1024 * 1024 * 1024);
    expect(service.config.allowActiveContent).toBe(false);
  });

  it("uses a caller-provided store when supplied", async () => {
    const calls: string[] = [];
    const customStore = {
      async list() {
        calls.push("list");
        return { items: [] };
      },
      async get() {
        return null;
      },
      async create(input: any) {
        calls.push("create");
        return { ...input, id: "id-1", createdAt: "x", updatedAt: "x" };
      },
      async delete() {
        return null;
      }
    } as unknown as MediaStore;

    const { app, ctx } = bootstrap();
    await installPlugins([mediaPlugin({ store: customStore })], app, ctx);
    const service = ctx.plugins.get("media");
    expect(service.store).toBe(customStore);
  });

  it("propagates allowActiveContent + presign knobs into the service config", async () => {
    const { app, ctx } = bootstrap();
    await installPlugins(
      [
        mediaPlugin({
          allowActiveContent: true,
          presignExpirySeconds: 120,
          maxPresignUploadSizeBytes: 1024
        })
      ],
      app,
      ctx
    );
    const service = ctx.plugins.get("media");
    expect(service.config.allowActiveContent).toBe(true);
    expect(service.config.presignExpirySeconds).toBe(120);
    expect(service.config.maxPresignUploadSizeBytes).toBe(1024);
  });
});
