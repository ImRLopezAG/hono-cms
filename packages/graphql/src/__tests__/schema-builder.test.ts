import { describe, expect, it } from "vitest";
import type { GraphQLObjectType, GraphQLSchema } from "graphql";
import { defineCollection, defineSchema, fields } from "@hono-cms/schema";
import { buildGraphQLSchema } from "../schema-builder";

describe("buildGraphQLSchema", () => {
  it("returns a runnable executable schema", () => {
    const collections = defineSchema({
      articles: defineCollection("articles", {
        title: fields.string({ required: true })
      }, {})
    });
    const schema: GraphQLSchema = buildGraphQLSchema(collections);
    expect(schema.getQueryType()?.name).toBe("Query");
    expect(schema.getMutationType()?.name).toBe("Mutation");
    expect(schema.getType("Articles")).toBeDefined();
    expect(schema.getType("ArticlesConnection")).toBeDefined();
  });

  it("declares the expected Query and Mutation fields per collection", () => {
    const collections = defineSchema({
      articles: defineCollection("articles", {
        title: fields.string({ required: true })
      }, { draftAndPublish: true })
    });
    const schema = buildGraphQLSchema(collections);
    const query = schema.getQueryType() as GraphQLObjectType;
    expect(Object.keys(query.getFields())).toEqual(expect.arrayContaining(["articles", "article"]));
    const mutation = schema.getMutationType() as GraphQLObjectType;
    expect(Object.keys(mutation.getFields())).toEqual(
      expect.arrayContaining(["createArticle", "updateArticle", "deleteArticle", "publishArticle", "unpublishArticle"])
    );
  });
});
