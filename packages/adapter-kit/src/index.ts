import {
  AdapterCapabilityError,
  createSchemaSnapshot,
  isManyRelation,
  planSchemaMigration,
  type CMSCollections,
  type ContentRecord,
  type ContentStatus,
  type DatabaseAdapter,
  type FieldDefinition,
  type HealthStatus,
  type MigrationFile,
  type PaginatedResult,
  type QueryParams,
  type SchemaDiff,
  type SchemaSnapshot
} from "@hono-cms/schema";

export type AdapterDialect = "sqlite" | "postgres" | "convex";

export type SqlStatementExecutor = {
  query?(statement: string, params?: readonly unknown[]): Promise<unknown[]>;
  execute?(statement: string, params?: readonly unknown[]): Promise<unknown>;
  batch?(statements: readonly string[]): Promise<unknown>;
};

export type DocumentExecutor = {
  list(collection: string, query?: QueryParams): Promise<PaginatedResult>;
  get(collection: string, id: string): Promise<ContentRecord | null>;
  create(collection: string, input: Record<string, unknown>): Promise<ContentRecord>;
  update(collection: string, id: string, patch: Record<string, unknown>): Promise<ContentRecord>;
  delete(collection: string, id: string): Promise<void>;
  findManyByIds?(collection: string, ids: readonly string[]): Promise<ContentRecord[]>;
  health?(): Promise<HealthStatus>;
};

export type PortableAdapterConfig<Collections extends CMSCollections, Client> = {
  provider: string;
  collections: Collections;
  client: Client;
  dialect: AdapterDialect;
  capabilities?: DatabaseAdapter<Collections, Client>["capabilities"];
  snapshot?: SchemaSnapshot | null;
};

export type SqlDocumentExecutorConfig<Collections extends CMSCollections> = {
  collections: Collections;
  executor: SqlStatementExecutor;
  dialect: Exclude<AdapterDialect, "convex">;
  idFactory?: () => string;
  now?: () => string;
};

export type SqlMediaStoreConfig = {
  executor: SqlStatementExecutor;
  dialect: Exclude<AdapterDialect, "convex">;
  tableName?: string;
  idFactory?: () => string;
  now?: () => string;
};

