import { afterEach, describe, expect, it, vi } from "vitest";
import { installContentTypeSmokeHarness } from "./content-type-smoke";

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.__honoCmsContentTypeSmoke = undefined;
});

describe("content type smoke harness", () => {
  it("stays disabled without the smoke query flag", () => {
    const storage = { setItem: vi.fn() };

    const harness = installContentTypeSmokeHarness({ search: "" } as Location, storage);

    expect(harness).toEqual({ enabled: false, requests: [] });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("mocks content type list and create calls for browser smoke runs", async () => {
    const storage = { setItem: vi.fn() };
    vi.stubGlobal("location", new URL("https://admin.test/settings/content-types?cmsSmoke=content-types"));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ passthrough: true })));

    const harness = installContentTypeSmokeHarness(globalThis.location, storage);

    expect(harness.enabled).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith("hono-cms:auth-token", JSON.stringify("smoke-admin"));

    const list = await fetch("/cms/content-types");
    await expect(list.json()).resolves.toMatchObject({
      capabilities: { writable: true, mode: "development" }
    });

    const created = await fetch("/cms/content-types", {
      method: "POST",
      body: JSON.stringify({ name: "product-reviews", fields: { title: { kind: "string", required: true } }, options: {} })
    });
    await expect(created.json()).resolves.toMatchObject({
      collection: { name: "product-reviews" },
      path: "cms/collections/product-reviews.ts",
      artifacts: ["node_modules/.cms/sdk/index.ts", "node_modules/.cms/drizzle-schema.ts"],
      message: "Smoke generated typed SDK and database schema"
    });
    expect(harness.requests).toEqual([
      { url: "/cms/content-types", method: "GET" },
      {
        url: "/cms/content-types",
        method: "POST",
        body: JSON.stringify({ name: "product-reviews", fields: { title: { kind: "string", required: true } }, options: {} })
      }
    ]);
  });
});
