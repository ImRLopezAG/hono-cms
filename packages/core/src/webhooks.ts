import type { WebhookDelivery, WebhookEvent, WebhookRecord, WebhookRecordAttemptInput, WebhookStore, WebhookTarget } from "./types/providers";

export class MemoryWebhookStore implements WebhookStore {
  private readonly webhooks = new Map<string, WebhookRecord>();
  private readonly deliveries: WebhookDelivery[] = [];

  async listWebhooks(): Promise<WebhookRecord[]> {
    return [...this.webhooks.values()];
  }

  async createWebhook(input: Omit<WebhookRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<WebhookRecord> {
    const now = new Date().toISOString();
    const record: WebhookRecord = {
      ...input,
      id: input.id ?? crypto.randomUUID(),
      createdAt: now,
      updatedAt: now
    };
    this.webhooks.set(record.id, record);
    return record;
  }

  async updateWebhook(id: string, patch: Partial<Omit<WebhookRecord, "id" | "createdAt" | "updatedAt" | "secret">> & { secret?: string | undefined }): Promise<WebhookRecord> {
    const current = this.webhooks.get(id);
    if (!current) throw new Error(`Webhook "${id}" not found.`);
    const { secret, ...rest } = patch;
    const next: WebhookRecord = { ...current, ...rest, updatedAt: new Date().toISOString() };
    if ("secret" in patch) {
      if (secret) next.secret = secret;
      else delete next.secret;
    }
    this.webhooks.set(id, next);
    return next;
  }

  async deleteWebhook(id: string): Promise<void> {
    this.webhooks.delete(id);
  }

  async appendDelivery(delivery: WebhookDelivery): Promise<void> {
    this.deliveries.unshift(delivery);
  }

  async getDelivery(id: string): Promise<WebhookDelivery | null> {
    return this.deliveries.find((delivery) => delivery.id === id) ?? null;
  }

  async updateDelivery(id: string, patch: Partial<Omit<WebhookDelivery, "id" | "createdAt">>): Promise<WebhookDelivery | null> {
    const index = this.deliveries.findIndex((delivery) => delivery.id === id);
    if (index === -1) return null;
    const next = { ...this.deliveries[index], ...patch } as WebhookDelivery;
    this.deliveries[index] = next;
    return next;
  }

  async listDeliveries(query: { webhookId?: string; cursor?: string; limit?: number } = {}): Promise<{ items: WebhookDelivery[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    let rows = [...this.deliveries];
    if (query.webhookId) rows = rows.filter((delivery) => delivery.webhookId === query.webhookId);
    const start = query.cursor ? Math.max(rows.findIndex((delivery) => delivery.id === query.cursor) + 1, 0) : 0;
    const items = rows.slice(start, start + limit);
    const last = items.at(-1);
    return start + limit < rows.length && last ? { items, nextCursor: last.id } : { items };
  }

  async listPendingRetries(now: Date): Promise<WebhookDelivery[]> {
    const cutoff = now.getTime();
    return this.deliveries.filter((delivery) => delivery.status === "retrying"
      && typeof delivery.nextAttemptAt === "string"
      && Date.parse(delivery.nextAttemptAt) <= cutoff);
  }

  async recordAttempt(deliveryId: string, input: WebhookRecordAttemptInput): Promise<WebhookDelivery | null> {
    const index = this.deliveries.findIndex((delivery) => delivery.id === deliveryId);
    if (index === -1) return null;
    const current = this.deliveries[index];
    if (!current) return null;
    const next: WebhookDelivery = { ...current };
    if (input.ok) {
      next.status = "success";
      next.nextAttemptAt = undefined;
      next.error = undefined;
      if (input.status !== undefined) next.responseStatus = input.status;
      if (input.responseBody !== undefined) next.responseBody = input.responseBody;
    } else if (input.finalFailure) {
      next.status = "failed";
      next.nextAttemptAt = undefined;
      if (input.status !== undefined) next.responseStatus = input.status;
      if (input.responseBody !== undefined) next.responseBody = input.responseBody;
      if (input.error !== undefined) next.error = input.error;
    } else {
      next.status = "retrying";
      if (input.status !== undefined) next.responseStatus = input.status;
      if (input.responseBody !== undefined) next.responseBody = input.responseBody;
      if (input.error !== undefined) next.error = input.error;
      next.nextAttemptAt = input.nextAttemptAt instanceof Date
        ? input.nextAttemptAt.toISOString()
        : input.nextAttemptAt;
    }
    this.deliveries[index] = next;
    return next;
  }

  async cleanup(olderThan: Date): Promise<number> {
    const cutoff = olderThan.getTime();
    let removed = 0;
    for (let index = this.deliveries.length - 1; index >= 0; index -= 1) {
      const delivery = this.deliveries[index];
      if (!delivery) continue;
      if (Date.parse(delivery.createdAt) <= cutoff) {
        this.deliveries.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }
}

export async function dispatchWebhooks(options: {
  staticTargets?: readonly WebhookTarget[];
  store?: WebhookStore | null;
  event: WebhookEvent;
  timeoutMs?: number;
  retry?: { enqueue(endpoint: string, body?: unknown, options?: { delay?: number }): Promise<void> };
}): Promise<WebhookDelivery[]> {
  const staticTargets = (options.staticTargets ?? []).map((target, index) => {
    const record: WebhookRecord = {
      id: target.id ?? `static:${index}`,
      name: target.name ?? target.url,
      url: target.url,
      events: target.events ?? ["*"],
      enabled: target.enabled ?? true,
      createdAt: "",
      updatedAt: ""
    };
    if (target.secret) record.secret = target.secret;
    return { record, webhookId: null };
  });
  const managedTargets = (await options.store?.listWebhooks() ?? []).map((record) => ({ record, webhookId: record.id }));
  const targets = [...staticTargets, ...managedTargets]
    .filter((target) => target.record.enabled)
    .filter((target) => target.record.events.some((pattern) => matchesEventPattern(options.event.type, pattern)));

  const deliveries = await Promise.all(targets.map((target) => deliverWebhook(target.record, options.event, options.timeoutMs ?? 10_000, target.webhookId)));
  await Promise.all(deliveries.map((delivery) => options.store?.appendDelivery(delivery)));
  await Promise.all(deliveries
    .filter((delivery) => delivery.status === "retrying")
    .map((delivery) => enqueueRetryWithFallback(options.retry, options.store ?? null, delivery)));
  return deliveries;
}

/**
 * Enqueue a webhook retry through the on-demand jobs adapter, falling back
 * to durable persistence in the webhook store when the jobs adapter is
 * unavailable or throws (e.g. Vercel cron-only or Cloudflare without a
 * Queue binding, per `JobsConfigError` from `@hono-cms/jobs`).
 *
 * The fallback path leaves the delivery row marked `retrying` with the
 * existing `nextAttemptAt` set by `deliverWebhook`/`recordRetryFailure`;
 * `runWebhookRetrySweep` later picks it up via `listPendingRetries`.
 */
async function enqueueRetryWithFallback(
  retry: { enqueue(endpoint: string, body?: unknown, options?: { delay?: number }): Promise<void> } | undefined,
  store: WebhookStore | null,
  delivery: WebhookDelivery
): Promise<void> {
  if (retry?.enqueue) {
    try {
      await retry.enqueue("/cms/jobs/webhook-retry", { deliveryId: delivery.id }, { delay: nextWebhookRetryDelay(delivery.attempt) });
      return;
    } catch (error) {
      console.warn(`[hono-cms/webhooks] jobs.enqueue failed for delivery ${delivery.id}; falling back to webhook-retry-sweep persistence: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // No jobs adapter, or enqueue threw: the delivery is already persisted with
  // status `retrying` and `nextAttemptAt`; the cron-driven sweep will retry it.
  // If the store doesn't support pending-retry lookup, no fallback is possible.
  if (!store?.listPendingRetries) {
    console.warn(`[hono-cms/webhooks] no jobs adapter and webhook store does not implement listPendingRetries; delivery ${delivery.id} will not be retried automatically.`);
  }
}

/**
 * Sweep persisted webhook deliveries that are ready to retry
 * (`status === "retrying"` and `nextAttemptAt <= now`) and re-attempt each.
 *
 * Registered as both a job runner (`webhook-retry-sweep`) and as a cron
 * endpoint so it works on every deployment topology:
 * - QStash / Cloudflare Queue: cron also runs, but on-demand enqueue is preferred.
 * - Vercel cron-only / Cloudflare without Queue: cron is the only retry path.
 * - Memory jobs adapter: the scheduled handler triggers it.
 */
export async function runWebhookRetrySweep(options: {
  store: WebhookStore;
  staticTargets?: readonly WebhookTarget[];
  now?: Date;
  timeoutMs?: number;
  batchLimit?: number;
}): Promise<{ swept: number; succeeded: number; retrying: number; failed: number }> {
  if (!options.store.listPendingRetries || !options.store.recordAttempt) {
    return { swept: 0, succeeded: 0, retrying: 0, failed: 0 };
  }
  const now = options.now ?? new Date();
  const limit = options.batchLimit ?? 100;
  const pending = (await options.store.listPendingRetries(now)).slice(0, limit);
  if (pending.length === 0) return { swept: 0, succeeded: 0, retrying: 0, failed: 0 };

  // Resolve webhook records (for the secret) once per sweep; static targets
  // are matched by URL so re-deliveries continue to sign with the original
  // secret even when the row was emitted before the sweep restarted.
  const managed = new Map((await options.store.listWebhooks()).map((record) => [record.id, record] as const));
  const staticByUrl = new Map((options.staticTargets ?? [])
    .filter((target): target is WebhookTarget & { url: string } => Boolean(target.url))
    .map((target) => [target.url, target] as const));

  let succeeded = 0;
  let retrying = 0;
  let failed = 0;
  for (const delivery of pending) {
    const secret = resolveDeliverySecret(delivery, managed, staticByUrl);
    const outcome = await sweepAttempt(options.store, delivery, secret, options.timeoutMs ?? 10_000);
    if (outcome === "success") succeeded += 1;
    else if (outcome === "failed") failed += 1;
    else retrying += 1;
  }
  return { swept: pending.length, succeeded, retrying, failed };
}

function resolveDeliverySecret(
  delivery: WebhookDelivery,
  managed: Map<string, WebhookRecord>,
  staticByUrl: Map<string, WebhookTarget>
): string | undefined {
  if (delivery.webhookId) return managed.get(delivery.webhookId)?.secret;
  return staticByUrl.get(delivery.url)?.secret;
}

async function sweepAttempt(
  store: WebhookStore,
  delivery: WebhookDelivery,
  secret: string | undefined,
  timeoutMs: number
): Promise<"success" | "retrying" | "failed"> {
  const attempt = delivery.attempt + 1;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(delivery.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cms-event": delivery.eventType,
        "x-cms-delivery": delivery.id,
        ...(secret ? { "x-cms-signature": await createHmacSignature(secret, delivery.requestBody) } : {})
      },
      body: delivery.requestBody,
      signal: controller.signal
    });
    const responseBody = redact(await response.text());
    if (response.ok) {
      await store.updateDelivery?.(delivery.id, { attempt });
      await store.recordAttempt?.(delivery.id, { ok: true, status: response.status, responseBody });
      return "success";
    }
    // 4xx terminal: endpoint says "stop". 5xx: schedule next retry.
    if (response.status >= 400 && response.status < 500) {
      await store.updateDelivery?.(delivery.id, { attempt });
      await store.recordAttempt?.(delivery.id, { ok: false, finalFailure: true, status: response.status, responseBody });
      return "failed";
    }
    if (attempt >= 3) {
      await store.updateDelivery?.(delivery.id, { attempt });
      await store.recordAttempt?.(delivery.id, { ok: false, finalFailure: true, status: response.status, responseBody });
      return "failed";
    }
    const delay = nextWebhookRetryDelay(attempt);
    await store.updateDelivery?.(delivery.id, { attempt });
    await store.recordAttempt?.(delivery.id, {
      ok: false,
      status: response.status,
      responseBody,
      nextAttemptAt: new Date(Date.now() + delay * 1000)
    });
    return "retrying";
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown delivery error";
    if (attempt >= 3) {
      await store.updateDelivery?.(delivery.id, { attempt });
      await store.recordAttempt?.(delivery.id, { ok: false, finalFailure: true, error: message });
      return "failed";
    }
    const delay = nextWebhookRetryDelay(attempt);
    await store.updateDelivery?.(delivery.id, { attempt });
    await store.recordAttempt?.(delivery.id, {
      ok: false,
      error: message,
      nextAttemptAt: new Date(Date.now() + delay * 1000)
    });
    return "retrying";
  } finally {
    clearTimeout(timeout);
  }
}

export async function webhookDeliveryCleanupJob(options: {
  store: WebhookStore | null;
  retentionDays?: number;
  now?: Date;
}): Promise<{ deletedCount: number; olderThan?: string }> {
  const retentionDays = options.retentionDays ?? 30;
  if (retentionDays <= 0) {
    console.warn(`[hono-cms/webhooks] webhook delivery cleanup skipped because retentionDays is ${retentionDays}.`);
    return { deletedCount: 0 };
  }
  if (!options.store?.cleanup) return { deletedCount: 0 };
  const now = options.now ?? new Date();
  const olderThan = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deletedCount = await options.store.cleanup(olderThan);
  return { deletedCount, olderThan: olderThan.toISOString() };
}

export async function deliverWebhook(target: WebhookRecord, event: WebhookEvent, timeoutMs = 10_000, webhookId: string | null = target.id): Promise<WebhookDelivery> {
  const body = JSON.stringify({ id: crypto.randomUUID(), event: event.type, data: event, timestamp: new Date().toISOString() });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const createdAt = new Date().toISOString();
  const base = {
    id: crypto.randomUUID(),
    webhookId,
    eventType: event.type,
    url: target.url,
    attempt: 1,
    requestBody: body,
    createdAt
  };

  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cms-event": event.type,
        "x-cms-delivery": base.id,
        ...(target.secret ? { "x-cms-signature": await createHmacSignature(target.secret, body) } : {})
      },
      body,
      signal: controller.signal
    });
    const responseBody = redact(await response.text());
    return {
      ...base,
      status: response.ok ? "success" : "retrying",
      responseStatus: response.status,
      responseBody,
      ...(response.ok ? {} : { nextAttemptAt: new Date(Date.now() + 30_000).toISOString() })
    };
  } catch (error) {
    return {
      ...base,
      status: "retrying",
      error: error instanceof Error ? error.message : "unknown delivery error",
      nextAttemptAt: new Date(Date.now() + 30_000).toISOString()
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function deliverWebhookTest(target: WebhookRecord, event: WebhookEvent, timeoutMs = 10_000): Promise<WebhookDelivery> {
  const body = JSON.stringify({ id: crypto.randomUUID(), event: "cms.test", data: event, timestamp: new Date().toISOString() });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const createdAt = new Date().toISOString();
  const base = {
    id: crypto.randomUUID(),
    webhookId: target.id,
    eventType: "cms.test",
    url: target.url,
    attempt: 1,
    requestBody: body,
    createdAt
  };

  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cms-event": "cms.test",
        "x-cms-delivery": base.id,
        ...(target.secret ? { "x-cms-signature": await createHmacSignature(target.secret, body) } : {})
      },
      body,
      signal: controller.signal
    });
    const responseBody = redact(await response.text());
    return {
      ...base,
      status: response.ok ? "success" : "failed",
      responseStatus: response.status,
      responseBody
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      error: error instanceof Error ? error.message : "unknown delivery error"
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function retryWebhookDelivery(options: {
  store: WebhookStore;
  jobs?: { enqueue?(endpoint: string, body?: unknown, options?: { delay?: number }): Promise<void> } | null;
  deliveryId: string;
  timeoutMs?: number;
}): Promise<{ skipped?: true; reason?: string; success?: true; retrying?: true; failed?: true; attempt?: number; delay?: number }> {
  const delivery = await options.store.getDelivery?.(options.deliveryId);
  if (!delivery) return { skipped: true, reason: "not_found" };
  if (delivery.status === "success" || delivery.status === "failed") return { skipped: true, reason: delivery.status };

  const attempt = delivery.attempt + 1;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetch(delivery.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cms-delivery": delivery.id },
      body: delivery.requestBody,
      signal: controller.signal
    });
    const responseBody = redact(await response.text());
    if (response.ok) {
      await options.store.updateDelivery?.(delivery.id, {
        attempt,
        status: "success",
        responseStatus: response.status,
        responseBody,
        nextAttemptAt: undefined,
        error: undefined
      });
      return { success: true, attempt };
    }
    return await recordRetryFailure(options, delivery, attempt, { responseStatus: response.status, responseBody });
  } catch (error) {
    return await recordRetryFailure(options, delivery, attempt, { error: error instanceof Error ? error.message : "unknown delivery error" });
  } finally {
    clearTimeout(timeout);
  }
}

export async function retryFailedWebhookDelivery(options: {
  store: WebhookStore;
  webhook: WebhookRecord;
  deliveryId: string;
  timeoutMs?: number;
}): Promise<WebhookDelivery | Response> {
  const delivery = await options.store.getDelivery?.(options.deliveryId);
  if (!delivery || delivery.webhookId !== options.webhook.id) return Response.json({ error: "not_found" }, { status: 404 });
  if (delivery.status !== "failed") return Response.json({ error: "delivery_not_failed" }, { status: 409 });

  const attempt = delivery.attempt + 1;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetch(delivery.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cms-delivery": delivery.id,
        ...(options.webhook.secret ? { "x-cms-signature": await createHmacSignature(options.webhook.secret, delivery.requestBody) } : {})
      },
      body: delivery.requestBody,
      signal: controller.signal
    });
    const responseBody = redact(await response.text());
    return await options.store.updateDelivery?.(delivery.id, {
      attempt,
      status: response.ok ? "success" : "failed",
      responseStatus: response.status,
      responseBody,
      error: undefined,
      nextAttemptAt: undefined
    }) ?? delivery;
  } catch (error) {
    return await options.store.updateDelivery?.(delivery.id, {
      attempt,
      status: "failed",
      error: error instanceof Error ? error.message : "unknown delivery error",
      nextAttemptAt: undefined
    }) ?? delivery;
  } finally {
    clearTimeout(timeout);
  }
}

export function nextWebhookRetryDelay(attempt: number): number {
  if (attempt <= 1) return 30;
  if (attempt === 2) return 300;
  return 3600;
}

export async function createHmacSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const hash = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function matchesEventPattern(event: string, pattern: string): boolean {
  const eventSegments = event.trim().split(".").filter(Boolean);
  const patternSegments = pattern.trim().split(".").filter(Boolean);
  if (eventSegments.length === 0 || patternSegments.length === 0) return false;
  return matchEventSegments(eventSegments, patternSegments);
}

function matchEventSegments(eventSegments: readonly string[], patternSegments: readonly string[]): boolean {
  if (patternSegments.length === 0) return eventSegments.length === 0;
  const [patternHead, ...patternTail] = patternSegments;
  if (patternHead === "**") {
    return matchEventSegments(eventSegments, patternTail)
      || (eventSegments.length > 0 && matchEventSegments(eventSegments.slice(1), patternSegments));
  }
  const [eventHead, ...eventTail] = eventSegments;
  if (!eventHead) return false;
  return (patternHead === "*" || patternHead === eventHead) && matchEventSegments(eventTail, patternTail);
}

export function serializeWebhook(record: WebhookRecord): Omit<WebhookRecord, "secret"> & { secret?: "****" } {
  const { secret, ...safe } = record;
  return secret ? { ...safe, secret: "****" } : safe;
}

function redact(value: string): string {
  return value.replace(/(token|secret|password)["':=\s]+[^"',\s}]+/gi, "$1=REDACTED").slice(0, 2048);
}

async function recordRetryFailure(
  options: {
    store: WebhookStore;
    jobs?: { enqueue?(endpoint: string, body?: unknown, options?: { delay?: number }): Promise<void> } | null;
    deliveryId: string;
  },
  delivery: WebhookDelivery,
  attempt: number,
  patch: Pick<Partial<WebhookDelivery>, "responseStatus" | "responseBody" | "error">
): Promise<{ retrying?: true; failed?: true; attempt: number; delay?: number }> {
  if (attempt >= 3) {
    await options.store.updateDelivery?.(delivery.id, {
      ...patch,
      attempt,
      status: "failed",
      nextAttemptAt: undefined
    });
    return { failed: true, attempt };
  }
  const delay = nextWebhookRetryDelay(attempt);
  await options.store.updateDelivery?.(delivery.id, {
    ...patch,
    attempt,
    status: "retrying",
    nextAttemptAt: new Date(Date.now() + delay * 1000).toISOString()
  });
  await options.jobs?.enqueue?.("/cms/jobs/webhook-retry", { deliveryId: delivery.id }, { delay });
  return { retrying: true, attempt, delay };
}
