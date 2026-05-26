/**
 * Domain types for the webhooks plugin.
 *
 * Re-exported from `@hono-cms/core` for the duration of the refactor so
 * existing core code (which still owns adapter integration paths)
 * continues to compile. Once the carve completes (Plan U-final) the
 * types will live exclusively in this package and core will import them
 * from here — at which point this file becomes the source of truth.
 */
export type {
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEvent,
  WebhookRecord,
  WebhookRecordAttemptInput,
  WebhookStore,
  WebhookTarget
} from "@hono-cms/core";
