import { expect, test } from "vitest";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { createCMS } from "@hono-cms/core";
import { createD1Adapter } from "../index";

const collections = defineSchema({
  articles: defineCollection("articles", { title: fields.string({ required: true }) })
});

test("D1 adapter registers and works through createCMS", async () => {
  const cms = createCMS({
    collections,
    db: createD1Adapter({ provider: "d1", collections }),
    auth: { tokens: { admin: { userId: "1", roles: ["admin"] } } },
    rbac: { publicRead: true }
  });

  const response = await cms.fetch(new Request("https://cms.test/api/articles", {
    method: "POST",
    headers: { authorization: "Bearer admin", "content-type": "application/json" },
    body: JSON.stringify({ title: "D1" })
  }));
  expect(response.status).toBe(201);
  await expect(cms.db.generateMigration?.(collections)).resolves.toMatchObject({ sql: expect.stringContaining("CREATE TABLE") });
});

test("D1 adapter delegates to a real binding when provided", async () => {
  const binding = new FakeD1Binding([{ id: "d1-1", title: "D1 SQL", created_at: "now", updated_at: "now" }]);
  const adapter = createD1Adapter({ provider: "d1", collections, binding });
  const record = await adapter.create("articles", { id: "d1-1", title: "D1 SQL" });
  expect(record).toMatchObject({ id: "d1-1", title: "D1 SQL" });
  expect(binding.statements.some((statement) => statement.includes("INSERT INTO \"articles\""))).toBe(true);
  expect(binding.statements.some((statement) => statement.includes("SELECT * FROM \"articles\""))).toBe(true);
});

class FakeD1Binding {
  readonly statements: string[] = [];
  constructor(private readonly rows: Array<Record<string, unknown>>) {}

  prepare(statement: string) {
    this.statements.push(statement);
    return {
      bind: (..._values: unknown[]) => ({
        all: async <T = unknown>() => ({ results: this.rows as T[] }),
        run: async () => ({ success: true })
      })
    };
  }
}
