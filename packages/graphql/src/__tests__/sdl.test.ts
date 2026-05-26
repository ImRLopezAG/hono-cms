import { describe, expect, it } from "vitest";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { createGraphQLSDL } from "../sdl";

describe("createGraphQLSDL", () => {
  it("emits Query + Mutation roots for each collection", () => {
    const collections = defineSchema({
      articles: defineCollection("articles", {
        title: fields.string({ required: true })
      }, {})
    });
    const sdl = createGraphQLSDL(collections);
    expect(sdl).toContain("type Query");
    expect(sdl).toContain("type Mutation");
    expect(sdl).toContain("type Articles");
    expect(sdl).toContain("createArticle(data: ArticlesCreateInput!): Articles!");
    expect(sdl).toContain("updateArticle(id: ID!, data: ArticlesUpdateInput!): Articles!");
    expect(sdl).toContain("deleteArticle(id: ID!): Boolean!");
  });

  it("emits publish/unpublish mutations only when draftAndPublish is on", () => {
    const collections = defineSchema({
      posts: defineCollection("posts", {
        title: fields.string({ required: true })
      }, { draftAndPublish: true })
    });
    const sdl = createGraphQLSDL(collections);
    expect(sdl).toContain("publishPost(id: ID!): Posts!");
    expect(sdl).toContain("unpublishPost(id: ID!): Posts!");
    expect(sdl).toContain("status: ContentStatus");
  });

  it("omits private fields from the public output type and filter input", () => {
    const collections = defineSchema({
      users: defineCollection("users", {
        email: fields.string({ required: true }),
        passwordHash: fields.string({ required: true, private: true })
      }, {})
    });
    const sdl = createGraphQLSDL(collections);
    expect(sdl).toContain("email: String");
    expect(sdl).not.toMatch(/type Users\s*\{[^}]*passwordHash/);
    // Filter input drops private fields too.
    const filterMatch = sdl.match(/input UsersFilterInput \{([\s\S]*?)\}/);
    expect(filterMatch?.[1] ?? "").not.toContain("passwordHash");
  });

  it("includes private fields in input types so legacy clients aren't rejected by Apollo", () => {
    // Per the port comments — the legacy parser tolerated private-field writes
    // (rejected at execute time with VALIDATION_ERROR). The new resolvers
    // surface the same VALIDATION_ERROR but we still need the input shape to
    // accept the field so Apollo's strict validator doesn't error first.
    const collections = defineSchema({
      users: defineCollection("users", {
        email: fields.string({ required: true }),
        passwordHash: fields.string({ required: true, private: true })
      }, {})
    });
    const sdl = createGraphQLSDL(collections);
    expect(sdl).toMatch(/input UsersCreateInput \{[^}]*passwordHash/);
  });
});
