import { describe, expect, it } from "vitest";

import { collectionColumns, contentSearchField, fieldModels, formValuesFromRecord, recordInputFromForm, recordInputFromValues, supportsDraftWorkflow } from "./field-rendering";
import { adminSchema } from "./sample-schema";

describe("admin schema field rendering", () => {
  it("maps CMS field definitions to stable form controls", () => {
    expect(fieldModels(adminSchema.articles)).toEqual([
      { name: "title", label: "Title", control: "text", required: true },
      { name: "slug", label: "Slug", control: "text", required: true },
      { name: "body", label: "Body", control: "textarea", required: false },
      {
        name: "status",
        label: "Status",
        control: "select",
        required: true,
        options: ["draft", "published", "archived"]
      },
      { name: "featured", label: "Featured", control: "checkbox", required: false },
      { name: "author", label: "Author", control: "relation", required: false, relation: { target: "authors", multiple: false } }
    ]);
  });

  it("derives compact table columns from collection fields", () => {
    expect(collectionColumns(adminSchema.articles)).toEqual([
      "id",
      "title",
      "slug",
      "body",
      "status",
      "updatedAt"
    ]);
  });

  it("selects the first public text-like field for admin list search", () => {
    expect(contentSearchField(adminSchema.articles)).toBe("title");
  });

  it("detects draft workflow collections and serializes record forms", () => {
    expect(supportsDraftWorkflow(adminSchema.articles)).toBe(true);
    expect(supportsDraftWorkflow(adminSchema.authors)).toBe(false);

    const data = new FormData();
    data.set("title", "Hello");
    data.set("featured", "on");
    const input = recordInputFromForm(fieldModels(adminSchema.articles), data);

    expect(input).toMatchObject({ title: "Hello", featured: true });
  });

  it("serializes multi-relation fields from comma-separated fallback input", () => {
    const data = new FormData();
    data.set("tags", "tag_1, tag_2,,");

    expect(recordInputFromForm([{
      name: "tags",
      label: "Tags",
      control: "relation",
      required: false,
      relation: { target: "tags", multiple: true }
    }], data)).toEqual({ tags: ["tag_1", "tag_2"] });
  });

  it("annotates relation fields with target search labels when schema metadata is available", () => {
    expect(fieldModels(adminSchema.articles, { collections: adminSchema }).find((field) => field.name === "author")).toMatchObject({
      relation: { target: "authors", multiple: false, labelField: "name" }
    });
  });

  it("maps media fields to picker controls and serializes selected asset ids", () => {
    const models = fieldModels({
      options: {},
      fields: {
        heroImage: { kind: "media", required: true }
      }
    });

    expect(models).toEqual([{ name: "heroImage", label: "HeroImage", control: "media", required: true }]);
    expect(recordInputFromValues(models, { heroImage: "media_1" })).toEqual({ heroImage: "media_1" });
  });

  it("round-trips TanStack Form state through schema-derived serializers", () => {
    const models = fieldModels(adminSchema.articles);
    const values = formValuesFromRecord(models, {
      title: "Typed CMS",
      slug: "typed-cms",
      body: "Hello",
      status: "draft",
      featured: true,
      author: "author_1"
    });

    expect(values).toMatchObject({
      title: "Typed CMS",
      featured: true,
      author: "author_1"
    });
    expect(recordInputFromValues(models, { ...values, featured: false })).toMatchObject({
      title: "Typed CMS",
      featured: false,
      author: "author_1"
    });
  });

  it("maps rich scalar field kinds to semantic browser controls", () => {
    expect(fieldModels({
      options: {},
      fields: {
        body: { kind: "richtext" },
        email: { kind: "email" },
        website: { kind: "url" },
        secret: { kind: "password" },
        publishDate: { kind: "date" },
        publishTime: { kind: "time" },
        scheduledAt: { kind: "datetime" },
        slug: { kind: "uid" }
      }
    }).map((field) => [field.name, field.control])).toEqual([
      ["body", "richtext"],
      ["email", "email"],
      ["website", "url"],
      ["secret", "password"],
      ["publishDate", "date"],
      ["publishTime", "time"],
      ["scheduledAt", "datetime"],
      ["slug", "text"]
    ]);
  });
});
