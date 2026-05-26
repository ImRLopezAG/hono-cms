import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNextExampleCMS } from "./cms";

/**
 * Plugin-shape e2e for the Next.js example.
 *
 * We chdir into an ephemeral tmpdir so the auth-tokens bootstrap key
 * file (written on first boot) lands somewhere disposable. The bootstrap
 * key itself is captured via the `onBootstrapKey` callback so the test
 * never reads from disk.
 *
 * Requests are driven directly against `cms.fetch(new Request(...))` —
 * the same Web Request contract the Next.js App Router calls into. This
 * keeps the test independent of the App Router runtime while still
 * exercising the same code paths the framework adapter mounts.
 */

const ORIGIN = "https://next.test";
let cms: Awaited<ReturnType<typeof createNextExampleCMS>>;
let bootstrapKey = "";
let workDir = "";
let originalCwd = "";

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "next-app-e2e-"));
  originalCwd = process.cwd();
  process.chdir(workDir);
  bootstrapKey = "";
  cms = await createNextExampleCMS({ onBootstrapKey: (key) => { bootstrapKey = key; } });
});

afterEach(() => {
  process.chdir(originalCwd);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function call(path: string, init?: RequestInit) {
  return cms.fetch(new Request(`${ORIGIN}${path}`, init));
}

describe("Hono CMS on Next.js App Router (plugin shape)", () => {
  test("liveness endpoint returns 200 OK", async () => {
    const response = await call("/cms/health/live");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  test("OpenAPI plugin exposes the configured title at /cms/openapi.json", async () => {
    const response = await call("/cms/openapi.json");
    expect(response.status).toBe(200);
    const spec = (await response.json()) as { info: { title: string } };
    expect(spec.info.title).toBe("Hono CMS (Next.js App Router, plugin shape)");
  });

  test("anonymous POST /api/posts returns 401", async () => {
    const response = await call("/api/posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "anon attempt", slug: "anon-attempt" })
    });
    expect(response.status).toBe(401);
  });

  test("authenticated POST /api/posts creates a record with the bootstrap key", async () => {
    expect(bootstrapKey).toMatch(/^sk_[0-9a-f]{48}$/);
    const created = await call("/api/posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bootstrapKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Next plugin post",
        slug: "next-plugin-post",
        body: "Created via createPluginCMS over the Next.js App Router."
      })
    });
    expect(created.status).toBe(201);
    const post = (await created.json()) as { id: string; title: string };
    expect(post.title).toBe("Next plugin post");
  });

  test("CORS preflight returns Access-Control-Allow headers", async () => {
    const response = await call("/api/posts", {
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