export type SqlMediaRecord = {
  id: string;
  key: string;
  url: string;
  filename: string;
  size: number;
  contentType?: string;
  metadata?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export class SqlDocumentExecutor<Collections extends CMSCollections = CMSCollections> implements DocumentExecutor {
  private readonly collections: Collections;
  private readonly executor: SqlStatementExecutor;
  private readonly dialect: Exclude<AdapterDialect, "convex">;
  private readonly idFactory: () => string;
  private readonly now: () => string;

  constructor(config: SqlDocumentExecutorConfig<Collections>) {
    this.collections = config.collections;
    this.executor = config.executor;
    this.dialect = config.dialect;
    this.idFactory = config.idFactory ?? (() => crypto.randomUUID());
    this.now = config.now ?? (() => new Date().toISOString());
  }

  async list(collectionName: string, query: QueryParams = {}): Promise<PaginatedResult> {
    const collection = this.collection(collectionName);
    const limit = Math.min(Math.max(query.pageSize ?? query.limit ?? 25, 1), 100);
    const offset = query.cursor ? 0 : Math.max((query.page ?? 1) - 1, 0) * limit;
    const params: unknown[] = [];
    const where = this.whereClause(collectionName, query, params);
    const usesDefaultSort = !query.sort;
    const order = query.sort ? this.orderClause(query.sort) : `ORDER BY ${quoteIdent("created_at", this.dialect)} DESC, ${quoteIdent("id", this.dialect)} DESC`;
    const cursor = this.cursorClause(query, params, Boolean(where.sql), usesDefaultSort);
    const total = query.page || query.pageSize
      ? await this.countRows(collection.name, where.sql, [...params])
      : undefined;
    params.push(limit + 1);
    if (offset > 0) params.push(offset);
    const sql = [
      `SELECT * FROM ${quoteIdent(collection.name, this.dialect)}`,
      where.sql,
      cursor,
      order,
      `LIMIT ${placeholderAt(params.length - (offset > 0 ? 1 : 0), this.dialect)}`,
      offset > 0 ? `OFFSET ${placeholderAt(params.length, this.dialect)}` : ""
    ].filter(Boolean).join(" ");
    const rows = await this.query(sql, params);
    const items = rows.slice(0, limit).map((row) => this.fromRow(collectionName, row));
    const last = items.at(-1);
    const result = rows.length > limit && last ? { items, nextCursor: last.id } : { items };
    return typeof total === "number" ? { ...result, total } : result;
  }

  async get(collectionName: string, id: string): Promise<ContentRecord | null> {
    const collection = this.collection(collectionName);
    const row = (await this.query(
      `SELECT * FROM ${quoteIdent(collection.name, this.dialect)} WHERE ${quoteIdent("id", this.dialect)} = ${placeholderAt(1, this.dialect)} LIMIT 1`,
      [id]
    ))[0];
    return row ? this.fromRow(collectionName, row) : null;
  }

  async findManyByIds(collectionName: string, ids: readonly string[]): Promise<ContentRecord[]> {
    if (ids.length === 0) return [];
    const collection = this.collection(collectionName);
    const params = [...ids];
    const placeholders = params.map((_, index) => placeholderAt(index + 1, this.dialect)).join(", ");
    const rows = await this.query(`SELECT * FROM ${quoteIdent(collection.name, this.dialect)} WHERE ${quoteIdent("id", this.dialect)} IN (${placeholders})`, params);
    return rows.map((row) => this.fromRow(collectionName, row));
  }

  async create(collectionName: string, input: Record<string, unknown>): Promise<ContentRecord> {
    const collection = this.collection(collectionName);
    const id = typeof input.id === "string" ? input.id : this.idFactory();
    const now = this.now();
    const data = { ...input, id, createdAt: now, updatedAt: now };
    const columns = this.writeColumns(collectionName, data, false);
    const params = columns.map((column) => column.value);
    const names = columns.map((column) => quoteIdent(column.name, this.dialect)).join(", ");
    const values = params.map((_, index) => placeholderAt(index + 1, this.dialect)).join(", ");
    await this.execute(`INSERT INTO ${quoteIdent(collection.name, this.dialect)} (${names}) VALUES (${values})`, params);
    await this.replaceManyRelations(collectionName, id, input);
    const created = await this.get(collectionName, id);
    if (!created) throw new Error(`Inserted record "${id}" in "${collectionName}" could not be read back.`);
    return created;
  }

  async update(collectionName: string, id: string, patch: Record<string, unknown>): Promise<ContentRecord> {
    const collection = this.collection(collectionName);
    const columns = this.writeColumns(collectionName, { ...patch, updatedAt: this.now() }, true);
    if (columns.length > 0) {
      const assignments = columns.map((column, index) => `${quoteIdent(column.name, this.dialect)} = ${placeholderAt(index + 1, this.dialect)}`).join(", ");
      const params = [...columns.map((column) => column.value), id];
      await this.execute(`UPDATE ${quoteIdent(collection.name, this.dialect)} SET ${assignments} WHERE ${quoteIdent("id", this.dialect)} = ${placeholderAt(params.length, this.dialect)}`, params);
    }
    await this.replaceManyRelations(collectionName, id, patch);
    const updated = await this.get(collectionName, id);
    if (!updated) throw new Error(`Record "${id}" was not found in "${collectionName}".`);
    return updated;
  }

  async delete(collectionName: string, id: string): Promise<void> {
    const collection = this.collection(collectionName);
    await this.execute(`DELETE FROM ${quoteIdent(collection.name, this.dialect)} WHERE ${quoteIdent("id", this.dialect)} = ${placeholderAt(1, this.dialect)}`, [id]);
  }

  async health(): Promise<HealthStatus> {
    await this.query("SELECT 1 AS ok", []);
    return { ok: true, details: { dialect: this.dialect } };
  }

  private collection(name: string) {
    const collection = this.collections[name];
    if (!collection) throw new Error(`Unknown collection "${name}".`);
    return collection;
  }

  private whereClause(collectionName: string, query: QueryParams, params: unknown[]): { sql: string } {
    const clauses: string[] = [];
    if (query.status) {
      clauses.push(`${quoteIdent("status", this.dialect)} = ${placeholder(params, this.dialect)}`);
      params.push(query.status);
    }
    if (query.locale) {
      clauses.push(`${quoteIdent("locale", this.dialect)} = ${placeholder(params, this.dialect)}`);
      params.push(query.locale);
    }
    for (const [fieldName, filter] of Object.entries(query.filters ?? {})) {
      const column = this.columnName(collectionName, fieldName);
      if (!column) continue;
      clauses.push(filterClause(quoteIdent(column, this.dialect), filter, params, this.dialect));
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "" };
  }

  private orderClause(sort: string): string {
    const descending = sort.startsWith("-");
    const field = descending ? sort.slice(1) : sort;
    return `ORDER BY ${quoteIdent(toSnakeCase(field), this.dialect)} ${descending ? "DESC" : "ASC"}`;
  }

  private cursorClause(query: QueryParams, params: unknown[], hasWhere: boolean, usesDefaultSort: boolean): string {
    if (!query.cursor) return "";
    const prefix = hasWhere ? " AND" : "WHERE";
    if (usesDefaultSort && query.cursorCreatedAt) {
      params.push(query.cursorCreatedAt);
      const createdAt = placeholderAt(params.length, this.dialect);
      params.push(query.cursorCreatedAt);
      const tieCreatedAt = placeholderAt(params.length, this.dialect);
      params.push(query.cursor);
      const id = placeholderAt(params.length, this.dialect);
      return `${prefix} (${quoteIdent("created_at", this.dialect)} < ${createdAt} OR (${quoteIdent("created_at", this.dialect)} = ${tieCreatedAt} AND ${quoteIdent("id", this.dialect)} < ${id}))`;
    }
    params.push(query.cursor);
    return `${prefix} ${quoteIdent("id", this.dialect)} > ${placeholderAt(params.length, this.dialect)}`;
  }

  private writeColumns(collectionName: string, data: Record<string, unknown>, partial: boolean): Array<{ name: string; value: unknown }> {
    const collection = this.collection(collectionName);
    const columns: Array<{ name: string; value: unknown }> = [];
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      const column = this.columnName(collectionName, key);
      if (!column) continue;
      const field = collection.fields[key];
      if (field?.kind === "relation" && isManyRelation(field)) continue;
      columns.push({ name: column, value: serializeValue(field, value) });
    }
    if (!partial) {
      if (!columns.some((column) => column.name === "id")) columns.push({ name: "id", value: data.id });
      if (!columns.some((column) => column.name === "created_at")) columns.push({ name: "created_at", value: data.createdAt });
      if (!columns.some((column) => column.name === "updated_at")) columns.push({ name: "updated_at", value: data.updatedAt });
    }
    return columns;
  }

  private columnName(collectionName: string, fieldName: string): string | null {
    if (fieldName === "createdAt") return "created_at";
    if (fieldName === "updatedAt") return "updated_at";
    if (fieldName === "publishedAt") return "published_at";
    if (["id", "status", "locale"].includes(fieldName)) return fieldName;
    const field = this.collection(collectionName).fields[fieldName];
    if (!field) return null;
    if (field.kind === "relation") return isManyRelation(field) ? null : `${fieldName}_id`;
    return toSnakeCase(fieldName);
  }

  private fromRow(collectionName: string, row: Record<string, unknown>): ContentRecord {
    const collection = this.collection(collectionName);
    const record: ContentRecord = {
      id: String(row.id),
      createdAt: String(row.created_at ?? row.createdAt ?? ""),
      updatedAt: String(row.updated_at ?? row.updatedAt ?? "")
    };
    if (typeof row.status === "string") record.status = row.status as ContentStatus;
    if (typeof row.locale === "string") record.locale = row.locale;
    if (typeof row.published_at === "string") record.publishedAt = row.published_at;
    for (const [name, field] of Object.entries(collection.fields)) {
      const column = this.columnName(collectionName, name);
      if (!column || !(column in row)) continue;
      record[name] = deserializeValue(field, row[column]);
    }
    return record;
  }

  private async replaceManyRelations(collectionName: string, id: string, data: Record<string, unknown>): Promise<void> {
    for (const [fieldName, value] of Object.entries(data)) {
      const field = this.collection(collectionName).fields[fieldName];
      if (field?.kind !== "relation" || !isManyRelation(field) || !Array.isArray(value)) continue;
      const endpoints = [collectionName, field.target].sort() as [string, string];
      const [left, right] = endpoints;
      const tableName = `${left}_${right}`;
      const ownerColumn = `${collectionName}_id`;
      const targetColumn = `${field.target}_id`;
      await this.execute(`DELETE FROM ${quoteIdent(tableName, this.dialect)} WHERE ${quoteIdent(ownerColumn, this.dialect)} = ${placeholderAt(1, this.dialect)}`, [id]);
      for (const targetId of value) {
        const params = endpoints[0] === collectionName ? [id, targetId] : [targetId, id];
        await this.execute(
          `INSERT INTO ${quoteIdent(tableName, this.dialect)} (${quoteIdent(left + "_id", this.dialect)}, ${quoteIdent(right + "_id", this.dialect)}) VALUES (${placeholderAt(1, this.dialect)}, ${placeholderAt(2, this.dialect)})`,
          params
        );
      }
      void targetColumn;
    }
  }

  private async query(statement: string, params: readonly unknown[]): Promise<Array<Record<string, unknown>>> {
    if (!this.executor.query) throw new Error("SQL executor does not support query().");
    return (await this.executor.query(statement, params)) as Array<Record<string, unknown>>;
  }

  private async execute(statement: string, params: readonly unknown[]): Promise<void> {
    if (!this.executor.execute) throw new Error("SQL executor does not support execute().");
    await this.executor.execute(statement, params);
  }

  private async countRows(tableName: string, whereSql: string, params: readonly unknown[]): Promise<number> {
    const rows = await this.query(`SELECT COUNT(*) AS total FROM ${quoteIdent(tableName, this.dialect)} ${whereSql}`.trim(), params);
    const total = rows[0]?.total ?? rows[0]?.count ?? rows[0]?.["COUNT(*)"] ?? 0;
    return Number(total);
  }
}

