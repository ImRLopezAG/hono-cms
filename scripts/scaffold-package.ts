#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Options = {
  name: string;
  platform: "neutral" | "node" | "browser";
  build: boolean;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  await scaffoldPackage(options);
}

export async function scaffoldPackage(options: Options, root = repoRoot) {
  validatePackageName(options.name);

  const packageDir = join(root, "packages", options.name);
  await mkdir(packageDir, { recursive: false });
  await mkdir(join(packageDir, "src"), { recursive: true });
  await mkdir(join(packageDir, "src", "__tests__"), { recursive: true });

  await Promise.all([
    writeFile(join(packageDir, "package.json"), `${JSON.stringify(packageJson(options), null, 2)}\n`),
    writeFile(join(packageDir, "tsconfig.json"), `${JSON.stringify(tsconfigJson(), null, 2)}\n`),
    writeFile(join(packageDir, "src", "index.ts"), "export const packageName = \"@hono-cms/" + options.name + "\";\n"),
    writeFile(join(packageDir, "src", "__tests__", `${options.name}.test.ts`), testSource(options.name))
  ]);

  if (options.build) {
    await writeFile(join(packageDir, "tsdown.config.ts"), tsdownConfigSource(options.platform));
  }
}

export function parseArgs(args: string[]): Options {
  const [name] = args;
  if (!name || name.startsWith("-")) throw new Error(usage());
  validatePackageName(name);

  let platform: Options["platform"] = "neutral";
  let build = true;

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-build") {
      build = false;
      continue;
    }
    if (arg === "--platform") {
      const value = args[index + 1];
      if (value !== "neutral" && value !== "node" && value !== "browser") throw new Error("--platform must be one of neutral|node|browser");
      platform = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return { name, platform, build };
}

function usage() {
  return "Usage: bun run scripts/scaffold-package.ts <name> [--platform neutral|node|browser] [--no-build]";
}

function validatePackageName(name: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("Package name must be kebab-case and start with a letter.");
}

function packageJson(options: Options) {
  const exports = options.build
    ? { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } }
    : { ".": { types: "./src/index.ts", import: "./src/index.ts" } };

  return {
    name: `@hono-cms/${options.name}`,
    version: "0.1.0",
    type: "module",
    exports,
    scripts: {
      build: options.build ? "tsdown --config tsdown.config.ts" : "tsc --noEmit",
      typecheck: "tsc --noEmit",
      test: "vitest run --passWithNoTests",
      lint: "tsc --noEmit",
      clean: "rm -rf dist coverage"
    }
  };
}

function tsconfigJson() {
  return {
    extends: "../../tsconfig.base.json",
    compilerOptions: {
      noEmit: true
    },
    include: ["src/**/*.ts"]
  };
}

function tsdownConfigSource(platform: Options["platform"]) {
  return [
    "import { defineConfig } from \"tsdown\";",
    "",
    "export default defineConfig({",
    "  entry: [\"src/index.ts\"],",
    "  dts: true,",
    `  platform: "${platform}",`,
    "  clean: true",
    "});",
    ""
  ].join("\n");
}

function testSource(name: string) {
  return [
    "import { describe, expect, it } from \"vitest\";",
    "import { packageName } from \"../index\";",
    "",
    `describe("@hono-cms/${name}", () => {`,
    "  it(\"exports its package name\", () => {",
    `    expect(packageName).toBe("@hono-cms/${name}");`,
    "  });",
    "});",
    ""
  ].join("\n");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
