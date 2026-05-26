import { defineCollection, defineSchema, fields } from "@hono-cms/schema";

/**
 * Schema for the Vercel Edge example.
 *
 * - `posts` + `authors` mirror the cross-runtime matrix shape (see
 *   `examples/bun-server`, `examples/cloudflare-worker`, etc.) so the live
 *   probes can compare runtimes apples-to-apples.
 * - `pages` is retained for the original `route.test.ts` handler test, which
 *   predates the matrix and asserts the Vercel Edge route handler contract.
 */
export const collections = defineSchema({
  posts: defineCollection("posts", {
    title: fields.string({ required: true }),
    slug: fields.uid({ required: true, targetField: "title" }),
    body: fields.richtext()
  }, { draftAndPublish: true }),
  authors: defineCollection("authors", {
    name: fields.string({ required: true }),
    bio: fields.richtext()
  }),
  pages: defineCollection("pages", {
    title: fields.string({ required: true }),
    slug: fields.uid({ targetField: "title" }),
    body: fields.richtext()
  }, { draftAndPublish: true })
});