export class PortableDocumentAdapter<Collections extends CMSCollections, Client = unknown> implements DatabaseAdapter<Collections, Client> {
  readonly provider: string;
  readonly collections: Collections;
  readonly client: Client;
  readonly capabilities: NonNullable<DatabaseAdapter<Collections, Client>["capabilities"]>;
  private readonly dialect: AdapterDialect;
  private snapshot: SchemaSnapshot | null;
  private readonly tables = new Map<string, ContentRecord[]>();
  private readonly delegate: DocumentExecutor | null;

  constructor(config: PortableAdapterConfig<Collections, Client> & { delegate?: DocumentExecutor }) {
    this.provider = config.provider;
    this.collections = config.collections;
    this.client = config.client;
    this.dialect = config.dialect;
    this.snapshot = config.snapshot ?? null;
    this.delegate = config.delegate ?? null;
    this.capabilities = {
      transactions: config.dialect !== "convex",
      jsonOperators: true,
      advisoryLocks: config.dialect === "postgres",
      migrations: true,
      populate: true,
      ...config.capabilities
    };
    for (const name of Object.keys(config.collections)) {
      this.tables.set(name, []);
    }
  }

  async list(collection: keyof Collections & string, query?: QueryParams): Promise<PaginatedResult> {
    if (this.delegate) return this.delegate.list(collection, query);
    return applyQuery(this.table(collection), query);
  }

