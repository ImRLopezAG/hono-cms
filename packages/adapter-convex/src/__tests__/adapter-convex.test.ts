import { expect, test } from "vitest";
import { AdapterCapabilityError, defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { createConvexAdapter } from "../index";

const collections = defineSchema({
  articles: defineCollection("articles", { title: fields.string({ required: true }) })
});

test("Convex adapter emits Convex schema and declares unsupported arbitrary sort", async () => {
  const adapter = createConvexAdapter({ provider: "convex", collections });
  await expect(adapter.generateMigration(collections)).resolves.toMatchObject({ convexSchema: expect.stringContaining("defineSchema") });
  await expect(adapter.list("articles", { sort: "title" })).rejects.toBeInstanceOf(AdapterCapabilityError);
});
