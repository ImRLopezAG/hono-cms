import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createCMS } from "@hono-cms/core";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { createMemoryDatabase } from "../../../adapter-memory/src/index";
import { createCloudflareExport } from "../cloudflare";
import { createNextRouteHandlers } from "../next";
import { createNodeHandler } from "../node";
import { createFetchHandler, createVercelHandler as rootCreateVercelHandler, generateVercelJson as rootGenerateVercelJson, toWebHandler } from "../index";
import { createVercelHandler, generateVercelJson } from "../vercel";

const collections = defineSchema({
  articles: defineCollection("articles", {
    title: fields.string({ required: true })
  }, { draftAndPublish: true })
});

afterEach(() => {
  vi.restoreAllMocks();
});

function cms() {
  return createCMS({
    collections,
    db: createMemoryDatabase({ provider: "memory", collections }),
    auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
    rbac: { publicRead: true }
  });
}

describe("@hono-cms/platform", () => {
  test("exposes a portable Web Request fetch handler from the root package", async () => {
    const calls: Array<{ request: Request; env?: unknown; ctx?: unknown }> = [];
    const handler = createFetchHandler({
      fetch: (request, env, ctx) => {
        calls.push({ request, env, ctx });
        return Response.json({ ok: true, url: request.url });
      }
    } as Pick<ReturnType<typeof cms>, "fetch">);
    const env = { DB: "binding" };
    const ctx = { waitUntil: vi.fn() };

    const response = await handler(new Request("https://cms.test/cms/health/live"), env, ctx);

    await expect(response.json()).resolves.toEqual({ ok: true, url: "https://cms.test/cms/health/live" });
    expect(calls).toEqual([{ request: expect.any(Request), env, ctx }]);
    expect(toWebHandler).toBe(createFetchHandler);
    expect(rootCreateVercelHandler).toBe(createVercelHandler);
    expect(rootGenerateVercelJson).toBe(generateVercelJson);
  });

  test("creates generic and Vercel Web Request handlers", async () => {
    const app = cms();
    const generic = toWebHandler(app);
    const vercel = createVercelHandler(app);

    const genericHealth = await generic(new Request("https://cms.test/cms/health/live"));
    await expect(genericHealth.json()).resolves.toMatchObject({ status: "ok" });

    const created = await vercel(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Vercel" })
    }));
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ title: "Vercel", status: "draft" });
  });

  test("creates Next.js App Router method handlers from the Web Request API", async () => {
    const app = cms();
    const handlers = createNextRouteHandlers(app);

    const health = await handlers.GET(new Request("https://cms.test/cms/health/live"));
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok" });

    const created = await handlers.POST(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "Next" })
    }));
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ title: "Next", status: "draft" });

    expect(handlers.PUT).toBeTypeOf("function");
    expect(handlers.PATCH).toBeTypeOf("function");
    expect(handlers.DELETE).toBeTypeOf("function");
    expect(handlers.OPTIONS).toBeTypeOf("function");
    expect(handlers.HEAD).toBeTypeOf("function");
  });

  test("creates narrowed Next.js App Router method handlers", () => {
    const handlers = createNextRouteHandlers(cms(), ["GET", "POST"] as const);

    expect(Object.keys(handlers).sort()).toEqual(["GET", "POST"]);
    expect(handlers.GET).toBeTypeOf("function");
    expect(handlers.POST).toBeTypeOf("function");
  });

  test("creates a Cloudflare Worker export with fetch and scheduled forwarding", async () => {
    const app = cms();
    const scheduled = vi.spyOn(app, "scheduled");
    const worker = createCloudflareExport(app);

    const health = await worker.fetch(new Request("https://cms.test/cms/health/live"), {}, {});
    expect(health.status).toBe(200);

    await worker.scheduled?.({ cron: "* * * * *" }, { DB: "binding" }, { waitUntil: vi.fn() });
    expect(scheduled).toHaveBeenCalledWith({ cron: "* * * * *" }, { DB: "binding" }, { waitUntil: expect.any(Function) });
  });

  test("forwards Cloudflare env and execution context to cms.fetch", async () => {
    const calls: Array<{ request: Request; env: unknown; ctx: unknown }> = [];
    const worker = createCloudflareExport({
      fetch: (request, env, ctx) => {
        calls.push({ request, env, ctx });
        return Response.json({ ok: true });
      },
      scheduled: async () => {}
    } as Pick<ReturnType<typeof cms>, "fetch" | "scheduled">);
    const env = { DB: "binding", BUCKET: "media" };
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

    const response = await worker.fetch(new Request("https://cms.test/api/articles"), env, ctx);

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ request: expect.any(Request), env, ctx }]);
  });

  test("dispatches Cloudflare cron events through the portable scheduled handler", async () => {
    const scheduledHandler = vi.fn(async () => {});
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      rbac: { publicRead: true },
      jobs: {
        provider: "test",
        dispatch: vi.fn(async () => {}),
        enqueue: vi.fn(async () => {}),
        verify: vi.fn(async () => true),
        scheduledHandler
      }
    });
    const worker = createCloudflareExport(app);
    const env = { CMS_QUEUE: "binding" };
    const ctx = { waitUntil: vi.fn() };

    await worker.scheduled?.({ cron: "*/5 * * * *" }, env, ctx);

    expect(scheduledHandler).toHaveBeenCalledWith("*/5 * * * *", env, ctx);
  });

  test("generates Vercel cron configuration for job endpoints", () => {
    expect(generateVercelJson({
      "/cms/jobs/scheduled-publish": "* * * * *",
      "/cms/jobs/audit-log-cleanup": "0 0 * * *"
    })).toEqual({
      crons: [
        { path: "/cms/jobs/scheduled-publish", schedule: "* * * * *" },
        { path: "/cms/jobs/audit-log-cleanup", schedule: "0 0 * * *" }
      ]
    });
    expect(generateVercelJson([
      { path: " /cms/jobs/cache-sweep ", schedule: " 0 * * * * " }
    ])).toEqual({
      crons: [{ path: "/cms/jobs/cache-sweep", schedule: "0 * * * *" }]
    });
    expect(() => generateVercelJson({ "cms/jobs/cache-sweep": "0 * * * *" })).toThrow("must start");
    expect(() => generateVercelJson({ "/cms/jobs/cache-sweep": " " })).toThrow("must be non-empty");
  });

  test("bridges Node IncomingMessage and ServerResponse to Web Request and Response", async () => {
    const app = cms();
    const server = createServer(createNodeHandler(app));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const created = await fetch(`${baseUrl}/api/articles`, {
        method: "POST",
        headers: { authorization: "Bearer admin", "content-type": "application/json" },
        body: JSON.stringify({ title: "Node" })
      });
      expect(created.status).toBe(201);
      await expect(created.json()).resolves.toMatchObject({ title: "Node", status: "draft" });

      const health = await fetch(`${baseUrl}/cms/health/live`);
      await expect(health.json()).resolves.toMatchObject({ status: "ok" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("preserves multiple Set-Cookie headers in the Node bridge", async () => {
    const server = createServer(createNodeHandler({
      fetch: () => {
        const headers = new Headers({ "x-cms-platform": "node" });
        headers.append("set-cookie", "cms_session=abc; Path=/; HttpOnly");
        headers.append("set-cookie", "cms_refresh=def; Path=/; Secure");
        return new Response("ok", { headers });
      }
    } as Pick<ReturnType<typeof cms>, "fetch">));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const response = await new Promise<{ headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const request = httpRequest(`${baseUrl}/cookies`, (incoming) => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk) => {
            body += chunk;
          });
          incoming.on("end", () => resolve({ headers: incoming.headers, body }));
        });
        request.on("error", reject);
        request.end();
      });

      expect(response.body).toBe("ok");
      expect(response.headers["set-cookie"]).toEqual([
        "cms_session=abc; Path=/; HttpOnly",
        "cms_refresh=def; Path=/; Secure"
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
