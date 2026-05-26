import { runScheduledPublishes, type CacheAdapter } from "@hono-cms/core";
import type { CMSCollections, ContentRecord, DatabaseAdapter } from "@hono-cms/schema";

/**
 * Promote every draft record whose `publishedAt` is `<= now` to
 * `status: "published"`, and invalidate any cached content list/get keys
 * for the touched collection.
 *
 * Extracted from `packages/core/src/create-cms.ts` (the legacy inline
 * `publishDueScheduledContent` helper) so the jobs-runtime plugin owns the
 * scheduled-publish job lifecycle.
 *
 * Cache invalidation is intentionally a `cache?: CacheAdapter` parameter
 * (not a `PluginServices` lookup) so this helper stays usable from anywhere —
 * tests pass `null`, the plugin resolves it from `ctx.plugins.get("cache")`
 * when the cache plugin is installed.
 */
export async function runScheduledPublish<Collections extends CMSCollections>(
  input: {
    db: DatabaseAdapter<Collections>;
    collections: Collections;
    cache?: CacheAdapter | null | undefined;
    now?: Date | undefined;
  }
): Promise<{ published: number; records: ContentRecord[] }> {
  const now = input.now ?? new Date();
  const records = await runScheduledPublishes(input.db, input.collections, now);
  if (records.length && input.cache) {
    // `ContentRecord` doesn't carry its source collection so we invalidate
    // every draft-aware collection — same fan-out the legacy core helper
    // (`publishDueScheduledContent`) used. Cheap because invalidation just
    // bumps a version stamp per collection.
    const draftAware = Object.keys(input.collections).filter(
      (name) => input.collections[name]?.options.draftAndPublish
    );
    await Promise.all(
      draftAware.map((name) => invalidateContentCacheForCollection(input.cache!, name))
    );
  }
  return { published: records.length, records };
}

async function invalidateContentCacheForCollection(cache: CacheAdapter, collection: string): Promise<void> {
  // Mirrors the version-bump strategy in `@hono-cms/core/content/cache.ts`
  // (see `invalidateContentCache`) — content cache entries are keyed by the
  // current version stamp, so writing a fresh stamp invalidates every cached
  // response for the collection without needing pattern deletion.
  await cache.set(`content-cache-version:${collection}`, crypto.randomUUID());
}
