import type { WebhookStore } from "./types";

/**
 * Delete `webhook_deliveries` rows older than `retentionDays`. Registered
 * as the `webhook-delivery-cleanup` job.
 *
 * Ported from `packages/core/src/webhooks.ts`. Returns `{ deletedCount,
 * olderThan }` so cron logs surface what was pruned.
 *
 * Setting `retentionDays` to `0` (or a negative number) disables the
 * cleanup — useful for compliance scenarios that need permanent audit of
 * webhook attempts.
 */
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
