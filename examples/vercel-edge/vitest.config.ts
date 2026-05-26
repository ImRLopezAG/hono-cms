import { defineConfig } from "vitest/config";

/**
 * `route.test.ts` runs under vitest and exercises the Vercel Edge route
 * handler directly (in-process, no socket).
 *
 * `local-server.test.ts` runs under `bun test` (`bun:test` imports) and boots
 * the same handler on `Bun.serve` for live HTTP probes. It must be excluded
 * from vitest discovery; otherwise vitest tries to resolve `bun:test` and
 * fails. See `test:live` script.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/local-server.test.ts"]
  }
});
