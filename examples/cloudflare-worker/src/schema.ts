import { defineCollection, defineSchema, fields } from "@hono-cms/schema";

export const collections = defineSchema({
  posts: defineCollection("posts", {
    title: fields.string({ required: true }),
    slug: fields.uid({ targetField: "title" }),
    body: fields.text(),
    featured: fields.boolean()
  }, { draftAndPublish: true })
});
