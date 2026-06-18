import { createPlugin, type CMSEvents, type Plugin } from "@hono-cms/core";
import { MemoryWebhookStore } from "./store/memory";
import { webhookDeliveriesTable, webhooksTable } from "./tables";
import {
  deliverWebhook,
  resolveTargets
} from "./dispatch";
import { runWebhookRetrySweep } from "./retry";
import { webhookDeliveryCleanupJob } from "./cleanup";
import { mountWebhookRoutes } from "./routes";
import type { WebhookEvent, WebhookRecord, WebhookStore, WebhookTarget } from "./types";

/** Plugin id under which the webhooks service self-registers. */
export const WEBHOOKS_PLUGIN_ID = "webhooks";

export type WebhooksConfig = {
  /**
   * Persistent storage for managed webhook targets + delivery history.
   * Defaults to an in-process {@link MemoryWebhookStore} which is safe
   * for development and tests but loses state on restart.
   */
  store?: WebhookStore;
  /**
   * Statically-declared targets that fire alongside any managed
   * webhooks. Useful for "this deployment always pings my Slack" style
   * defaults that should survive admin tampering.
   */
  targets?: readonly WebhookTarget[];
  /**
   * Retention window (days) for delivery rows. The
   * `webhook-delivery-cleanup` cron prunes anything older. Default 30.
   * Set to `0` to disable cleanup.
   */
  deliveryRetentionDays?: number;
  /**
   * Receiver-side replay window in milliseconds. NOT enforced by the
   * dispatcher (the timestamp goes out on every request via
   * `X-Timestamp`); receivers SHOULD reject deliveries whose
   * `X-Timestamp` is older than this window. Default 5 minutes.
   *
   * Documented in `README.md` so receiver implementers can wire the
   * check correctly.
   */
  replayWindowMs?: number;
  /** HTTP timeout (ms) for each delivery attempt. Default 10s. */
  timeoutMs?: number;
};

/** Service exposed on the plugin registry under id `"webhooks"`. */
export type WebhooksService = {
  /** Backing store handle for downstream plugins / admin tooling. */
  readonly store: WebhookStore;
  /** The static targets configured at install time. */
  readonly targets: readonly WebhookTarget[];
};

/**
 * Build the webhooks plugin.
 *
 * Composition contract:
 * - **Requires `@hono-cms/jobs-runtime`** — without it there is no
 *   `JobsService` on the registry and the plugin throws during install.
 * - **Fast-path event handlers (R17)** — subscribers to
 *   `content:after-*` and `media:after-*` resolve matching targets and
 *   enqueue one `webhook-deliver` job per target. They do *not* perform
 *   HTTP I/O on the request path; the actual delivery runs inside the
 *   job handler so a slow receiver cannot stall the mutation response.
 * - **Jobs** registered via `JobsService.registerJob`:
 *   - `webhook-deliver`: perform a single HTTP delivery + persist the row.
 *   - `webhook-retry-sweep`: scan `listPendingRetries` and re-attempt.
 *   - `webhook-delivery-cleanup`: prune rows older than retention.
 *
 * Example:
 * ```ts
 * createCMS({
 *   plugins: [
 *     jobsRuntime({ adapter: memoryJobs({}) }),
 *     webhooks({ targets: [{ url: "https://example.com/hook", events: ["content.*"] }] })
 *   ]
 * });
 * ```
 */
