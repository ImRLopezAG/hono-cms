import type { HealthStatus } from "@hono-cms/schema";
import type { LocaleVariant, TranslationStore } from "../types/providers";

export type DrizzleTranslationStoreDialect = "sqlite" | "postgres";

export type CreateDrizzleTranslationStoreOptions = {
  dialect: DrizzleTranslationStoreDialect;
  tableName?: string;
};

type LocaleVariantRow = {
  id: string;
  collection: string;
  documentId: string;
  locale: string;
  fields: string;
  status: string;
  translatedBy: string;
  sourceUpdatedAt: string | null;
  error: string | null;
  provider: string | null;
  translatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Creates a Drizzle-backed {@link TranslationStore}. Two dialects are supported:
 * `sqlite` (`drizzle-orm/sqlite-core`) and `postgres` (`drizzle-orm/pg-core`).
 *
 * The required table is *not* created here — adapter consumers should run the
 * matching migration emitted by `@hono-cms/schema`'s drizzle generator. The
 * factory only builds an in-memory table reference for query construction.
 */
export function createDrizzleTranslationStore(
  db: any,
  options: CreateDrizzleTranslationStoreOptions
): TranslationStore {
  const tableName = options.tableName ?? "locale_variants";
  const dialect = options.dialect;

  // Lazy loaders – the drizzle subpath chosen depends on dialect, so we only
  // import the one we actually use. The returned promises are cached so repeat
  // calls don't re-import the module on every query.
  let cached: Promise<DrizzleTable> | null = null;
  const getTable = (): Promise<DrizzleTable> => {
    if (!cached) cached = loadTable(dialect, tableName);
    return cached;
  };

  // Helpers ---------------------------------------------------------------

  const rowToVariant = (row: LocaleVariantRow): LocaleVariant => ({
    id: row.id,
    collection: row.collection,
    documentId: row.documentId,
    locale: row.locale,
    fields: parseFields(row.fields),
    status: row.status as LocaleVariant["status"],
    translatedBy: row.translatedBy as LocaleVariant["translatedBy"],
    sourceUpdatedAt: row.sourceUpdatedAt ?? undefined,
    error: row.error ?? undefined,
    provider: row.provider ?? undefined,
    translatedAt: row.translatedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  });

  // Store implementation --------------------------------------------------

  return {
    async getVariant(collection, documentId, locale) {
      const { table, and, eq } = await getTable();
      const rows = (await db
        .select()
        .from(table)
        .where(
          and(
            eq(table.collection, collection),
            eq(table.documentId, documentId),
            eq(table.locale, locale)
          )
        )
        .limit(1)) as LocaleVariantRow[];
      const row = rows[0];
      return row ? rowToVariant(row) : null;
    },

    async listVariants(collection, documentId) {
      const { table, and, eq, asc } = await getTable();
      const rows = (await db
        .select()
        .from(table)
        .where(and(eq(table.collection, collection), eq(table.documentId, documentId)))
        .orderBy(asc(table.locale))) as LocaleVariantRow[];
      return rows.map(rowToVariant);
    },

    async upsertVariant(input) {
      const { table, and, eq } = await getTable();
      const now = new Date().toISOString();
      const existingRows = (await db
        .select()
        .from(table)
        .where(
          and(
            eq(table.collection, input.collection),
            eq(table.documentId, input.documentId),
            eq(table.locale, input.locale)
          )
        )
        .limit(1)) as LocaleVariantRow[];
      const existing = existingRows[0];

      if (!existing) {
        const fields = input.fields ?? {};
        const row: LocaleVariantRow = {
          id: crypto.randomUUID(),
          collection: input.collection,
          documentId: input.documentId,
          locale: input.locale,
          fields: JSON.stringify(fields),
          status: input.status,
          translatedBy: input.translatedBy,
          sourceUpdatedAt: input.sourceUpdatedAt ?? null,
          error: input.error ?? null,
          provider: input.provider ?? null,
          translatedAt: input.translatedAt ?? null,
          createdAt: now,
          updatedAt: now
        };
        await db.insert(table).values(row);
        return rowToVariant(row);
      }

      const mergedFields = input.fields ?? parseFields(existing.fields);
      const row: LocaleVariantRow = {
        id: existing.id,
        collection: existing.collection,
        documentId: existing.documentId,
        locale: existing.locale,
        fields: JSON.stringify(mergedFields),
        status: input.status,
        translatedBy: input.translatedBy,
        sourceUpdatedAt: input.sourceUpdatedAt ?? existing.sourceUpdatedAt,
        error: input.error ?? null,
        provider: input.provider ?? existing.provider,
        translatedAt: input.translatedAt ?? existing.translatedAt,
        createdAt: existing.createdAt,
        updatedAt: now
      };
      await db
        .update(table)
        .set({
          fields: row.fields,
          status: row.status,
          translatedBy: row.translatedBy,
          sourceUpdatedAt: row.sourceUpdatedAt,
          error: row.error,
          provider: row.provider,
          translatedAt: row.translatedAt,
          updatedAt: row.updatedAt
        })
        .where(eq(table.id, existing.id));
      return rowToVariant(row);
    },

    async health(): Promise<HealthStatus> {
      try {
        const { sql } = await getTable();
        await db.execute ? await db.execute(sql`SELECT 1`) : await db.run(sql`SELECT 1`);
        return { ok: true, status: "pass" } as HealthStatus & { status: "pass" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, status: "fail", message } as HealthStatus & { status: "fail" };
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type DrizzleTable = {
  table: any;
  and: (...args: any[]) => any;
  eq: (...args: any[]) => any;
  asc: (...args: any[]) => any;
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => any;
};

async function loadTable(
  dialect: DrizzleTranslationStoreDialect,
  tableName: string
): Promise<DrizzleTable> {
  const drizzleCore = await import("drizzle-orm");
  const { and, eq, asc, sql } = drizzleCore as {
    and: (...args: any[]) => any;
    eq: (...args: any[]) => any;
    asc: (...args: any[]) => any;
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => any;
  };

  if (dialect === "postgres") {
    const pg = await import("drizzle-orm/pg-core");
    const { pgTable, text, uniqueIndex } = pg as {
      pgTable: (name: string, columns: Record<string, unknown>, extras?: (table: any) => Record<string, unknown>) => any;
      text: (name: string) => { notNull: () => any; primaryKey: () => any };
      uniqueIndex: (name: string) => { on: (...columns: unknown[]) => any };
    };
    const table = pgTable(
      tableName,
      {
        id: text("id").primaryKey(),
        collection: text("collection").notNull(),
        documentId: text("document_id").notNull(),
        locale: text("locale").notNull(),
        fields: text("fields").notNull(),
        status: text("status").notNull(),
        translatedBy: text("translated_by").notNull(),
        sourceUpdatedAt: text("source_updated_at"),
        error: text("error"),
        provider: text("provider"),
        translatedAt: text("translated_at"),
        createdAt: text("created_at").notNull(),
        updatedAt: text("updated_at").notNull()
      },
      (t: any) => ({
        collectionDocumentLocaleUnique: uniqueIndex(`${tableName}_collection_document_locale_uq`).on(
          t.collection,
          t.documentId,
          t.locale
        )
      })
    );
    return { table, and, eq, asc, sql };
  }

  const sqliteCore = await import("drizzle-orm/sqlite-core");
  const { sqliteTable, text, uniqueIndex } = sqliteCore as {
    sqliteTable: (name: string, columns: Record<string, unknown>, extras?: (table: any) => Record<string, unknown>) => any;
    text: (name: string) => { notNull: () => any; primaryKey: () => any };
    uniqueIndex: (name: string) => { on: (...columns: unknown[]) => any };
  };
  const table = sqliteTable(
    tableName,
    {
      id: text("id").primaryKey(),
      collection: text("collection").notNull(),
      documentId: text("document_id").notNull(),
      locale: text("locale").notNull(),
      fields: text("fields").notNull(),
      status: text("status").notNull(),
      translatedBy: text("translated_by").notNull(),
      sourceUpdatedAt: text("source_updated_at"),
      error: text("error"),
      provider: text("provider"),
      translatedAt: text("translated_at"),
      createdAt: text("created_at").notNull(),
      updatedAt: text("updated_at").notNull()
    },
    (t: any) => ({
      collectionDocumentLocaleUnique: uniqueIndex(`${tableName}_collection_document_locale_uq`).on(
        t.collection,
        t.documentId,
        t.locale
      )
    })
  );
  return { table, and, eq, asc, sql };
}

function parseFields(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
