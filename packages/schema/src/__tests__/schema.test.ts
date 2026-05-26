import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { CMSConfigError, SchemaLoadError, collectionToZod, createSchemaSnapshot, defineCollection, defineSchema, fields, formatSchemaPlan, generateCollectionFile, generateDrizzleSchema, generateOpenAPISchemas, generateTypeScriptSDK, isCMSCollection, isManyRelation, planSchemaMigration, type InferCollectionInput } from "../index";
import { SchemaCache, loadSchema } from "../schema-compiler";

const execFileAsync = promisify(execFile);

async function linkGeneratedSDKDependencies(directory: string): Promise<void> {
  const bunStore = resolve(__dirname, "../../../../node_modules/.bun");
  const entries = await readdir(bunStore);
  const qsEntry = entries.find((entry) => entry.startsWith("qs@"));
  const qsTypesEntry = entries.find((entry) => entry.startsWith("@types+qs@"));
  if (!qsEntry || !qsTypesEntry) throw new Error("Generated SDK tests require qs and @types/qs to be installed.");

  await mkdir(join(directory, "node_modules", "@types"), { recursive: true });
  await symlink(join(bunStore, qsEntry, "node_modules", "qs"), join(directory, "node_modules", "qs"), "dir");
  await symlink(join(bunStore, qsTypesEntry, "node_modules", "@types", "qs"), join(directory, "node_modules", "@types", "qs"), "dir");
}

const article = defineCollection("articles", {
  title: fields.string({ required: true }),
  body: fields.text(),
  status: fields.enum(["draft", "published"], { required: true }),
  views: fields.number()
}, { draftAndPublish: true });

test("infers required and optional input fields", () => {
  const input = {
    title: "Hello",
    status: "draft"
  } satisfies InferCollectionInput<typeof article>;

  expect(input.title).toBe("Hello");
});

