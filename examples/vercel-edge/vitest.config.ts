import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = resolve(__dirname, "..", "..");

/**
 * `route.test.ts` runs under vitest and exercises the Vercel Edge handler
 * in-process (no socket).
 *
 * `local-server.test.ts` runs under `bun test` (`bun:test` imports) and
 * boots the same handler on `Bun.serve` for live HTTP probes. It must be
 * excluded from vitest discovery; otherwise vitest tries to resolve
 * `bun:test`/`Bun` and fails. See `test:live` script.
 */
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
      "@hono-cms/openapi": resolve(root, "packages/openapi/src/index.ts")
    }
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/local-server.test.ts"]
  }
});
