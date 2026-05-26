import { expect, test } from "vitest";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { createTursoAdapter } from "../index";

const collections = defineSchema({
  articles: defineCollection("articles", { title: fields.string({ required: true }) })
});

test("Turso adapter supports local and sync configuration", async () => {
  const adapter = createTursoAdapter({ provider: "turso", collections, url: "file::memory:", syncUrl: "libsql://remote.turso.io" });
  expect(adapter.url).toBe("file::memory:");
  expect(adapter.syncUrl).toBe("libsql://remote.turso.io");
  const record = await adapter.create("articles", { title: "Turso" });
  await expect(adapter.get("articles", record.id)).resolves.toMatchObject({ title: "Turso" });
});

test("Turso adapter uses SQL client when provided", async () => {
  const client = new RecordingClient([{ id: "turso-1", title: "Turso SQL", created_at: "now", updated_at: "now" }]);
  const adapter = createTursoAdapter({ provider: "turso", collections, client });
  const record = await adapter.create("articles", { id: "turso-1", title: "Turso SQL" });
  expect(record).toMatchObject({ id: "turso-1", title: "Turso SQL" });
  expect(client.statements[0]).toContain("INSERT INTO \"articles\"");
  expect(client.statements[1]).toContain("WHERE \"id\" = ?");
});

class RecordingClient {
  readonly statements: string[] = [];
  constructor(private readonly rows: Array<Record<string, unknown>>) {}

  async query(statement: string): Promise<unknown[]> {
    this.statements.push(statement);
    return this.rows;
  }

  async execute(statement: string): Promise<unknown> {
    this.statements.push(statement);
    return { rowsAffected: 1 };
  }
}
