import { afterEach, describe, expect, test, vi } from "vitest";
import { createCMS } from "@hono-cms/core";
import { createMemoryDatabase } from "../../../adapter-memory/src/index";
import { defineCollection, defineSchema, fields } from "../../../schema/src/index";
import { CloudflareJobsAdapter, cloudflareJobs, createCloudflareJobs, createNoneJobs, createQStashJobs, createVercelJobs, generateVercelJson, JobsConfigError, memoryJobs, MemoryJobsAdapter, noneJobs, NoneJobsAdapter, QStashJobsAdapter, qstashJobs, VercelJobsAdapter, vercelJobs, type QStashClientLike } from "../index";

const collections = defineSchema({
  articles: defineCollection("articles", {
    title: fields.string({ required: true })
  })
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CRON_SECRET;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  delete process.env.CMS_PUBLIC_URL;
  delete process.env.QSTASH_TOKEN;
  delete process.env.QSTASH_CURRENT_SIGNING_KEY;
  delete process.env.QSTASH_NEXT_SIGNING_KEY;
  delete process.env.QSTASH_URL;
  delete process.env.DEV_SKIP_JOB_SIGNATURE;
});

describe("@hono-cms/jobs — explicit factory exports (U12)", () => {
  test("memoryJobs({}) returns a JobsAdapter", () => {
    const adapter = memoryJobs({});
    expect(adapter).toBeInstanceOf(MemoryJobsAdapter);
    expect(adapter.provider).toBe("memory");
  });

  test("noneJobs({}) returns a disabled JobsAdapter", () => {
    const adapter = noneJobs({});
    expect(adapter).toBeInstanceOf(NoneJobsAdapter);
    expect(adapter.provider).toBe("none");
  });

  test("qstashJobs(config) returns a QStash JobsAdapter", () => {
    const adapter = qstashJobs({
      token: "token",
      baseUrl: "https://cms.example.com",
      currentSigningKey: "current",
      nextSigningKey: "next",
      client: {
        publishJSON: vi.fn(async () => ({})),
        schedules: { list: vi.fn(async () => []), create: vi.fn(async () => ({})) }
      }
    });
    expect(adapter).toBeInstanceOf(QStashJobsAdapter);
    expect(adapter.provider).toBe("qstash");
  });

  test("cloudflareJobs(config) returns a Cloudflare JobsAdapter", () => {
    const adapter = cloudflareJobs({ cronOnly: true });
    expect(adapter).toBeInstanceOf(CloudflareJobsAdapter);
    expect(adapter.provider).toBe("cloudflare");
  });

  test("vercelJobs(config) returns a Vercel JobsAdapter", () => {
    const adapter = vercelJobs({ secret: "secret", cronOnly: true });
    expect(adapter).toBeInstanceOf(VercelJobsAdapter);
    expect(adapter.provider).toBe("vercel");
  });
});

