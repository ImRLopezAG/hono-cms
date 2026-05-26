import { expect, test } from "vitest";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { createPostgresAdapter, detectPostgresMode } from "../index";

const collections = defineSchema({
  articles: defineCollection("articles", {
    title: fields.string({ required: true }),
    meta: fields.json()
  })
});

test("Postgres adapter detects modes and emits Postgres migrations", async () => {
  expect(detectPostgresMode("postgres://demo.neon.tech/db")).toBe("http");
  const adapter = createPostgresAdapter({ provider: "postgres", collections, mode: "http" });
  expect(adapter.mode).toBe("http");
  expect(adapter.capabilities.advisoryLocks).toBe(false);
  await expect(adapter.generateMigration(collections)).resolves.toMatchObject({ sql: expect.stringContaining("JSONB") });
});

test("Postgres adapter uses SQL client with numbered placeholders", async () => {
  const client = new RecordingClient([{ id: "pg-1", title: "Postgres", meta: "{\"ok\":true}", created_at: "now", updated_at: "now" }]);
  const adapter = createPostgresAdapter({ provider: "postgres", collections, mode: "tcp", client });
  const record = await adapter.create("articles", { id: "pg-1", title: "Postgres", meta: { ok: true } });
  expect(record).toMatchObject({ id: "pg-1", title: "Postgres", meta: { ok: true } });
  expect(client.statements[0]).toContain("VALUES ($1, $2, $3, $4, $5)");
  expect(client.statements[1]).toContain("\"id\" = $1");
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
    return { rowCount: 1 };
  }
}
