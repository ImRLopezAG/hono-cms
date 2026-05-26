import type { Hono } from "hono";
import type { AuthSession, HonoCMSEnv } from "@hono-cms/core";
import { deliverWebhookTest, serializeWebhook } from "./dispatch";
import type { WebhookDelivery, WebhookRecord, WebhookStore } from "./types";

/**
 * Mount the `/cms/settings/webhooks/*` admin surface on `app`.
 *
 * Routes:
 * - `GET    /cms/settings/webhooks`                  — list managed targets
 * - `POST   /cms/settings/webhooks`                  — create a managed target
 * - `PATCH  /cms/settings/webhooks/:id`              — partial update
 * - `PUT    /cms/settings/webhooks/:id`              — full update
 * - `DELETE /cms/settings/webhooks/:id`              — remove target
 * - `GET    /cms/settings/webhooks/:id/deliveries`   — paginated delivery history
 * - `POST   /cms/settings/webhooks/:id/test`         — fire a synthetic `cms.test`
 *
 * Authorisation: all routes are admin-only. Sessions are pulled from
 * `c.get("session")`, which the kernel populates before the plugin's
 * routes run.
 */
export function mountWebhookRoutes(app: Hono<HonoCMSEnv>, store: WebhookStore): void {
  app.get("/cms/settings/webhooks", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const webhooks = await store.listWebhooks();
    const deliveries = await store.listDeliveries({ limit: 200 });
    return Response.json({
      items: webhooks.map((webhook) => serializeWebhookListItem(webhook, deliveries.items.find((delivery) => delivery.webhookId === webhook.id))),
      meta: { total: webhooks.length }
    });
  });

  app.post("/cms/settings/webhooks", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const body = await context.req.json<{ name: string; url: string; secret?: string; events?: string[]; enabled?: boolean }>();
    const validation = validateWebhookInput(body);
    if (validation) return validation;
    const input: { name: string; url: string; secret?: string; events: string[]; enabled: boolean } = {
      name: body.name.trim(),
      url: body.url,
      events: body.events ?? ["*"],
      enabled: body.enabled ?? true
    };
    if (body.secret) input.secret = body.secret;
    const webhook = await store.createWebhook(input);
    return Response.json(webhook, { status: 201 });
  });

  app.patch("/cms/settings/webhooks/:id", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    return updateManagedWebhook(store, context.req.param("id"), await context.req.json(), { partial: true });
  });

  app.put("/cms/settings/webhooks/:id", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    return updateManagedWebhook(store, context.req.param("id"), await context.req.json(), { partial: false });
  });

  app.delete("/cms/settings/webhooks/:id", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    await store.deleteWebhook(context.req.param("id"));
    return new Response(null, { status: 204 });
  });

  app.get("/cms/settings/webhooks/:id/deliveries", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const parsed = parseWebhookDeliveryListQuery(new URL(context.req.url), context.req.param("id"));
    if (parsed instanceof Response) return parsed;
    return Response.json(await store.listDeliveries(parsed));
  });

  app.post("/cms/settings/webhooks/:id/test", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const webhook = (await store.listWebhooks()).find((item) => item.id === context.req.param("id"));
    if (!webhook) return Response.json({ error: "not_found" }, { status: 404 });
    const delivery = await deliverWebhookTest(webhook, {
      type: "cms.test",
      timestamp: new Date().toISOString(),
      requestId: context.req.header("x-request-id") ?? crypto.randomUUID()
    }, 10_000);
    await store.appendDelivery(delivery);
    return Response.json(delivery);
  });
}

function requireAdmin(session: AuthSession | null): Response | null {
  return session?.roles.includes("admin") ? null : Response.json({ error: "forbidden" }, { status: 403 });
}

function serializeWebhookListItem(record: WebhookRecord, lastDelivery?: WebhookDelivery): Omit<WebhookRecord, "secret"> & {
  hasSecret: boolean;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: WebhookDelivery["status"] | null;
} {
  const { secret, ...safe } = record;
  return {
    ...safe,
    hasSecret: Boolean(secret),
    lastDeliveryAt: lastDelivery?.createdAt ?? null,
    lastDeliveryStatus: lastDelivery?.status ?? null
  };
}

async function updateManagedWebhook(
  store: WebhookStore,
  id: string,
  body: Partial<WebhookRecord> & { secret?: string | null },
  options: { partial: boolean }
): Promise<Response> {
  const validation = validateWebhookInput(body, { partial: options.partial });
  if (validation) return validation;
  const patch: Partial<Omit<WebhookRecord, "id" | "createdAt" | "updatedAt" | "secret">> & { secret?: string | undefined } = {};
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.url !== undefined) patch.url = body.url;
  if (body.events !== undefined) patch.events = body.events;
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if ("secret" in body) {
    if (typeof body.secret === "string" && body.secret.trim()) patch.secret = body.secret;
    else patch.secret = undefined;
  }
  try {
    const webhook = await store.updateWebhook(id, patch);
    return Response.json("secret" in body && typeof body.secret === "string" && body.secret.trim() ? webhook : serializeWebhook(webhook));
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) return Response.json({ error: "not_found" }, { status: 404 });
    throw error;
  }
}

function validateWebhookInput(input: Partial<Pick<WebhookRecord, "name" | "url" | "events" | "enabled">>, options?: { partial?: boolean }): Response | null {
  const issues: Array<{ path: string[]; message: string }> = [];
  if (!options?.partial || input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim()) issues.push({ path: ["name"], message: "name is required" });
  }
  if (!options?.partial || input.url !== undefined) {
    if (typeof input.url !== "string" || !isValidHttpUrl(input.url)) issues.push({ path: ["url"], message: "url must be a valid HTTP URL" });
  }
  if (!options?.partial || input.events !== undefined) {
    if (!Array.isArray(input.events) || input.events.length === 0 || input.events.some((event) => typeof event !== "string" || !event.trim())) {
      issues.push({ path: ["events"], message: "events must be a non-empty string array" });
    }
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") issues.push({ path: ["enabled"], message: "enabled must be a boolean" });
  return issues.length ? Response.json({ error: "validation_error", issues }, { status: 400 }) : null;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseWebhookDeliveryListQuery(url: URL, webhookId: string): { webhookId: string; cursor?: string; limit: number } | Response {
  const rawLimit = url.searchParams.get("limit");
  const limit = Number(rawLimit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return Response.json({
      error: "validation_error",
      issues: [{ path: ["limit"], message: "limit must be an integer between 1 and 100" }]
    }, { status: 400 });
  }

  const query: { webhookId: string; cursor?: string; limit: number } = { webhookId, limit };
  const cursor = url.searchParams.get("cursor");
  if (cursor) query.cursor = cursor;
  return query;
}
