/**
 * @hono-cms/jobs
 *
 * Background jobs and crons adapters for Hono CMS.
 *
 * ## Vercel
 *
 * Vercel deployments split job execution into two distinct paths:
 *
 * 1. **Scheduled jobs (crons)**: declared via `vercel.json` (use
 *    `generateVercelJson(scheduleMap)` to generate the configuration).
 *    Vercel Cron calls the registered HTTP endpoints on schedule. No
 *    additional runtime configuration is required.
 *
 * 2. **On-demand jobs (e.g. webhook retries, translation queueing)**:
 *    Vercel does not provide a native queue API. To enqueue on-demand
 *    jobs, configure a `qstashFallback` (typically a `QStashJobsAdapter`):
 *
 *    ```ts
 *    import { createVercelJobs, createQStashJobs } from "@hono-cms/jobs";
 *
 *    const qstash = createQStashJobs({ provider: "qstash", baseUrl, token });
 *    const jobs = createVercelJobs({ provider: "vercel", qstashFallback: qstash });
 *    ```
 *
 *    If `enqueue()` is called without `qstashFallback`, the adapter
 *    throws a `JobsConfigError` so silent drops cannot occur. If you
 *    only need cron-driven jobs and never call `enqueue()` (no webhook
 *    retries, no on-demand jobs), configure the adapter as
 *    `cronOnly: true` to acknowledge the limitation at construction
 *    time.
 *
 * ## Cloudflare
 *
 * Cloudflare deployments mirror the Vercel split:
 *
 * 1. **Scheduled jobs (crons)**: declared via Cloudflare Cron Triggers
 *    in `wrangler.toml`. Register handlers per cron expression through
 *    `cronMap`; the worker's `scheduled()` export calls
 *    `scheduledHandler(cron)`.
 *
 * 2. **On-demand jobs**: configure a Cloudflare Queue producer binding
 *    (`queue`) or a `qstashFallback`. If neither is configured the
 *    adapter throws `JobsConfigError` at construction (unless
 *    `cronOnly: true` is set) and `enqueue()` throws `JobsConfigError`
 *    so on-demand jobs cannot be dropped silently.
 */
import { registerProvider, type JobContext, type JobHandler, type JobsAdapter } from "@hono-cms/core";
import { Client, Receiver } from "@upstash/qstash";

export class JobsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobsConfigError";
  }
}

export type MemoryJobsConfig = {
  provider: "memory";
};

export type NoneJobsConfig = {
  provider: "none";
};

export type VercelJobsConfig = {
  provider: "vercel";
  secret?: string;
  /**
   * Optional QStash (or compatible) adapter used to satisfy on-demand
   * `enqueue()` calls. Required unless `cronOnly` is set to `true`.
   */
  qstashFallback?: Pick<JobsAdapter, "enqueue">;
  /**
   * Acknowledges that this deployment only uses Vercel Cron (schedules
   * declared via `generateVercelJson`) and will never call `enqueue()`.
   * When `true`, `enqueue()` still throws — this flag only suppresses
   * the construction-time guard.
   */
  cronOnly?: boolean;
};

export type QStashClientLike = {
  publishJSON(input: { url: string; body?: unknown; delay?: number }): Promise<unknown>;
  schedules: {
    list(): Promise<readonly QStashScheduleLike[]>;
    create(input: { destination: string; cron: string }): Promise<unknown>;
  };
};

export type QStashReceiverLike = {
  verify(input: { body: string; signature: string; url: string }): Promise<boolean>;
};

export type QStashScheduleLike = {
  id?: string;
  destination?: string;
  url?: string;
  cron?: string;
};

export type QStashJobsConfig = {
  provider: "qstash";
  token?: string;
  baseUrl?: string;
  currentSigningKey?: string;
  nextSigningKey?: string;
  client?: QStashClientLike;
  receiver?: QStashReceiverLike;
};

export type CloudflareQueueLike = {
  send(message: { endpoint: string; body?: unknown; delaySeconds?: number }): Promise<void>;
};

export type CloudflareCronMap = Record<string, JobHandler>;

