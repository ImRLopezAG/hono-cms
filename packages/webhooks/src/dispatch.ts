import type {
  WebhookDelivery,
  WebhookEvent,
  WebhookRecord,
  WebhookStore,
  WebhookTarget
} from "./types";
import { signTimestampedBody } from "./signing";

/**
 * Glob-style event pattern matching. Supports:
 * - `*`  — single segment wildcard
 * - `**` — zero-or-more segments wildcard
 *
 * Ported from `packages/core/src/webhooks.ts`.
 */
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

/**
 * Strip the `secret` field from a webhook record before serialising to
 * the wire. The replacement `"****"` token signals "set" without leaking
 * the value.
 */
export function serializeWebhook(record: WebhookRecord): Omit<WebhookRecord, "secret"> & { secret?: "****" } {
  const { secret, ...safe } = record;
  return secret ? { ...safe, secret: "****" } : safe;
}

/**
 * Resolve every webhook target that should fire for `event`. Static
 * targets (declared at install time) and managed targets (created via
 * the admin API) are both candidates; only enabled targets whose event
 * patterns match are returned.
 *
 * Used by the plugin's fast-path event handler to fan out one
 * `webhook-deliver` job per matching target without performing any HTTP
 * I/O — R17 in the plan.
 */
export async function resolveTargets(
  event: WebhookEvent,
  store: WebhookStore | null,
  staticTargets: readonly WebhookTarget[]
): Promise<Array<{ record: WebhookRecord; webhookId: string | null }>> {
  const staticOnes = staticTargets.map((target, index) => {
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
    return { record, webhookId: null as string | null };
  });
  const managed = (await store?.listWebhooks() ?? []).map((record) => ({ record, webhookId: record.id }));
  return [...staticOnes, ...managed]
    .filter((entry) => entry.record.enabled)
    .filter((entry) => entry.record.events.some((pattern) => matchesEventPattern(event.type, pattern)));
}

export type DeliverOutcome = WebhookDelivery;

/**
 * Perform a single HTTP delivery attempt and return the resulting
 * {@link WebhookDelivery} row. The caller is responsible for persisting
 * it (via `store.appendDelivery`) and for scheduling a retry.
 *
 * The delivery body envelope: `{ id, event, data, timestamp }` where
 * `id` is a fresh UUID used as the `X-CMS-Delivery` header and the
 * stable correlation id for retries.
 *
 * Signature scheme (R17 / Stripe-style):
 *   sig = HMAC-SHA256(secret, `${timestampMs}.${rawBody}`)
 *
 * Receivers MUST reconstruct the signed payload exactly and reject
 * deliveries whose `X-Timestamp` is older than the configured
 * `replayWindowMs` (default 5 minutes).
 */
export async function deliverWebhook(
  target: WebhookRecord,
  event: WebhookEvent,
  timeoutMs = 10_000,
  webhookId: string | null = target.id
): Promise<WebhookDelivery> {
  const timestampMs = Date.now();
  const timestamp = String(timestampMs);
  const body = JSON.stringify({
    id: crypto.randomUUID(),
    event: event.type,
    data: event,
    timestamp: new Date(timestampMs).toISOString()
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const createdAt = new Date(timestampMs).toISOString();
  const base = {
    id: crypto.randomUUID(),
    webhookId,
    eventType: event.type,
    url: target.url,
    attempt: 1,
    requestBody: body,
    createdAt
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-cms-event": event.type,
    "x-cms-delivery": base.id,
    "x-timestamp": timestamp
  };
  if (target.secret) {
    headers["x-cms-signature"] = await signTimestampedBody(target.secret, timestamp, body);
  }

  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers,
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

/**
 * Synthetic-event delivery for the `POST /cms/settings/webhooks/:id/test`
 * endpoint. Marks failed responses as `failed` (not `retrying`) — tests
 * should not enter the retry pipeline.
 */
export async function deliverWebhookTest(target: WebhookRecord, event: WebhookEvent, timeoutMs = 10_000): Promise<WebhookDelivery> {
  const timestampMs = Date.now();
  const timestamp = String(timestampMs);
  const body = JSON.stringify({
    id: crypto.randomUUID(),
    event: "cms.test",
    data: event,
    timestamp: new Date(timestampMs).toISOString()
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const createdAt = new Date(timestampMs).toISOString();
  const base = {
    id: crypto.randomUUID(),
    webhookId: target.id,
    eventType: "cms.test",
    url: target.url,
    attempt: 1,
    requestBody: body,
    createdAt
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-cms-event": "cms.test",
    "x-cms-delivery": base.id,
    "x-timestamp": timestamp
  };
  if (target.secret) {
    headers["x-cms-signature"] = await signTimestampedBody(target.secret, timestamp, body);
  }

  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers,
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

/**
 * Backoff schedule (seconds) for failed deliveries. Three attempts then
 * permanent failure: 30s → 5m → 1h.
 */
export function nextWebhookRetryDelay(attempt: number): number {
  if (attempt <= 1) return 30;
  if (attempt === 2) return 300;
  return 3600;
}

function redact(value: string): string {
  return value.replace(/(token|secret|password)["':=\s]+[^"',\s}]+/gi, "$1=REDACTED").slice(0, 2048);
}
