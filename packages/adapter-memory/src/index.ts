import { applyListQuery, registerProvider, type ContentRecord, type DatabaseAdapter, type ListQuery, type ListResult } from "@hono-cms/core";
import type { CMSCollections } from "@hono-cms/schema";

export type MemoryDatabaseConfig<Collections extends CMSCollections = CMSCollections> = {
  provider: "memory";
  collections: Collections;
  seed?: Partial<Record<keyof Collections & string, ContentRecord[]>>;
};

export class MemoryDatabaseAdapter<Collections extends CMSCollections = CMSCollections> implements DatabaseAdapter<Collections> {
  readonly provider = "memory";
  readonly collections: Collections;
  readonly client = this;
  readonly capabilities = {
    transactions: false,
    jsonOperators: true,
    advisoryLocks: false,
    migrations: false,
    populate: true
  };
  private readonly tables = new Map<string, ContentRecord[]>();

  constructor(config: MemoryDatabaseConfig<Collections>) {
    this.collections = config.collections;
    for (const name of Object.keys(config.collections)) {
      this.tables.set(name, [...(config.seed?.[name] ?? [])]);
    }
  }

  async list(collection: keyof Collections & string, query?: ListQuery): Promise<ListResult> {
    return applyListQuery(this.table(collection), query);
  }

  async get(collection: keyof Collections & string, id: string): Promise<ContentRecord | null> {
    return this.table(collection).find((record) => record.id === id) ?? null;
  }

  async findManyByIds(collection: keyof Collections & string, ids: readonly string[]): Promise<ContentRecord[]> {
    const idSet = new Set(ids);
    return this.table(collection).filter((record) => idSet.has(record.id));
  }

  async create(collection: keyof Collections & string, input: Record<string, unknown>): Promise<ContentRecord> {
    const now = new Date().toISOString();
    const record: ContentRecord = {
      ...input,
      id: typeof input.id === "string" ? input.id : crypto.randomUUID(),
      createdAt: now,
      updatedAt: now
    };
    this.table(collection).push(record);
    return record;
  }

  async update(collection: keyof Collections & string, id: string, patch: Record<string, unknown>): Promise<ContentRecord> {
    const table = this.table(collection);
    const index = table.findIndex((record) => record.id === id);
    if (index === -1) throw new Error(`Record "${id}" was not found in "${collection}".`);
    const next = { ...table[index], ...patch, id, updatedAt: new Date().toISOString() } as ContentRecord;
    table[index] = next;
    return next;
  }

  async delete(collection: keyof Collections & string, id: string): Promise<void> {
    const table = this.table(collection);
    const index = table.findIndex((record) => record.id === id);
    if (index >= 0) table.splice(index, 1);
  }

  async publish(collection: keyof Collections & string, id: string): Promise<ContentRecord> {
    return this.update(collection, id, { status: "published", publishedAt: new Date().toISOString() });
  }

  async unpublish(collection: keyof Collections & string, id: string): Promise<ContentRecord> {
    return this.update(collection, id, { status: "draft", publishedAt: null });
  }

  async health(): Promise<{ ok: boolean; details: Record<string, number> }> {
    return {
      ok: true,
      details: Object.fromEntries([...this.tables].map(([name, rows]) => [name, rows.length]))
    };
  }

  /**
   * Allocate storage for a collection that was registered after construction.
   * Called by `cms.registerCollection(...)` / the content-type builder when a
   * fresh collection is wired into the live CMS instance (Gap-A runtime fix).
   * Idempotent — safe to call for collections that already exist.
   */
  ensureCollection(collection: string): void {
    if (!this.tables.has(collection)) this.tables.set(collection, []);
  }

  private table(collection: string): ContentRecord[] {
    let table = this.tables.get(collection);
    if (!table) {
      // Lazy-allocate so newly-registered collections (Gap-A) read as empty
      // instead of erroring out before any record has been created.
      table = [];
      this.tables.set(collection, table);
    }
    return table;
  }
}

export function createMemoryDatabase<Collections extends CMSCollections>(config: MemoryDatabaseConfig<Collections>): MemoryDatabaseAdapter<Collections> {
  return new MemoryDatabaseAdapter(config);
}

registerProvider<MemoryDatabaseConfig, DatabaseAdapter>("db", "memory", createMemoryDatabase);
