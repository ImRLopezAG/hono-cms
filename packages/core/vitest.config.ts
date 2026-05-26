import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@hono-cms/core": resolve(__dirname, "src/index.ts"),
      "@hono-cms/schema": resolve(__dirname, "../schema/src/index.ts")
    }
  }
});
