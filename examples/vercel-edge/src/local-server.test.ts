import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVercelExampleHandler } from "./route";

/**
 * Live-boot probe for the Vercel Edge example (plugin shape).
 *
 * Runs under `bun test` (not vitest) so we can use `Bun.serve` to
 * exercise the handler over a real TCP socket. We instantiate the same
 * lazy `(Request) => Promise<Response>` handler that the Vercel Edge
 * runtime invokes in production, then plug it into `Bun.serve({ fetch })`
 * on an ephemeral port. Because the Vercel Edge contract is "Web-standard
 * `(Request) => Response`", Bun.serve is a faithful proxy for the Vercel
 * Edge invocation surface.
 *
 * The bootstrap key is captured via the `onBootstrapKey` callback so
 * the test never depends on filesystem layout.
 */

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let bootstrapKey = "";
let workDir = "";
let originalCwd = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "vercel-edge-live-"));
  originalCwd = process.cwd();
  process.chdir(workDir);
  const handler = createVercelExampleHandler({
    onBootstrapKey: (key) => { bootstrapKey = key; }
  });
  server = Bun.serve({ port: 0, fetch: handler });
  baseUrl = `http://${server.hostname}:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  process.chdir(originalCwd);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("Vercel Edge handler under Bun.serve (live HTTP, plugin shape)", () => {
  test("GET /cms/health/live returns 200 over a real TCP socket", async () => {
    const response = await fetch(`${baseUrl}/cms/health/live`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  test("openapi plugin exposes the configured title at /cms/openapi.json", async () => {
    const response = await fetch(`${baseUrl}/cms/openapi.json`);
    expect(response.status).toBe(200);
    const spec = (await response.json()) as { info: { title: string } };
    expect(spec.info.title).toBe("Hono CMS (Vercel Edge, plugin shape)");
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
        title: "Vercel Edge live",
        slug: "vercel-edge-live",
        body: "Created via createVercelExampleHandler over Bun.serve."
      })
    });
    expect(created.status).toBe(201);
    const post = (await created.json()) as { id: string; title: string };
    expect(post.title).toBe("Vercel Edge live");
  });
});
