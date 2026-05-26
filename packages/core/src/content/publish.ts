import type { CMSCollections, ContentRecord, DatabaseAdapter } from "@hono-cms/schema";

export type PublishOperation = "publish" | "unpublish" | "schedule" | "unschedule";

export function stripSystemDraftFields(input: Record<string, unknown>): Record<string, unknown> {
  const { status: _status, publishedAt: _publishedAt, published_at: _published_at, ...rest } = input;
  return rest;
}

export function normalizeDraftInput(enabled: boolean | undefined, input: Record<string, unknown>): Record<string, unknown> {
  const stripped = stripSystemDraftFields(input);
  return enabled ? { ...stripped, status: "draft" } : stripped;
}

export async function publishDocument<Collections extends CMSCollections>(
  adapter: DatabaseAdapter<Collections>,
  collection: keyof Collections & string,
  id: string,
  now: Date = new Date()
): Promise<ContentRecord> {
  const existing = await adapter.get(collection, id);
  if (!existing) throw new Error(`Record "${id}" was not found in "${collection}".`);
  if (existing.status === "published") return existing;
  if (adapter.publish) return adapter.publish(collection, id);
  return adapter.update(collection, id, { status: "published", publishedAt: now.toISOString() });
}

export async function unpublishDocument<Collections extends CMSCollections>(
  adapter: DatabaseAdapter<Collections>,
  collection: keyof Collections & string,
  id: string
): Promise<ContentRecord> {
  const existing = await adapter.get(collection, id);
  if (!existing) throw new Error(`Record "${id}" was not found in "${collection}".`);
  if (existing.status === "draft" && !existing.publishedAt && !existing.published_at) return existing;
  if (adapter.unpublish) return adapter.unpublish(collection, id);
  return adapter.update(collection, id, { status: "draft", publishedAt: null, published_at: null });
}

export async function schedulePublish<Collections extends CMSCollections>(
  adapter: DatabaseAdapter<Collections>,
  collection: keyof Collections & string,
  id: string,
  publishAt: Date
): Promise<ContentRecord> {
  if (Number.isNaN(publishAt.valueOf())) throw new Error("Invalid publishAt value.");
  return adapter.update(collection, id, { status: "draft", publishedAt: publishAt.toISOString() });
}

export async function unschedulePublish<Collections extends CMSCollections>(
  adapter: DatabaseAdapter<Collections>,
  collection: keyof Collections & string,
  id: string
): Promise<ContentRecord> {
  return adapter.update(collection, id, { publishedAt: null, published_at: null });
}

export async function runScheduledPublishes<Collections extends CMSCollections>(
  adapter: DatabaseAdapter<Collections>,
  collections: Collections,
  now: Date = new Date(),
  limit = 100
): Promise<ContentRecord[]> {
  const published: ContentRecord[] = [];
  for (const [collectionName, collection] of Object.entries(collections)) {
    if (!collection.options.draftAndPublish) continue;
    const due = await adapter.list(collectionName as keyof Collections & string, {
      status: "draft",
      filters: { publishedAt: { $lte: now.toISOString() } },
      limit
    });
    for (const record of due.items) {
      if (published.length >= limit) return published;
      published.push(await publishDocument(adapter, collectionName as keyof Collections & string, record.id, now));
    }
  }
  return published;
}