test("generates stable SDK and OpenAPI schemas", () => {
  const author = defineCollection("authors", { name: fields.string({ required: true }), apiKey: fields.string({ private: true, permissions: { read: ["admin"], write: ["admin"] } }) });
  const schema = defineSchema({
    articles: defineCollection("articles", {
      title: fields.string({ required: true }),
      slug: fields.uid({ targetField: "title", required: true }),
      summary: fields.richtext(),
      contactEmail: fields.email(),
      canonicalUrl: fields.url(),
      embargoDate: fields.date(),
      publishTime: fields.time(),
      editorialPassword: fields.password({ private: true }),
      views: fields.number({ permissions: { read: ["authenticated"], write: ["editor"] } }),
      heroImage: fields.media(),
      gallery: fields.media({ multiple: true }),
      author: fields.relation("authors", "one")
    }, { draftAndPublish: true }),
    tags: defineCollection("tags", {
      name: fields.string({ required: true }),
      articles: fields.relation("articles", "many")
    }),
    pages: defineCollection("pages", {
      title: fields.string({ required: true })
    }, { i18n: { locales: ["en", "es", "es-MX"], defaultLocale: "en" } }),
    authors: author
  });
  const sdk = generateTypeScriptSDK(schema);
  expect(sdk).toContain("export type Articles");
  expect(sdk.indexOf("export type Articles")).toBeLessThan(sdk.indexOf("export type Authors"));
  expect(sdk).toContain("\"title\": string;");
  expect(sdk).toContain("\"slug\": string;");
  expect(sdk).toContain("\"slug\": {\"kind\":\"uid\",\"targetField\":\"title\"}");
  expect(sdk).toContain("\"contactEmail\"?: string;");
  expect(sdk).toContain("\"author\"?: Authors;");
  expect(sdk).toContain("\"authorId\"?: ID;");
  expect(sdk).toContain("\"heroImage\"?: MediaFile | ID;");
  expect(sdk).toContain("\"gallery\"?: MediaFile[] | ID[];");
  expect(sdk).toContain("\"heroImage\"?: ID;");
  expect(sdk).toContain("\"gallery\"?: ID[];");
  expect(sdk).toContain("export type ArticlesPopulated");
  expect(sdk).toContain("export type ArticlesRelationKey = \"author\";");
  expect(sdk).toContain("export type ArticlesQuery = QueryParams<Articles, ArticlesRelationKey>;");
  expect(sdk).toContain("export function buildArticlesQuery(query: ArticlesQuery = {}): string");
  expect(sdk).toContain("export type PagesQuery = QueryParams<Pages, PagesRelationKey, PagesLocale>;");
  expect(sdk).toContain("export function buildPagesQuery(query: PagesQuery = {}): string");
  expect(sdk).toContain("export type SortDirection = 'asc' | 'desc';");
  expect(sdk).toContain("`${Extract<keyof T, string>}:${SortDirection}`");
  expect(sdk).toContain("export type ArticlesCreateInput = {");
  expect(sdk).toContain("\"author\": Authors;");
  expect(sdk).toContain("export type PopulateParams<RelationKey extends string>");
  expect(sdk).toContain("export type CMSPaginationMeta");
  expect(sdk).toContain("export type MediaFile = MediaRecord;");
  expect(sdk).toContain("export type CMSClient");
  expect(sdk).toContain("media: {");
  expect(sdk).toContain("presign(input: MediaPresignInput): Promise<MediaPresign>;");
  expect(sdk).toContain("auditLog(query?: AuditLogQuery): Promise<PaginatedResponse<AuditEntry>>;");
  expect(sdk).toContain("findMany(): Promise<WebhookListResponse>;");
  expect(sdk).toContain("createCMSClient");
  expect(sdk).toContain("export type Authors = {\n  \"name\": string;");
  expect(sdk).not.toContain("export type Authors = {\n  \"apiKey\"");
  expect(sdk).toContain("publish(id: ID): Promise<Articles>;");
  expect(sdk).toContain("export type PagesLocale = \"en\" | \"es\" | \"es-MX\";");
  expect(sdk).toContain("export type PagesResult<Query> = Pages;");
  expect(sdk).not.toContain("export type PagesPopulated");
  expect(sdk).toContain("translate(id: ID, input: TranslateInput<PagesLocale>): Promise<PagesTranslationVariant>;");
  expect(sdk).toContain("locales(id: ID): Promise<PagesLocaleStatus>;");
  expect(sdk).toContain("delete(id: ID): Promise<void>;");
  expect(sdk).toContain("buildQuery");
  expect(sdk).toContain("export const cmsSchema = {");
  expect(sdk).toContain("\"views\": {\"kind\":\"number\",\"permissions\":{\"read\":[\"authenticated\"],\"write\":[\"editor\"]}}");
  expect(sdk).toContain("\"apiKey\": {\"kind\":\"string\",\"private\":true,\"permissions\":{\"read\":[\"admin\"],\"write\":[\"admin\"]}}");
  expect(sdk).toContain("schemaHash:");
  expect(generateTypeScriptSDK(schema)).toBe(sdk);
  const openApiSchemas = generateOpenAPISchemas(schema) as {
    Articles: { properties: { views: Record<string, unknown>; author: Record<string, unknown>; heroImage: Record<string, unknown>; gallery: Record<string, unknown>; slug: Record<string, unknown>; contactEmail: Record<string, unknown>; canonicalUrl: Record<string, unknown>; embargoDate: Record<string, unknown>; publishTime: Record<string, unknown> } };
    ArticlesCreateInput: { properties: Record<string, unknown>; required: string[] };
    ArticlesUpdateInput: { properties: Record<string, unknown>; required: string[] };
    Authors: { properties: Record<string, unknown> };
    AuthorsCreateInput: { properties: { apiKey: Record<string, unknown> } };
  };
  expect(openApiSchemas).toHaveProperty("Articles");
  expect(openApiSchemas).toHaveProperty("ArticlesCreateInput");
  expect(openApiSchemas).toHaveProperty("ArticlesUpdateInput");
  expect(openApiSchemas.Articles.properties.views["x-cms-permissions"]).toEqual({ read: ["authenticated"], write: ["editor"] });
  expect(openApiSchemas.Articles.properties.slug).toMatchObject({ type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" });
  expect(openApiSchemas.Articles.properties.contactEmail).toMatchObject({ type: "string", format: "email" });
  expect(openApiSchemas.Articles.properties.canonicalUrl).toMatchObject({ type: "string", format: "uri" });
  expect(openApiSchemas.Articles.properties.embargoDate).toMatchObject({ type: "string", format: "date" });
  expect(openApiSchemas.Articles.properties.publishTime).toMatchObject({ type: "string" });
  expect(openApiSchemas.Articles.properties.author).toMatchObject({ oneOf: [{ type: "string" }, { $ref: "#/components/schemas/Authors" }] });
  expect(openApiSchemas.Articles.properties.heroImage).toMatchObject({ oneOf: [{ type: "string" }, { $ref: "#/components/schemas/MediaRecord" }] });
  expect(openApiSchemas.Articles.properties.gallery).toMatchObject({ type: "array", items: { oneOf: [{ type: "string" }, { $ref: "#/components/schemas/MediaRecord" }] } });
  expect(openApiSchemas.ArticlesCreateInput.properties).not.toHaveProperty("id");
  expect(openApiSchemas.ArticlesCreateInput.properties).not.toHaveProperty("createdAt");
  expect(openApiSchemas.ArticlesCreateInput.properties).toHaveProperty("authorId");
  expect(openApiSchemas.ArticlesCreateInput.properties.authorId).toMatchObject({ type: "string" });
  expect(openApiSchemas.ArticlesCreateInput.properties.heroImage).toMatchObject({ type: "string" });
  expect(openApiSchemas.ArticlesCreateInput.properties.gallery).toMatchObject({ type: "array", items: { type: "string" } });
  expect(openApiSchemas.ArticlesCreateInput.required).toContain("title");
  expect(openApiSchemas.ArticlesCreateInput.required).toContain("slug");
  expect(openApiSchemas.ArticlesUpdateInput.required).toEqual([]);
  expect(openApiSchemas.Authors.properties).not.toHaveProperty("apiKey");
  expect(openApiSchemas.AuthorsCreateInput.properties.apiKey["x-cms-private"]).toBe(true);
});

test("validates multiple media fields as arrays of media IDs", () => {
  const collection = defineCollection("galleries", {
    title: fields.string({ required: true }),
    heroImage: fields.media(),
    assets: fields.media({ multiple: true })
  });
  const validator = collectionToZod(collection);

  expect(validator.safeParse({ title: "Launch", heroImage: "media_1", assets: ["media_1", "media_2"] }).success).toBe(true);
  expect(validator.safeParse({ title: "Launch", heroImage: ["media_1"], assets: "media_1" }).success).toBe(false);
});

test("validates relation targets at schema definition time", () => {
  expect(() => defineSchema({
    articles: defineCollection("articles", {
      author: fields.relation("missing-authors", "one")
    })
  })).toThrow(CMSConfigError);
});

test("schema migration planning detects collection option drift", () => {
  const before = defineSchema({
    pages: defineCollection("pages", {
      title: fields.string({ required: true })
    })
  });
  const after = defineSchema({
    pages: defineCollection("pages", {
      title: fields.string({ required: true })
    }, { i18n: { locales: ["en", "es"], defaultLocale: "en" }, draftAndPublish: true })
  });
  const plan = planSchemaMigration(createSchemaSnapshot(before), after);

  expect(plan.empty).toBe(false);
  expect(plan.destructive).toBe(false);
  expect(plan.changes).toEqual([
    {
      type: "alter_collection",
      collection: "pages",
      before: {},
      after: { draftAndPublish: true, i18n: { locales: ["en", "es"], defaultLocale: "en" } }
    }
  ]);
  expect(formatSchemaPlan(plan)).toContain("~ collection pages options");
});

test("schema migration planning reads legacy field-only snapshots", () => {
  const legacySnapshot = {
    collections: {
      pages: {
        title: { kind: "string", required: true }
      }
    }
  };
  const after = defineSchema({
    pages: defineCollection("pages", {
      title: fields.string({ required: true })
    }, { draftAndPublish: true })
  });

  expect(planSchemaMigration(legacySnapshot as unknown as ReturnType<typeof createSchemaSnapshot>, after).changes).toContainEqual({
    type: "alter_collection",
    collection: "pages",
    before: {},
    after: { draftAndPublish: true }
  });
});

test("schema migration planning tracks provider system tables", () => {
  const collections = defineSchema({
    articles: defineCollection("articles", { title: fields.string({ required: true }) })
  });
  const systemTables = {
    "auth:user": {
      name: "user",
      fields: {
        id: { type: "string", required: true },
        email: { type: "string", required: true, index: true }
      }
    }
  };

  const plan = planSchemaMigration(null, collections, { systemTables });
  expect(plan.changes).toEqual([
    { type: "create_collection", collection: "articles" },
    {
      type: "add_field",
      collection: "articles",
      field: "title",
      definition: { kind: "string", required: true }
    },
    { type: "create_system_table", table: "auth:user" }
  ]);
  expect(plan.snapshot.systemTables).toEqual(systemTables);
  expect(formatSchemaPlan(plan)).toContain("+ system table auth:user");
});

test("validates incompatible relation onDelete options", () => {
  expect(() => defineSchema({
    authors: defineCollection("authors", { name: fields.string() }),
    articles: defineCollection("articles", {
      author: fields.relation("authors", "many-to-one", { required: true, onDelete: "set_null" })
    })
  })).toThrow(/set_null/);

  expect(() => defineSchema({
    articles: defineCollection("articles", {
      tags: fields.relation("tags", "many-to-many", { onDelete: "set_null" } as never)
    }),
    tags: defineCollection("tags", { name: fields.string() })
  })).toThrow(/many-to-many/);
});

test("validates required flags only on local foreign key relations", () => {
  expect(() => defineSchema({
    authors: defineCollection("authors", {
      articles: fields.relation("articles", "one-to-many", { required: true } as never)
    }),
    articles: defineCollection("articles", {
      title: fields.string({ required: true }),
      author: fields.relation("authors", "many-to-one")
    })
  })).toThrow(/required: true/);

  expect(() => defineSchema({
    articles: defineCollection("articles", {
      tags: fields.relation("tags", "many-to-many", { required: true } as never)
    }),
    tags: defineCollection("tags", { name: fields.string() })
  })).toThrow(/required: true/);
});

test("relation helper typing rejects invalid inverse and join relation options", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hono-cms-relation-types-"));
  try {
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "src", "relation-types.ts"), [
      `import { fields } from ${JSON.stringify(resolve(__dirname, "../index.ts"))};`,
      "fields.relation('authors', 'many-to-one', { required: true, onDelete: 'set_null' });",
      "fields.relation('profiles', 'one-to-one', { required: true });",
      "fields.relation('tags', 'many-to-many', { onDelete: 'cascade' });",
      "// @ts-expect-error inverse relations have no local FK, so required is invalid",
      "fields.relation('articles', 'one-to-many', { required: true });",
      "// @ts-expect-error join-table relations have no local FK, so required is invalid",
      "fields.relation('tags', 'many-to-many', { required: true });",
      "// @ts-expect-error many-to-many can only remove join rows, not set target FKs to null",
      "fields.relation('tags', 'many-to-many', { onDelete: 'set_null' });"
    ].join("\n"));
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        skipLibCheck: true
      },
      include: ["src/**/*.ts"]
    }, null, 2));
    await expect(execFileAsync("bunx", ["tsc", "--project", join(directory, "tsconfig.json")], { cwd: directory })).resolves.toBeDefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("supports standard relation cardinalities in schema, SDK, and OpenAPI output", () => {
  const schema = defineSchema({
    authors: defineCollection("authors", {
      name: fields.string({ required: true }),
      profile: fields.relation("profiles", "one-to-one"),
      articles: fields.relation("articles", "one-to-many")
    }),
    profiles: defineCollection("profiles", {
      bio: fields.text(),
      author: fields.relation("authors", "many-to-one")
    }),
    articles: defineCollection("articles", {
      title: fields.string({ required: true }),
      author: fields.relation("authors", "many-to-one"),
      tags: fields.relation("tags", "many-to-many")
    }),
    tags: defineCollection("tags", {
      name: fields.string({ required: true }),
      articles: fields.relation("articles", "many-to-many")
    })
  });

  expect(isManyRelation(schema.authors.fields.articles)).toBe(true);
  expect(isManyRelation(schema.articles.fields.tags)).toBe(true);
  expect(isManyRelation(schema.articles.fields.author)).toBe(false);

  const sdk = generateTypeScriptSDK(schema);
  expect(sdk).toContain("\"profileId\"?: ID;");
  expect(sdk).not.toContain("\"articlesId\"");
  expect(sdk).toContain("\"author\"?: Authors;");
  expect(sdk).toContain("\"authorId\"?: ID;");
  expect(sdk).toContain("\"tags\"?: Tags[];");
  expect(sdk).toContain("\"tags\"?: ID[];");
  expect(sdk).not.toContain("\"tagsId\"");
  expect(sdk).toContain("export type ArticlesRelationKey = \"author\" | \"tags\";");

  const openApiSchemas = generateOpenAPISchemas(schema) as {
    Articles: { properties: Record<string, unknown> };
    ArticlesCreateInput: { properties: Record<string, unknown> };
  };
  expect(openApiSchemas.Articles.properties.author).toMatchObject({ oneOf: [{ type: "string" }, { $ref: "#/components/schemas/Authors" }] });
  expect(openApiSchemas.Articles.properties.tags).toMatchObject({ type: "array", items: { oneOf: [{ type: "string" }, { $ref: "#/components/schemas/Tags" }] } });
  expect(openApiSchemas.ArticlesCreateInput.properties.authorId).toMatchObject({ type: "string" });
  expect(openApiSchemas.ArticlesCreateInput.properties.tags).toMatchObject({ type: "array", items: { type: "string" } });
  expect(openApiSchemas.ArticlesCreateInput.properties).not.toHaveProperty("tagsId");
});

