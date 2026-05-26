import { describe, expect, test } from "vitest";
import {
  CloudflareJobsAdapter,
  cloudflareJobs,
  createCloudflareJobs,
  createNoneJobs,
  createQStashJobs,
  createVercelJobs,
  generateVercelJson,
  JobsConfigError,
  memoryJobs,
  MemoryJobsAdapter,
  noneJobs,
  NoneJobsAdapter,
  QStashJobsAdapter,
  qstashJobs,
  VercelJobsAdapter,
  vercelJobs
} from "../index";

describe("@hono-cms/jobs — explicit factory exports (U12 + U24)", () => {
  test("memoryJobs({}) returns a JobsAdapter instance", () => {
    const adapter = memoryJobs({});
    expect(adapter).toBeInstanceOf(MemoryJobsAdapter);
    expect(adapter.provider).toBe("memory");
  });

  test("noneJobs() returns a no-op JobsAdapter", () => {
    const adapter = noneJobs();
    expect(adapter).toBeInstanceOf(NoneJobsAdapter);
  });

  test("vercelJobs({ secret, cronOnly: true }) returns a JobsAdapter with the vercel provider", () => {
    process.env.CMS_PUBLIC_URL = "https://example.com";
    const adapter = vercelJobs({ secret: "test-secret", cronOnly: true });
    expect(adapter).toBeInstanceOf(VercelJobsAdapter);
    expect(adapter.provider).toBe("vercel");
    delete process.env.CMS_PUBLIC_URL;
  });

  test("qstashJobs throws on missing QSTASH_TOKEN", () => {
    delete process.env.QSTASH_TOKEN;
    expect(() => qstashJobs({})).toThrow();
  });

  test("qstashJobs returns a JobsAdapter when configured", () => {
    process.env.QSTASH_TOKEN = "tok";
    process.env.QSTASH_CURRENT_SIGNING_KEY = "cur";
    process.env.QSTASH_NEXT_SIGNING_KEY = "next";
    process.env.CMS_PUBLIC_URL = "https://example.com";
    const adapter = qstashJobs({});
    expect(adapter).toBeInstanceOf(QStashJobsAdapter);
    delete process.env.QSTASH_TOKEN;
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    delete process.env.QSTASH_NEXT_SIGNING_KEY;
    delete process.env.CMS_PUBLIC_URL;
  });

  test("cloudflareJobs requires either queue binding or qstashFallback", () => {
    expect(() => cloudflareJobs({})).toThrow(JobsConfigError);
  });

  test("cloudflareJobs returns a JobsAdapter when a queue binding is provided", () => {
    const adapter = cloudflareJobs({
      queue: { send: async () => undefined }
    });
    expect(adapter).toBeInstanceOf(CloudflareJobsAdapter);
  });

  test("generateVercelJson serialises configured cron schedules", () => {
    const json = generateVercelJson({ "/cms/jobs/foo": "*/5 * * * *" });
    expect(json).toMatchObject({
      crons: [{ path: "/cms/jobs/foo", schedule: "*/5 * * * *" }]
    });
  });

  test("legacy `create*Jobs` aliases exist alongside the new factory names", () => {
    expect(typeof createNoneJobs).toBe("function");
    expect(typeof createCloudflareJobs).toBe("function");
    expect(typeof createQStashJobs).toBe("function");
    expect(typeof createVercelJobs).toBe("function");
  });
});
