import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const repoRoot = resolve(__dirname, "../../../..");
const cliPackageJson = new URL("../../package.json", import.meta.url);

const packageEntrypoints: Record<string, string[]> = {
  "packages/adapter-memory": ["index.js", "index.d.ts", "index.d.ts.map"],
  "packages/cache": [
    "index.js",
    "index.d.ts",
    "index.d.ts.map",
    "plugin.js",
    "plugin.d.ts",
    "plugin.d.ts.map",
    "adapters"
  ],
  "packages/cli": ["index.js", "index.d.ts", "index.d.ts.map"],
  "packages/jobs": ["index.js", "index.d.ts", "index.d.ts.map"],
  "packages/platform": [
    "cloudflare.js",
    "cloudflare.d.ts",
    "cloudflare.d.ts.map",
    "index.js",
    "index.d.ts",
    "index.d.ts.map",
    "next.js",
    "next.d.ts",
    "next.d.ts.map",
    "node.js",
    "node.d.ts",
    "node.d.ts.map",
    "vercel.js",
    "vercel.d.ts",
    "vercel.d.ts.map"
  ],
  "packages/storage-local": ["index.js", "index.d.ts", "index.d.ts.map"],
  "packages/storage-memory": ["index.js", "index.d.ts", "index.d.ts.map"],
  "packages/storage-r2": ["index.js", "index.d.ts", "index.d.ts.map"],
  "packages/storage-s3": ["index.js", "index.d.ts", "index.d.ts.map"],
  "packages/storage-vercel-blob": ["index.js", "index.d.ts", "index.d.ts.map"]
};

test("tsc-built packages emit only their exported entrypoints", async () => {
  for (const [packagePath, expectedFiles] of Object.entries(packageEntrypoints)) {
    const dist = join(repoRoot, packagePath, "dist");
    expect(existsSync(dist), `${packagePath} must be built before packaging verification`).toBe(true);
    const files = await readdir(dist);
    expect(files.sort()).toEqual([...expectedFiles].sort());
  }
});

test("CLI package exposes the cms binary with an executable shebang", async () => {
  const packageJson = JSON.parse(await readFile(cliPackageJson, "utf8")) as { bin?: Record<string, string> };
  expect(packageJson.bin).toMatchObject({
    cms: "./dist/index.js",
    "hono-cms": "./dist/index.js"
  });

  const source = await readFile(join(repoRoot, "packages/cli/src/index.ts"), "utf8");
  expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);

  const built = await readFile(join(repoRoot, "packages/cli/dist/index.js"), "utf8");
  expect(built.startsWith("#!/usr/bin/env node\n")).toBe(true);
});
