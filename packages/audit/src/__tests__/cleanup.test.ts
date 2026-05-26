import { describe, expect, it, vi } from "vitest";
import { auditLogCleanupJob } from "../cleanup";
import { MemoryAuditStore } from "../store/memory";

function seedStore(timestamps: string[]): MemoryAuditStore {
  const store = new MemoryAuditStore();
  for (const createdAt of timestamps) {
    void store.append({
      id: `entry-${createdAt}`,
      operation: "create",
      collection: "articles",
      actorRoles: [],
      requestId: "req-1",
      diff: { before: null, after: { id: "x" } },
      createdAt
    });
  }
  return store;
}

describe("auditLogCleanupJob", () => {
  it("deletes rows older than retentionDays from the configured cutoff", async () => {
    const store = seedStore([
      "2025-01-01T00:00:00.000Z",
      "2025-06-01T00:00:00.000Z",
      "2026-05-22T00:00:00.000Z"
    ]);
    const now = new Date("2026-05-25T00:00:00.000Z");

    const result = await auditLogCleanupJob({ store, retentionDays: 90, now });

    expect(result.deletedCount).toBe(2);
    expect(result.olderThan).toBe(new Date("2026-02-24T00:00:00.000Z").toISOString());

    const remaining = await store.list({});
    expect(remaining.items.map((entry) => entry.id)).toEqual(["entry-2026-05-22T00:00:00.000Z"]);
  });

  it("returns deletedCount: 0 and skips when retentionDays <= 0", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = seedStore(["2025-01-01T00:00:00.000Z"]);

    const zero = await auditLogCleanupJob({ store, retentionDays: 0 });
    const negative = await auditLogCleanupJob({ store, retentionDays: -10 });

    expect(zero.deletedCount).toBe(0);
    expect(zero.olderThan).toBeUndefined();
    expect(negative.deletedCount).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("defaults retentionDays to 90 when omitted", async () => {
    const now = new Date("2026-05-25T00:00:00.000Z");
    const store = seedStore(["2020-01-01T00:00:00.000Z"]);

    const result = await auditLogCleanupJob({ store, now });

    expect(result.deletedCount).toBe(1);
    expect(result.olderThan).toBe(new Date("2026-02-24T00:00:00.000Z").toISOString());
  });

  it("returns 0 when store is null (plugin disabled-store path)", async () => {
    const result = await auditLogCleanupJob({ store: null, retentionDays: 30 });
    expect(result.deletedCount).toBe(0);
    expect(result.olderThan).toBeDefined();
  });

  it("treats stores without a cleanup method as a no-op", async () => {
    const store = {
      async append() {},
      async list() {
        return { items: [] };
      }
    } as any;

    const result = await auditLogCleanupJob({ store, retentionDays: 30 });
    expect(result.deletedCount).toBe(0);
  });
});
