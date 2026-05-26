import type { WebhookDelivery, WebhookRecord, WebhookStore, WebhookTarget } from "./types";
import { signTimestampedBody } from "./signing";
import { nextWebhookRetryDelay } from "./dispatch";

/**
 * Sweep persisted webhook deliveries that are ready to retry
 * (`status === "retrying"` and `nextAttemptAt <= now`) and re-attempt each.
 *
 * Registered as both a job runner (`webhook-retry-sweep`) and as a cron
 * endpoint so it works on every deployment topology:
 * - QStash / Cloudflare Queue: cron also runs, but on-demand enqueue is preferred.
 * - Vercel cron-only / Cloudflare without Queue: cron is the only retry path.
 * - Memory jobs adapter: the scheduled handler triggers it.
 *
 * Ported verbatim from `packages/core/src/webhooks.ts`.
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
    // The signed payload binds the *original* request body to a *fresh*
    // timestamp so receivers' replay window applies to the re-delivery
    // attempt (not the original creation time).
    const timestamp = String(Date.now());
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-cms-event": delivery.eventType,
      "x-cms-delivery": delivery.id,
      "x-timestamp": timestamp
    };
    if (secret) {
      headers["x-cms-signature"] = await signTimestampedBody(secret, timestamp, delivery.requestBody);
    }
    const response = await fetch(delivery.url, {
      method: "POST",
      headers,
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

function redact(value: string): string {
  return value.replace(/(token|secret|password)["':=\s]+[^"',\s}]+/gi, "$1=REDACTED").slice(0, 2048);
}