export type CloudflareJobsConfig = {
  provider: "cloudflare";
  cronMap?: CloudflareCronMap;
  /**
   * Cloudflare Queue producer binding used to satisfy on-demand
   * `enqueue()` calls. Required unless `qstashFallback` or `cronOnly`
   * is configured.
   */
  queue?: CloudflareQueueLike;
  /**
   * Optional QStash (or compatible) adapter used to satisfy on-demand
   * `enqueue()` calls when no Cloudflare `queue` binding is available.
   */
  qstashFallback?: Pick<JobsAdapter, "enqueue">;
  /**
   * Acknowledges that this deployment only uses Cloudflare Cron Triggers
   * (handlers declared via `cronMap`) and will never call `enqueue()`.
   * When `true`, `enqueue()` still throws — this flag only suppresses
   * the construction-time guard.
   */
  cronOnly?: boolean;
};

export type VercelCron = { path: string; schedule: string };
export type VercelJson = { crons: VercelCron[] };

export class MemoryJobsAdapter implements JobsAdapter {
  readonly provider = "memory";
  private readonly handlers = new Map<string, JobHandler>();

  register(name: string, handler: JobHandler): void {
    if (this.handlers.has(name)) throw new Error(`Job "${name}" is already registered.`);
    this.handlers.set(name, handler);
  }

  async dispatch(name: string, payload?: unknown): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Job "${name}" is not registered.`);
    const context: JobContext = { cms: null, now: new Date() };
    await handler(payload, context);
  }

  async enqueue(endpoint: string, body?: unknown): Promise<void> {
    await this.dispatch(endpoint.replace(/^\/?cms\/jobs\//, "").replace(/^\//, ""), body);
  }

  async verify(): Promise<boolean> {
    return true;
  }

  async scheduled(): Promise<void> {
    if (this.handlers.has("scheduled")) {
      await this.dispatch("scheduled");
    }
  }

  async scheduledHandler(cron: string): Promise<void> {
    await this.dispatch("scheduled", { cron });
  }

  async health(): Promise<{ ok: boolean; details: { handlers: number } }> {
    return { ok: true, details: { handlers: this.handlers.size } };
  }
}

export function createMemoryJobs(): MemoryJobsAdapter {
  return new MemoryJobsAdapter();
}

export class NoneJobsAdapter implements JobsAdapter {
  readonly provider = "none";

  register(): void {}

  async dispatch(): Promise<void> {}

  async enqueue(): Promise<void> {}

  async verify(): Promise<boolean> {
    return false;
  }

  async health(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: "disabled" };
  }
}

export function createNoneJobs(): NoneJobsAdapter {
  return new NoneJobsAdapter();
}

export class QStashJobsAdapter implements JobsAdapter {
  readonly provider = "qstash";
  private readonly handlers = new Map<string, JobHandler>();
  private readonly baseUrl: string;
  private readonly client: QStashClientLike;
  private readonly receiver: QStashReceiverLike | null;
  private readonly skipVerification: boolean;

  constructor(config: QStashJobsConfig) {
    const baseUrl = normalizeBaseUrl(config.baseUrl ?? readEnv("CMS_PUBLIC_URL"));
    if (!baseUrl) {
      throw new Error("[hono-cms/jobs] QStash provider requires baseUrl (CMS_PUBLIC_URL). Set createCMS({ baseUrl }) or jobs: { provider: 'qstash', baseUrl }.");
    }
    if (isLocalhostUrl(baseUrl) && !allowsLocalQStashBaseUrl()) {
      throw new Error("[hono-cms/jobs] QStash provider requires a public baseUrl. Use QSTASH_URL for local QStash development or set jobs: { provider: 'memory' } locally.");
    }

    const token = config.token ?? readEnv("QSTASH_TOKEN");
    if (!token && !config.client) {
      throw new Error("[hono-cms/jobs] QStash provider requires token (QSTASH_TOKEN).");
    }

    this.baseUrl = baseUrl;
    this.client = config.client ?? new Client({
      token: token as string,
      ...(readEnv("QSTASH_URL") ? { baseUrl: readEnv("QSTASH_URL") as string } : {})
    }) as QStashClientLike;
    this.skipVerification = readEnv("DEV_SKIP_JOB_SIGNATURE") === "true" || isQStashLocalDev();

    const currentSigningKey = config.currentSigningKey ?? readEnv("QSTASH_CURRENT_SIGNING_KEY");
    const nextSigningKey = config.nextSigningKey ?? readEnv("QSTASH_NEXT_SIGNING_KEY") ?? currentSigningKey;
    if (!this.skipVerification && !config.receiver && (!currentSigningKey || !nextSigningKey)) {
      throw new Error("[hono-cms/jobs] QStash provider requires signing keys (QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY) or an explicit receiver.");
    }
    this.receiver = config.receiver ?? (currentSigningKey && nextSigningKey
      ? new Receiver({ currentSigningKey, nextSigningKey }) as QStashReceiverLike
      : null);
  }

  register(name: string, handler: JobHandler): void {
    if (this.handlers.has(name)) throw new Error(`Job "${name}" is already registered.`);
    this.handlers.set(name, handler);
  }

  async dispatch(name: string, payload?: unknown): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Job "${name}" is not registered.`);
    const context: JobContext = { cms: null, now: new Date() };
    await handler(payload, context);
  }

  async enqueue(endpoint: string, body?: unknown, options: { delay?: number } = {}): Promise<void> {
    await this.client.publishJSON({
      url: joinUrl(this.baseUrl, endpoint),
      body,
      ...(options.delay !== undefined ? { delay: options.delay } : {})
    });
  }

  async verify(request: Request): Promise<boolean> {
    if (this.skipVerification) return true;
    const signature = request.headers.get("upstash-signature");
    if (!signature || !this.receiver) return false;
    try {
      return await this.receiver.verify({
        body: await request.clone().text(),
        signature,
        url: request.url
      });
    } catch {
      return false;
    }
  }

  async bootstrapSchedules(scheduleMap: Record<string, string> | readonly VercelCron[]): Promise<{ created: number; skipped: number }> {
    const schedules = Array.isArray(scheduleMap)
      ? scheduleMap.map(({ path, schedule }) => ({ destination: joinUrl(this.baseUrl, path), cron: schedule }))
      : Object.entries(scheduleMap).map(([cron, endpoint]) => ({ destination: joinUrl(this.baseUrl, endpoint), cron }));
    const existing = await this.client.schedules.list();
    let created = 0;
    let skipped = 0;

    for (const schedule of schedules) {
      if (existing.some((item) => scheduleIdentity(item).destination === schedule.destination && scheduleIdentity(item).cron === schedule.cron)) {
        skipped += 1;
        continue;
      }
      await this.client.schedules.create(schedule);
      created += 1;
    }

    return { created, skipped };
  }

  async health(): Promise<{ ok: boolean; details: { signatureConfigured: boolean } }> {
    return { ok: true, details: { signatureConfigured: this.skipVerification || Boolean(this.receiver) } };
  }
}

