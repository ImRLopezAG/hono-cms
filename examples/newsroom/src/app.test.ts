/**
 * Newsroom example tests — migrated to the plugin manifest shape (U25 7/7).
 *
 * Drives the full plugin stack composed by `createNewsroomCMS` through
 * HTTP and verifies: health, openapi spec, auth gate (anonymous-401 +
 * bootstrap-key-authenticated POST), CORS preflight, audit event flow,
 * plugin schema-merge surface, and plugin install ordering.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNewsroomCMS } from "./app";

let workDir = "";
let originalCwd = "";
let bootstrapKey = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "newsroom-e2e-"));
  originalCwd = process.cwd();
  process.chdir(workDir);
  bootstrapKey = "";
});

afterEach(() => {
  process.chdir(originalCwd);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function build() {
  return createNewsroomCMS({ onBootstrapKey: (key) => { bootstrapKey = key; } });
}

describe("Newsroom example (plugin shape)", () => {
  test("liveness endpoint returns 200 OK", async () => {
    const cms = await build();
    const res = await cms.fetch(new Request("https://cms.test/cms/health/live"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok" });
  });

  test("openapi plugin exposes the configured title", async () => {
    const cms = await build();
    const res = await cms.fetch(new Request("https://cms.test/cms/openapi.json"));
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { info: { title: string; version: string } };
    expect(spec.info.title).toBe("Newsroom CMS API (plugin shape)");
  });

  test("anonymous GET /api/articles returns 401", async () => {
    const cms = await build();
    const res = await cms.fetch(new Request("https://cms.test/api/articles"));
    expect(res.status).toBe(401);
  });

  test("authenticated POST /api/authors creates a record", async () => {
    const cms = await build();
    expect(bootstrapKey).toMatch(/^sk_[0-9a-f]{48}$/);
    const created = await cms.fetch(new Request("https://cms.test/api/authors", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bootstrapKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: "Ada Lovelace", bio: "Computing notes" })
    }));
    expect(created.status).toBe(201);
    const author = (await created.json()) as { id: string; name: string };
    expect(author.name).toBe("Ada Lovelace");
    expect(typeof author.id).toBe("string");
  });

  test("CORS preflight returns 200 with Access-Control-Allow-Origin", async () => {
    const cms = await build();
    const res = await cms.fetch(new Request("https://cms.test/api/articles", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "POST"
      }
    }));
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });

  test("authenticated POST /api/articles fires content:after-create on the event bus", async () => {
    const cms = await build();
    const events: string[] = [];
    cms.ctx.events.on("content:after-create", (payload) => {
      events.push(payload.collection);
    });
    const res = await cms.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bootstrapKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ title: "First article", slug: "first-article" })
    }));
    expect(res.status).toBe(201);
    expect(events).toContain("articles");
  });

  test("plugin install registers expected services", async () => {
    const cms = await build();
    expect(cms.ctx.plugins.has("cache")).toBe(true);
    expect(cms.ctx.plugins.has("jobs")).toBe(true);
    expect(cms.ctx.plugins.has("openapi")).toBe(true);
    expect(cms.ctx.plugins.has("webhooks")).toBe(true);
  });

  test("plugin schema merge propagates internal tables to ctx.systemTables", async () => {
    const cms = await build();
    expect(cms.ctx.systemTables.has("api_keys")).toBe(true);
    expect(cms.ctx.systemTables.has("roles")).toBe(true);
    expect(cms.ctx.systemTables.has("audit_log")).toBe(true);
    expect(cms.ctx.systemTables.has("webhooks")).toBe(true);
    expect(cms.ctx.systemTables.has("media")).toBe(true);
  });

  test("installed plugin ids include the full stack in expected order", async () => {
    const cms = await build();
    expect(cms.installed.installedIds).toEqual([
      "cors",
      "openapi",
      "cache",
      "jobs",
      "auth-tokens",
      "rate-limit",
      "content-cache",
      "audit",
      "webhooks",
      "drafts",
      "media"
    ]);
  });
});
