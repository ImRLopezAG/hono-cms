import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = resolve(__dirname, "..", "..");

export default defineConfig({
  resolve: {
    alias: {
      "@hono-cms/core": resolve(root, "packages/core/src/index.ts"),
      "@hono-cms/schema": resolve(root, "packages/schema/src/index.ts"),
      "@hono-cms/adapter-memory": resolve(root, "packages/adapter-memory/src/index.ts"),
      "@hono-cms/storage-memory": resolve(root, "packages/storage-memory/src/index.ts"),
      "@hono-cms/cors": resolve(root, "packages/cors/src/index.ts"),
      "@hono-cms/cache": resolve(root, "packages/cache/src/index.ts"),
      "@hono-cms/jobs": resolve(root, "packages/jobs/src/index.ts"),
      "@hono-cms/jobs-runtime": resolve(root, "packages/jobs-runtime/src/index.ts"),
      "@hono-cms/auth-tokens": resolve(root, "packages/auth-tokens/src/index.ts"),
      "@hono-cms/rate-limit": resolve(root, "packages/rate-limit/src/index.ts"),
      "@hono-cms/audit": resolve(root, "packages/audit/src/index.ts"),
      "@hono-cms/openapi": resolve(root, "packages/openapi/src/index.ts"),
      "@hono-cms/platform/next": resolve(root, "packages/platform/src/next.ts"),
      "@hono-cms/platform": resolve(root, "packages/platform/src/index.ts")
    }
  },
  test: {
    include: ["src/**/*.test.ts"]
  }
});
