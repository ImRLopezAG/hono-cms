import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import {
  createPluginContext,
  installPlugins,
  type HonoCMSEnv
} from "@hono-cms/core";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import {
  contentTypeBuilder,
  CONTENT_TYPE_BUILDER_PLUGIN_ID
} from "../plugin";
import type { SchemaWriter } from "../writer";

const schema = defineSchema({
  articles: defineCollection("articles", {
    title: fields.string({ required: true })
  })
});

function noopWriter(): SchemaWriter {
  return {
    writeCollection: () => ({}),
    removeCollection: () => ({})
  };
}

function bootstrap() {
  const db = createMemoryDatabase({ provider: "memory", collections: schema });
  const app = new Hono<HonoCMSEnv>();
  const ctx = createPluginContext({ collections: schema, db, env: {} });
  return { app, ctx, db };
}

describe("contentTypeBuilder() — plugin manifest", () => {
  it("returns a Plugin with id 'content-type-builder' and mountPhase 'catchAll'", () => {
    const plugin = contentTypeBuilder({ writer: noopWriter() });
    expect(plugin.id).toBe(CONTENT_TYPE_BUILDER_PLUGIN_ID);
    expect(plugin.id).toBe("content-type-builder");
    expect(plugin.mountPhase).toBe("catchAll");
  });

  it("installs cleanly through installPlugins (no required dependencies)", async () => {
    const { app, ctx } = bootstrap();
    const result = await installPlugins(
      [contentTypeBuilder({ writer: noopWriter() })],
      app,
      ctx
    );
    expect(result.installedIds).toEqual(["content-type-builder"]);
  });
});
