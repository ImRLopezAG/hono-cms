import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * No SQLite driver (libSQL/better-sqlite3) is installed in this workspace, so we
 * use an in-memory shim that interprets the calls drizzle's query builder makes
 * against `db`. Drizzle modules are mocked so `eq`/`and`/`asc` produce inspectable
 * filter descriptors. The store then chains them through our shim, which
 * implements filter evaluation in JS against a row array.
 */

type Filter = { kind: "eq"; column: ColumnRef; value: unknown } | { kind: "and"; parts: Filter[] };
type ColumnRef = { __col: string };
type OrderBy = { column: ColumnRef; dir: "asc" };

const STATE = {
  rows: [] as Record<string, any>[],
  lastInserted: null as Record<string, any> | null,
  lastUpdate: null as { values: Record<string, any>; where: Filter | undefined } | null,
  throwOnExecute: false as boolean
};

// Mock drizzle modules ------------------------------------------------------
// `vi.mock` factories are hoisted, so anything they reference must come from
// `vi.hoisted`. We build the column set and shared FAKE_TABLE there.
const mocks = vi.hoisted(() => {
  const cols = [
    "id",
    "collection",
    "documentId",
    "locale",
    "fields",
    "status",
    "translatedBy",
    "sourceUpdatedAt",
    "error",
    "provider",
    "translatedAt",
    "createdAt",
    "updatedAt"
  ];
  const columnSet = Object.fromEntries(cols.map((c) => [c, { __col: c }])) as Record<string, { __col: string }>;
  return { FAKE_TABLE: { __isFakeTable: true, ...columnSet } };
});

vi.mock("drizzle-orm", () => ({
  and: (...parts: any[]) => ({ kind: "and", parts }),
  eq: (column: any, value: unknown) => ({ kind: "eq", column, value }),
  asc: (column: any) => ({ column, dir: "asc" as const }),
  sql: (strings: TemplateStringsArray, ..._values: unknown[]) => ({ __sql: strings.join("?") })
}));

vi.mock("drizzle-orm/sqlite-core", () => ({
  sqliteTable: (_name: string, _columns: any, _extras?: any) => mocks.FAKE_TABLE,
  text: (_name: string) => ({ notNull: () => ({ primaryKey: () => ({}) }), primaryKey: () => ({}) }),
  uniqueIndex: (_name: string) => ({ on: () => ({}) })
}));

vi.mock("drizzle-orm/pg-core", () => ({
  pgTable: (_name: string, _columns: any, _extras?: any) => mocks.FAKE_TABLE,
  text: (_name: string) => ({ notNull: () => ({ primaryKey: () => ({}) }), primaryKey: () => ({}) }),
  uniqueIndex: (_name: string) => ({ on: () => ({}) })
}));

// Filter evaluator ---------------------------------------------------------

function rowMatches(row: Record<string, any>, filter: Filter | undefined): boolean {
  if (!filter) return true;
  if (filter.kind === "eq") return row[filter.column.__col] === filter.value;
  if (filter.kind === "and") return filter.parts.every((part) => rowMatches(row, part));
  return false;
}

// In-memory db shim --------------------------------------------------------

