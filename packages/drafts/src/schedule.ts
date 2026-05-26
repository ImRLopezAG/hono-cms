import {
  schedulePublish as coreSchedulePublish,
  unschedulePublish as coreUnschedulePublish,
  type PluginEvents
} from "@hono-cms/core";
import type { CMSCollections, ContentRecord, DatabaseAdapter } from "@hono-cms/schema";
import { publishDocument } from "./publish";

/**
 * Set a future `publishedAt` on a draft so the scheduled-publish job promotes
 * it once due. Pure state mutation — no events fire at scheduling time;
 * `content:after-publish` only emits when the job actually flips the row.
 *
 * Thin wrapper over the core primitive so the plugin exposes a single import
 * surface for callers that don't want to reach into `@hono-cms/core` directly.
 */
export async function schedulePublish<Collections extends CMSCollections>(args: {
  db: DatabaseAdapter<Collections>;
  collection: keyof Collections & string;
  id: string;
  publishAt: Date;
}): Promise<ContentRecord> {
  return coreSchedulePublish(args.db, args.collection, args.id, args.publishAt);
}

/**
 * Cancel a previously-scheduled publish by clearing `publishedAt`. The
 * document remains a draft. No events fire — the schedule never took effect.
 */
export async function unschedulePublish<Collections extends CMSCollections>(args: {
  db: DatabaseAdapter<Collections>;
  collection: keyof Collections & string;
  id: string;
}): Promise<ContentRecord> {
  return coreUnschedulePublish(args.db, args.collection, args.id);
}

/**
 * Job body for the `scheduled-publish` job: scan every draft-and-publish-
 * enabled collection for rows whose `publishedAt <= now`, promote each via
 * {@link publishDocument} (which emits `content:after-publish`), and return
 * the list of records promoted on this tick.
 *
 * Mirrors `runScheduledPublishes` from `@hono-cms/core` but routes each
 * promotion through the plugin's `publishDocument` so subscribers (audit,
 * webhooks, content-cache) observe the same events they'd see for a manual
 * publish call.
 */
export async function runScheduledPublishes<Collections extends CMSCollections>(args: {
  db: DatabaseAdapter<Collections>;
  collections: Collections;
  events: PluginEvents;
  now?: Date;
  limit?: number;
}): Promise<ContentRecord[]> {
  const now = args.now ?? new Date();
  const limit = args.limit ?? 100;
  const published: ContentRecord[] = [];
  for (const [collectionName, collection] of Object.entries(args.collections)) {
    if (!collection?.options.draftAndPublish) continue;
    const due = await args.db.list(collectionName as keyof Collections & string, {
      status: "draft",
      filters: { publishedAt: { $lte: now.toISOString() } },
      limit
    });
    for (const record of due.items) {
      if (published.length >= limit) return published;
      const promoted = await publishDocument({
        db: args.db,
        events: args.events,
        collection: collectionName as keyof Collections & string,
        id: record.id,
        now
      });
      published.push(promoted);
    }
  }
  return published;
}
