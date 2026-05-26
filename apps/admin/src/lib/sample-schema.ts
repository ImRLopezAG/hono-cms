import { defineCollection, defineSchema, fields } from "@hono-cms/schema";

export const adminSchema = defineSchema({
  articles: defineCollection("articles", {
    title: fields.string({ required: true }),
    slug: fields.string({ required: true, unique: true }),
    body: fields.text(),
    status: fields.enum(["draft", "published", "archived"], { required: true }),
    featured: fields.boolean(),
    author: fields.relation("authors", "one")
  }, { draftAndPublish: true }),
  authors: defineCollection("authors", {
    name: fields.string({ required: true }),
    email: fields.string(),
    bio: fields.text()
  })
});

export type AdminCollectionName = keyof typeof adminSchema & string;
