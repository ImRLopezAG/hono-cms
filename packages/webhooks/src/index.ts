/**
 * `@hono-cms/webhooks`
 *
 * Plugin that owns webhook management, dispatch, retry, and cleanup.
 * Carved out of `@hono-cms/core` per
 * `docs/plans/2026-05-25-001-refactor-plugin-system-architecture-plan.md`
 * §U17.
 *
 * Compose with `@hono-cms/jobs-runtime` — the plugin enforces this via
 * `requires: ["jobs"]` so installation fails fast if the runtime is
 * absent.
 *
 * ## Replay protection (receiver-side)
 *
 * Every delivery carries:
 * - `X-Timestamp`: Unix epoch milliseconds (string).
 * - `X-CMS-Signature`: `sha256=<hex>` HMAC over `${timestamp}.${rawBody}`.
 *
 * Receivers MUST reconstruct the signed payload exactly and reject any
 * delivery whose timestamp is older than the configured `replayWindowMs`
 * (default 5 minutes). The dispatcher does **not** enforce this window —
 * it's an out-of-band contract receivers honour. Skip the check and a
 * leaked transcript can be replayed for any age.
 *
 * Example verification (Node 18+ / Workers):
 * ```ts
 * const timestamp = request.headers.get("x-timestamp");
 * const signature = request.headers.get("x-cms-signature");
 * const body = await request.text();
 * if (!timestamp || Date.now() - Number(timestamp) > 5 * 60 * 1000) {
 *   return new Response("stale", { status: 401 });
 * }
 * const expected = await signTimestampedBody(SECRET, timestamp, body);
 * if (expected !== signature) {
 *   return new Response("bad signature", { status: 401 });
 * }
 * ```
 */
export {
  webhooks,
  WEBHOOKS_PLUGIN_ID,
  type WebhooksConfig,
  type WebhooksService
} from "./plugin";

export { MemoryWebhookStore } from "./store/memory";
export { createHmacSignature, buildSignedPayload, signTimestampedBody } from "./signing";
export {
  deliverWebhook,
  deliverWebhookTest,
  matchesEventPattern,
  nextWebhookRetryDelay,
  resolveTargets,
  serializeWebhook
} from "./dispatch";
export { runWebhookRetrySweep } from "./retry";
export { webhookDeliveryCleanupJob } from "./cleanup";
export { webhooksTable, webhookDeliveriesTable } from "./tables";
export { mountWebhookRoutes } from "./routes";
export type {
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEvent,
  WebhookRecord,
  WebhookRecordAttemptInput,
  WebhookStore,
  WebhookTarget
} from "./types";