  async get(collection: keyof Collections & string, id: string): Promise<ContentRecord | null> {
    if (this.delegate) return this.delegate.get(collection, id);
    return this.table(collection).find((record) => record.id === id) ?? null;
  }

  async findManyByIds(collection: keyof Collections & string, ids: readonly string[]): Promise<ContentRecord[]> {
    if (this.delegate?.findManyByIds) return this.delegate.findManyByIds(collection, ids);
    const idSet = new Set(ids);
    return this.table(collection).filter((record) => idSet.has(record.id));
  }

  async create(collection: keyof Collections & string, input: Record<string, unknown>): Promise<ContentRecord> {
    if (this.delegate) return this.delegate.create(collection, input);
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
    if (this.delegate) return this.delegate.update(collection, id, patch);
    const table = this.table(collection);
    const index = table.findIndex((record) => record.id === id);
    if (index === -1) throw new Error(`Record "${id}" was not found in "${collection}".`);
    const next = { ...table[index], ...patch, id, updatedAt: new Date().toISOString() } as ContentRecord;
    table[index] = next;
    return next;
  }

  async delete(collection: keyof Collections & string, id: string): Promise<void> {
    if (this.delegate) return this.delegate.delete(collection, id);
    const table = this.table(collection);
    const index = table.findIndex((record) => record.id === id);
    if (index >= 0) table.splice(index, 1);
  }

  async publish(collection: keyof Collections & string, id: string): Promise<ContentRecord> {
    return this.update(collection, id, { status: "published" });
  }

  async unpublish(collection: keyof Collections & string, id: string): Promise<ContentRecord> {
    return this.update(collection, id, { status: "draft" });
  }

