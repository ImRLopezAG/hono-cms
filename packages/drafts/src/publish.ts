import {
  publishDocument as corePublishDocument,
  unpublishDocument as coreUnpublishDocument,
  type CMSEvents,
  type Identity,
  type PluginEvents
} from "@hono-cms/core";
import type { CMSCollections, ContentRecord, DatabaseAdapter } from "@hono-cms/schema";

/**
 * Publish a single document and emit `content:after-publish` on success.
 *
 * Wraps the primitive `publishDocument` state-transition helper that stays in
 * `@hono-cms/core` (since the content REST routes still need to call it on
 * create-with-status flows). The plugin adds the event-bus emission so audit,
 * webhooks, and any other downstream subscriber observe the state change.
 *
 * Identity + request are passed through to the event payload so listeners can
 * record actor metadata. Both are accepted as `null` for non-request-driven
 * invocations (e.g. the scheduled-publish job).
 */
export async function publishDocument<Collections extends CMSCollections>(args: {
  db: DatabaseAdapter<Collections>;
  events: PluginEvents;
  collection: keyof Collections & string;
  id: string;
  identity?: Identity | null;
  request?: Request | null;
  now?: Date;
}): Promise<ContentRecord> {
  const record = await corePublishDocument(args.db, args.collection, args.id, args.now ?? new Date());
  const payload: CMSEvents["content:after-publish"] = {
    collection: args.collection,
    record,
    identity: args.identity ?? null,
    request: args.request ?? new Request("https://hono-cms.local/internal/publish")
  };
  await args.events.emit("content:after-publish", payload);
  return record;
}

/**
 * Unpublish a document and emit `content:after-unpublish` on success.
 *
 * Sibling of {@link publishDocument} — same event-emission rationale.
 */
export async function unpublishDocument<Collections extends CMSCollections>(args: {
  db: DatabaseAdapter<Collections>;
  events: PluginEvents;
  collection: keyof Collections & string;
  id: string;
  identity?: Identity | null;
  request?: Request | null;
}): Promise<ContentRecord> {
  const record = await coreUnpublishDocument(args.db, args.collection, args.id);
  const payload: CMSEvents["content:after-unpublish"] = {
    collection: args.collection,
    record,
    identity: args.identity ?? null,
    request: args.request ?? new Request("https://hono-cms.local/internal/unpublish")
  };
  await args.events.emit("content:after-unpublish", payload);
  return record;
}
