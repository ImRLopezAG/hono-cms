import type { CacheAdapter, PluginContext } from "@hono-cms/core";
import { invalidateContentCache } from "./middleware";

/**
 * Event names that should invalidate the per-collection content cache.
 *
 * Centralised here so that `subscribeInvalidationEvents` and tests stay in
 * lock-step. New content events added to the kernel's `CMSEvents` map only
 * need to be appended here for the plugin to react.
 */
export const INVALIDATING_EVENTS = [
  "content:after-create",
  "content:after-update",
  "content:after-delete",
  "content:after-publish",
  "content:after-unpublish"
] as const;

export type InvalidatingEvent = (typeof INVALIDATING_EVENTS)[number];

/**
 * Wire the cache invalidation handlers onto the plugin context's event bus.
 * Returns a teardown function that detaches every subscription — handy for
 * tests that install + uninstall the plugin between cases.
 */
export function subscribeInvalidationEvents(
  ctx: PluginContext,
  cache: CacheAdapter,
  keyPrefix: string
): () => void {
  const unsubscribes = INVALIDATING_EVENTS.map((event) =>
    ctx.events.on(event, async (payload) => {
      // Every event in `INVALIDATING_EVENTS` carries a `collection: string`,
      // so the cast below is safe — but we widen to a tolerant shape so a
      // misfire (e.g. payload missing fields) doesn't crash the bus.
      const collection = (payload as { collection?: unknown }).collection;
      if (typeof collection !== "string" || collection.length === 0) return;
      await invalidateContentCache(cache, keyPrefix, collection);
    })
  );

  return () => {
    for (const off of unsubscribes) off();
  };
}