export function createQStashJobs(config: QStashJobsConfig): QStashJobsAdapter {
  return new QStashJobsAdapter(config);
}

export class CloudflareJobsAdapter implements JobsAdapter {
  readonly provider = "cloudflare";
  private readonly handlers = new Map<string, JobHandler>();
  private readonly queue: CloudflareQueueLike | undefined;
  private readonly qstashFallback: Pick<JobsAdapter, "enqueue"> | undefined;
  private readonly cronOnly: boolean;

  constructor(config: CloudflareJobsConfig = { provider: "cloudflare" }) {
    this.queue = config.queue;
    this.qstashFallback = config.qstashFallback;
    this.cronOnly = config.cronOnly === true;
    if (!this.queue && !this.qstashFallback?.enqueue && !this.cronOnly) {
      throw new JobsConfigError(
        "CloudflareJobsAdapter requires a Queue binding or qstashFallback for on-demand jobs; only cron handlers declared via cronMap will run. Pass jobs: { provider: 'cloudflare', queue: env.JOBS_QUEUE } or { provider: 'cloudflare', qstashFallback: createQStashJobs({ ... }) } to support on-demand jobs, or set cronOnly: true to acknowledge this limitation."
      );
    }
    for (const [cron, handler] of Object.entries(config.cronMap ?? {})) {
      this.register(cron, handler);
    }
  }

  register(name: string, handler: JobHandler): void {
    if (this.handlers.has(name)) throw new Error(`Job "${name}" is already registered.`);
    this.handlers.set(name, handler);
  }

