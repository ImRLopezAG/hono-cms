import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVercelExampleHandler, runtime } from "./route";

let workDir = "";
let originalCwd = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "vercel-edge-e2e-"));
  originalCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("Vercel Edge example (plugin shape)", () => {
  test("exports `runtime = 'edge'` per the Vercel Edge contract", () => {
    expect(runtime).toBe("edge");
  });

  test("handler exposes a Web Request fetch contract", async () => {
    const handler = createVercelExampleHandler();
    const health = await handler(new Request("https://vercel.test/cms/health/live"));
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok" });
  });

  test("openapi plugin exposes the configured title at /cms/openapi.json", async () => {
    const handler = createVercelExampleHandler();
    const res = await handler(new Request("https://vercel.test/cms/openapi.json"));
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { info: { title: string } };
    expect(spec.info.title).toBe("Hono CMS (Vercel Edge, plugin shape)");
  });

  test("anonymous POST /api/posts returns 401", async () => {
    const handler = createVercelExampleHandler();
    const res = await handler(new Request("https://vercel.test/api/posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "anon" })
    }));
    expect(res.status).toBe(401);
  });

  test("authenticated POST creates a record with the bootstrap key", async () => {
    let bootstrapKey = "";
    const handler = createVercelExampleHandler({
      onBootstrapKey: (key) => { bootstrapKey = key; }
    });
    // First call triggers lazy CMS init; bootstrap key is captured during it.
    await handler(new Request("https://vercel.test/cms/health/live"));
    expect(bootstrapKey).toMatch(/^sk_[0-9a-f]{48}$/);

    const created = await handler(new Request("https://vercel.test/api/posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bootstrapKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Vercel Edge plugin shape",
        slug: "vercel-edge-plugin-shape",
        body: "Plugin runtime over Vercel Edge."
      })
    }));
    expect(created.status).toBe(201);
    const post = (await created.json()) as { id: string; title: string };
    expect(post.title).toBe("Vercel Edge plugin shape");
  });
});
