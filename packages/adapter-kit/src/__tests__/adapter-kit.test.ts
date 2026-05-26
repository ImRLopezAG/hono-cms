import { describe, expect, test } from "vitest";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { createSqlDocumentExecutor, createSqlMediaStore, generateConvexSchema, generateSQLSchema, PortableDocumentAdapter, type SqlStatementExecutor } from "../index";

const collections = defineSchema({
  authors: defineCollection("authors", {
    name: fields.string({ required: true })
  }),
  articles: defineCollection("articles", {
    title: fields.string({ required: true }),
    body: fields.text(),
    meta: fields.json(),
    author: fields.relation("authors", "many-to-one", { onDelete: "cascade" }),
    tags: fields.relation("tags", "many-to-many")
  }, { draftAndPublish: true }),
  tags: defineCollection("tags", {
    name: fields.string({ required: true }),
    articles: fields.relation("articles", "many-to-many")
  }, { draftAndPublish: true })
});

describe("adapter kit", () => {
  test("generates dialect-specific schema artifacts", () => {
    expect(generateSQLSchema(collections, "sqlite")).toContain("CREATE TABLE IF NOT EXISTS \"articles\"");
    expect(generateSQLSchema(collections, "sqlite")).toContain("CREATE TABLE IF NOT EXISTS \"hono_cms_media\"");
    expect(generateSQLSchema(collections, "sqlite")).toContain("\"key\" TEXT NOT NULL UNIQUE");
    expect(generateSQLSchema(collections, "sqlite")).toContain("published_at TEXT");
    expect(generateSQLSchema(collections, "sqlite")).toContain("idx_articles_status_id");
    expect(generateSQLSchema(collections, "sqlite").match(/CREATE TABLE IF NOT EXISTS "articles_tags"/g)).toHaveLength(1);
    const articleTable = generateSQLSchema(collections, "sqlite").split("CREATE TABLE IF NOT EXISTS \"tags\"")[0];
    expect(articleTable).not.toContain("\"tags_id\" TEXT");
    expect(generateSQLSchema(collections, "postgres")).toContain("JSONB");
    expect(generateConvexSchema(collections)).toContain("defineTable");
  });

  test("provides portable CRUD and drift helpers", async () => {
    const adapter = new PortableDocumentAdapter({ provider: "test", collections, client: null, dialect: "sqlite" });
    const author = await adapter.create("authors", { name: "Ada" });
    const article = await adapter.create("articles", { title: "Hello", author: author.id });
    await expect(adapter.list("articles", { filters: { title: { $contains: "ell" } } })).resolves.toMatchObject({ items: [{ id: article.id }] });
    await expect(adapter.findManyByIds("articles", [article.id])).resolves.toHaveLength(1);
    await expect(adapter.generateMigration(collections)).resolves.toMatchObject({ filename: expect.stringContaining(".sql") });
    await expect(adapter.checkDrift(collections)).resolves.toMatchObject({ added: expect.arrayContaining(["authors", "articles"]) });
    await adapter.migrate(collections);
    await expect(adapter.checkDrift(collections)).resolves.toEqual({ added: [], removed: [], altered: [] });
  });

  test("executes SQL CRUD with row mapping, filters, and many relation joins", async () => {
    const executor = new RecordingExecutor([
      [{ id: "article-1", title: "Hello", meta: "{\"views\":3}", author_id: "author-1", status: "draft", created_at: "now", updated_at: "now" }],
      [{ id: "article-1", title: "Hello", meta: "{\"views\":3}", author_id: "author-1", status: "draft", created_at: "now", updated_at: "later" }],
      [{ total: 12 }],
      [{ id: "article-1", title: "Hello", meta: "{\"views\":3}", author_id: "author-1", status: "draft", created_at: "now", updated_at: "later" }]
    ]);
    const sql = createSqlDocumentExecutor({
      collections,
      executor,
      dialect: "sqlite",
      idFactory: () => "article-1",
      now: () => "now"
    });

    const created = await sql.create("articles", {
      title: "Hello",
      meta: { views: 3 },
      author: "author-1",
      tags: ["tag-1", "tag-2"]
    });
    expect(created).toMatchObject({ id: "article-1", title: "Hello", meta: { views: 3 }, author: "author-1", status: "draft" });
    expect(executor.statements).toEqual(expect.arrayContaining([
      expect.objectContaining({ statement: expect.stringContaining("INSERT INTO \"articles\"") }),
      expect.objectContaining({ statement: expect.stringContaining("DELETE FROM \"articles_tags\"") }),
      expect.objectContaining({ statement: expect.stringContaining("INSERT INTO \"articles_tags\"") })
    ]));

    await sql.update("articles", "article-1", { title: "Updated" });
    await expect(sql.list("articles", { status: "draft", filters: { title: { $contains: "Hell" } }, sort: "-createdAt", page: 2, pageSize: 5 })).resolves.toMatchObject({ total: 12 });
    expect(executor.statements.at(-1)).toMatchObject({
      statement: expect.stringContaining("\"title\" LIKE ?"),
      params: ["draft", "%Hell%", 6, 5]
    });
    expect(executor.statements.at(-1)?.statement).toContain("OFFSET ?");
    expect(executor.statements.at(-2)).toMatchObject({
      statement: expect.stringContaining("SELECT COUNT(*) AS total FROM \"articles\""),
      params: ["draft", "%Hell%"]
    });
  });

  test("uses numbered placeholders for Postgres clients", async () => {
    const executor = new RecordingExecutor([[{ id: "article-1", title: "Hello", created_at: "now", updated_at: "now" }]]);
    const sql = createSqlDocumentExecutor({ collections, executor, dialect: "postgres" });
    await sql.get("articles", "article-1");
    expect(executor.statements[0]?.statement).toContain("\"id\" = $1");
  });

  test("uses createdAt/id keyset cursors for default SQL pagination", async () => {
    const executor = new RecordingExecutor([
      [
        { id: "article-b", title: "Second", created_at: "2026-05-22T10:00:00.000Z", updated_at: "now" },
        { id: "article-a", title: "First", created_at: "2026-05-22T10:00:00.000Z", updated_at: "now" }
      ]
    ]);
    const sql = createSqlDocumentExecutor({ collections, executor, dialect: "sqlite" });

    await expect(sql.list("articles", {
      limit: 1,
      cursor: "article-c",
      cursorCreatedAt: "2026-05-22T10:00:00.000Z"
    })).resolves.toMatchObject({
      items: [{ id: "article-b" }],
      nextCursor: "article-b"
    });

    expect(executor.statements[0]).toMatchObject({
      statement: expect.stringContaining("\"created_at\" < ? OR (\"created_at\" = ? AND \"id\" < ?)"),
      params: ["2026-05-22T10:00:00.000Z", "2026-05-22T10:00:00.000Z", "article-c", 2]
    });
    expect(executor.statements[0]?.statement).toContain("ORDER BY \"created_at\" DESC, \"id\" DESC");
  });

  test("executes SQL media metadata CRUD with pagination", async () => {
    const executor = new RecordingExecutor([
      [
        {
          id: "media-1",
          key: "media/file.txt",
          url: "https://cdn.test/media/file.txt",
          filename: "file.txt",
          size: 12,
          content_type: "text/plain",
          metadata: "{\"alt\":\"File\"}",
          created_at: "2026-01-02T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z"
        },
        {
          id: "media-0",
          key: "media/old.txt",
          url: "https://cdn.test/media/old.txt",
          filename: "old.txt",
          size: 8,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z"
        }
      ],
      [{
        id: "media-1",
        key: "media/file.txt",
        url: "https://cdn.test/media/file.txt",
        filename: "file.txt",
        size: 12,
        content_type: "text/plain",
        metadata: "{\"alt\":\"File\"}",
        created_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z"
      }]
    ]);
    const store = createSqlMediaStore({
      executor,
      dialect: "sqlite",
      idFactory: () => "media-1",
      now: () => "2026-01-02T00:00:00.000Z"
    });

    const created = await store.create({
      key: "media/file.txt",
      url: "https://cdn.test/media/file.txt",
      filename: "file.txt",
      size: 12,
      contentType: "text/plain",
      metadata: { alt: "File" }
    });
    expect(created).toMatchObject({ id: "media-1", filename: "file.txt", contentType: "text/plain", metadata: { alt: "File" } });
    expect(executor.statements[0]).toMatchObject({
      statement: expect.stringContaining("INSERT INTO \"hono_cms_media\""),
      params: expect.arrayContaining(["media-1", "media/file.txt", "{\"alt\":\"File\"}"])
    });

    await expect(store.list({ limit: 1 })).resolves.toMatchObject({
      items: [{ id: "media-1", filename: "file.txt", metadata: { alt: "File" } }],
      nextCursor: "media-1"
    });
    await expect(store.delete("media-1")).resolves.toMatchObject({ id: "media-1", key: "media/file.txt" });
    expect(executor.statements.at(-1)).toMatchObject({
      statement: expect.stringContaining("DELETE FROM \"hono_cms_media\""),
      params: ["media-1"]
    });
  });
});

class RecordingExecutor implements SqlStatementExecutor {
  readonly statements: Array<{ statement: string; params: readonly unknown[] }> = [];
  constructor(private readonly queryResults: unknown[][] = []) {}

  async query(statement: string, params: readonly unknown[] = []): Promise<unknown[]> {
    this.statements.push({ statement, params });
    return this.queryResults.shift() ?? [];
  }

  async execute(statement: string, params: readonly unknown[] = []): Promise<unknown> {
    this.statements.push({ statement, params });
    return { ok: true };
  }
}