describe("@hono-cms/jobs", () => {
  test("provides an explicit disabled jobs provider", async () => {
    const adapter = createNoneJobs();

    expect(adapter.provider).toBe("none");
    await expect(adapter.enqueue("/cms/jobs/cache-sweep")).resolves.toBeUndefined();
    await expect(adapter.verify(new Request("https://cms.test/cms/jobs/cache-sweep"))).resolves.toBe(false);
    await expect(adapter.health()).resolves.toEqual({ ok: true, message: "disabled" });
  });

  test("dispatches Cloudflare scheduled jobs by cron expression", async () => {
    const publish = vi.fn(async () => {});
    const cleanup = vi.fn(async () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = createCloudflareJobs({
      provider: "cloudflare",
      cronOnly: true,
      cronMap: {
        "*/15 * * * *": publish,
        "0 3 * * *": cleanup
      }
    });

    await adapter.scheduledHandler("*/15 * * * *");
    await adapter.scheduledHandler("0 3 * * *");
    await adapter.scheduledHandler("1 2 3 4 5");

    expect(publish).toHaveBeenCalledWith({ cron: "*/15 * * * *" }, expect.objectContaining({ cms: null, now: expect.any(Date) }));
    expect(cleanup).toHaveBeenCalledWith({ cron: "0 3 * * *" }, expect.objectContaining({ cms: null, now: expect.any(Date) }));
    expect(warn).toHaveBeenCalledWith("[hono-cms/jobs] Cloudflare provider: no job registered for cron \"1 2 3 4 5\".");
    await expect(adapter.verify(new Request("https://cms.test/cms/jobs/cache-sweep"))).resolves.toBe(true);
  });

  test("enqueues Cloudflare jobs through Queue bindings or QStash fallback", async () => {
    const queue = { send: vi.fn(async () => {}) };
    const queueAdapter = createCloudflareJobs({ provider: "cloudflare", queue });

    await queueAdapter.enqueue("/cms/jobs/webhook-retry", { deliveryId: "delivery-1" }, { delay: 30 });
    expect(queue.send).toHaveBeenCalledWith({
      endpoint: "/cms/jobs/webhook-retry",
      body: { deliveryId: "delivery-1" },
      delaySeconds: 30
    });

    const enqueue = vi.fn(async () => {});
    const fallbackAdapter = createCloudflareJobs({ provider: "cloudflare", qstashFallback: { enqueue } });
    await fallbackAdapter.enqueue("/cms/jobs/translation", { collection: "pages" }, { delay: 5 });
    expect(enqueue).toHaveBeenCalledWith("/cms/jobs/translation", { collection: "pages" }, { delay: 5 });
  });

  test("Cloudflare construction throws when neither queue, qstashFallback, nor cronOnly is configured", () => {
    expect(() => createCloudflareJobs({ provider: "cloudflare" })).toThrow(JobsConfigError);
    expect(() => createCloudflareJobs({ provider: "cloudflare" })).toThrow(/Queue binding or qstashFallback/);
  });

  test("Cloudflare enqueue throws JobsConfigError on cron-only deployments", async () => {
    const adapter = createCloudflareJobs({ provider: "cloudflare", cronOnly: true });

    await expect(adapter.enqueue("/cms/jobs/webhook-retry", { id: "delivery-1" })).rejects.toBeInstanceOf(JobsConfigError);
    await expect(adapter.enqueue("/cms/jobs/webhook-retry", { id: "delivery-1" })).rejects.toThrow(/dropped silently/);
  });

  test("Cloudflare cron-only deployment still dispatches scheduled handlers", async () => {
    const publish = vi.fn(async () => {});
    const adapter = createCloudflareJobs({
      provider: "cloudflare",
      cronOnly: true,
      cronMap: { "0 * * * *": publish }
    });

    await adapter.scheduledHandler("0 * * * *");

    expect(publish).toHaveBeenCalledWith({ cron: "0 * * * *" }, expect.objectContaining({ cms: null, now: expect.any(Date) }));
    await expect(adapter.health()).resolves.toMatchObject({
      ok: true,
      details: { queueConfigured: false, qstashFallbackConfigured: false, cronOnly: true }
    });
  });

  test("registers Cloudflare jobs as a CMS provider and exposes scheduledHandler", async () => {
    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      jobs: {
        provider: "cloudflare",
        cronOnly: true,
        cronMap: {
          "*/15 * * * *": vi.fn(async () => {})
        }
      },
      rbac: { publicRead: true }
    });

    expect(app.jobs).toBeInstanceOf(CloudflareJobsAdapter);
    expect(app.scheduledHandler).toEqual(expect.any(Function));
    await expect(app.scheduledHandler("*/15 * * * *")).resolves.toBeUndefined();
  });

  test("publishes delayed jobs through QStash with a full endpoint URL", async () => {
    const client = qstashClient();
    const adapter = createQStashJobs({
      provider: "qstash",
      token: "token",
      baseUrl: "https://cms.example.com/",
      currentSigningKey: "current",
      nextSigningKey: "next",
      client
    });

    await adapter.enqueue("/cms/jobs/webhook-retry", { deliveryId: "delivery-1" }, { delay: 30 });

    expect(client.publishJSON).toHaveBeenCalledWith({
      url: "https://cms.example.com/cms/jobs/webhook-retry",
      body: { deliveryId: "delivery-1" },
      delay: 30
    });
  });

  test("verifies QStash signatures and fails closed on missing or rejected signatures", async () => {
    const verify = vi.fn(async () => true);
    const adapter = createQStashJobs({
      provider: "qstash",
      token: "token",
      baseUrl: "https://cms.example.com",
      receiver: { verify },
      client: qstashClient()
    });

    await expect(adapter.verify(new Request("https://cms.example.com/cms/jobs/webhook-retry", {
      method: "POST",
      headers: { "upstash-signature": "sig" },
      body: JSON.stringify({ deliveryId: "delivery-1" })
    }))).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith({
      body: JSON.stringify({ deliveryId: "delivery-1" }),
      signature: "sig",
      url: "https://cms.example.com/cms/jobs/webhook-retry"
    });

    await expect(adapter.verify(new Request("https://cms.example.com/cms/jobs/webhook-retry", { method: "POST" }))).resolves.toBe(false);

    verify.mockRejectedValueOnce(new Error("bad signature"));
    await expect(adapter.verify(new Request("https://cms.example.com/cms/jobs/webhook-retry", {
      method: "POST",
      headers: { "upstash-signature": "sig" },
      body: "tampered"
    }))).resolves.toBe(false);
  });

  test("supports explicit QStash local development signature bypass", async () => {
    process.env.DEV_SKIP_JOB_SIGNATURE = "true";
    const verify = vi.fn(async () => false);
    const adapter = createQStashJobs({
      provider: "qstash",
      token: "token",
      baseUrl: "http://localhost:3000",
      receiver: { verify },
      client: qstashClient()
    });

    await expect(adapter.verify(new Request("http://localhost:3000/cms/jobs/cache-sweep", { method: "POST" }))).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  test("deduplicates QStash schedule bootstrap by destination and cron", async () => {
    const client = qstashClient([{ destination: "https://cms.example.com/cms/jobs/cache-sweep", cron: "0 * * * *" }]);
    const adapter = createQStashJobs({
      provider: "qstash",
      token: "token",
      baseUrl: "https://cms.example.com",
      currentSigningKey: "current",
      nextSigningKey: "next",
      client
    });

    await expect(adapter.bootstrapSchedules({
      "0 * * * *": "/cms/jobs/cache-sweep",
      "*/15 * * * *": "/cms/jobs/scheduled-publish"
    })).resolves.toEqual({ created: 1, skipped: 1 });
    expect(client.schedules.create).toHaveBeenCalledWith({
      destination: "https://cms.example.com/cms/jobs/scheduled-publish",
      cron: "*/15 * * * *"
    });
  });

  test("validates QStash startup configuration and resolves through createCMS baseUrl", async () => {
    expect(() => createQStashJobs({ provider: "qstash", token: "token", client: qstashClient() })).toThrow("requires baseUrl");
    expect(() => createQStashJobs({ provider: "qstash", token: "token", baseUrl: "http://localhost:3000", client: qstashClient() })).toThrow("requires a public baseUrl");
    expect(() => createQStashJobs({ provider: "qstash", token: "token", baseUrl: "https://cms.example.com", client: qstashClient() })).toThrow("requires signing keys");
    expect(() => createQStashJobs({
      provider: "qstash",
      token: "token",
      baseUrl: "https://cms.example.com",
      currentSigningKey: "current",
      nextSigningKey: "next",
      client: qstashClient()
    })).not.toThrow();

    process.env.QSTASH_TOKEN = "token";
    process.env.QSTASH_CURRENT_SIGNING_KEY = "current";
    process.env.QSTASH_NEXT_SIGNING_KEY = "next";
    const app = createCMS({
      baseUrl: "https://cms.example.com",
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      jobs: { provider: "qstash" },
      rbac: { publicRead: true }
    });
    expect(app.jobs).toBeInstanceOf(QStashJobsAdapter);
  });

  test("verifies Vercel cron requests with the official CRON_SECRET bearer header", async () => {
    const adapter = createVercelJobs({ provider: "vercel", secret: "secret", cronOnly: true });

    await expect(adapter.verify(new Request("https://cms.test/cms/jobs/scheduled-publish", {
      method: "GET",
      headers: { authorization: "Bearer secret" }
    }))).resolves.toBe(true);
  });

  test("keeps Vercel HMAC-SHA256 signature verification as a compatibility fallback", async () => {
    const secret = "secret";
    const body = JSON.stringify({ job: "scheduled-publish" });
    const adapter = createVercelJobs({ provider: "vercel", secret, cronOnly: true });
    const signature = await hmacHex(body, secret);

    await expect(adapter.verify(new Request("https://cms.test/cms/jobs/scheduled-publish", {
      method: "POST",
      headers: { "x-vercel-signature": signature },
      body
    }))).resolves.toBe(true);
  });

  test("rejects missing or mismatched Vercel cron authorization", async () => {
    const secret = "secret";
    const body = JSON.stringify({ job: "scheduled-publish" });
    const signature = await hmacHex(body, secret);
    const adapter = createVercelJobs({ provider: "vercel", secret, cronOnly: true });

    await expect(adapter.verify(new Request("https://cms.test/cms/jobs/scheduled-publish", {
      method: "POST",
      body
    }))).resolves.toBe(false);
    await expect(adapter.verify(new Request("https://cms.test/cms/jobs/scheduled-publish", {
      method: "GET",
      headers: { authorization: "Bearer wrong-secret" }
    }))).resolves.toBe(false);
    await expect(adapter.verify(new Request("https://cms.test/cms/jobs/scheduled-publish", {
      method: "POST",
      headers: { "x-vercel-signature": signature },
      body: JSON.stringify({ job: "tampered" })
    }))).resolves.toBe(false);
    await expect(createVercelJobs({ provider: "vercel", cronOnly: true }).verify(new Request("https://cms.test/cms/jobs/scheduled-publish", {
      method: "POST",
      headers: { "x-vercel-signature": signature },
      body
    }))).resolves.toBe(false);
  });

  test("reads Vercel CRON_SECRET from environment when config omits it", async () => {
    process.env.CRON_SECRET = "env-secret";
    const adapter = createVercelJobs({ provider: "vercel", cronOnly: true });

    await expect(adapter.verify(new Request("https://cms.test/cms/jobs/cache-sweep", {
      method: "GET",
      headers: { authorization: "Bearer env-secret" }
    }))).resolves.toBe(true);
  });

  test("keeps the legacy Vercel signature environment variable as a fallback", async () => {
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "env-secret";
    const body = "";
    const signature = await hmacHex(body, "env-secret");
    const adapter = createVercelJobs({ provider: "vercel", cronOnly: true });

    await expect(adapter.verify(new Request("https://cms.test/cms/jobs/cache-sweep", {
      method: "POST",
      headers: { "x-vercel-signature": signature },
      body
    }))).resolves.toBe(true);
  });

  test("throws at construction when neither qstashFallback nor cronOnly is configured", () => {
    expect(() => createVercelJobs({ provider: "vercel", secret: "secret" })).toThrow(JobsConfigError);
    expect(() => createVercelJobs({ provider: "vercel", secret: "secret" })).toThrow(/qstashFallback for on-demand jobs/);
  });

  test("throws JobsConfigError when enqueue is called without a QStash fallback", async () => {
    const adapter = createVercelJobs({ provider: "vercel", secret: "secret", cronOnly: true });

    await expect(adapter.enqueue("/cms/jobs/webhook-retry", { id: "delivery-1" })).rejects.toBeInstanceOf(JobsConfigError);
    await expect(adapter.enqueue("/cms/jobs/webhook-retry", { id: "delivery-1" })).rejects.toThrow(/Vercel has no native queue API/);
  });

  test("delegates Vercel on-demand enqueue to a QStash fallback adapter", async () => {
    const enqueue = vi.fn(async () => {});
    const adapter = createVercelJobs({
      provider: "vercel",
      secret: "secret",
      qstashFallback: { enqueue }
    });

    await expect(adapter.enqueue("/cms/jobs/webhook-retry", { deliveryId: "delivery-1" }, { delay: 30 })).resolves.toBeUndefined();

    expect(enqueue).toHaveBeenCalledWith("/cms/jobs/webhook-retry", { deliveryId: "delivery-1" }, { delay: 30 });
  });

  test("Vercel cron-only deployment still functions via generateVercelJson and scheduledHandler", async () => {
    const adapter = createVercelJobs({ provider: "vercel", secret: "secret", cronOnly: true });
    const scheduled = vi.fn(async () => {});
    adapter.register("scheduled", scheduled);

    await adapter.scheduledHandler("0 * * * *");
    expect(scheduled).toHaveBeenCalledWith({ cron: "0 * * * *" }, expect.objectContaining({ cms: null, now: expect.any(Date) }));

    expect(generateVercelJson({ "/cms/jobs/scheduled-publish": "0 * * * *" })).toEqual({
      crons: [{ path: "/cms/jobs/scheduled-publish", schedule: "0 * * * *" }]
    });

    await expect(adapter.health()).resolves.toMatchObject({
      ok: true,
      details: { qstashFallbackConfigured: false, cronOnly: true }
    });
  });

  test("dispatches scheduled jobs and registers as a CMS jobs provider", async () => {
    const adapter = new VercelJobsAdapter({ provider: "vercel", secret: "secret", cronOnly: true });
    const scheduled = vi.fn(async () => {});
    adapter.register("scheduled", scheduled);

    await adapter.scheduledHandler("0 * * * *");

    expect(scheduled).toHaveBeenCalledWith({ cron: "0 * * * *" }, expect.objectContaining({ cms: null, now: expect.any(Date) }));

    const app = createCMS({
      collections,
      db: createMemoryDatabase({ provider: "memory", collections }),
      jobs: { provider: "vercel", secret: "secret", cronOnly: true },
      rbac: { publicRead: true }
    });
    expect(app.jobs?.provider).toBe("vercel");
  });

  test("generates Vercel cron config", () => {
    expect(generateVercelJson({
      "/cms/jobs/scheduled-publish": "* * * * *",
      "/cms/jobs/audit-log-cleanup": "0 0 * * *"
    })).toEqual({
      crons: [
        { path: "/cms/jobs/scheduled-publish", schedule: "* * * * *" },
        { path: "/cms/jobs/audit-log-cleanup", schedule: "0 0 * * *" }
      ]
    });
    expect(() => generateVercelJson({ "cms/jobs/cache-sweep": "0 * * * *" })).toThrow("must start");
  });
});

async function hmacHex(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function qstashClient(schedules: QStashClientLike["schedules"] extends { list(): Promise<infer T> } ? T : never = []): QStashClientLike {
  return {
    publishJSON: vi.fn(async () => ({ messageId: "msg_1" })),
    schedules: {
      list: vi.fn(async () => schedules),
      create: vi.fn(async () => ({ scheduleId: "sched_1" }))
    }
  };
}