  async migrate(schema: Collections): Promise<void> {
    this.snapshot = createSchemaSnapshot(schema);
  }

  async checkDrift(schema: Collections): Promise<SchemaDiff> {
    const plan = planSchemaMigration(this.snapshot, schema);
    return {
      added: plan.changes.filter((change) => change.type === "create_collection" || change.type === "add_field").map(formatChange),
      removed: plan.changes.filter((change) => change.type === "drop_collection" || change.type === "drop_field").map(formatChange),
      altered: plan.changes.filter((change) => change.type === "alter_field").map(formatChange)
    };
  }

  async generateMigration(schema: Collections): Promise<MigrationFile> {
    const filename = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}_${this.provider}_schema`;
    if (this.dialect === "convex") {
      return { filename: `${filename}.ts`, convexSchema: generateConvexSchema(schema) };
    }
    return { filename: `${filename}.sql`, sql: generateSQLSchema(schema, this.dialect) };
  }

  async health(): Promise<HealthStatus> {
    if (this.delegate?.health) return this.delegate.health();
    return { ok: true, details: { provider: this.provider, dialect: this.dialect, collections: Object.keys(this.collections).length } };
  }

  private table(collection: string): ContentRecord[] {
    const table = this.tables.get(collection);
    if (!table) throw new Error(`Unknown collection "${collection}".`);
    return table;
  }
}

export class SqlMediaStore {
  private readonly executor: SqlStatementExecutor;
  private readonly dialect: Exclude<AdapterDialect, "convex">;
  private readonly tableName: string;
  private readonly idFactory: () => string;
  private readonly now: () => string;

  constructor(config: SqlMediaStoreConfig) {
    this.executor = config.executor;
    this.dialect = config.dialect;
    this.tableName = config.tableName ?? "hono_cms_media";
    this.idFactory = config.idFactory ?? (() => crypto.randomUUID());
    this.now = config.now ?? (() => new Date().toISOString());
  }

  async list(query: { cursor?: string; limit?: number } = {}): Promise<{ items: SqlMediaRecord[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const params: unknown[] = [];
    const where = query.cursor ? `WHERE ${quoteIdent("id", this.dialect)} > ${placeholder(params, this.dialect)}` : "";
    if (query.cursor) params.push(query.cursor);
    params.push(limit + 1);
    const rows = await this.query([
      `SELECT * FROM ${quoteIdent(this.tableName, this.dialect)}`,
      where,
      `ORDER BY ${quoteIdent("created_at", this.dialect)} DESC`,
      `LIMIT ${placeholder(params, this.dialect)}`
    ].filter(Boolean).join(" "), params);
    const items = rows.slice(0, limit).map(mediaFromRow);
    const last = items.at(-1);
    return rows.length > limit && last ? { items, nextCursor: last.id } : { items };
  }

  async get(id: string): Promise<SqlMediaRecord | null> {
    const row = (await this.query(
      `SELECT * FROM ${quoteIdent(this.tableName, this.dialect)} WHERE ${quoteIdent("id", this.dialect)} = ${placeholderAt(1, this.dialect)} LIMIT 1`,
      [id]
    ))[0];
    return row ? mediaFromRow(row) : null;
  }

  async create(input: Omit<SqlMediaRecord, "id" | "createdAt" | "updatedAt">): Promise<SqlMediaRecord> {
    const now = this.now();
    const record: SqlMediaRecord = { ...input, id: this.idFactory(), createdAt: now, updatedAt: now };
    const columns: Array<{ name: string; value: unknown }> = [
      { name: "id", value: record.id },
      { name: "key", value: record.key },
      { name: "url", value: record.url },
      { name: "filename", value: record.filename },
      { name: "size", value: record.size },
      { name: "content_type", value: record.contentType ?? null },
      { name: "metadata", value: record.metadata ? JSON.stringify(record.metadata) : null },
      { name: "created_at", value: record.createdAt },
      { name: "updated_at", value: record.updatedAt }
    ];
    const names = columns.map((column) => quoteIdent(column.name, this.dialect)).join(", ");
    const placeholders = columns.map((_, index) => placeholderAt(index + 1, this.dialect)).join(", ");
    await this.execute(`INSERT INTO ${quoteIdent(this.tableName, this.dialect)} (${names}) VALUES (${placeholders})`, columns.map((column) => column.value));
    return record;
  }

  async delete(id: string): Promise<SqlMediaRecord | null> {
    const record = await this.get(id);
    await this.execute(`DELETE FROM ${quoteIdent(this.tableName, this.dialect)} WHERE ${quoteIdent("id", this.dialect)} = ${placeholderAt(1, this.dialect)}`, [id]);
    return record;
  }

  async health(): Promise<HealthStatus> {
    await this.query(`SELECT 1 AS ok FROM ${quoteIdent(this.tableName, this.dialect)} LIMIT 1`, []);
    return { ok: true, details: { table: this.tableName, dialect: this.dialect } };
  }

  private async query(statement: string, params: readonly unknown[]): Promise<Array<Record<string, unknown>>> {
    if (!this.executor.query) throw new Error("SQL executor does not support query().");
    return (await this.executor.query(statement, params)) as Array<Record<string, unknown>>;
  }

  private async execute(statement: string, params: readonly unknown[]): Promise<void> {
    if (!this.executor.execute) throw new Error("SQL executor does not support execute().");
    await this.executor.execute(statement, params);
  }
}

export function generateSQLSchema(collections: CMSCollections, dialect: Exclude<AdapterDialect, "convex">): string {
  const tableStatements = Object.values(collections).map((collection) => {
    const columns = [
      "id TEXT PRIMARY KEY",
      "created_at TEXT NOT NULL",
      "updated_at TEXT NOT NULL",
      collection.options.draftAndPublish ? "status TEXT NOT NULL DEFAULT 'draft'" : null,
      collection.options.draftAndPublish ? "published_at TEXT" : null,
      ...Object.entries(collection.fields).flatMap(([name, field]) => sqlColumns(name, field, dialect))
    ].filter(Boolean);
    const table = quoteIdent(collection.name, dialect);
    const statements = [`CREATE TABLE IF NOT EXISTS ${table} (\n  ${columns.join(",\n  ")}\n);`];
    if (collection.options.draftAndPublish) {
      statements.push(`CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${collection.name}_status_id`, dialect)} ON ${table} (${quoteIdent("status", dialect)}, ${quoteIdent("id", dialect)});`);
      statements.push(`CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${collection.name}_published_at`, dialect)} ON ${table} (${quoteIdent("published_at", dialect)});`);
    }
    statements.push(`CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${collection.name}_created_at_id`, dialect)} ON ${table} (${quoteIdent("created_at", dialect)}, ${quoteIdent("id", dialect)});`);
    return statements.join("\n");
  });
  return [...tableStatements, mediaTableStatement(dialect), ...joinTableStatements(collections, dialect)].join("\n\n");
}