  async dispatch(name: string, payload?: unknown): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Job "${name}" is not registered.`);
    const context: JobContext = { cms: null, now: new Date() };
    await handler(payload, context);
  }

  async enqueue(endpoint: string, body?: unknown, options: { delay?: number } = {}): Promise<void> {
    if (this.queue) {
      await this.queue.send({
        endpoint,
        body,
        ...(options.delay !== undefined ? { delaySeconds: options.delay } : {})
      });
      return;
    }
    if (this.qstashFallback?.enqueue) {
      await this.qstashFallback.enqueue(endpoint, body, options);
      return;
    }
    throw new JobsConfigError(
      `[hono-cms/jobs] Cloudflare provider cannot enqueue on-demand job "${endpoint}": no Queue binding or QStash fallback configured, so the request would be dropped silently. Configure jobs: { provider: 'cloudflare', queue: env.JOBS_QUEUE } or { provider: 'cloudflare', qstashFallback: createQStashJobs({ ... }) } to support on-demand jobs. Cloudflare Cron Triggers declared via cronMap are unaffected.`
    );
  }

  async verify(): Promise<boolean> {
    return true;
  }

  async scheduledHandler(cron: string): Promise<void> {
    const handler = this.handlers.get(cron);
    if (!handler) {
      console.warn(`[hono-cms/jobs] Cloudflare provider: no job registered for cron "${cron}".`);
      return;
    }
    const context: JobContext = { cms: null, now: new Date() };
    await handler({ cron }, context);
  }

  async health(): Promise<{ ok: boolean; details: { handlers: number; queueConfigured: boolean; qstashFallbackConfigured: boolean; cronOnly: boolean } }> {
    return {
      ok: true,
      details: {
        handlers: this.handlers.size,
        queueConfigured: Boolean(this.queue),
        qstashFallbackConfigured: Boolean(this.qstashFallback?.enqueue),
        cronOnly: this.cronOnly
      }
    };
  }
}

export function createCloudflareJobs(config: CloudflareJobsConfig = { provider: "cloudflare" }): CloudflareJobsAdapter {
  return new CloudflareJobsAdapter(config);
}

export class VercelJobsAdapter implements JobsAdapter {
  readonly provider = "vercel";
  private readonly handlers = new Map<string, JobHandler>();
  private readonly secret: string | undefined;
  private readonly qstashFallback: Pick<JobsAdapter, "enqueue"> | undefined;
  private readonly cronOnly: boolean;

  constructor(config: VercelJobsConfig = { provider: "vercel" }) {
    this.secret = config.secret ?? readEnv("CRON_SECRET") ?? readEnv("VERCEL_AUTOMATION_BYPASS_SECRET");
    this.qstashFallback = config.qstashFallback;
    this.cronOnly = config.cronOnly === true;
    if (!this.qstashFallback?.enqueue && !this.cronOnly) {
      throw new JobsConfigError(
        "VercelJobsAdapter requires qstashFallback for on-demand jobs; only crons declared via generateVercelJson will run. Pass jobs: { provider: 'vercel', qstashFallback: createQStashJobs({ ... }) } or set cronOnly: true to acknowledge this limitation."
      );
    }
  }

  register(name: string, handler: JobHandler): void {
    if (this.handlers.has(name)) throw new Error(`Job "${name}" is already registered.`);
    this.handlers.set(name, handler);
  }

  async dispatch(name: string, payload?: unknown): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Job "${name}" is not registered.`);
    const context: JobContext = { cms: null, now: new Date() };
    await handler(payload, context);
  }

  async enqueue(endpoint: string, body?: unknown, options: { delay?: number } = {}): Promise<void> {
    if (this.qstashFallback?.enqueue) {
      await this.qstashFallback.enqueue(endpoint, body, options);
      return;
    }
    throw new JobsConfigError(
      `[hono-cms/jobs] Vercel provider cannot enqueue on-demand job "${endpoint}": Vercel has no native queue API. Configure jobs: { provider: 'vercel', qstashFallback: createQStashJobs({ ... }) } to support on-demand jobs (webhook retries, translations, etc.). Vercel Cron declared via generateVercelJson is unaffected.`
    );
  }

  async verify(request: Request): Promise<boolean> {
    if (!this.secret) return false;
    if (request.headers.get("authorization") === `Bearer ${this.secret}`) return true;
    const signature = request.headers.get("x-vercel-signature");
    if (!signature) return false;
    const body = await request.clone().text();
    const expected = await hmacSha256(body, this.secret);
    return timingSafeEqual(signature, expected.hex) || timingSafeEqual(signature, expected.base64);
  }

  async scheduledHandler(cron: string): Promise<void> {
    await this.dispatch("scheduled", { cron });
  }

  async health(): Promise<{ ok: boolean; details: { handlers: number; signatureConfigured: boolean; qstashFallbackConfigured: boolean; cronOnly: boolean } }> {
    return {
      ok: true,
      details: {
        handlers: this.handlers.size,
        signatureConfigured: Boolean(this.secret),
        qstashFallbackConfigured: Boolean(this.qstashFallback?.enqueue),
        cronOnly: this.cronOnly
      }
    };
  }
}

