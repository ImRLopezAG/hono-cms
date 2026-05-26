import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@hono-cms/schema/schema-compiler": resolve(__dirname, "../schema/src/schema-compiler.ts"),
      "@hono-cms/schema": resolve(__dirname, "../schema/src/index.ts")
    }
  }
});
