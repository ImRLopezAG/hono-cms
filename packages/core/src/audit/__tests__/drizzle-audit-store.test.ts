import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * No SQLite driver is available in this workspace. We mock drizzle-orm operators
 * to return inspectable filter descriptors, then implement a JS-side filter
 * evaluator + in-memory storage shim that the audit store talks to.
 */

type ColumnRef = { __col: string };
type Filter =
  | { kind: "eq"; column: ColumnRef; value: unknown }
  | { kind: "gte"; column: ColumnRef; value: unknown }
  | { kind: "lte"; column: ColumnRef; value: unknown }
  | { kind: "lt"; column: ColumnRef; value: unknown }
  | { kind: "or"; parts: (Filter | undefined)[] }
  | { kind: "and"; parts: (Filter | undefined)[] };
type OrderBy = { column: ColumnRef; dir: "desc" | "asc" };

const STATE = {
  rows: [] as Record<string, any>[],
  throwOnExecute: false as boolean,
  throwOnInsert: false as boolean,
  throwOnDelete: false as boolean
};

const mocks = vi.hoisted(() => {
  const columnSet = {
    id: { __col: "id" },
    operation: { __col: "operation" },
    collection: { __col: "collection" },
    documentId: { __col: "documentId" },
    actorId: { __col: "actorId" },
    actorRoles: { __col: "actorRoles" },
    requestId: { __col: "requestId" },
    diffBefore: { __col: "diffBefore" },
    diffAfter: { __col: "diffAfter" },
    createdAt: { __col: "createdAt" }
  };
  return { FAKE_TABLE: { __isFakeTable: true, ...columnSet } };
});

vi.mock("drizzle-orm", () => ({
  and: (...parts: any[]) => ({ kind: "and", parts }),
  or: (...parts: any[]) => ({ kind: "or", parts }),
  desc: (column: any) => ({ column, dir: "desc" as const }),
  eq: (column: any, value: unknown) => ({ kind: "eq", column, value }),
  gte: (column: any, value: unknown) => ({ kind: "gte", column, value }),
  lte: (column: any, value: unknown) => ({ kind: "lte", column, value }),
  lt: (column: any, value: unknown) => ({ kind: "lt", column, value }),
  sql: (strings: TemplateStringsArray, ..._values: unknown[]) => ({ __sql: strings.join("?") })
}));

vi.mock("drizzle-orm/sqlite-core", () => ({
  sqliteTable: (_name: string, _columns: any, _extras?: any) => mocks.FAKE_TABLE,
  text: (_name: string) => ({ notNull: () => ({ primaryKey: () => ({}) }), primaryKey: () => ({}) }),
  index: (_name: string) => ({ on: () => ({}) })
}));

vi.mock("drizzle-orm/pg-core", () => ({
  pgTable: (_name: string, _columns: any, _extras?: any) => mocks.FAKE_TABLE,
  text: (_name: string) => ({ notNull: () => ({ primaryKey: () => ({}) }), primaryKey: () => ({}) }),
  index: (_name: string) => ({ on: () => ({}) })
}));

// Filter evaluator ---------------------------------------------------------
function evalFilter(row: Record<string, any>, filter: Filter | undefined): boolean {
  if (!filter) return true;
  switch (filter.kind) {
    case "eq":
      return row[filter.column.__col] === filter.value;
    case "gte":
      return row[filter.column.__col] != null && (row[filter.column.__col] as string | number) >= (filter.value as string | number);
    case "lte":
      return row[filter.column.__col] != null && (row[filter.column.__col] as string | number) <= (filter.value as string | number);
    case "lt":
      return row[filter.column.__col] != null && (row[filter.column.__col] as string | number) < (filter.value as string | number);
    case "and":
      return filter.parts.every((part) => evalFilter(row, part as Filter | undefined));
    case "or":
      return filter.parts.some((part) => evalFilter(row, part as Filter | undefined));
  }
}

