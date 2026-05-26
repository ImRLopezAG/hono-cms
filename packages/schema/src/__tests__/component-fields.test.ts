import { expect, test } from "vitest";
import {
  CMSConfigError,
  collectionToZod,
  componentToZod,
  defineCollection,
  defineComponent,
  defineSchema,
  fields,
  generateDrizzleSchema,
  generateOpenAPISchemas,
  generateTypeScriptSDK,
  getSchemaComponents,
  isCMSComponent,
  type ComponentDefinition,
  type FieldsDefinition,
  type InferCollectionInput,
} from "../index";

const seo = defineComponent("seo", {
  title: fields.string({ required: true }),
  description: fields.text(),
  ogImage: fields.media()
});

const paragraph = defineComponent("paragraph", {
  body: fields.richtext({ required: true })
});

const image = defineComponent("image", {
  src: fields.media({ required: true }),
  alt: fields.string()
});

const cta = defineComponent("cta", {
  label: fields.string({ required: true }),
  href: fields.url({ required: true })
});

const articles = defineCollection("articles", {
  title: fields.string({ required: true }),
  seo: fields.component("seo", { required: true }),
  authors: fields.component("seo", { repeatable: true }),
});

const blocks = defineCollection("blocks", {
  title: fields.string({ required: true }),
  body: fields.dynamiczone(["paragraph", "image", "cta"] as const, { min: 1 })
});

const schema = defineSchema({
  collections: { articles, blocks },
  components: { seo, paragraph, image, cta }
});

test("defineComponent marks the value as a component", () => {
  expect(isCMSComponent(seo)).toBe(true);
  expect(isCMSComponent(articles)).toBe(false);
});

test("defineSchema accepts components and stores them for downstream use", () => {
  expect(schema).toBe(schema); // returned collections object is the same reference
  const components = getSchemaComponents(schema);
  expect(Object.keys(components).sort()).toEqual(["cta", "image", "paragraph", "seo"]);
});

test("validateSchema rejects unknown component references", () => {
  expect(() =>
    defineSchema({
      collections: {
        broken: defineCollection("broken", {
          title: fields.string({ required: true }),
          ghost: fields.component("nonexistent")
        })
      },
      components: { seo }
    })
  ).toThrow(CMSConfigError);
});

test("validateSchema rejects unknown dynamiczone components", () => {
  expect(() =>
    defineSchema({
      collections: {
        broken: defineCollection("broken", {
          title: fields.string({ required: true }),
          body: fields.dynamiczone(["paragraph", "missing"] as const)
        })
      },
      components: { paragraph }
    })
  ).toThrow(CMSConfigError);
});

test("validateSchema rejects empty dynamiczone allowed list", () => {
  expect(() =>
    defineSchema({
      collections: {
        broken: defineCollection("broken", {
          title: fields.string({ required: true }),
          body: fields.dynamiczone([] as unknown as readonly [string, ...string[]])
        })
      },
      components: { paragraph }
    })
  ).toThrow(/at least one component/);
});

test("validateSchema rejects relations declared inside a component", () => {
  expect(() =>
    defineSchema({
      collections: {
        articles: defineCollection("articles", { title: fields.string({ required: true }) })
      },
      components: {
        bad: defineComponent("bad", {
          owner: fields.relation("articles", "one") as never
        } as FieldsDefinition) as ComponentDefinition<"bad", FieldsDefinition>
      }
    })
  ).toThrow(/cannot declare a relation field/);
});

test("collectionToZod validates a non-repeatable component value", () => {
  const validator = collectionToZod(articles, getSchemaComponents(schema));
  const ok = validator.safeParse({
    title: "Hello",
    seo: { title: "Hello SEO", description: "x" }
  });
  expect(ok.success).toBe(true);

  const missingRequired = validator.safeParse({ title: "Hello" });
  expect(missingRequired.success).toBe(false);

  const invalidNested = validator.safeParse({
    title: "Hello",
    seo: { description: "missing title" }
  });
  expect(invalidNested.success).toBe(false);
});

test("collectionToZod validates a repeatable component as array", () => {
  const validator = collectionToZod(articles, getSchemaComponents(schema));
  const ok = validator.safeParse({
    title: "Hello",
    seo: { title: "SEO" },
    authors: [{ title: "A" }, { title: "B" }]
  });
  expect(ok.success).toBe(true);

  const wrongType = validator.safeParse({
    title: "Hello",
    seo: { title: "SEO" },
    authors: { title: "Not an array" }
  });
  expect(wrongType.success).toBe(false);
});

