import type { PluginTableDef } from "@hono-cms/core";

/**
 * Schema declaration for the `webhooks` table — managed webhook targets
 * created through the admin UI.
 *
 * Row reads/writes flow through the configured {@link WebhookStore}; the
 * declaration lives here purely for the kernel's migration surface so
 * `@hono-cms/schema` can emit DDL when the user opts into Drizzle-backed
 * stores.
 */
export const webhooksTable: PluginTableDef = {
  modelName: "Webhook",
  fields: {
    id: { type: "string", required: true, unique: true },
    name: { type: "string", required: true },
    url: { type: "string", required: true },
    secret: { type: "string" },
    events: { type: "json", required: true },
    enabled: { type: "boolean", required: true },
    createdAt: { type: "date", required: true },
    updatedAt: { type: "date", required: true }
  }
};

/**
 * Schema declaration for the `webhook_deliveries` table — one row per
 * dispatched delivery attempt, used for the admin "Deliveries" tab and
 * for the cron-driven retry sweep.
 */
export const webhookDeliveriesTable: PluginTableDef = {
  modelName: "WebhookDelivery",
  fields: {
    id: { type: "string", required: true, unique: true },
    webhookId: { type: "string" },
    eventType: { type: "string", required: true },
    url: { type: "string", required: true },
    attempt: { type: "number", required: true },
    status: { type: "string", required: true },
    requestBody: { type: "string", required: true },
    responseStatus: { type: "number" },
    responseBody: { type: "string" },
    error: { type: "string" },
    nextAttemptAt: { type: "date" },
    createdAt: { type: "date", required: true }
  }
};