// In-memory db shim --------------------------------------------------------
function makeDb() {
  return {
    select() {
      return {
        from(_table: any) {
          let where: Filter | undefined;
          let orders: OrderBy[] = [];
          let lim: number | undefined;
          const chain: any = {
            where(f: Filter) {
              where = f;
              return chain;
            },
            orderBy(...os: OrderBy[]) {
              orders = os;
              return chain;
            },
            limit(n: number) {
              lim = n;
              return chain;
            },
            then(resolve: (value: any) => any, reject?: (err: any) => any) {
              try {
                let result = STATE.rows.filter((row) => evalFilter(row, where));
                if (orders.length) {
                  result = [...result].sort((a, b) => {
                    for (const o of orders) {
                      const col = o.column.__col;
                      if (a[col] > b[col]) return o.dir === "desc" ? -1 : 1;
                      if (a[col] < b[col]) return o.dir === "desc" ? 1 : -1;
                    }
                    return 0;
                  });
                }
                if (typeof lim === "number") result = result.slice(0, lim);
                resolve(result);
              } catch (err) {
                if (reject) reject(err);
              }
            }
          };
          return chain;
        }
      };
    },
    insert(_table: any) {
      return {
        async values(row: Record<string, any>) {
          if (STATE.throwOnInsert) throw new Error("insert failed");
          STATE.rows.push({ ...row });
        }
      };
    },
    delete(_table: any) {
      return {
        async where(filter: Filter) {
          if (STATE.throwOnDelete) throw new Error("delete failed");
          const before = STATE.rows.length;
          STATE.rows = STATE.rows.filter((row) => !evalFilter(row, filter));
          return { rowsAffected: before - STATE.rows.length };
        }
      };
    },
    async execute(_sqlExpr: unknown) {
      if (STATE.throwOnExecute) throw new Error("db unavailable");
      return { rows: [{ 1: 1 }] };
    }
  };
}

function makeEntry(overrides: Partial<{
  id: string;
  operation: any;
  collection: string;
  documentId: string;
  actorId: string;
  actorRoles: string[];
  requestId: string;
  diff: { before: any; after: any };
  createdAt: string;
}> = {}): any {
  return {
    id: overrides.id ?? "entry-1",
    operation: overrides.operation ?? "create",
    collection: overrides.collection ?? "articles",
    documentId: overrides.documentId ?? "doc-1",
    actorId: overrides.actorId ?? "user-1",
    actorRoles: overrides.actorRoles ?? ["editor"],
    requestId: overrides.requestId ?? "req-1",
    diff: overrides.diff ?? { before: null, after: { title: "Hello" } },
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z"
  };
}

// Tests --------------------------------------------------------------------