function makeDb() {
  return {
    select() {
      return {
        from(_table: any) {
          let where: Filter | undefined;
          let order: OrderBy | undefined;
          let limit: number | undefined;
          const chain: any = {
            where(f: Filter) {
              where = f;
              return chain;
            },
            orderBy(o: OrderBy) {
              order = o;
              return chain;
            },
            limit(n: number) {
              limit = n;
              return chain;
            },
            then(resolve: (value: any) => any, reject?: (err: any) => any) {
              try {
                let result = STATE.rows.filter((row) => rowMatches(row, where));
                if (order) {
                  const dir = order.dir === "asc" ? 1 : -1;
                  const col = order.column.__col;
                  result = [...result].sort((a, b) => (a[col] > b[col] ? dir : a[col] < b[col] ? -dir : 0));
                }
                if (typeof limit === "number") result = result.slice(0, limit);
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
          STATE.rows.push({ ...row });
          STATE.lastInserted = { ...row };
        }
      };
    },
    update(_table: any) {
      return {
        set(values: Record<string, any>) {
          return {
            async where(filter: Filter) {
              STATE.lastUpdate = { values, where: filter };
              for (const row of STATE.rows) {
                if (rowMatches(row, filter)) Object.assign(row, values);
              }
            }
          };
        }
      };
    },
    async execute(_sqlExpr: unknown) {
      if (STATE.throwOnExecute) throw new Error("db unavailable");
      return { rows: [{ 1: 1 }] };
    }
  };
}

// Tests --------------------------------------------------------------------

describe("createDrizzleTranslationStore", () => {
  let createDrizzleTranslationStore: typeof import("../drizzle-translation-store").createDrizzleTranslationStore;

  beforeEach(async () => {
    STATE.rows = [];
    STATE.lastInserted = null;
    STATE.lastUpdate = null;
    STATE.throwOnExecute = false;
    // Stable UUIDs across tests (best-effort; falls back silently if non-spyable)
    let n = 0;
    try {
      vi.spyOn(crypto, "randomUUID").mockImplementation(
        (() => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`) as any
      );
    } catch {
      // Some runtimes ship crypto.randomUUID as non-configurable; tests don't
      // depend on exact UUID values, only on the resulting row.id being a string.
    }

    ({ createDrizzleTranslationStore } = await import("../drizzle-translation-store"));
  });

  test("upsertVariant inserts a new variant when none exists", async () => {
    const db = makeDb();
    const store = createDrizzleTranslationStore(db, { dialect: "sqlite" });

    const result = await store.upsertVariant({
      collection: "articles",
      documentId: "doc-1",
      locale: "es",
      fields: { title: "Hola" },
      status: "complete",
      translatedBy: "ai",
      provider: "openai",
      translatedAt: "2026-01-02T00:00:00.000Z"
    });

    expect(STATE.rows.length).toBe(1);
    const stored = STATE.rows[0]!;
    expect(stored.collection).toBe("articles");
    expect(stored.documentId).toBe("doc-1");
    expect(stored.locale).toBe("es");
    expect(JSON.parse(stored.fields)).toEqual({ title: "Hola" });
    expect(stored.status).toBe("complete");
    expect(stored.translatedBy).toBe("ai");
    expect(stored.createdAt).toBeTypeOf("string");
    expect(stored.updatedAt).toBe(stored.createdAt);

    expect(result.id).toBe(stored.id);
    expect(result.fields).toEqual({ title: "Hola" });
    expect(result.provider).toBe("openai");
  });

  test("upsertVariant updates existing in place, preserving createdAt and refreshing updatedAt", async () => {
    const db = makeDb();
    const store = createDrizzleTranslationStore(db, { dialect: "sqlite" });

    await store.upsertVariant({
      collection: "articles",
      documentId: "doc-1",
      locale: "es",
      fields: { title: "Hola" },
      status: "pending",
      translatedBy: "pending"
    });
    const originalCreatedAt = STATE.rows[0]!.createdAt;
    const originalId = STATE.rows[0]!.id;

    // Force the next ISO timestamp to differ (>=2ms is enough for ms precision)
    await new Promise((r) => setTimeout(r, 15));

    const updated = await store.upsertVariant({
      collection: "articles",
      documentId: "doc-1",
      locale: "es",
      fields: { title: "Hola mundo" },
      status: "complete",
      translatedBy: "ai",
      provider: "openai",
      translatedAt: "2026-01-03T00:00:00.000Z"
    });

    expect(STATE.rows.length).toBe(1);
    expect(STATE.rows[0]!.id).toBe(originalId);
    expect(STATE.rows[0]!.createdAt).toBe(originalCreatedAt);
    expect(STATE.rows[0]!.updatedAt).not.toBe(originalCreatedAt);
    expect(JSON.parse(STATE.rows[0]!.fields)).toEqual({ title: "Hola mundo" });
    expect(STATE.rows[0]!.status).toBe("complete");

    expect(updated.id).toBe(originalId);
    expect(updated.createdAt).toBe(originalCreatedAt);
    expect(updated.fields).toEqual({ title: "Hola mundo" });
  });

  test("getVariant returns null when missing", async () => {
    const db = makeDb();
    const store = createDrizzleTranslationStore(db, { dialect: "sqlite" });

    const result = await store.getVariant("articles", "missing", "es");
    expect(result).toBeNull();
  });

  test("getVariant returns variant with parsed fields object", async () => {
    const db = makeDb();
    const store = createDrizzleTranslationStore(db, { dialect: "sqlite" });

    await store.upsertVariant({
      collection: "articles",
      documentId: "doc-1",
      locale: "es",
      fields: { title: "Hola", body: "Mundo" },
      status: "complete",
      translatedBy: "ai"
    });

    const got = await store.getVariant("articles", "doc-1", "es");
    expect(got).not.toBeNull();
    expect(got!.fields).toEqual({ title: "Hola", body: "Mundo" });
    expect(got!.collection).toBe("articles");
    expect(got!.locale).toBe("es");
  });

  test("listVariants returns variants ordered by locale (ascending)", async () => {
    const db = makeDb();
    const store = createDrizzleTranslationStore(db, { dialect: "sqlite" });

    await store.upsertVariant({
      collection: "articles",
      documentId: "doc-1",
      locale: "fr",
      fields: { title: "Bonjour" },
      status: "complete",
      translatedBy: "ai"
    });
    await store.upsertVariant({
      collection: "articles",
      documentId: "doc-1",
      locale: "de",
      fields: { title: "Hallo" },
      status: "complete",
      translatedBy: "ai"
    });
    await store.upsertVariant({
      collection: "articles",
      documentId: "doc-1",
      locale: "es",
      fields: { title: "Hola" },
      status: "complete",
      translatedBy: "ai"
    });
    // Different doc -- should not appear in listVariants for doc-1
    await store.upsertVariant({
      collection: "articles",
      documentId: "doc-other",
      locale: "es",
      fields: { title: "X" },
      status: "complete",
      translatedBy: "ai"
    });

    const list = await store.listVariants("articles", "doc-1");
    expect(list.length).toBe(3);
    expect(list.map((v) => v.locale)).toEqual(["de", "es", "fr"]);
  });

  test("health() returns ok:true when db.execute works", async () => {
    const db = makeDb();
    const store = createDrizzleTranslationStore(db, { dialect: "sqlite" });

    const result = await store.health!();
    expect(result.ok).toBe(true);
  });

  test("health() returns ok:false when db.execute throws", async () => {
    const db = makeDb();
    STATE.throwOnExecute = true;
    const store = createDrizzleTranslationStore(db, { dialect: "sqlite" });

    const result = await store.health!();
    expect(result.ok).toBe(false);
    expect((result as any).message).toContain("db unavailable");
  });
});