test("generates deterministic Drizzle sqlite schema with relations and join tables", async () => {
  const schema = defineSchema({
    authors: defineCollection("authors", {
      name: fields.string({ required: true, max: 120 }),
      profile: fields.relation("profiles", "one-to-one", { unique: true }),
      articles: fields.relation("articles", "one-to-many")
    }),
    profiles: defineCollection("profiles", {
      bio: fields.text(),
      author: fields.relation("authors", "many-to-one")
    }),
    articles: defineCollection("articles", {
      title: fields.string({ required: true, max: 255 }),
      slug: fields.uid({ targetField: "title", unique: true }),
      views: fields.number({ int: true }),
      rating: fields.number(),
      featured: fields.boolean(),
      payload: fields.json(),
      kind: fields.enum(["news", "opinion"], { required: true }),
      scheduledAt: fields.datetime(),
      hero: fields.media(),
      author: fields.relation("authors", "many-to-one", { required: true, onDelete: "cascade" }),
      tags: fields.relation("tags", "many-to-many")
    }, { draftAndPublish: true, i18n: { locales: ["en", "es"], defaultLocale: "en" } }),
    tags: defineCollection("tags", {
      name: fields.string({ required: true }),
      articles: fields.relation("articles", "many-to-many")
    })
  });
  const source = generateDrizzleSchema(schema);

  expect(generateDrizzleSchema(schema)).toBe(source);
  expect(source).toContain("import { relations } from \"drizzle-orm\";");
  expect(source).toContain("export const articlesTable = sqliteTable(\"articles\", {");
  expect(source).toContain("id: text(\"id\", { length: 24 }).primaryKey().$defaultFn(() => createId())");
  expect(source).toContain("title: text(\"title\", { length: 255 }).notNull()");
  expect(source).toContain("views: integer(\"views\")");
  expect(source).toContain("rating: real(\"rating\")");
  expect(source).toContain("featured: integer(\"featured\", { mode: \"boolean\" })");
  expect(source).toContain("payload: text(\"payload\", { mode: \"json\" })");
  expect(source).toContain("kind: text(\"kind\", { enum: [\"news\", \"opinion\"] }).notNull()");
  expect(source).toContain("status: text(\"status\", { enum: [\"draft\", \"published\"] }).notNull().default(\"draft\")");
  expect(source).toContain("publishedAt: integer(\"published_at\", { mode: \"timestamp\" })");
  expect(source).toContain("heroId: text(\"hero_id\", { length: 24 })");
  expect(source).toContain("heroMeta: text(\"hero_meta\", { mode: \"json\" })");
  expect(source).toContain("authorId: text(\"author_id\", { length: 24 }).references(() => authorsTable.id, { onDelete: \"cascade\" }).notNull()");
  expect(source).toContain("locale: text(\"locale\", { length: 10 })");
  expect(source).toContain("createdAt: integer(\"created_at\", { mode: \"timestamp\" }).notNull()");
  expect(source).toContain("updatedAt: integer(\"updated_at\", { mode: \"timestamp\" }).notNull()");
  expect(source).toContain("slugIdx: index(\"articles_slug_idx\").on(table.slug)");
  expect(source.match(/export const articlesTagsTable = sqliteTable\("articles_tags"/g)).toHaveLength(1);
  expect(source).toContain("pk: primaryKey({ columns: [table.articleId, table.tagId] })");
  expect(source).toContain("author: one(authorsTable, { fields: [articlesTable.authorId], references: [authorsTable.id] })");
  expect(source).toContain("tags: many(articlesTagsTable)");
  expect(source).toContain("articles: many(articlesTable)");
  expect(source).toContain("export const articlesTagsRelations = relations(articlesTagsTable");

  const dir = await mkdtemp(join(tmpdir(), "hono-cms-drizzle-schema-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "drizzle-schema.ts"), source);
    await writeFile(join(dir, "src", "stubs.d.ts"), [
      "declare module 'drizzle-orm' {",
      "  export function relations(table: unknown, builder: (helpers: { one: (...args: unknown[]) => unknown; many: (...args: unknown[]) => unknown }) => Record<string, unknown>): unknown;",
      "}",
      "declare module 'drizzle-orm/sqlite-core' {",
      "  type Column = { primaryKey(): Column; $defaultFn(fn: () => unknown): Column; notNull(): Column; default(value: unknown): Column; unique(): Column; references(fn: () => unknown, options?: unknown): Column };",
      "  export function sqliteTable(name: string, columns: Record<string, unknown>, extra?: (table: Record<string, unknown>) => Record<string, unknown>): Record<string, Column>;",
      "  export function text(name: string, config?: unknown): Column;",
      "  export function integer(name: string, config?: unknown): Column;",
      "  export function real(name: string, config?: unknown): Column;",
      "  export function blob(name: string, config?: unknown): Column;",
      "  export function index(name: string): { on(...columns: unknown[]): unknown };",
      "  export function uniqueIndex(name: string): { on(...columns: unknown[]): unknown };",
      "  export function primaryKey(config: { columns: unknown[] }): unknown;",
      "}",
      "declare module '@paralleldrive/cuid2' { export function createId(): string; }"
    ].join("\n"));
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true
      },
      include: ["src/**/*.ts"]
    }, null, 2));
    await execFileAsync("bunx", ["tsc", "--project", join(dir, "tsconfig.json")], { cwd: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generates self-referential many-to-many join tables without duplicate columns", async () => {
  const schema = defineSchema({
    categories: defineCollection("categories", {
      name: fields.string({ required: true }),
      related: fields.relation("categories", "many-to-many")
    })
  });
  const source = generateDrizzleSchema(schema);

  expect(source).toContain("export const categoriesCategoriesTable = sqliteTable(\"categories_categories\", {");
  expect(source).toContain("leftId: text(\"left_id\", { length: 24 }).notNull().references(() => categoriesTable.id, { onDelete: \"cascade\" })");
  expect(source).toContain("rightId: text(\"right_id\", { length: 24 }).notNull().references(() => categoriesTable.id, { onDelete: \"cascade\" })");
  expect(source).toContain("pk: primaryKey({ columns: [table.leftId, table.rightId] })");
  expect(source).toContain("related: many(categoriesCategoriesTable)");
  expect(source).toContain("export const categoriesCategoriesRelations = relations(categoriesCategoriesTable");
  expect(source).toContain("left: one(categoriesTable, { fields: [categoriesCategoriesTable.leftId], references: [categoriesTable.id] })");
  expect(source).toContain("right: one(categoriesTable, { fields: [categoriesCategoriesTable.rightId], references: [categoriesTable.id] })");
  expect(source).not.toContain("categoryId:");
  expect(source.match(/export const categoriesCategoriesTable = sqliteTable\("categories_categories"/g)).toHaveLength(1);

  const sdk = generateTypeScriptSDK(schema);
  expect(sdk).toContain("\"related\"?: Categories[];");
  expect(sdk).toContain("\"related\"?: ID[];");
  expect(sdk).toContain("export type CategoriesRelationKey = \"related\";");

  const dir = await mkdtemp(join(tmpdir(), "hono-cms-drizzle-self-relation-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "drizzle-schema.ts"), source);
    await writeFile(join(dir, "src", "stubs.d.ts"), [
      "declare module 'drizzle-orm' {",
      "  export function relations(table: unknown, builder: (helpers: { one: (...args: unknown[]) => unknown; many: (...args: unknown[]) => unknown }) => Record<string, unknown>): unknown;",
      "}",
      "declare module 'drizzle-orm/sqlite-core' {",
      "  type Column = { primaryKey(): Column; $defaultFn(fn: () => unknown): Column; notNull(): Column; default(value: unknown): Column; unique(): Column; references(fn: () => unknown, options?: unknown): Column };",
      "  export function sqliteTable(name: string, columns: Record<string, unknown>, extra?: (table: Record<string, unknown>) => Record<string, unknown>): Record<string, Column>;",
      "  export function text(name: string, config?: unknown): Column;",
      "  export function integer(name: string, config?: unknown): Column;",
      "  export function real(name: string, config?: unknown): Column;",
      "  export function index(name: string): { on(...columns: unknown[]): unknown };",
      "  export function uniqueIndex(name: string): { on(...columns: unknown[]): unknown };",
      "  export function primaryKey(config: { columns: unknown[] }): unknown;",
      "}",
      "declare module '@paralleldrive/cuid2' { export function createId(): string; }"
    ].join("\n"));
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true
      },
      include: ["src/**/*.ts"]
    }, null, 2));
    await execFileAsync("bunx", ["tsc", "--project", join(dir, "tsconfig.json")], { cwd: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generates deterministic Drizzle postgres schema for edge postgres adapters", async () => {
  const schema = defineSchema({
    authors: defineCollection("authors", {
      name: fields.string({ required: true, max: 120 })
    }),
    articles: defineCollection("articles", {
      title: fields.string({ required: true, max: 255 }),
      slug: fields.uid({ targetField: "title", unique: true }),
      featured: fields.boolean(),
      payload: fields.json(),
      kind: fields.enum(["news", "opinion"], { required: true }),
      scheduledAt: fields.datetime(),
      author: fields.relation("authors", "many-to-one", { required: true, onDelete: "cascade" })
    }, { draftAndPublish: true, i18n: { locales: ["en", "es"], defaultLocale: "en" } })
  });
  const source = generateDrizzleSchema(schema, { dialect: "pg" });

  expect(generateDrizzleSchema(schema, { dialect: "pg" })).toBe(source);
  expect(source).toContain("import { boolean, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uniqueIndex, varchar } from \"drizzle-orm/pg-core\";");
  expect(source).toContain("export const articlesTable = pgTable(\"articles\", {");
  expect(source).toContain("id: varchar(\"id\", { length: 24 }).primaryKey().$defaultFn(() => createId())");
  expect(source).toContain("title: varchar(\"title\", { length: 255 }).notNull()");
  expect(source).toContain("featured: boolean(\"featured\")");
  expect(source).toContain("payload: jsonb(\"payload\")");
  expect(source).toContain("kind: varchar(\"kind\", { length: 255, enum: [\"news\", \"opinion\"] }).notNull()");
  expect(source).toContain("scheduledAt: timestamp(\"scheduled_at\", { mode: \"date\" })");
  expect(source).toContain("publishedAt: timestamp(\"published_at\", { mode: \"date\" })");
  expect(source).toContain("status: varchar(\"status\", { length: 16, enum: [\"draft\", \"published\"] }).notNull().default(\"draft\")");
  expect(source).toContain("authorId: varchar(\"author_id\", { length: 24 }).references(() => authorsTable.id, { onDelete: \"cascade\" }).notNull()");

  const dir = await mkdtemp(join(tmpdir(), "hono-cms-drizzle-pg-schema-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "drizzle-schema.ts"), source);
    await writeFile(join(dir, "src", "stubs.d.ts"), [
      "declare module 'drizzle-orm' {",
      "  export function relations(table: unknown, builder: (helpers: { one: (...args: unknown[]) => unknown; many: (...args: unknown[]) => unknown }) => Record<string, unknown>): unknown;",
      "}",
      "declare module 'drizzle-orm/pg-core' {",
      "  type Column = { primaryKey(): Column; $defaultFn(fn: () => unknown): Column; notNull(): Column; default(value: unknown): Column; unique(): Column; references(fn: () => unknown, options?: unknown): Column };",
      "  export function pgTable(name: string, columns: Record<string, unknown>, extra?: (table: Record<string, unknown>) => Record<string, unknown>): Record<string, Column>;",
      "  export function varchar(name: string, config?: unknown): Column;",
      "  export function text(name: string, config?: unknown): Column;",
      "  export function integer(name: string, config?: unknown): Column;",
      "  export function real(name: string, config?: unknown): Column;",
      "  export function boolean(name: string, config?: unknown): Column;",
      "  export function timestamp(name: string, config?: unknown): Column;",
      "  export function jsonb(name: string, config?: unknown): Column;",
      "  export function index(name: string): { on(...columns: unknown[]): unknown };",
      "  export function uniqueIndex(name: string): { on(...columns: unknown[]): unknown };",
      "  export function primaryKey(config: { columns: unknown[] }): unknown;",
      "}",
      "declare module '@paralleldrive/cuid2' { export function createId(): string; }"
    ].join("\n"));
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true
      },
      include: ["src/**/*.ts"]
    }, null, 2));
    await execFileAsync("bunx", ["tsc", "--project", join(dir, "tsconfig.json")], { cwd: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validates collection i18n locale configuration", () => {
  expect(() => defineSchema({
    pages: defineCollection("pages", { title: fields.string() }, { i18n: { locales: ["es"], defaultLocale: "en" } })
  })).toThrow(/defaultLocale/);

  expect(() => defineSchema({
    pages: defineCollection("pages", { title: fields.string() }, { i18n: { locales: ["not_a_locale"], defaultLocale: "not_a_locale" } })
  })).toThrow(/BCP 47/);
});

test("validates collection rbac actions", () => {
  expect(() => defineSchema({
    pages: defineCollection("pages", { title: fields.string() }, { rbac: { public: ["read", "export" as "read"] } })
  })).toThrow(CMSConfigError);
});

test("validates field permission audiences", () => {
  expect(() => defineSchema({
    pages: defineCollection("pages", { title: fields.string({ permissions: { read: [""] } }) })
  })).toThrow(CMSConfigError);
});

test("generates deterministic collection files that round-trip through the schema DSL", async () => {
  const collection = defineCollection("articles", {
    title: fields.string({ required: true, max: 120 }),
    body: fields.richtext(),
    slug: fields.uid({ targetField: "title", unique: true }),
    category: fields.enum(["news", "opinion"], { required: true }),
    author: fields.relation("authors", "many-to-one", { inverse: "articles", onDelete: "restrict" }),
    secretNotes: fields.text({ private: true, permissions: { read: ["admin"], write: ["editor", "admin"] } })
  }, {
    draftAndPublish: true,
    i18n: { locales: ["en", "es"], defaultLocale: "en" },
    rbac: { public: ["read"], authenticated: ["read", "create"] }
  });
  const importPath = pathToFileURL(join(__dirname, "../index.ts")).href;
  const source = generateCollectionFile(collection, { importPath });

  expect(generateCollectionFile(collection, { importPath })).toBe(source);
  expect(source).toContain(`import { defineCollection, fields } from ${JSON.stringify(importPath)};`);
  expect(source.indexOf("\"author\": fields.relation")).toBeLessThan(source.indexOf("\"body\": fields.richtext()"));
  expect(source.indexOf("\"body\": fields.richtext()")).toBeLessThan(source.indexOf("\"category\": fields.enum"));
  expect(source.indexOf("\"slug\": fields.uid")).toBeLessThan(source.indexOf("\"title\": fields.string"));
  expect(source).toContain("\"draftAndPublish\": true");
  expect(source).toContain("\"i18n\": {");
  expect(source).toContain("\"category\": fields.enum([\"news\", \"opinion\"]");
  expect(source).not.toContain("required: false");
  expect(source).not.toContain("_systemFields");

  const dir = await mkdtemp(join(tmpdir(), "hono-cms-collection-file-"));
  try {
    const file = join(dir, "articles.ts");
    await writeFile(file, source);
    const imported = await import(`${pathToFileURL(file).href}?t=${Date.now()}`) as { default: typeof collection };
    expect(imported.default).toEqual(collection);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loads collection files with marked exports and cross-collection validation", async () => {
  const importPath = pathToFileURL(join(__dirname, "../index.ts")).href;
  const authors = defineCollection("authors", {
    name: fields.string({ required: true })
  });
  const articles = defineCollection("articles", {
    title: fields.string({ required: true }),
    author: fields.relation("authors", "many-to-one")
  }, { draftAndPublish: true });
  const directory = await mkdtemp(join(tmpdir(), "hono-cms-schema-load-"));

  try {
    await writeFile(join(directory, "helpers.ts"), "export const ignored = { name: 'not-a-collection' };\n");
    await writeFile(join(directory, "authors.ts"), generateCollectionFile(authors, { importPath }));
    await writeFile(join(directory, "articles.ts"), generateCollectionFile(articles, { importPath }));

    const loaded = await loadSchema(directory);
    expect(Object.keys(loaded)).toEqual(["articles", "authors"]);
    expect(loaded.articles?.fields.author).toMatchObject({ kind: "relation", target: "authors" });
    expect(loaded.articles?.options.draftAndPublish).toBe(true);
    expect(isCMSCollection(loaded.articles)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wraps collection import and validation failures as schema load errors", async () => {
  const importPath = pathToFileURL(join(__dirname, "../index.ts")).href;
  const directory = await mkdtemp(join(tmpdir(), "hono-cms-schema-error-"));

  try {
    await writeFile(join(directory, "broken.ts"), "throw new Error('broken collection file');\n");
    await expect(loadSchema(directory)).rejects.toMatchObject({
      name: "SchemaLoadError",
      code: "SCHEMA_LOAD_ERROR",
      filePath: join(directory, "broken.ts")
    });

    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const invalid = defineCollection("articles", {
      author: fields.relation("missing-authors", "many-to-one")
    });
    await writeFile(join(directory, "articles.ts"), generateCollectionFile(invalid, { importPath }));
    await expect(loadSchema(directory)).rejects.toThrow(SchemaLoadError);
    await expect(loadSchema(directory)).rejects.toThrow(/missing-authors/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("schema cache exposes loaded schema synchronously and notifies listeners", async () => {
  const importPath = pathToFileURL(join(__dirname, "../index.ts")).href;
  const pages = defineCollection("pages", {
    title: fields.string({ required: true })
  });
  const directory = await mkdtemp(join(tmpdir(), "hono-cms-schema-cache-"));
  const cache = new SchemaCache();
  const changes: string[][] = [];

  try {
    expect(() => cache.get()).toThrow(SchemaLoadError);
    const unsubscribe = cache.onChange((collections) => changes.push(Object.keys(collections)));
    await writeFile(join(directory, "pages.ts"), generateCollectionFile(pages, { importPath }));

    const loaded = await cache.load(directory);
    expect(cache.get()).toBe(loaded);
    expect(changes).toEqual([["pages"]]);

    unsubscribe();
    cache.invalidate();
    expect(() => cache.get()).toThrow(/Schema not loaded/);

    cache.set({ pages });
    expect(cache.get().pages).toBe(pages);
    expect(changes).toEqual([["pages"]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generated SDK compiles with typed query and client usage", async () => {
  const schema = defineSchema({
    articles: defineCollection("articles", {
      title: fields.string({ required: true }),
      views: fields.number(),
      publishedOn: fields.datetime(),
      author: fields.relation("authors", "one")
    }, { draftAndPublish: true }),
    authors: defineCollection("authors", {
      name: fields.string({ required: true })
    }),
    pages: defineCollection("pages", {
      title: fields.string({ required: true })
    }, {
      i18n: { locales: ["en", "es", "es-MX"], defaultLocale: "en" }
    })
  });
  const directory = await mkdtemp(join(tmpdir(), "hono-cms-sdk-"));
  try {
    await mkdir(join(directory, "src"), { recursive: true });
    await linkGeneratedSDKDependencies(directory);
    await writeFile(join(directory, "src", "sdk.ts"), generateTypeScriptSDK(schema));
    await writeFile(join(directory, "src", "usage.ts"), [
      "import { buildArticlesQuery, buildPagesQuery, buildQuery, createCMSClient, qs, type ApiKeyRecord, type Articles, type ArticlesPopulated, type ArticlesQuery, type AuditEntry, type CMSPaginationMeta, type ContentTypeInput, type ContentTypeWriteResponse, type HealthReport, type LivenessReport, type MediaFile, type MediaRecord, type Pages, type PagesLocaleStatus, type PagesQuery, type PagesTranslationVariant, type PopulateParams, type SchemaMetadata, type WebhookDelivery, type WebhookRecord } from './sdk';",
      "const cursor = 'eyJpZCI6ImFydGljbGVfMSIsImNyZWF0ZWRBdCI6IjIwMjYtMDUtMjJUMTA6MDA6MDAuMDAwWiJ9';",
      "const query = buildQuery<Articles>({ filters: { title: { $contains: 'cms', $notContains: 'draft', $between: ['a', 'z'] }, views: { $gte: 1, $nin: [2, 3], $between: [1, 10] } }, sort: 'title:asc', pagination: { limit: 20, cursor }, populate: ['author'] });",
      "const shorthandSort = buildQuery<Articles>({ sort: ['-title', 'views:desc'] });",
      "qs.stringify({ filters: { title: { $contains: 'cms' } } }) satisfies string;",
      "shorthandSort satisfies string;",
      "query satisfies string;",
      "const articleQuery = { populate: ['author'] } satisfies ArticlesQuery;",
      "const collectionQuery = buildArticlesQuery({ filters: { title: { $contains: 'cms' }, author: { name: { $startsWith: 'Ada' } } }, populate: ['author'] });",
      "collectionQuery satisfies string;",
      "const pageQuery = { locale: 'es-MX', fallback: false } satisfies PagesQuery;",
      "pageQuery.locale satisfies 'en' | 'es' | 'es-MX' | undefined;",
      "buildPagesQuery({ locale: 'es-MX', fallback: false }) satisfies string;",
      "buildQuery<Pages, never, 'en' | 'es' | 'es-MX'>({ locale: 'es-MX', fallback: false }) satisfies string;",
      "const populateParams = { populate: ['author'] } satisfies PopulateParams<'author'>;",
      "populateParams.populate?.[0] satisfies 'author' | undefined;",
      "const paginationMeta = { cursor, hasMore: true, total: 2 } satisfies CMSPaginationMeta;",
      "paginationMeta.hasMore satisfies boolean | undefined;",
      "const populated = {} as ArticlesPopulated;",
      "populated.author.name satisfies string;",
      "const client = createCMSClient({ baseUrl: 'https://cms.test', token: 'admin', fetch });",
      "client.liveness().then((report) => report satisfies LivenessReport);",
      "client.readiness().then((report) => report satisfies HealthReport);",
      "client.health().then((report) => report.checks.db.status satisfies 'ok' | 'error' | undefined);",
      "client.schema().then((metadata) => metadata satisfies SchemaMetadata<'articles' | 'authors' | 'pages'>);",
      "client.schema().then((metadata) => metadata.collections.articles.fields.title.kind satisfies string);",
      "client.contentTypes.capabilities().then((capabilities) => capabilities.writable satisfies boolean);",
      "client.contentTypes.findMany().then((result) => result.collections.articles.name satisfies 'articles' | 'authors' | 'pages');",
      "const contentTypeInput = { name: 'sections', fields: { title: { kind: 'string', required: true } }, options: { draftAndPublish: true } } satisfies ContentTypeInput;",
      "client.contentTypes.create(contentTypeInput).then((result) => result satisfies ContentTypeWriteResponse);",
      "client.contentTypes.update('sections', contentTypeInput).then((result) => result.collection.name satisfies string);",
      "client.articles.findOne('article_1').then((article) => article?.author?.name satisfies string | undefined);",
      "client.articles.findOne('article_1', { populate: ['author'] }).then((article) => article?.author.name satisfies string | undefined);",
      "client.articles.findMany({ populate: '*' }).then((result) => result.items[0]?.author.name satisfies string | undefined);",
      "client.articles.publish('article_1').then((article) => article.status satisfies 'draft' | 'published');",
      "client.articles.schedule('article_1', { publishAt: new Date('2026-05-23T12:00:00.000Z') }).then((article) => article.status satisfies 'draft' | 'published');",
      "client.articles.unschedule('article_1').then((article) => article.status satisfies 'draft' | 'published');",
      "client.articles.create({ title: 'Typed', views: 1, authorId: 'author_1' });",
      "client.previewTokens.create({ collection: 'articles', documentId: 'article_1' }).then((preview) => preview.previewUrl satisfies string);",
      "client.previewTokens.revoke('preview_token');",
      "client.auditLog({ collection: 'articles', operation: 'publish', from: '2026-05-01T00:00:00.000Z', to: '2026-05-22T23:59:59.000Z', limit: 10 }).then((result) => result.items[0] satisfies AuditEntry | undefined);",
      "client.auditLogCsv({ actorId: 'admin_1' }).then((csv) => csv satisfies string);",
      "client.webhooks.findMany().then((result) => result.items[0]?.lastDeliveryStatus satisfies 'pending' | 'success' | 'retrying' | 'failed' | null | undefined);",
      "client.webhooks.create({ name: 'Deploy', url: 'https://hooks.test/deploy', events: ['content.published'], enabled: true }).then((webhook) => webhook satisfies WebhookRecord);",
      "client.webhooks.update('webhook_1', { enabled: false, secret: null }).then((webhook) => webhook satisfies WebhookRecord);",
      "client.webhooks.replace('webhook_1', { name: 'Deploy', url: 'https://hooks.test/deploy', events: ['*'] }).then((webhook) => webhook satisfies WebhookRecord);",
      "client.webhooks.deliveries('webhook_1', { limit: 5, cursor: 'delivery_1' }).then((result) => result.items[0] satisfies WebhookDelivery | undefined);",
      "client.webhooks.retryDelivery('webhook_1', 'delivery_1').then((delivery) => delivery satisfies WebhookDelivery);",
      "client.webhooks.test('webhook_1').then((delivery) => delivery satisfies WebhookDelivery);",
      "client.webhooks.delete('webhook_1');",
      "client.apiKeys.findMany().then((result) => result.items[0]?.prefix satisfies string | undefined);",
      "client.apiKeys.create({ userId: 'bot', roles: ['editor'], enabled: true }).then((key) => key.secret satisfies string);",
      "client.apiKeys.update('api_key_1', { roles: ['admin'], enabled: false }).then((key) => key satisfies ApiKeyRecord);",
      "client.apiKeys.delete('api_key_1');",
      "client.media.findMany({ limit: 10 }).then((result) => result.items[0]?.filename satisfies string | undefined);",
      "client.media.findMany({ limit: 10 }).then((result) => result.items[0] satisfies MediaFile | undefined);",
      "client.media.presign({ filename: 'hero.jpg', contentType: 'image/jpeg', size: 1024 }).then((presign) => presign.method satisfies 'PUT' | 'POST');",
      "client.media.presign({ filename: 'hero.jpg', mimeType: 'image/jpeg', size: 1024 }).then((presign) => presign.method satisfies 'PUT' | 'POST');",
      "client.media.confirm({ uploadId: 'up_1', key: 'media/hero.jpg', filename: 'hero.jpg', contentType: 'image/jpeg', size: 1024 }).then((media) => media satisfies MediaRecord);",
      "client.media.confirm({ uploadId: 'up_1', key: 'media/hero.jpg', filename: 'hero.jpg', mimeType: 'image/jpeg', size: 1024 }).then((media) => media satisfies MediaRecord);",
      "client.pages.translate('page_1', { targetLocale: 'es' }).then((variant) => variant satisfies PagesTranslationVariant);",
      "client.pages.findMany({ locale: 'es', fallback: false }).then((result) => result.items[0]?.locale satisfies 'en' | 'es' | 'es-MX' | undefined);",
      "client.pages.locales('page_1').then((status) => status satisfies PagesLocaleStatus);",
      "client.pages.reviewLocale('page_1', 'es').then((variant) => variant satisfies PagesTranslationVariant);",
      "client.pages.updateLocale('page_1', 'es-MX', { title: 'Inicio' }).then((variant) => variant satisfies PagesTranslationVariant);",
      "// @ts-expect-error targetLocale must be one of configured locales",
      "client.pages.translate('page_1', { targetLocale: 'fr' });",
      "// @ts-expect-error default locale cannot be edited as a locale variant",
      "client.pages.updateLocale('page_1', 'en', { title: 'Home' });",
      "// @ts-expect-error locale review only accepts human",
      "client.pages.reviewLocale('page_1', 'es', { translatedBy: 'ai' });",
      "// @ts-expect-error unknown filter key must be rejected",
      "buildQuery<Articles>({ filters: { missing: { $eq: 'x' } } });",
      "// @ts-expect-error relation filters only accept public target fields",
      "buildArticlesQuery({ filters: { author: { missing: { $contains: 'Ada' } } } });",
      "// @ts-expect-error string fields do not accept numeric comparison operators",
      "buildQuery<Articles>({ filters: { title: { $gte: 1 } } });",
      "// @ts-expect-error sort direction must be asc or desc",
      "buildQuery<Articles>({ sort: 'title:up' });",
      "// @ts-expect-error sort field must exist on the collection type",
      "buildQuery<Articles>({ sort: 'missing:asc' });",
      "// @ts-expect-error between requires a tuple with two values",
      "buildQuery<Articles>({ filters: { views: { $between: [1] } } });",
      "// @ts-expect-error content queries use pagination.limit instead of top-level limit",
      "buildQuery<Articles>({ limit: 20 });",
      "// @ts-expect-error collection clients use pagination.cursor instead of top-level cursor",
      "client.articles.findMany({ cursor: 'article_1' });",
      "// @ts-expect-error create input cannot write system fields",
      "client.articles.create({ title: 'Nope', views: 1, id: 'system' });",
      "// @ts-expect-error create input cannot write populated relation objects",
      "client.articles.create({ title: 'Nope', author: { id: 'author_1', name: 'Ada', createdAt: 'now', updatedAt: 'now' } });",
      "// @ts-expect-error collection client populate only accepts relation keys",
      "client.articles.findMany({ populate: ['title'] });",
      "// @ts-expect-error collection-specific query helper only accepts relation keys",
      "buildArticlesQuery({ populate: ['title'] });",
      "// @ts-expect-error page queries only accept configured locales",
      "client.pages.findMany({ locale: 'fr' });",
      "// @ts-expect-error page query helper only accepts configured locales",
      "buildPagesQuery({ locale: 'fr' });",
      "// @ts-expect-error schedule publish requires publishAt",
      "client.articles.schedule('article_1', {});",
      "// @ts-expect-error non-draft collections do not expose schedule workflow",
      "client.pages.schedule('page_1', { publishAt: '2026-05-23T12:00:00.000Z' });",
      "// @ts-expect-error preview tokens require a known collection name",
      "client.previewTokens.create({ collection: 'missing', documentId: 'article_1' });",
      "// @ts-expect-error audit log operations are fixed CMS operations",
      "client.auditLog({ operation: 'login' });",
      "// @ts-expect-error webhook create requires a URL",
      "client.webhooks.create({ name: 'Deploy', events: ['*'] });",
      "// @ts-expect-error media presign requires contentType or mimeType",
      "client.media.presign({ filename: 'hero.jpg', size: 1024 });",
      "// @ts-expect-error media confirm requires contentType or mimeType",
      "client.media.confirm({ uploadId: 'up_1', key: 'media/hero.jpg', filename: 'hero.jpg', size: 1024 });",
      "// @ts-expect-error generated schema metadata only includes configured collection keys",
      "client.schema().then((metadata) => metadata.collections.missing);",
      "// @ts-expect-error content type fields require a known schema field kind",
      "client.contentTypes.create({ name: 'bad', fields: { title: { kind: 'made-up' } } });",
      "// @ts-expect-error unpopulated relation fields remain optional by default",
      "client.articles.findOne('article_1').then((article) => article?.author.name);"
    ].join("\n"));
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true
      },
      include: ["src/**/*.ts"]
    }, null, 2));

    await execFileAsync("bunx", ["tsc", "--project", join(directory, "tsconfig.json")], { cwd: directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generated SDK client builds request URLs and JSON bodies", async () => {
  const schema = defineSchema({
    articles: defineCollection("articles", {
      title: fields.string({ required: true }),
      views: fields.number()
    }, { draftAndPublish: true }),
    pages: defineCollection("pages", {
      title: fields.string({ required: true })
    }, { i18n: { locales: ["en", "es"], defaultLocale: "en" } })
  });
  const directory = await mkdtemp(join(tmpdir(), "hono-cms-sdk-runtime-"));
  try {
    await mkdir(join(directory, "src"), { recursive: true });
    await linkGeneratedSDKDependencies(directory);
    await writeFile(join(directory, "src", "sdk.ts"), `${generateTypeScriptSDK(schema)}\nexport const __runtime = { buildQuery, createCMSClient, qs };\n`);
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        rootDir: "src",
        outDir: "dist",
        skipLibCheck: true
      },
      include: ["src/**/*.ts"]
    }, null, 2));
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    await execFileAsync("bunx", ["tsc", "--project", join(directory, "tsconfig.json")], { cwd: directory });
    const sdk = await import(/* @vite-ignore */ pathToFileURL(join(directory, "dist", "sdk.js")).href) as {
      __runtime: {
        buildQuery<T>(query?: unknown): string;
        qs: { parse(query: string): unknown; stringify(input: unknown, options?: unknown): string };
        createCMSClient(options: { baseUrl: string; token?: string; fetch: typeof fetch }): {
          media: {
            findMany(query?: unknown): Promise<unknown>;
            upload(file: File): Promise<unknown>;
            presign(input: unknown): Promise<unknown>;
            confirm(input: unknown): Promise<unknown>;
            delete(id: string): Promise<void>;
          };
          previewTokens: {
            create(input: unknown): Promise<unknown>;
            revoke(token: string): Promise<void>;
          };
          liveness(): Promise<unknown>;
          readiness(): Promise<unknown>;
          health(): Promise<unknown>;
          schema(): Promise<unknown>;
          contentTypes: {
            capabilities(): Promise<unknown>;
            findMany(): Promise<unknown>;
            create(input: unknown): Promise<unknown>;
            update(name: string, input: unknown): Promise<unknown>;
          };
          auditLog(query?: unknown): Promise<unknown>;
          auditLogCsv(query?: unknown): Promise<string>;
          webhooks: {
            findMany(): Promise<unknown>;
            create(input: unknown): Promise<unknown>;
            update(id: string, input: unknown): Promise<unknown>;
            replace(id: string, input: unknown): Promise<unknown>;
            delete(id: string): Promise<void>;
            deliveries(id: string, query?: unknown): Promise<unknown>;
            retryDelivery(id: string, deliveryId: string): Promise<unknown>;
            test(id: string): Promise<unknown>;
          };
          apiKeys: {
            findMany(): Promise<unknown>;
            create(input: unknown): Promise<unknown>;
            update(id: string, input: unknown): Promise<unknown>;
            delete(id: string): Promise<void>;
          };
          articles: {
            findMany(query?: unknown): Promise<unknown>;
            create(input: unknown): Promise<unknown>;
            publish(id: string): Promise<unknown>;
            schedule(id: string, input: unknown): Promise<unknown>;
            unschedule(id: string): Promise<unknown>;
          };
          pages: {
            locales(id: string): Promise<unknown>;
            translate(id: string, input: unknown): Promise<unknown>;
            reviewLocale(id: string, locale: string, input?: unknown): Promise<unknown>;
            updateLocale(id: string, locale: string, input: unknown): Promise<unknown>;
          };
        };
      };
    };
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (String(input).includes("/cms/health/live")) return Response.json({ status: "ok", version: "0.1.0", uptime_seconds: 1 });
      if (String(input).includes("/cms/health/ready") || String(input).endsWith("/cms/health")) return Response.json({ status: "ok", version: "0.1.0", uptime_seconds: 1, checks: { db: { status: "ok", latency_ms: 1 } } });
      if (String(input).includes("/cms/schema")) return Response.json({ collections: { articles: { name: "articles", options: { draftAndPublish: true }, fields: { title: { kind: "string", required: true, unique: false, localized: false, private: false } } } } });
      if (String(input).includes("/cms/content-types/capabilities")) return Response.json({ writable: true, mode: "development" });
      if (String(input).includes("/cms/content-types/articles")) return Response.json({ collection: { name: "articles", options: { draftAndPublish: true }, fields: { title: { kind: "string", required: true, unique: false, localized: false, private: false } } }, path: "collections/articles.ts" });
      if (String(input).includes("/cms/content-types")) {
        if (init?.method === "POST") return Response.json({ collection: { name: "sections", options: {}, fields: { title: { kind: "string", required: true, unique: false, localized: false, private: false } } }, source: "export default sections;" });
        return Response.json({ collections: { articles: { name: "articles", options: { draftAndPublish: true }, fields: { title: { kind: "string", required: true, unique: false, localized: false, private: false } } } }, capabilities: { writable: true, mode: "development" } });
      }
      if (String(input).includes("/cms/audit-log") && String(input).includes("format=csv")) return new Response("id,operation\naudit_1,publish\n", { headers: { "content-type": "text/csv" } });
      if (String(input).includes("/cms/audit-log")) return Response.json({ items: [{ id: "audit_1", operation: "publish", collection: "articles", documentId: "a1", actorRoles: ["admin"], requestId: "req_1", diff: { before: null, after: { status: "published" } }, createdAt: "now" }] });
      if (String(input).includes("/cms/settings/webhooks/webhook_1/deliveries/delivery_1/retry")) return Response.json({ id: "delivery_1", webhookId: "webhook_1", eventType: "content.published", url: "https://hooks.test/deploy", attempt: 2, status: "success", requestBody: "{}", createdAt: "now" });
      if (String(input).includes("/cms/settings/webhooks/webhook_1/deliveries")) return Response.json({ items: [{ id: "delivery_1", webhookId: "webhook_1", eventType: "content.published", url: "https://hooks.test/deploy", attempt: 1, status: "failed", requestBody: "{}", error: "timeout", createdAt: "now" }] });
      if (String(input).includes("/cms/settings/webhooks/webhook_1/test")) return Response.json({ id: "delivery_test", webhookId: "webhook_1", eventType: "webhook.test", url: "https://hooks.test/deploy", attempt: 1, status: "success", requestBody: "{}", createdAt: "now" });
      if (String(input).includes("/cms/settings/webhooks/webhook_1")) {
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        return Response.json({ id: "webhook_1", name: "Deploy", url: "https://hooks.test/deploy", events: ["*"], enabled: true, createdAt: "now", updatedAt: "now" });
      }
      if (String(input).includes("/cms/settings/webhooks")) {
        if (init?.method === "POST") return Response.json({ id: "webhook_1", name: "Deploy", url: "https://hooks.test/deploy", events: ["content.published"], enabled: true, createdAt: "now", updatedAt: "now" });
        return Response.json({ items: [{ id: "webhook_1", name: "Deploy", url: "https://hooks.test/deploy", events: ["*"], enabled: true, createdAt: "now", updatedAt: "now", hasSecret: false, lastDeliveryAt: null, lastDeliveryStatus: null }], meta: { total: 1 } });
      }
      if (String(input).includes("/cms/settings/api-keys/api_key_1")) {
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        return Response.json({ id: "api_key_1", userId: "bot", roles: ["admin"], enabled: false });
      }
      if (String(input).includes("/cms/settings/api-keys")) {
        if (init?.method === "POST") return Response.json({ id: "api_key_1", userId: "bot", roles: ["editor"], enabled: true, secret: "cms_live_secret" });
        return Response.json({ items: [{ id: "api_key_1", userId: "bot", roles: ["editor"], enabled: true, prefix: "cms_live_abc..." }], meta: { total: 1 } });
      }
      if (String(input).includes("/api/media/presign")) return Response.json({ uploadId: "up_1", uploadUrl: "https://upload.test", method: "PUT", key: "media/file.txt", expiresAt: "2026-05-23T00:00:00.000Z" });
      if (String(input).includes("/api/media/confirm")) return Response.json({ id: "media_1", key: "media/file.txt", url: "/media/file.txt", filename: "file.txt", size: 4, createdAt: "now", updatedAt: "now" });
      if (String(input).includes("/api/media")) return init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(String(input).includes("?") ? { items: [] } : { id: "media_1", key: "media/file.txt", url: "/media/file.txt", filename: "file.txt", size: 4, createdAt: "now", updatedAt: "now" });
      if (String(input).includes("/api/preview-tokens/")) return new Response(null, { status: 204 });
      if (String(input).includes("/api/preview-tokens")) return Response.json({ token: "preview_token", expiresAt: "2026-05-23T13:00:00.000Z", previewUrl: "https://site.test/preview?preview=preview_token" });
      if (String(input).includes("/api/pages/page_1/locales/es-MX")) return Response.json({ id: "v2", collection: "pages", documentId: "page_1", locale: "es-MX", fields: { title: "Inicio" }, status: "complete", translatedBy: "human", createdAt: "now", updatedAt: "now" });
      if (String(input).includes("/api/pages/page_1/locales/es")) return Response.json({ id: "v1", collection: "pages", documentId: "page_1", locale: "es", fields: { title: "Hola" }, status: "complete", translatedBy: "human", createdAt: "now", updatedAt: "now" });
      if (String(input).includes("/api/pages/page_1/locales")) return Response.json({ defaultLocale: "en", locales: [{ locale: "en", status: "complete", translatedBy: "human" }] });
      if (String(input).includes("/api/pages/page_1/translate")) return Response.json({ id: "v1", collection: "pages", documentId: "page_1", locale: "es", fields: { title: "Hola" }, status: "complete", translatedBy: "ai", createdAt: "now", updatedAt: "now" });
      return Response.json(String(input).includes("/publish") ? { id: "a1", status: "published" } : String(input).includes("?") ? { items: [] } : { id: "a1", title: "Hello" });
    }) satisfies typeof fetch;
    const client = sdk.__runtime.createCMSClient({ baseUrl: "https://cms.test/root/", token: "admin", fetch: fetchMock });
    const contentCursor = "eyJpZCI6ImExIiwiY3JlYXRlZEF0IjoiMjAyNi0wNS0yMlQxMDowMDowMC4wMDBaIn0";
    const builtQuery = sdk.__runtime.buildQuery({ filters: { title: { $contains: "edge" }, views: { $in: [1, 2] }, author: { name: { $startsWith: "Ada" } } }, pagination: { limit: 10, cursor: contentCursor }, sort: ["title:asc", "views:desc"] });
    expect(builtQuery).toBe(`filters[title][$contains]=edge&filters[views][$in][]=1&filters[views][$in][]=2&filters[author][name][$startsWith]=Ada&pagination[limit]=10&pagination[cursor]=${contentCursor}&sort[]=title%3Aasc&sort[]=views%3Adesc`);
    expect(sdk.__runtime.qs.parse(builtQuery)).toMatchObject({
      filters: { title: { $contains: "edge" }, views: { $in: ["1", "2"] }, author: { name: { $startsWith: "Ada" } } },
      pagination: { limit: "10", cursor: contentCursor },
      sort: ["title:asc", "views:desc"]
    });
    const offsetQuery = sdk.__runtime.buildQuery({ pagination: { page: 2, pageSize: 10 } });
    expect(offsetQuery).toBe("pagination[page]=2&pagination[pageSize]=10");
    expect(sdk.__runtime.qs.parse(offsetQuery)).toMatchObject({ pagination: { page: "2", pageSize: "10" } });
    await client.articles.findMany({ filters: { title: { $contains: "edge" } }, pagination: { limit: 5 }, sort: "-title", populate: ["views"] });
    await client.articles.create({ title: "Hello", views: 1 });
    await client.articles.publish("a1");
    await client.articles.schedule("a1", { publishAt: new Date("2026-05-23T12:00:00.000Z") });
    await client.articles.unschedule("a1");
    await client.previewTokens.create({ collection: "articles", documentId: "a1" });
    await client.previewTokens.revoke("preview_token");
    await client.auditLog({ collection: "articles", operation: "publish", from: "2026-05-01T00:00:00.000Z", to: "2026-05-22T23:59:59.000Z", limit: 10 });
    await client.auditLogCsv({ actorId: "admin_1" });
    await client.webhooks.findMany();
    await client.webhooks.create({ name: "Deploy", url: "https://hooks.test/deploy", events: ["content.published"], enabled: true });
    await client.webhooks.update("webhook_1", { enabled: false, secret: null });
    await client.webhooks.replace("webhook_1", { name: "Deploy", url: "https://hooks.test/deploy", events: ["*"] });
    await client.webhooks.deliveries("webhook_1", { limit: 5, cursor: "delivery_1" });
    await client.webhooks.retryDelivery("webhook_1", "delivery_1");
    await client.webhooks.test("webhook_1");
    await client.webhooks.delete("webhook_1");
    await client.apiKeys.findMany();
    await client.apiKeys.create({ userId: "bot", roles: ["editor"], enabled: true });
    await client.apiKeys.update("api_key_1", { roles: ["admin"], enabled: false });
    await client.apiKeys.delete("api_key_1");
    await client.media.findMany({ limit: 5 });
    await client.media.upload(new File(["file"], "file.txt", { type: "text/plain" }));
    const presign = await client.media.presign({ filename: "file.txt", contentType: "text/plain", size: 4 }) as { uploadId: string; key: string };
    await client.media.confirm({ uploadId: presign.uploadId, key: presign.key, filename: "file.txt", contentType: "text/plain", size: 4 });
    await client.media.delete("media_1");
    await client.pages.locales("page_1");
    await client.pages.translate("page_1", { targetLocale: "es" });
    await client.pages.reviewLocale("page_1", "es");
    await client.pages.updateLocale("page_1", "es-MX", { title: "Inicio" });
    await client.liveness();
    await client.readiness();
    await client.health();
    await client.schema();
    await client.contentTypes.capabilities();
    await client.contentTypes.findMany();
    await client.contentTypes.create({ name: "sections", fields: { title: { kind: "string", required: true } }, options: { draftAndPublish: true } });
    await client.contentTypes.update("articles", { name: "articles", fields: { title: { kind: "string", required: true } } });

    expect(calls[0]?.url).toBe("https://cms.test/api/articles?filters[title][$contains]=edge&pagination[limit]=5&sort=-title&populate[]=views");
    expect(calls[1]?.url).toBe("https://cms.test/api/articles");
    expect(calls[1]?.init).toMatchObject({ method: "POST", body: JSON.stringify({ title: "Hello", views: 1 }) });
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe("Bearer admin");
    expect(calls[2]?.url).toBe("https://cms.test/api/articles/a1/publish");
    expect(calls[3]?.url).toBe("https://cms.test/api/articles/a1/schedule");
    expect(calls[3]?.init).toMatchObject({ method: "POST", body: JSON.stringify({ publishAt: "2026-05-23T12:00:00.000Z" }) });
    expect(calls[4]?.url).toBe("https://cms.test/api/articles/a1/unschedule");
    expect(calls[5]?.url).toBe("https://cms.test/api/preview-tokens");
    expect(calls[5]?.init).toMatchObject({ method: "POST", body: JSON.stringify({ collection: "articles", documentId: "a1" }) });
    expect(calls[6]?.url).toBe("https://cms.test/api/preview-tokens/preview_token");
    expect(calls[6]?.init).toMatchObject({ method: "DELETE" });
    expect(calls[7]?.url).toBe("https://cms.test/cms/audit-log?collection=articles&operation=publish&from=2026-05-01T00%3A00%3A00.000Z&to=2026-05-22T23%3A59%3A59.000Z&limit=10");
    expect(calls[8]?.url).toBe("https://cms.test/cms/audit-log?actorId=admin_1&format=csv");
    expect(calls[9]?.url).toBe("https://cms.test/cms/settings/webhooks");
    expect(calls[10]?.url).toBe("https://cms.test/cms/settings/webhooks");
    expect(calls[10]?.init).toMatchObject({ method: "POST", body: JSON.stringify({ name: "Deploy", url: "https://hooks.test/deploy", events: ["content.published"], enabled: true }) });
    expect(calls[11]?.url).toBe("https://cms.test/cms/settings/webhooks/webhook_1");
    expect(calls[11]?.init).toMatchObject({ method: "PATCH", body: JSON.stringify({ enabled: false, secret: null }) });
    expect(calls[12]?.url).toBe("https://cms.test/cms/settings/webhooks/webhook_1");
    expect(calls[12]?.init).toMatchObject({ method: "PUT", body: JSON.stringify({ name: "Deploy", url: "https://hooks.test/deploy", events: ["*"] }) });
    expect(calls[13]?.url).toBe("https://cms.test/cms/settings/webhooks/webhook_1/deliveries?limit=5&cursor=delivery_1");
    expect(calls[14]?.url).toBe("https://cms.test/cms/settings/webhooks/webhook_1/deliveries/delivery_1/retry");
    expect(calls[14]?.init).toMatchObject({ method: "POST" });
    expect(calls[15]?.url).toBe("https://cms.test/cms/settings/webhooks/webhook_1/test");
    expect(calls[15]?.init).toMatchObject({ method: "POST" });
    expect(calls[16]?.url).toBe("https://cms.test/cms/settings/webhooks/webhook_1");
    expect(calls[16]?.init).toMatchObject({ method: "DELETE" });
    expect(calls[17]?.url).toBe("https://cms.test/cms/settings/api-keys");
    expect(calls[18]?.url).toBe("https://cms.test/cms/settings/api-keys");
    expect(calls[18]?.init).toMatchObject({ method: "POST", body: JSON.stringify({ userId: "bot", roles: ["editor"], enabled: true }) });
    expect(calls[19]?.url).toBe("https://cms.test/cms/settings/api-keys/api_key_1");
    expect(calls[19]?.init).toMatchObject({ method: "PATCH", body: JSON.stringify({ roles: ["admin"], enabled: false }) });
    expect(calls[20]?.url).toBe("https://cms.test/cms/settings/api-keys/api_key_1");
    expect(calls[20]?.init).toMatchObject({ method: "DELETE" });
    expect(calls[21]?.url).toBe("https://cms.test/api/media?limit=5");
    expect(calls[22]?.url).toBe("https://cms.test/api/media");
    expect(calls[22]?.init.body).toBeInstanceOf(FormData);
    expect(new Headers(calls[22]?.init.headers).has("content-type")).toBe(false);
    expect(calls[23]?.url).toBe("https://cms.test/api/media/presign");
    expect(calls[24]?.url).toBe("https://cms.test/api/media/confirm");
    expect(calls[25]?.url).toBe("https://cms.test/api/media/media_1");
    expect(calls[26]?.url).toBe("https://cms.test/api/pages/page_1/locales");
    expect(calls[27]?.url).toBe("https://cms.test/api/pages/page_1/translate");
    expect(calls[27]?.init).toMatchObject({ method: "POST", body: JSON.stringify({ targetLocale: "es" }) });
    expect(calls[28]?.url).toBe("https://cms.test/api/pages/page_1/locales/es");
    expect(calls[28]?.init).toMatchObject({ method: "PATCH", body: JSON.stringify({ translatedBy: "human" }) });
    expect(calls[29]?.url).toBe("https://cms.test/api/pages/page_1/locales/es-MX");
    expect(calls[29]?.init).toMatchObject({ method: "PUT", body: JSON.stringify({ title: "Inicio" }) });
    expect(calls[30]?.url).toBe("https://cms.test/cms/health/live");
    expect(calls[31]?.url).toBe("https://cms.test/cms/health/ready");
    expect(calls[32]?.url).toBe("https://cms.test/cms/health");
    expect(calls[33]?.url).toBe("https://cms.test/cms/schema");
    expect(calls[34]?.url).toBe("https://cms.test/cms/content-types/capabilities");
    expect(calls[35]?.url).toBe("https://cms.test/cms/content-types");
    expect(calls[36]?.url).toBe("https://cms.test/cms/content-types");
    expect(calls[36]?.init).toMatchObject({ method: "POST", body: JSON.stringify({ name: "sections", fields: { title: { kind: "string", required: true } }, options: { draftAndPublish: true } }) });
    expect(calls[37]?.url).toBe("https://cms.test/cms/content-types/articles");
    expect(calls[37]?.init).toMatchObject({ method: "PUT", body: JSON.stringify({ name: "articles", fields: { title: { kind: "string", required: true } } }) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