test("collectionToZod validates a dynamiczone via discriminated union", () => {
  const validator = collectionToZod(blocks, getSchemaComponents(schema));
  const ok = validator.safeParse({
    title: "Landing",
    body: [
      { __component: "paragraph", body: "<p>Hi</p>" },
      { __component: "image", src: "media123", alt: "alt" },
      { __component: "cta", label: "Click", href: "https://example.com" }
    ]
  });
  expect(ok.success).toBe(true);

  const unknownVariant = validator.safeParse({
    title: "Landing",
    body: [{ __component: "video", url: "https://example.com" }]
  });
  expect(unknownVariant.success).toBe(false);

  const tooShort = validator.safeParse({ title: "Landing", body: [] });
  expect(tooShort.success).toBe(false);
});

test("componentToZod yields an independently usable validator", () => {
  const validator = componentToZod(seo);
  expect(validator.safeParse({ title: "Hi" }).success).toBe(true);
  expect(validator.safeParse({ description: "no title" }).success).toBe(false);
});

test("generateDrizzleSchema emits jsonb columns on pg and text(json) on sqlite for components and dynamiczones", () => {
  const pg = generateDrizzleSchema(schema, { dialect: "pg" });
  expect(pg).toContain('seo: jsonb("seo").notNull()');
  expect(pg).toContain('authors: jsonb("authors")');
  expect(pg).toContain('body: jsonb("body")');

  const sqlite = generateDrizzleSchema(schema, { dialect: "sqlite" });
  expect(sqlite).toContain('seo: text("seo", { mode: "json" }).notNull()');
  expect(sqlite).toContain('authors: text("authors", { mode: "json" })');
  expect(sqlite).toContain('body: text("body", { mode: "json" })');
});

test("generateTypeScriptSDK emits component types and uses them inside collection types", () => {
  const sdk = generateTypeScriptSDK(schema);
  expect(sdk).toContain("export type Seo = {");
  expect(sdk).toContain("export type SeoInput = {");
  expect(sdk).toContain("export type Paragraph = {");
  expect(sdk).toContain("export type Image = {");
  expect(sdk).toContain("export type Cta = {");
  expect(sdk).toContain('"seo": Seo;');
  expect(sdk).toContain('"authors"?: Seo[];');
  expect(sdk).toContain('"body"?: Array<Paragraph | Image | Cta>;');
  expect(sdk).toContain('"seo": SeoInput;');
  expect(sdk).toContain('"authors"?: SeoInput[];');
  expect(sdk).toContain("\"kind\":\"component\"");
  expect(sdk).toContain("\"kind\":\"dynamiczone\"");
  expect(sdk).toContain("'component'");
  expect(sdk).toContain("'dynamiczone'");
});

test("generateOpenAPISchemas registers component schemas and references them from collections", () => {
  const openapi = generateOpenAPISchemas(schema) as Record<string, { properties?: Record<string, unknown> }>;
  expect(openapi.Seo).toBeDefined();
  expect(openapi.Paragraph).toBeDefined();
  expect((openapi.Articles?.properties as Record<string, unknown> | undefined)?.seo).toMatchObject({ $ref: "#/components/schemas/Seo" });
  expect((openapi.Articles?.properties as Record<string, unknown> | undefined)?.authors).toMatchObject({ type: "array", items: { $ref: "#/components/schemas/Seo" } });
  expect((openapi.Blocks?.properties as Record<string, unknown> | undefined)?.body).toMatchObject({ type: "array" });
});

test("component and dynamiczone fields surface in InferCollectionInput", () => {
  const value: InferCollectionInput<typeof articles> = {
    title: "Hello",
    seo: { title: "SEO" },
  };
  expect(value.title).toBe("Hello");
  // dynamiczone repeatable component field stays optional unless required:
  const blockValue: InferCollectionInput<typeof blocks> = {
    title: "B",
    body: [{ __component: "paragraph", body: "<p>Hi</p>" }]
  };
  expect(Array.isArray(blockValue.body)).toBe(true);
});

test("legacy defineSchema(collections) form continues to work", () => {
  const legacy = defineSchema({
    articles: defineCollection("articles", { title: fields.string({ required: true }) })
  });
  expect(Object.keys(legacy)).toEqual(["articles"]);
});
