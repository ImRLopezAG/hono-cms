import { defineCollection, defineSchema, fields } from "@hono-cms/schema";

export const newsroomSchema = defineSchema({
  authors: defineCollection("authors", {
    name: fields.string({ required: true }),
    bio: fields.richtext(),
    apiKey: fields.string({ private: true, permissions: { read: ["admin"], write: ["admin"] } })
  }),
  articles: defineCollection("articles", {
    title: fields.string({ required: true }),
    slug: fields.uid({ targetField: "title", required: true }),
    summary: fields.text(),
    views: fields.number(),
    author: fields.relation("authors", "many-to-one")
  }, { draftAndPublish: true })
});

export const schema = newsroomSchema;
