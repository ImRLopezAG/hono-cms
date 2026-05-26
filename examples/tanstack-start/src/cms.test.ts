import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTanstackExampleCMS } from "./cms";

/**
 * Plugin-shape CMS exercise for the TanStack Start example. The
 * file-route adapter is a thin wrapper around `cms.fetch`, so the
 * unit test drives the public Web Fetch contract directly — same
 * shape any host (Bun, Workers, Node) consumes.
 */

let workDir = "";
let originalCwd = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "tanstack-start-e2e-"));
  originalCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("Hono CMS on TanStack Start (plugin shape)", () => {
  test("liveness endpoint returns 200 OK", async () => {
    const cms = await createTanstackExampleCMS();
    const response = await cms.fetch(new Request("https://tanstack.test/cms/health/live"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  test("OpenAPI plugin exposes the configured title at /cms/openapi.json", async () => {
    const cms = await createTanstackExampleCMS();
    const response = await cms.fetch(new Request("https://tanstack.test/cms/openapi.json"));
    expect(response.status).toBe(200);
    const spec = (await response.json()) as { info: { title: string } };
    expect(spec.info.title).toBe("Hono CMS (TanStack Start, plugin shape)");
  });

  test("anonymous POST /api/posts returns 401", async () => {
    const cms = await createTanstackExampleCMS();
    const response = await cms.fetch(new Request("https://tanstack.test/api/posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "anon attempt", slug: "anon-attempt" })
    }));
    expect(response.status).toBe(401);
  });

  test("authenticated POST /api/posts creates a record with the bootstrap key", async () => {
    let bootstrapKey = "";
    const cms = await createTanstackExampleCMS({
      onBootstrapKey: (key) => { bootstrapKey = key; }
    });
    expect(bootstrapKey).toMatch(/^sk_[0-9a-f]{48}$/);

    const created = await cms.fetch(new Request("https://tanstack.test/api/posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bootstrapKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "TanStack Start plugin shape",
        slug: "tanstack-start-plugin-shape",
        body: "Created via createCMS through a TanStack Start splat route."
      })
    }));
    expect(created.status).toBe(201);
    const post = (await created.json()) as { id: string; title: string };
    expect(post.title).toBe("TanStack Start plugin shape");
  });
});
