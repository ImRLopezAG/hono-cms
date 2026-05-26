import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBunExampleCMS } from "./cms";

/**
 * Boot the plugin-shape CMS programmatically via Bun.serve on an
 * ephemeral port (port: 0). Captures the auth-tokens bootstrap key
 * via the `onBootstrapKey` callback so the test does not depend on
 * filesystem layout. Exercises the public fetch contract over real
 * TCP — the same shape a `curl` user would hit.
 */

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let bootstrapKey = "";
let workDir = "";
let originalCwd = "";

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "bun-server-e2e-"));
  originalCwd = process.cwd();
  process.chdir(workDir);
  const cms = await createBunExampleCMS({ onBootstrapKey: (key) => { bootstrapKey = key; } });
  server = Bun.serve({ port: 0, fetch: cms.fetch });
  baseUrl = `http://${server.hostname}:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  process.chdir(originalCwd);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("Hono CMS on Bun.serve (plugin shape)", () => {
  test("liveness endpoint returns 200 OK over a real HTTP socket", async () => {
    const response = await fetch(`${baseUrl}/cms/health/live`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  test("OpenAPI plugin exposes the configured title at /cms/openapi.json", async () => {
    const response = await fetch(`${baseUrl}/cms/openapi.json`);
    expect(response.status).toBe(200);
    const spec = (await response.json()) as { info: { title: string } };
    expect(spec.info.title).toBe("Hono CMS (Bun.serve, plugin shape)");
  });

  test("anonymous POST /api/posts returns 401", async () => {
    const response = await fetch(`${baseUrl}/api/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "anon attempt", slug: "anon-attempt" })
    });
    expect(response.status).toBe(401);
  });

  test("authenticated POST /api/posts creates a record with the bootstrap key", async () => {
    expect(bootstrapKey).toMatch(/^sk_[0-9a-f]{48}$/);
    const created = await fetch(`${baseUrl}/api/posts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bootstrapKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Plugin-shape post",
        slug: "plugin-shape-post",
        body: "Created via createCMS over Bun.serve."
      })
    });
    expect(created.status).toBe(201);
    const post = (await created.json()) as { id: string; title: string };
    expect(post.title).toBe("Plugin-shape post");
  });

  test("CORS preflight returns 200 with Access-Control-Allow headers", async () => {
    const response = await fetch(`${baseUrl}/api/posts`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type"
      }
    });
    expect(response.headers.get("access-control-allow-origin")).toBeTruthy();
  });
});