export function generateConvexSchema(collections: CMSCollections): string {
  const body = Object.values(collections).map((collection) => {
    const fields = Object.entries(collection.fields)
      .map(([name, field]) => `    ${JSON.stringify(name)}: ${convexField(field)},`)
      .join("\n");
    return `  ${collection.name}: defineTable({\n${fields}\n  }),`;
  }).join("\n");
  return `import { defineSchema, defineTable } from "convex/server";\nimport { v } from "convex/values";\n\nexport default defineSchema({\n${body}\n});\n`;
}

export function assertCapability(provider: string, supported: boolean, capability: string): void {
  if (!supported) throw new AdapterCapabilityError(provider, capability);
}

function applyQuery(records: ContentRecord[], query: QueryParams = {}): PaginatedResult {
  const limit = Math.min(Math.max(query.pageSize ?? query.limit ?? 25, 1), 100);
  let rows = [...records];
  if (query.status) rows = rows.filter((record) => record.status === query.status);
  if (query.locale) rows = rows.filter((record) => record.locale === query.locale);
  for (const [key, filter] of Object.entries(query.filters ?? {})) {
    rows = rows.filter((record) => matches(record[key], filter));
  }
  if (query.sort) {
    const descending = query.sort.startsWith("-");
    const field = descending ? query.sort.slice(1) : query.sort;
    rows.sort((a, b) => String(a[field] ?? "").localeCompare(String(b[field] ?? "")) * (descending ? -1 : 1));
  }
  const start = query.cursor ? cursorStart(rows, query) : Math.max((query.page ?? 1) - 1, 0) * limit;
  const items = rows.slice(start, start + limit);
  const last = items.at(-1);
  return start + limit < rows.length && last ? { items, nextCursor: last.id, total: rows.length } : { items, total: rows.length };
}

