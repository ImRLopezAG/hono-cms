import type {
  WebhookDelivery,
  WebhookRecord,
  WebhookRecordAttemptInput,
  WebhookStore
} from "../types";

/**
 * In-memory `WebhookStore` used by tests and small-scale deployments.
 *
 * Ported verbatim from `packages/core/src/webhooks.ts` (Plan U17). The
 * implementation is intentionally non-persistent — durable adapters
 * (Postgres, D1, Convex) implement the same {@link WebhookStore}
 * interface.
 */
export class MemoryWebhookStore implements WebhookStore {
  private readonly webhooks = new Map<string, WebhookRecord>();
  private readonly deliveries: WebhookDelivery[] = [];

  async listWebhooks(): Promise<WebhookRecord[]> {
    return [...this.webhooks.values()];
  }

  async createWebhook(input: Omit<WebhookRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<WebhookRecord> {
    const now = new Date().toISOString();
    const record: WebhookRecord = {
      ...input,
      id: input.id ?? crypto.randomUUID(),
      createdAt: now,
      updatedAt: now
    };
    this.webhooks.set(record.id, record);
    return record;
  }

  async updateWebhook(id: string, patch: Partial<Omit<WebhookRecord, "id" | "createdAt" | "updatedAt" | "secret">> & { secret?: string | undefined }): Promise<WebhookRecord> {
    const current = this.webhooks.get(id);
    if (!current) throw new Error(`Webhook "${id}" not found.`);
    const { secret, ...rest } = patch;
    const next: WebhookRecord = { ...current, ...rest, updatedAt: new Date().toISOString() };
    if ("secret" in patch) {
      if (secret) next.secret = secret;
      else delete next.secret;
    }
    this.webhooks.set(id, next);
    return next;
  }

  async deleteWebhook(id: string): Promise<void> {
    this.webhooks.delete(id);
  }

  async appendDelivery(delivery: WebhookDelivery): Promise<void> {
    this.deliveries.unshift(delivery);
  }

  async getDelivery(id: string): Promise<WebhookDelivery | null> {
    return this.deliveries.find((delivery) => delivery.id === id) ?? null;
  }

  async updateDelivery(id: string, patch: Partial<Omit<WebhookDelivery, "id" | "createdAt">>): Promise<WebhookDelivery | null> {
    const index = this.deliveries.findIndex((delivery) => delivery.id === id);
    if (index === -1) return null;
    const next = { ...this.deliveries[index], ...patch } as WebhookDelivery;
    this.deliveries[index] = next;
    return next;
  }

  async listDeliveries(query: { webhookId?: string; cursor?: string; limit?: number } = {}): Promise<{ items: WebhookDelivery[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    let rows = [...this.deliveries];
    if (query.webhookId) rows = rows.filter((delivery) => delivery.webhookId === query.webhookId);
    const start = query.cursor ? Math.max(rows.findIndex((delivery) => delivery.id === query.cursor) + 1, 0) : 0;
    const items = rows.slice(start, start + limit);
    const last = items.at(-1);
    return start + limit < rows.length && last ? { items, nextCursor: last.id } : { items };
  }

  async listPendingRetries(now: Date): Promise<WebhookDelivery[]> {
    const cutoff = now.getTime();
    return this.deliveries.filter((delivery) => delivery.status === "retrying"
      && typeof delivery.nextAttemptAt === "string"
      && Date.parse(delivery.nextAttemptAt) <= cutoff);
  }

  async recordAttempt(deliveryId: string, input: WebhookRecordAttemptInput): Promise<WebhookDelivery | null> {
    const index = this.deliveries.findIndex((delivery) => delivery.id === deliveryId);
    if (index === -1) return null;
    const current = this.deliveries[index];
    if (!current) return null;
    const next: WebhookDelivery = { ...current };
    if (input.ok) {
      next.status = "success";
      next.nextAttemptAt = undefined;
      next.error = undefined;
      if (input.status !== undefined) next.responseStatus = input.status;
      if (input.responseBody !== undefined) next.responseBody = input.responseBody;
    } else if (input.finalFailure) {
      next.status = "failed";
      next.nextAttemptAt = undefined;
      if (input.status !== undefined) next.responseStatus = input.status;
      if (input.responseBody !== undefined) next.responseBody = input.responseBody;
      if (input.error !== undefined) next.error = input.error;
    } else {
      next.status = "retrying";
      if (input.status !== undefined) next.responseStatus = input.status;
      if (input.responseBody !== undefined) next.responseBody = input.responseBody;
      if (input.error !== undefined) next.error = input.error;
      next.nextAttemptAt = input.nextAttemptAt instanceof Date
        ? input.nextAttemptAt.toISOString()
        : input.nextAttemptAt;
    }
    this.deliveries[index] = next;
    return next;
  }

  async cleanup(olderThan: Date): Promise<number> {
    const cutoff = olderThan.getTime();
    let removed = 0;
    for (let index = this.deliveries.length - 1; index >= 0; index -= 1) {
      const delivery = this.deliveries[index];
      if (!delivery) continue;
      if (Date.parse(delivery.createdAt) <= cutoff) {
        this.deliveries.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }
}
