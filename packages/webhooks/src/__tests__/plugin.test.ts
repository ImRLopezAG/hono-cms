import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createPluginContext, installPlugins } from "@hono-cms/core";
import type { CMSCollections } from "@hono-cms/schema";
import type { DatabaseAdapter } from "@hono-cms/core";
import { jobsRuntime } from "@hono-cms/jobs-runtime";
import { memoryJobs } from "@hono-cms/jobs";
import {
  WEBHOOKS_PLUGIN_ID,
  buildSignedPayload,
  createHmacSignature,
  matchesEventPattern,
  webhooks
} from "../index";

const noopDb: DatabaseAdapter = {
  provider: "memory",
  capabilities: {},
  async migrate() {},
  async list() { return { items: [], total: 0 }; },
  async get() { return null; },
  async create(_c, payload) { return payload as never; },
  async update() { return null; },
  async delete() { return null; },
  async ensureCollection() {}
} as unknown as DatabaseAdapter;

const baseInit = () => ({
  collections: {} as CMSCollections,
  db: noopDb,
  env: {}
});

describe("@hono-cms/webhooks plugin", () => {
  it("exposes a Plugin with id 'webhooks' and requires jobs", () => {
    const plugin = webhooks({});
    expect(plugin.id).toBe(WEBHOOKS_PLUGIN_ID);
    expect(plugin.requires).toContain("jobs");
  });

  it("declares webhook + webhook_deliveries internal tables in its schema", () => {
    const plugin = webhooks({});
    expect(plugin.schema).toBeDefined();
    const tables = Object.keys(plugin.schema!);
    expect(tables).toContain("webhooks");
    expect(tables).toContain("webhook_deliveries");
  });

  it("installs cleanly with jobs-runtime present", async () => {
    const app = new Hono();
    const ctx = createPluginContext(baseInit());
    const result = await installPlugins(
      [jobsRuntime({ adapter: memoryJobs({}) }), webhooks({})],
      app,
      ctx
    );
    expect(result.installedIds).toContain("jobs");
    expect(result.installedIds).toContain("webhooks");
  });

  it("registers a webhooks service on ctx.plugins", async () => {
    const app = new Hono();
    const ctx = createPluginContext(baseInit());
    await installPlugins(
      [jobsRuntime({ adapter: memoryJobs({}) }), webhooks({})],
      app,
      ctx
    );
    expect(ctx.plugins.has("webhooks")).toBe(true);
  });
});

describe("webhook signing", () => {
  it("buildSignedPayload joins timestamp.body with a literal dot", () => {
    expect(buildSignedPayload("123", '{"x":1}')).toBe('123.{"x":1}');
  });

  it("createHmacSignature returns a deterministic sha256 hex string", async () => {
    const sig1 = await createHmacSignature("secret", "payload");
    const sig2 = await createHmacSignature("secret", "payload");
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("different secrets produce different signatures", async () => {
    const sig1 = await createHmacSignature("secretA", "payload");
    const sig2 = await createHmacSignature("secretB", "payload");
    expect(sig1).not.toBe(sig2);
  });
});

describe("matchesEventPattern", () => {
  it("matches identical patterns", () => {
    expect(matchesEventPattern("content.created", "content.created")).toBe(true);
  });

  it("matches single-segment wildcard", () => {
    expect(matchesEventPattern("content.created", "content.*")).toBe(true);
    expect(matchesEventPattern("content.updated", "content.*")).toBe(true);
    expect(matchesEventPattern("media.uploaded", "content.*")).toBe(false);
  });

  it("matches double-star (zero-or-more segments)", () => {
    expect(matchesEventPattern("anything.whatever", "**")).toBe(true);
    expect(matchesEventPattern("content.created.foo", "content.**")).toBe(true);
  });
});