function cursorStart(rows: ContentRecord[], query: QueryParams): number {
  if (query.cursorCreatedAt) {
    const exactIndex = rows.findIndex((record) => record.id === query.cursor && record.createdAt === query.cursorCreatedAt);
    if (exactIndex >= 0) return exactIndex + 1;
  }
  return Math.max(rows.findIndex((record) => record.id === query.cursor) + 1, 0);
}

function matches(value: unknown, filter: unknown): boolean {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return value === filter;
  return Object.entries(filter).every(([operator, expected]) => {
    switch (operator) {
      case "$eq": return value === expected;
      case "$ne": return value !== expected;
      case "$contains": return String(value ?? "").includes(String(expected));
      case "$startsWith": return String(value ?? "").startsWith(String(expected));
      case "$endsWith": return String(value ?? "").endsWith(String(expected));
      case "$gt": return Number(value) > Number(expected);
      case "$gte": return Number(value) >= Number(expected);
      case "$lt": return Number(value) < Number(expected);
      case "$lte": return Number(value) <= Number(expected);
      case "$in": return Array.isArray(expected) && expected.includes(value);
      default: return false;
    }
  });
}

function sqlColumns(name: string, field: FieldDefinition, dialect: Exclude<AdapterDialect, "convex">): string[] {
  const column = quoteIdent(field.kind === "relation" ? `${name}_id` : name, dialect);
  const required = field.required ? " NOT NULL" : "";
  switch (field.kind) {
    case "number":
      return [`${column} ${field.int ? "INTEGER" : "REAL"}${required}`];
    case "boolean":
      return [`${column} ${dialect === "postgres" ? "BOOLEAN" : "INTEGER"}${required}`];
    case "json":
      return [`${column} ${dialect === "postgres" ? "JSONB" : "TEXT"}${required}`];
    case "datetime":
      return [`${column} TEXT${required}`];
    case "relation":
      return isManyRelation(field)
        ? []
        : [`${column} TEXT${required} REFERENCES ${quoteIdent(field.target, dialect)}(id) ON DELETE ${onDelete(field.onDelete)}`];
    default:
      return [`${column} TEXT${required}`];
  }
}

export function createSqlDocumentExecutor<Collections extends CMSCollections>(config: SqlDocumentExecutorConfig<Collections>): SqlDocumentExecutor<Collections> {
  return new SqlDocumentExecutor(config);
}

export function createSqlMediaStore(config: SqlMediaStoreConfig): SqlMediaStore {
  return new SqlMediaStore(config);
}

function filterClause(column: string, filter: unknown, params: unknown[], dialect: Exclude<AdapterDialect, "convex">): string {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    params.push(filter);
    return `${column} = ${placeholderAt(params.length, dialect)}`;
  }
  const clauses = Object.entries(filter).map(([operator, expected]) => {
    if (operator === "$in" && Array.isArray(expected)) {
      const placeholders = expected.map((value) => {
        params.push(value);
        return placeholderAt(params.length, dialect);
      }).join(", ");
      return `${column} IN (${placeholders})`;
    }
    params.push(operator === "$contains" ? `%${expected}%` : operator === "$startsWith" ? `${expected}%` : operator === "$endsWith" ? `%${expected}` : expected);
    const value = placeholderAt(params.length, dialect);
    switch (operator) {
      case "$eq": return `${column} = ${value}`;
      case "$ne": return `${column} <> ${value}`;
      case "$contains":
      case "$startsWith":
      case "$endsWith": return `${column} LIKE ${value}`;
      case "$gt": return `${column} > ${value}`;
      case "$gte": return `${column} >= ${value}`;
      case "$lt": return `${column} < ${value}`;
      case "$lte": return `${column} <= ${value}`;
      default: return "1 = 0";
    }
  });
  return `(${clauses.join(" AND ")})`;
}

function placeholder(params: readonly unknown[], dialect: Exclude<AdapterDialect, "convex">): string {
  return placeholderAt(params.length + 1, dialect);
}

function placeholderAt(index: number, dialect: Exclude<AdapterDialect, "convex">): string {
  return dialect === "postgres" ? `$${index}` : "?";
}

function serializeValue(field: FieldDefinition | undefined, value: unknown): unknown {
  if (field?.kind === "json" || field?.kind === "media") return JSON.stringify(value);
  if (field?.kind === "boolean") return typeof value === "boolean" ? (value ? 1 : 0) : value;
  return value;
}