describe("createDrizzleAuditStore", () => {
  let createDrizzleAuditStore: typeof import("../drizzle-audit-store").createDrizzleAuditStore;

  beforeEach(async () => {
    STATE.rows = [];
    STATE.throwOnExecute = false;
    STATE.throwOnInsert = false;
    STATE.throwOnDelete = false;
    ({ createDrizzleAuditStore } = await import("../drizzle-audit-store"));
  });

  test("append inserts an entry as a serialized row", async () => {
    const db = makeDb();
    const store = createDrizzleAuditStore(db, { dialect: "sqlite" });

    await store.append(makeEntry());

    expect(STATE.rows.length).toBe(1);
    const stored = STATE.rows[0]!;
    expect(stored.id).toBe("entry-1");
    expect(stored.operation).toBe("create");
    expect(stored.collection).toBe("articles");
    expect(stored.documentId).toBe("doc-1");
    expect(stored.actorId).toBe("user-1");
    expect(JSON.parse(stored.actorRoles)).toEqual(["editor"]);
    expect(stored.requestId).toBe("req-1");
    expect(stored.diffBefore).toBeNull();
    expect(JSON.parse(stored.diffAfter)).toEqual({ title: "Hello" });
    expect(stored.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("append swallows errors and logs a warning", async () => {
    const db = makeDb();
    STATE.throwOnInsert = true;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createDrizzleAuditStore(db, { dialect: "sqlite" });

    await expect(store.append(makeEntry())).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("list returns entries newest first (by createdAt desc, id desc)", async () => {
    const db = makeDb();
    const store = createDrizzleAuditStore(db, { dialect: "sqlite" });

    await store.append(makeEntry({ id: "e1", createdAt: "2026-01-01T00:00:00.000Z" }));
    await store.append(makeEntry({ id: "e2", createdAt: "2026-01-03T00:00:00.000Z" }));
    await store.append(makeEntry({ id: "e3", createdAt: "2026-01-02T00:00:00.000Z" }));

    const result = await store.list();
    expect(result.items.map((i) => i.id)).toEqual(["e2", "e3", "e1"]);
  });

  test("list filters by collection / documentId / operation / actorId", async () => {
    const db = makeDb();
    const store = createDrizzleAuditStore(db, { dialect: "sqlite" });

    await store.append(makeEntry({ id: "e1", collection: "articles", operation: "create", actorId: "u1", documentId: "d1" }));
    await store.append(makeEntry({ id: "e2", collection: "pages", operation: "create", actorId: "u1", documentId: "d2", createdAt: "2026-01-02T00:00:00.000Z" }));
    await store.append(makeEntry({ id: "e3", collection: "articles", operation: "update", actorId: "u2", documentId: "d1", createdAt: "2026-01-03T00:00:00.000Z" }));

    expect((await store.list({ collection: "articles" })).items.map((i) => i.id)).toEqual(["e3", "e1"]);
    expect((await store.list({ documentId: "d1" })).items.map((i) => i.id)).toEqual(["e3", "e1"]);
    expect((await store.list({ operation: "update" })).items.map((i) => i.id)).toEqual(["e3"]);
    expect((await store.list({ actorId: "u1" })).items.map((i) => i.id)).toEqual(["e2", "e1"]);
  });

  test("list filters by from and to date range", async () => {
    const db = makeDb();
    const store = createDrizzleAuditStore(db, { dialect: "sqlite" });

    await store.append(makeEntry({ id: "e1", createdAt: "2026-01-01T00:00:00.000Z" }));
    await store.append(makeEntry({ id: "e2", createdAt: "2026-01-05T00:00:00.000Z" }));
    await store.append(makeEntry({ id: "e3", createdAt: "2026-01-10T00:00:00.000Z" }));

    const result = await store.list({ from: "2026-01-02T00:00:00.000Z", to: "2026-01-08T00:00:00.000Z" });
    expect(result.items.map((i) => i.id)).toEqual(["e2"]);
  });

  test("list cursor pagination round-trips across pages", async () => {
    const db = makeDb();
    const store = createDrizzleAuditStore(db, { dialect: "sqlite" });

    // Seed 5 entries with unique ascending timestamps
    for (let i = 1; i <= 5; i++) {
      await store.append(makeEntry({
        id: `e${i}`,
        createdAt: `2026-01-0${i}T00:00:00.000Z`
      }));
    }

    const page1 = await store.list({ limit: 2 });
    expect(page1.items.map((i) => i.id)).toEqual(["e5", "e4"]);
    expect(page1.nextCursor).toBeTypeOf("string");

    const page2 = await store.list({ limit: 2, ...(page1.nextCursor ? { cursor: page1.nextCursor } : {}) });
    expect(page2.items.map((i) => i.id)).toEqual(["e3", "e2"]);
    expect(page2.nextCursor).toBeTypeOf("string");

    const page3 = await store.list({ limit: 2, ...(page2.nextCursor ? { cursor: page2.nextCursor } : {}) });
    expect(page3.items.map((i) => i.id)).toEqual(["e1"]);
    expect(page3.nextCursor).toBeUndefined();
  });

  test("list malformed cursor is ignored (no filter applied)", async () => {
    const db = makeDb();
    const store = createDrizzleAuditStore(db, { dialect: "sqlite" });
    await store.append(makeEntry({ id: "e1" }));

    const result = await store.list({ cursor: "@@not-base64@@" });
    expect(result.items.length).toBe(1);
  });

  test("cleanup deletes entries older than the cutoff date", async () => {
    const db = makeDb();
    const store = createDrizzleAuditStore(db, { dialect: "sqlite" });

    await store.append(makeEntry({ id: "old1", createdAt: "2025-01-01T00:00:00.000Z" }));
    await store.append(makeEntry({ id: "old2", createdAt: "2025-06-01T00:00:00.000Z" }));
    await store.append(makeEntry({ id: "fresh", createdAt: "2026-05-22T00:00:00.000Z" }));

    const removed = await store.cleanup!(new Date("2026-01-01T00:00:00.000Z"));
    expect(removed).toBe(2);
    expect(STATE.rows.map((r) => r.id)).toEqual(["fresh"]);
  });

  test("cleanup swallows errors and returns 0", async () => {
    const db = makeDb();
    STATE.throwOnDelete = true;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createDrizzleAuditStore(db, { dialect: "sqlite" });

    const removed = await store.cleanup!(new Date());
    expect(removed).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("health() returns ok:true when execute works", async () => {
    const db = makeDb();
    const store = createDrizzleAuditStore(db, { dialect: "sqlite" });

    const result = await store.health!();
    expect(result.ok).toBe(true);
    expect(result.details).toEqual({ table: "audit_log" });
  });

  test("health() returns ok:false when execute throws", async () => {
    const db = makeDb();
    STATE.throwOnExecute = true;
    const store = createDrizzleAuditStore(db, { dialect: "sqlite" });

    const result = await store.health!();
    expect(result.ok).toBe(false);
    expect(result.details).toMatchObject({ table: "audit_log" });
    expect((result.details as any).error).toContain("db unavailable");
  });

  test("rowToEntry round-trips diff.before / diff.after / actorRoles", async () => {
    const db = makeDb();
    const store = createDrizzleAuditStore(db, { dialect: "sqlite" });

    await store.append(makeEntry({
      id: "e1",
      actorRoles: ["admin", "editor"],
      diff: { before: { title: "A" }, after: { title: "B" } }
    }));

    const result = await store.list();
    expect(result.items[0]!.actorRoles).toEqual(["admin", "editor"]);
    expect(result.items[0]!.diff).toEqual({ before: { title: "A" }, after: { title: "B" } });
  });
});