export function createVercelJobs(config: VercelJobsConfig = { provider: "vercel" }): VercelJobsAdapter {
  return new VercelJobsAdapter(config);
}

export function generateVercelJson(scheduleMap: Record<string, string> | readonly VercelCron[]): VercelJson {
  const crons = Array.isArray(scheduleMap)
    ? scheduleMap
    : Object.entries(scheduleMap).map(([path, schedule]) => ({ path, schedule }));

  return { crons: crons.map(normalizeCron) };
}

function normalizeCron(cron: VercelCron): VercelCron {
  const path = cron.path.trim();
  const schedule = cron.schedule.trim();
  if (!path.startsWith("/")) {
    throw new Error(`Vercel cron path must start with "/": ${cron.path}`);
  }
  if (!schedule) {
    throw new Error(`Vercel cron schedule must be non-empty for ${path}`);
  }
  return { path, schedule };
}

async function hmacSha256(body: string, secret: string): Promise<{ hex: string; base64: string }> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return {
    hex: Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    base64: btoa(String.fromCharCode(...signature))
  };
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

function readEnv(name: string): string | undefined {
  const env = typeof process !== "undefined" ? process.env : undefined;
  return env?.[name];
}

function normalizeBaseUrl(input: string | undefined): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
}

function isLocalhostUrl(input: string): boolean {
  return /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(input);
}

function isQStashLocalDev(): boolean {
  const url = readEnv("QSTASH_URL");
  return Boolean(url && !url.startsWith("https://qstash.upstash.io"));
}

function allowsLocalQStashBaseUrl(): boolean {
  return isQStashLocalDev() || readEnv("DEV_SKIP_JOB_SIGNATURE") === "true";
}

function scheduleIdentity(schedule: QStashScheduleLike): { destination: string | undefined; cron: string | undefined } {
  return {
    destination: schedule.destination ?? schedule.url,
    cron: schedule.cron
  };
}

// ---------------------------------------------------------------------------
// Explicit factory exports (Plan-15 U12 — explicit composition).
//
// These are the preferred way to construct a `JobsAdapter` once Phase-3 of the
// plugin-system refactor lands: `jobsRuntime({ adapter: memoryJobs({}) })`.
// They are thin wrappers around the existing `create*Jobs` constructors so
// callers can adopt the new naming without losing the legacy provider-resolver
// flow that `createCMS({ jobs: { provider: "memory" } })` still relies on.
//
// The `registerProvider` side effects below keep the legacy `jobs: { provider }`
// resolution working until `packages/core/src/create-cms.ts` deletes the jobs
// block (U12 follow-up — see plan §U12).
// ---------------------------------------------------------------------------

export function memoryJobs(_config: MemoryJobsConfig | Record<string, unknown> = {}): MemoryJobsAdapter {
  return createMemoryJobs();
}

export function noneJobs(_config: NoneJobsConfig | Record<string, unknown> = {}): NoneJobsAdapter {
  return createNoneJobs();
}

export function qstashJobs(config: Omit<QStashJobsConfig, "provider"> & { provider?: "qstash" }): QStashJobsAdapter {
  return createQStashJobs({ ...config, provider: "qstash" });
}

export function cloudflareJobs(config: Omit<CloudflareJobsConfig, "provider"> & { provider?: "cloudflare" } = {}): CloudflareJobsAdapter {
  return createCloudflareJobs({ ...config, provider: "cloudflare" });
}

export function vercelJobs(config: Omit<VercelJobsConfig, "provider"> & { provider?: "vercel" } = {}): VercelJobsAdapter {
  return createVercelJobs({ ...config, provider: "vercel" });
}

registerProvider<MemoryJobsConfig, JobsAdapter>("jobs", "memory", createMemoryJobs);
registerProvider<NoneJobsConfig, JobsAdapter>("jobs", "none", createNoneJobs);
registerProvider<QStashJobsConfig, JobsAdapter>("jobs", "qstash", createQStashJobs);
registerProvider<CloudflareJobsConfig, JobsAdapter>("jobs", "cloudflare", createCloudflareJobs);
registerProvider<VercelJobsConfig, JobsAdapter>("jobs", "vercel", createVercelJobs);
