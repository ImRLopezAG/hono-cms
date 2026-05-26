import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElysiaApp } from "./index";

const ORIGIN = "http://elysia.test";

let app: Awaited<ReturnType<typeof createElysiaApp>>;
let bootstrapKey = "";
let workDir = "";
let originalCwd = "";

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "elysia-host-e2e-"));
  originalCwd = process.cwd();
  process.chdir(workDir);
  app = await createElysiaApp({ onBootstrapKey: (key) => { bootstrapKey = key; } });
});

afterEach(() => {
  process.chdir(originalCwd);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function call(path: string, init?: RequestInit) {
  return app.handle(new Request(`${ORIGIN}${path}`, init));
}

describe("Elysia host example (plugin shape)", () => {
  test("Elysia root route returns the welcome string", async () => {
    const response = await call("/");
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("Hono CMS via Elysia host");
  });

  test("forwards CMS health checks through the /api/cms prefix", async () => {
    const response = await call("/api/cms/cms/health/live");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  test("anonymous POST through the mount is rejected with 401", async () => {
    const response = await call("/api/cms/api/posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "anon", slug: "anon" })
    });
    expect(response.status).toBe(401);
  });

  test("creates a draft post with the bootstrap key via the mounted CMS", async () => {
    expect(bootstrapKey).toMatch(/^sk_[0-9a-f]{48}$/);
    const created = await call("/api/cms/api/posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bootstrapKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Elysia plugin post",
        slug: "elysia-plugin-post",
        body: "Authored from an ElysiaJS host (plugin shape)."
      })
    });
    expect(created.status).toBe(201);
    const post = (await created.json()) as { id: string; title: string };
    expect(post.title).toBe("Elysia plugin post");
  });
});
