import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, scaffoldPackage } from "./scaffold-package";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("scaffold-package", () => {
  it("parses package scaffold options", () => {
    expect(parseArgs(["storage-edge", "--platform", "node", "--no-build"])).toEqual({
      name: "storage-edge",
      platform: "node",
      build: false
    });
  });

  it("rejects invalid package names", () => {
    expect(() => parseArgs(["Storage"])).toThrow("kebab-case");
    expect(() => parseArgs(["bad_name"])).toThrow("kebab-case");
  });

  it("writes package files using the current workspace conventions", async () => {
    const root = await mkdtemp(join(tmpdir(), "hono-cms-scaffold-"));
    created.push(root);
    await mkdir(join(root, "packages"));

    await scaffoldPackage({ name: "storage-edge", platform: "neutral", build: true }, root);

    const packageJson = JSON.parse(await readFile(join(root, "packages", "storage-edge", "package.json"), "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
      exports?: Record<string, unknown>;
    };
    const tsconfig = JSON.parse(await readFile(join(root, "packages", "storage-edge", "tsconfig.json"), "utf8")) as { extends?: string };
    const testSource = await readFile(join(root, "packages", "storage-edge", "src", "__tests__", "storage-edge.test.ts"), "utf8");

    expect(packageJson.name).toBe("@hono-cms/storage-edge");
    expect(packageJson.scripts?.build).toBe("tsdown --config tsdown.config.ts");
    expect(packageJson.scripts?.test).toBe("vitest run --passWithNoTests");
    expect(packageJson.exports).toEqual({ ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } });
    expect(tsconfig.extends).toBe("../../tsconfig.base.json");
    expect(testSource).toContain("@hono-cms/storage-edge");
    await expect(readFile(join(root, "packages", "storage-edge", "tsdown.config.ts"), "utf8")).resolves.toContain("platform: \"neutral\"");
  });

  it("writes the selected tsdown platform", async () => {
    const root = await mkdtemp(join(tmpdir(), "hono-cms-scaffold-"));
    created.push(root);
    await mkdir(join(root, "packages"));

    await scaffoldPackage({ name: "storage-localish", platform: "node", build: true }, root);

    await expect(readFile(join(root, "packages", "storage-localish", "tsdown.config.ts"), "utf8")).resolves.toContain("platform: \"node\"");
  });
});