export function webhooks(opts: WebhooksConfig = {}): Plugin {
  const store = opts.store ?? new MemoryWebhookStore();
  const staticTargets = opts.targets ?? [];
  const deliveryRetentionDays = opts.deliveryRetentionDays ?? 30;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return createPlugin({
    id: WEBHOOKS_PLUGIN_ID,
    requires: ["jobs"],

    schema: {
      webhooks: webhooksTable,
      webhook_deliveries: webhookDeliveriesTable
    },

    app(app, ctx) {
      // Surface the service handle so other plugins / admin tooling can
      // reach the store without re-importing the package.
      ctx.plugins.register(WEBHOOKS_PLUGIN_ID, {
        store,
        targets: staticTargets
      } satisfies WebhooksService);

      const jobs = ctx.plugins.get("jobs");

      // -- Jobs --------------------------------------------------------------

      // `webhook-deliver` performs the actual HTTP I/O. It is the fast-path
      // handler's only output: subscribers enqueue exactly one job per
      // matching target with a fully-resolved {@link WebhookRecord} so the
      // worker never needs to re-read the store on the request path.
      jobs.registerJob("webhook-deliver", async (payload) => {
        const parsed = parseDeliverPayload(payload);
        if (!parsed) {
          console.warn("[hono-cms/webhooks] webhook-deliver payload missing target or event; skipping.");
          return;
        }
        const delivery = await deliverWebhook(parsed.target, parsed.event, timeoutMs, parsed.webhookId);
        await store.appendDelivery(delivery);
        if (delivery.status === "retrying") {
          // Schedule the next attempt through the jobs adapter. The
          // sweep-fallback covers deployments without on-demand enqueue.
          try {
            await jobs.enqueue("/cms/jobs/webhook-retry-sweep", {}, { delay: 30 });
          } catch (error) {
            console.warn(`[hono-cms/webhooks] jobs.enqueue(webhook-retry-sweep) failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      });

      // `webhook-retry-sweep` drains overdue rows from the store and
      // re-attempts each. Safe to run repeatedly; no-op when nothing is due.
      jobs.registerJob("webhook-retry-sweep", async () => {
        await runWebhookRetrySweep({
          store,
          staticTargets,
          timeoutMs
        });
      });

      // `webhook-delivery-cleanup` prunes delivery rows older than retention.
      jobs.registerJob("webhook-delivery-cleanup", async () => {
        await webhookDeliveryCleanupJob({
          store,
          retentionDays: deliveryRetentionDays
        });
      });

      // -- Event subscriptions (R17 fast handlers) ---------------------------

      const FORWARDED_EVENTS = [
        "content:after-create",
        "content:after-update",
        "content:after-delete",
        "content:after-publish",
        "content:after-unpublish",
        "media:after-upload",
        "media:after-delete"
      ] as const satisfies readonly (keyof CMSEvents)[];

      for (const eventName of FORWARDED_EVENTS) {
        ctx.events.on(eventName, async (payload) => {
          const webhookEvent = toWebhookEvent(eventName, payload);
          const targets = await resolveTargets(webhookEvent, store, staticTargets);
          // Enqueue one delivery job per target. Concurrent fan-out is
          // fine here because each job is independent and the adapter
          // serialises them however it wants. On adapters without
          // `enqueue` (memory) the runtime dispatches in-process.
          await Promise.all(targets.map((entry) => jobs.enqueue("/cms/jobs/webhook-deliver", {
            target: entry.record,
            webhookId: entry.webhookId,
            event: webhookEvent
          }).catch((error) => {
            console.warn(`[hono-cms/webhooks] jobs.enqueue(webhook-deliver) failed for target ${entry.record.id}: ${error instanceof Error ? error.message : String(error)}`);
          })));
        });
      }

      // -- HTTP surface ------------------------------------------------------

      mountWebhookRoutes(app, store);
    }
  });
}

/**
 * Translate a kernel `CMSEvents` payload into the `WebhookEvent` shape
 * the delivery body envelope expects.
 *
 * The kernel uses dotted event names with namespacing (`content:after-*`
 * vs `media:after-*`); we normalise them to a single dotted form
 * (`content.after-*`) so glob patterns like `content.*` and `**` continue
 * to match across the carve.
 */
function toWebhookEvent(eventName: keyof CMSEvents, payload: unknown): WebhookEvent {
  const type = eventName.replace(":", ".");
  const base: WebhookEvent = {
    type,
    timestamp: new Date().toISOString()
  };
  if (!payload || typeof payload !== "object") return base;
  const data = payload as Record<string, unknown>;
  if (typeof data.collection === "string") base.collection = data.collection;
  if (typeof data.requestId === "string") base.requestId = data.requestId;
  if ("record" in data && data.record && typeof data.record === "object") {
    base.record = data.record as NonNullable<WebhookEvent["record"]>;
  }
  if ("before" in data) {
    if (data.before === null) base.previous = null;
    else if (typeof data.before === "object") base.previous = data.before as NonNullable<WebhookEvent["previous"]>;
  }
  return base;
}

function parseDeliverPayload(payload: unknown): { target: WebhookRecord; webhookId: string | null; event: WebhookEvent } | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  const target = data.target as WebhookRecord | undefined;
  const event = data.event as WebhookEvent | undefined;
  if (!target || !event || typeof target.url !== "string" || typeof event.type !== "string") return null;
  const webhookId = typeof data.webhookId === "string" ? data.webhookId : null;
  return { target, webhookId, event };
}
