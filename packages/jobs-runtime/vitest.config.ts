import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@hono-cms/core": resolve(__dirname, "../core/src/index.ts"),
      "@hono-cms/schema": resolve(__dirname, "../schema/src/index.ts"),
      "@hono-cms/adapter-memory": resolve(__dirname, "../adapter-memory/src/index.ts"),
      "@hono-cms/jobs": resolve(__dirname, "../jobs/src/index.ts")
    }
  }
});