function deserializeValue(field: FieldDefinition, value: unknown): unknown {
  if (value == null) return value;
  if (field.kind === "json" || field.kind === "media") {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (field.kind === "boolean") return value === true || value === 1;
  return value;
}

function toSnakeCase(value: string): string {
  return value.replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function joinTableStatements(collections: CMSCollections, dialect: Exclude<AdapterDialect, "convex">): string[] {
  const seen = new Set<string>();
  const statements: string[] = [];
  for (const collection of Object.values(collections)) {
    for (const field of Object.values(collection.fields)) {
      if (field.kind !== "relation" || !isManyRelation(field)) continue;
      const endpoints = [collection.name, field.target].sort() as [string, string];
      const [left, right] = endpoints;
      const tableName = `${left}_${right}`;
      if (seen.has(tableName)) continue;
      seen.add(tableName);
      statements.push([
        `CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName, dialect)} (`,
        `  ${quoteIdent(`${left}_id`, dialect)} TEXT NOT NULL REFERENCES ${quoteIdent(left, dialect)}(id) ON DELETE CASCADE,`,
        `  ${quoteIdent(`${right}_id`, dialect)} TEXT NOT NULL REFERENCES ${quoteIdent(right, dialect)}(id) ON DELETE CASCADE,`,
        `  PRIMARY KEY (${quoteIdent(`${left}_id`, dialect)}, ${quoteIdent(`${right}_id`, dialect)})`,
        ");"
      ].join("\n"));
    }
  }
  return statements;
}

function mediaTableStatement(dialect: Exclude<AdapterDialect, "convex">): string {
  const metadataType = dialect === "postgres" ? "JSONB" : "TEXT";
  const table = quoteIdent("hono_cms_media", dialect);
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    `  ${quoteIdent("id", dialect)} TEXT PRIMARY KEY,`,
    `  ${quoteIdent("key", dialect)} TEXT NOT NULL UNIQUE,`,
    `  ${quoteIdent("url", dialect)} TEXT NOT NULL,`,
    `  ${quoteIdent("filename", dialect)} TEXT NOT NULL,`,
    `  ${quoteIdent("size", dialect)} INTEGER NOT NULL,`,
    `  ${quoteIdent("content_type", dialect)} TEXT,`,
    `  ${quoteIdent("metadata", dialect)} ${metadataType},`,
    `  ${quoteIdent("created_at", dialect)} TEXT NOT NULL,`,
    `  ${quoteIdent("updated_at", dialect)} TEXT NOT NULL`,
    ");",
    `CREATE INDEX IF NOT EXISTS ${quoteIdent("idx_hono_cms_media_created_at", dialect)} ON ${table} (${quoteIdent("created_at", dialect)});`
  ].join("\n");
}

function mediaFromRow(row: Record<string, unknown>): SqlMediaRecord {
  const record: SqlMediaRecord = {
    id: String(row.id),
    key: String(row.key),
    url: String(row.url),
    filename: String(row.filename),
    size: Number(row.size),
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
    updatedAt: String(row.updated_at ?? row.updatedAt ?? "")
  };
  if (typeof row.content_type === "string") record.contentType = row.content_type;
  const metadata = parseMetadata(row.metadata);
  if (metadata) record.metadata = metadata;
  return record;
}

function parseMetadata(value: unknown): Record<string, string> | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]))
      : null;
  } catch {
    return null;
  }
}

function convexField(field: FieldDefinition): string {
  const wrap = (value: string) => field.required ? value : `v.optional(${value})`;
  switch (field.kind) {
    case "number": return wrap("v.number()");
    case "boolean": return wrap("v.boolean()");
    case "json": return wrap("v.any()");
    case "relation": return wrap(isManyRelation(field) ? "v.array(v.string())" : "v.string()");
    default: return wrap("v.string()");
  }
}

function quoteIdent(value: string, dialect: Exclude<AdapterDialect, "convex">): string {
  return dialect === "postgres" ? `"${value.replaceAll('"', '""')}"` : `"${value.replaceAll('"', '""')}"`;
}

function onDelete(value: "cascade" | "restrict" | "set_null" | undefined): string {
  if (value === "cascade") return "CASCADE";
  if (value === "set_null") return "SET NULL";
  return "RESTRICT";
}

function formatChange(change: { type: string; collection: string; field?: string }): string {
  return change.field ? `${change.collection}.${change.field}` : change.collection;
}
