import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { defineCollection, fields, formatSchemaPlan } from "@hono-cms/schema";
import { buildProject, createContentTypeWriter, deployTemplate, deployTemplateFromSchema, doctorProject, generateDrizzleArtifact, generateDrizzleConfigArtifact, generateOpenAPIArtifact, generateSDK, generateSDKArtifact, initProject, initProjectWizard, loadCMS, main, platformEntrypointTemplate, planDeployInfrastructure, renderSchemaMigrationSQL, runDrizzleKit, runSeeds, schemaApply, schemaCheck, schemaCheckJSON, schemaPlan, startDevServer, usageText, writeTemplateOutput, type InitPromptAdapter } from "../index";

test("generates SDK files from a TypeScript schema module", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  await mkdir(join(dir, "src"));
  const schemaPath = join(dir, "cms.schema.ts");
  const outFile = join(dir, "src/generated.ts");
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");

  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', { title: fields.string({ required: true }) })
    });
  `);

  await generateSDK({ schemaPath, outFile });
  await expect(readFile(outFile, "utf8")).resolves.toContain("export type Articles");
});

test("generates schema artifacts from a collection-file directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const collectionsDir = join(dir, "cms/collections");
  const outFile = join(dir, "cms/sdk/index.ts");
  const openApiFile = join(dir, "cms/openapi.json");
  const drizzleFile = join(dir, "node_modules/.cms/drizzle-schema.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  await mkdir(collectionsDir, { recursive: true });

  await writeFile(join(collectionsDir, "authors.ts"), `
    import { defineCollection, fields } from ${JSON.stringify(schemaImport)};
    export default defineCollection('authors', { name: fields.string({ required: true }) });
  `);
  await writeFile(join(collectionsDir, "articles.ts"), `
    import { defineCollection, fields } from ${JSON.stringify(schemaImport)};
    export default defineCollection('articles', {
      title: fields.string({ required: true }),
      author: fields.relation('authors', 'many-to-one')
    }, { draftAndPublish: true });
  `);

  await generateSDK({ schemaPath: collectionsDir, outFile });
  await expect(readFile(outFile, "utf8")).resolves.toContain("export type Articles");
  const openapi = await generateOpenAPIArtifact({ schemaPath: collectionsDir, outFile: openApiFile });
  expect(openapi.source).toContain("\"/api/articles\"");
  const drizzle = await generateDrizzleArtifact({ schemaPath: collectionsDir, outFile: drizzleFile });
  expect(drizzle.source).toContain("export const articlesTable = sqliteTable(\"articles\"");
  expect(drizzle.source).toContain("authorId: text(\"author_id\", { length: 24 })");
  const plan = await schemaPlan({ schemaPath: collectionsDir, stateFile });
  expect(formatSchemaPlan(plan)).toContain("+ collection articles");
  expect(formatSchemaPlan(plan)).toContain("+ collection authors");
});

test("creates a content-type writer that refreshes generated artifacts after schema saves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const collectionsDir = join(dir, "cms/collections");
  const sdkOutFile = join(dir, "cms/sdk/index.ts");
  const openapiOutFile = join(dir, "cms/openapi.json");
  const drizzleOutFile = join(dir, "node_modules/.cms/drizzle-schema.ts");
  const drizzleConfigOutFile = join(dir, "node_modules/.cms/drizzle.config.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  const migrationsDir = join(dir, ".hono-cms/migrations");
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const collection = defineCollection("sections", {
    title: fields.string({ required: true }),
    layout: fields.enum(["hero", "grid"])
  }, { draftAndPublish: true });
  const source = `
    import { defineCollection, fields } from ${JSON.stringify(schemaImport)};
    export default defineCollection('sections', {
      title: fields.string({ required: true }),
      layout: fields.enum(['hero', 'grid'])
    }, { draftAndPublish: true });
  `;
  const writer = createContentTypeWriter({
    collectionsDir,
    sdkOutFile,
    openapiOutFile,
    drizzleOutFile,
    drizzleConfigOutFile,
    stateFile,
    migrationsDir,
    drizzleDialect: "pg",
    drizzleKit: true,
    drizzleKitRunner: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { stdout: "ok" };
    }
  });

  const write = await writer.writeCollection({ collection, source, mode: "create" });
  const afterWrite = await writer.afterWrite?.({ collection, source, mode: "create", result: write });

  expect(write.path).toBe(join(collectionsDir, "sections.ts"));
  await expect(readFile(join(collectionsDir, "sections.ts"), "utf8")).resolves.toContain("defineCollection('sections'");
  await expect(readFile(sdkOutFile, "utf8")).resolves.toContain("export type Sections");
  await expect(readFile(openapiOutFile, "utf8")).resolves.toContain("\"/api/sections\"");
  await expect(readFile(drizzleOutFile, "utf8")).resolves.toContain("export const sectionsTable = pgTable(\"sections\"");
  await expect(readFile(drizzleConfigOutFile, "utf8")).resolves.toContain("dialect: \"postgresql\"");
  expect(afterWrite).toMatchObject({
    artifacts: expect.arrayContaining([sdkOutFile, openapiOutFile, drizzleOutFile, drizzleConfigOutFile]),
    migrations: [expect.stringMatching(/create_sections\.sql$/)],
    message: "Schema artifacts refreshed"
  });
  expect(calls).toEqual([
    { command: "bunx", args: ["drizzle-kit", "generate", "--config", drizzleConfigOutFile], cwd: dir },
    { command: "bunx", args: ["drizzle-kit", "migrate", "--config", drizzleConfigOutFile], cwd: dir }
  ]);
});

test("prints current CLI usage for schema generation and multi-platform deployment", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await expect(main(["--help"])).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(usageText());
    expect(usageText()).toContain("schema check-sdk");
    expect(usageText()).toContain("schema openapi");
    expect(usageText()).toContain("schema drizzle");
    expect(usageText()).toContain("--openapi-out cms/openapi.json");
    expect(usageText()).toContain("--drizzle-out node_modules/.cms/drizzle-schema.ts");
    expect(usageText()).toContain("cms doctor");
    expect(usageText()).toContain("cloudflare|vercel|node|next");
    expect(usageText()).toContain("entrypoint --target");
  } finally {
    log.mockRestore();
  }
});

test("generates and checks Drizzle schemas from a TypeScript schema module", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaPath = join(dir, "cms.schema.ts");
  const outFile = join(dir, "node_modules/.cms/drizzle-schema.ts");
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', {
        title: fields.string({ required: true }),
        tags: fields.relation('tags', 'many-to-many')
      }, { draftAndPublish: true }),
      tags: defineCollection('tags', { name: fields.string({ required: true }) })
    });
  `);

  try {
    await expect(generateDrizzleArtifact({ schemaPath, outFile, check: true })).rejects.toThrow("Drizzle schema is out of date");
    const generated = await generateDrizzleArtifact({ schemaPath, outFile });
    expect(generated.changed).toBe(true);
    const source = await readFile(outFile, "utf8");
    expect(source).toContain("export const articlesTable = sqliteTable(\"articles\"");
    expect(source).toContain("export const articlesTagsTable = sqliteTable(\"articles_tags\"");
    await expect(main(["schema", "check-drizzle", "--schema", schemaPath, "--out", outFile])).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(`Drizzle schema is up to date: ${outFile}`);
  } finally {
    log.mockRestore();
  }
});

test("generates Postgres Drizzle schemas from the CLI dialect flag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaPath = join(dir, "cms.schema.ts");
  const outFile = join(dir, "node_modules/.cms/drizzle-schema.ts");
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', {
        title: fields.string({ required: true }),
        metadata: fields.json(),
        published: fields.boolean()
      }, { draftAndPublish: true })
    });
  `);

  try {
    await expect(main(["schema", "drizzle", "--schema", schemaPath, "--out", outFile, "--dialect", "pg"])).resolves.toBeUndefined();
    const source = await readFile(outFile, "utf8");
    expect(source).toContain("from \"drizzle-orm/pg-core\"");
    expect(source).toContain("export const articlesTable = pgTable(\"articles\"");
    expect(source).toContain("metadata: jsonb(\"metadata\")");
    expect(source).toContain("published: boolean(\"published\")");
    await expect(main(["schema", "check-drizzle", "--schema", schemaPath, "--out", outFile, "--dialect", "pg"])).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(`Drizzle schema is up to date: ${outFile}`);
  } finally {
    log.mockRestore();
  }
});

test("generates and checks Drizzle Kit config artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaOutFile = join(dir, "node_modules/.cms/drizzle-schema.ts");
  const outFile = join(dir, "node_modules/.cms/drizzle.config.ts");
  const migrationsDir = join(dir, ".hono-cms/migrations");
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  try {
    await expect(generateDrizzleConfigArtifact({ outFile, schemaOutFile, migrationsDir, dialect: "pg", check: true })).rejects.toThrow("Drizzle config is out of date");
    const generated = await generateDrizzleConfigArtifact({ outFile, schemaOutFile, migrationsDir, dialect: "pg" });
    expect(generated.source).toContain("import { defineConfig } from \"drizzle-kit\";");
    expect(generated.source).toContain("dialect: \"postgresql\"");
    expect(generated.source).toContain(`schema: ${JSON.stringify(schemaOutFile)}`);
    expect(generated.source).toContain(`out: ${JSON.stringify(migrationsDir)}`);
    expect(generated.source).toContain("process.env.DATABASE_URL");
    await expect(main([
      "schema",
      "check-drizzle-config",
      "--out",
      outFile,
      "--schema-out",
      schemaOutFile,
      "--migrations-dir",
      migrationsDir,
      "--dialect",
      "pg"
    ])).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(`Drizzle config is up to date: ${outFile}`);
  } finally {
    log.mockRestore();
  }
});

test("runs Drizzle Kit through generated schema and config artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaPath = join(dir, "cms.schema.ts");
  const migrationsDir = join(dir, ".hono-cms/migrations");
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', {
        title: fields.string({ required: true }),
        payload: fields.json()
      })
    });
  `);

  const result = await runDrizzleKit({
    schemaPath,
    action: "generate",
    migrationsDir,
    dialect: "pg",
    command: "bunx",
    runner: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { stdout: "No schema changes, nothing to migrate" };
    }
  });

  expect(calls).toEqual([{
    command: "bunx",
    args: ["drizzle-kit", "generate", "--config", join(dir, "node_modules/.cms/drizzle.config.ts")],
    cwd: dir
  }]);
  expect(result.stdout).toContain("No schema changes");
  await expect(readFile(join(dir, "node_modules/.cms/drizzle-schema.ts"), "utf8")).resolves.toContain("pgTable(\"articles\"");
  await expect(readFile(join(dir, "node_modules/.cms/drizzle.config.ts"), "utf8")).resolves.toContain("dialect: \"postgresql\"");
  await expect(readFile(join(dir, "node_modules/.cms/drizzle.config.ts"), "utf8")).resolves.toContain(`out: ${JSON.stringify(migrationsDir)}`);
});

test("reports Drizzle Kit runner failures with stderr context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaPath = join(dir, "cms.schema.ts");
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");

  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', { title: fields.string({ required: true }) })
    });
  `);

  await expect(runDrizzleKit({
    schemaPath,
    action: "migrate",
    runner: async () => {
      throw new Error("database locked");
    }
  })).rejects.toThrow("database locked");
});

test("buildProject emits Postgres Drizzle artifacts when requested", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaPath = join(dir, "cms.schema.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  const migrationsDir = join(dir, ".hono-cms/migrations");
  const outFile = join(dir, "cms/sdk/index.ts");
  const openapiOutFile = join(dir, "cms/openapi.json");
  const drizzleOutFile = join(dir, "node_modules/.cms/drizzle-schema.ts");
  const drizzleConfigOutFile = join(dir, "node_modules/.cms/drizzle.config.ts");
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");

  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', {
        title: fields.string({ required: true }),
        payload: fields.json()
      })
    });
  `);
  await schemaApply({ schemaPath, stateFile, yes: true, migrationsDir });

  await expect(buildProject({
    schemaPath,
    stateFile,
    outFile,
    openapiOutFile,
    drizzleOutFile,
    drizzleConfigOutFile,
    drizzleDialect: "pg"
  })).resolves.toMatchObject({ plan: { empty: true } });
  await expect(readFile(drizzleOutFile, "utf8")).resolves.toContain("export const articlesTable = pgTable(\"articles\"");
  await expect(readFile(drizzleConfigOutFile, "utf8")).resolves.toContain("dialect: \"postgresql\"");
});

test("checks generated SDK freshness without writing stale files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaPath = join(dir, "cms.schema.ts");
  const outFile = join(dir, "cms/sdk/index.ts");
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");

  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', { title: fields.string({ required: true }) })
    });
  `);

  await expect(generateSDKArtifact({ schemaPath, outFile, check: true })).rejects.toThrow("SDK types are out of date");
  await expect(readFile(outFile, "utf8")).rejects.toThrow();
  await expect(generateSDKArtifact({ schemaPath, outFile })).resolves.toMatchObject({ checked: false, changed: true });
  await expect(generateSDKArtifact({ schemaPath, outFile, check: true })).resolves.toMatchObject({ checked: true, changed: false });
});

test("exposes a CI-friendly schema check-sdk command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaPath = join(dir, "cms.schema.ts");
  const outFile = join(dir, "cms/sdk/index.ts");
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', { title: fields.string({ required: true }) })
    });
  `);

  try {
    await expect(main(["schema", "check-sdk", "--schema", schemaPath, "--out", outFile])).rejects.toThrow("SDK types are out of date");
    await generateSDKArtifact({ schemaPath, outFile });
    await expect(main(["schema", "check-sdk", "--schema", schemaPath, "--out", outFile])).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(`SDK types are up to date: ${outFile}`);
  } finally {
    log.mockRestore();
  }
});

test("generates and checks OpenAPI specs from a TypeScript schema module", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaPath = join(dir, "cms.schema.ts");
  const outFile = join(dir, "cms/openapi.json");
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', {
        title: fields.string({ required: true }),
        author: fields.relation('authors', 'one')
      }, { draftAndPublish: true }),
      authors: defineCollection('authors', { name: fields.string({ required: true }) })
    });
  `);

  try {
    await expect(generateOpenAPIArtifact({ schemaPath, outFile, check: true, title: "Newsroom CMS", version: "2026.5" })).rejects.toThrow("OpenAPI spec is out of date");
    const generated = await generateOpenAPIArtifact({ schemaPath, outFile, title: "Newsroom CMS", version: "2026.5" });
    expect(generated.changed).toBe(true);
    const spec = JSON.parse(await readFile(outFile, "utf8")) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(spec).toMatchObject({
      openapi: "3.1.0",
      info: { title: "Newsroom CMS", version: "2026.5" },
      paths: {
        "/api/articles": expect.any(Object),
        "/cms/health/ready": expect.any(Object),
        "/cms/schema": expect.any(Object)
      },
      components: {
        schemas: {
          Articles: expect.any(Object),
          ArticlesCreateInput: expect.any(Object),
          WebhookListResponse: expect.any(Object)
        }
      }
    });
    await expect(main(["schema", "check-openapi", "--schema", schemaPath, "--out", outFile, "--title", "Newsroom CMS", "--version", "2026.5"])).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(`OpenAPI spec is up to date: ${outFile}`);
  } finally {
    log.mockRestore();
  }
});

test("initializes a Cloudflare CMS preset with D1, R2, auth, and email env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  await writeFile(join(dir, "bun.lock"), "");

  const result = await initProject({
    cwd: dir,
    preset: "cloudflare",
    projectName: "newsroom",
    authPlugins: ["organization"],
    email: "resend"
  });

  expect(result).toMatchObject({ projectName: "newsroom", packageManager: "bun", installCommand: ["bun", "install"] });
  const cmsConfig = await readFile(join(dir, "cms.config.ts"), "utf8");
  const cmsDevConfig = await readFile(join(dir, "cms.dev.ts"), "utf8");
  const articleCollection = await readFile(join(dir, "cms/collections/articles.ts"), "utf8");
  const schemaIndex = await readFile(join(dir, "cms/schema.ts"), "utf8");
  expect(cmsConfig).toContain("import \"@hono-cms/adapter-d1\";");
  expect(cmsConfig).toContain("import \"@hono-cms/storage-r2\";");
  expect(cmsConfig).toContain("import { collections } from './cms/schema';");
  expect(cmsConfig).toContain("export const cmsConfig = {");
  expect(cmsConfig).toContain("contentTypeBuilder: false");
  expect(cmsConfig).toContain("collections,");
  expect(cmsConfig).not.toContain("@hono-cms/cli");
  expect(cmsDevConfig).toContain("import { createContentTypeWriter } from '@hono-cms/cli';");
  expect(cmsDevConfig).toContain("collectionsDir: 'cms/collections'");
  expect(articleCollection).toContain("export default defineCollection('articles'");
  expect(schemaIndex).toContain("import collection0 from \"./collections/articles\";");
  expect(schemaIndex).toContain("export const collections = defineSchema");
  expect(cmsConfig).toContain("const DB = (globalThis as typeof globalThis & { DB?: import(\"@hono-cms/adapter-d1\").D1DatabaseLike }).DB;");
  expect(cmsConfig).toContain("const R2_BUCKET = (globalThis as typeof globalThis & { R2_BUCKET: import(\"@hono-cms/storage-r2\").R2BucketBinding }).R2_BUCKET;");
  expect(cmsConfig).toContain("db: { provider: \"d1\", collections, binding: DB }");
  expect(cmsConfig).toContain("storage: { provider: \"r2\", bucket: R2_BUCKET");
  await expect(readFile(join(dir, ".env.example"), "utf8")).resolves.toContain("CLOUDFLARE_D1_DATABASE_ID");
  await expect(readFile(join(dir, ".env.example"), "utf8")).resolves.toContain("R2_BUCKET_NAME");
  await expect(readFile(join(dir, ".env.example"), "utf8")).resolves.toContain("RESEND_API_KEY");
  const packageJson = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  expect(packageJson.dependencies).toMatchObject({
    "@hono-cms/adapter-d1": "latest",
    "@hono-cms/auth-organization": "latest",
    "@hono-cms/core": "latest",
    "@hono-cms/schema": "latest",
    "qs": "latest"
  });
  expect(packageJson.devDependencies).toMatchObject({
    "@types/qs": "latest",
    "@hono-cms/cli": "latest",
    "drizzle-kit": "latest"
  });
  expect(packageJson.scripts).toMatchObject({
    "cms:dev": "cms dev --cms cms.dev.ts --schema cms/collections --drizzle-kit",
    "cms:schema:generate": "cms schema drizzle-generate --schema cms.config.ts",
    "cms:schema:migrate": "cms schema drizzle-migrate --schema cms.config.ts"
  });
});

test("starts a dev server using the Web Request CMS handler", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const cmsPath = join(dir, "cms.config.ts");
  await writeFile(cmsPath, `
    export default {
      db: { provider: 'test' },
      fetch: (request) => new Response(JSON.stringify({ ok: true, path: new URL(request.url).pathname }), {
        headers: { 'content-type': 'application/json' }
      })
    };
  `);

  const server = await startDevServer({ cmsPath, port: 0, autoMigrate: false });
  try {
    expect(server.banner).toContain("@hono-cms/dev");
    const response = await fetch(`${server.url}/api/health`);
    await expect(response.json()).resolves.toEqual({ ok: true, path: "/api/health" });
  } finally {
    await server.close();
  }
});

test("serves built admin assets before falling back to CMS routes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const cmsPath = join(dir, "cms.config.ts");
  const adminDist = join(dir, "admin-dist");
  await mkdir(adminDist);
  await writeFile(join(adminDist, "index.html"), "<main>Admin Shell</main>");
  await writeFile(join(adminDist, "app.js"), "console.log('admin');");
  await writeFile(cmsPath, `
    export default {
      db: { provider: 'test' },
      fetch: (request) => new Response('cms:' + new URL(request.url).pathname)
    };
  `);

  const server = await startDevServer({ cmsPath, adminDist, port: 0, autoMigrate: false, watch: false });
  try {
    await expect(fetch(`${server.url}/admin`).then((response) => response.text())).resolves.toContain("Admin Shell");
    await expect(fetch(`${server.url}/admin/app.js`).then((response) => response.text())).resolves.toContain("console.log");
    await expect(fetch(`${server.url}/api/health`).then((response) => response.text())).resolves.toBe("cms:/api/health");
  } finally {
    await server.close();
  }
});

test("proxies admin requests to Vite when no built admin dist exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const cmsPath = join(dir, "cms.config.ts");
  await writeFile(cmsPath, `
    export default {
      db: { provider: 'test' },
      fetch: () => new Response('cms')
    };
  `);
  const upstream = createServer((request, response) => {
    response.setHeader("content-type", "text/plain");
    response.end("vite:" + request.url);
  });
  await new Promise<void>((resolveListen) => upstream.listen(0, "localhost", resolveListen));
  const address = upstream.address();
  if (!address || typeof address !== "object") throw new Error("Missing upstream address.");

  const server = await startDevServer({
    cmsPath,
    adminDist: join(dir, "missing-admin-dist"),
    adminProxyUrl: `http://localhost:${address.port}`,
    port: 0,
    autoMigrate: false,
    watch: false
  });
  try {
    await expect(fetch(`${server.url}/admin/src/main.tsx?x=1`).then((response) => response.text())).resolves.toBe("vite:/src/main.tsx?x=1");
  } finally {
    await server.close();
    await new Promise<void>((resolveClose, rejectClose) => upstream.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});

test("auto-migrates schema state before accepting dev requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const cmsPath = join(dir, "cms.config.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  const migrationsDir = join(dir, ".hono-cms/migrations");
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  await writeFile(cmsPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export const schema = defineSchema({
      articles: defineCollection('articles', { title: fields.string({ required: true }) })
    });
    export default {
      db: { provider: 'test' },
      fetch: () => new Response('ready')
    };
  `);

  const server = await startDevServer({ cmsPath, stateFile, migrationsDir, port: 0 });
  try {
    expect(server.banner).toContain("Auto-migration applied (2 changes).");
    await expect(readFile(stateFile, "utf8").then(JSON.parse)).resolves.toMatchObject({ collections: { articles: {} } });
    await expect(readFile(join(dir, "node_modules/.cms/drizzle-schema.ts"), "utf8")).resolves.toContain("export const articlesTable = sqliteTable(\"articles\"");
    await expect(readFile(join(dir, "node_modules/.cms/drizzle.config.ts"), "utf8")).resolves.toContain("schema: " + JSON.stringify(join(dir, "node_modules/.cms/drizzle-schema.ts")));
    expect(await readdir(migrationsDir)).toHaveLength(1);
  } finally {
    await server.close();
  }
});

test("runs Drizzle Kit generate and migrate during opt-in dev auto-migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const cmsPath = join(dir, "cms.config.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  const migrationsDir = join(dir, ".hono-cms/migrations");
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  await writeFile(cmsPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export const schema = defineSchema({
      articles: defineCollection('articles', { title: fields.string({ required: true }) })
    });
    export default {
      db: { provider: 'test' },
      fetch: () => new Response('ready')
    };
  `);

  const server = await startDevServer({
    cmsPath,
    stateFile,
    migrationsDir,
    port: 0,
    watch: false,
    drizzleKit: true,
    drizzleKitRunner: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { stdout: `${args[1]} ok` };
    }
  });
  try {
    expect(calls).toEqual([
      {
        command: "bunx",
        args: ["drizzle-kit", "generate", "--config", join(dir, "node_modules/.cms/drizzle.config.ts")],
        cwd: dir
      },
      {
        command: "bunx",
        args: ["drizzle-kit", "migrate", "--config", join(dir, "node_modules/.cms/drizzle.config.ts")],
        cwd: dir
      }
    ]);
  } finally {
    await server.close();
  }
});

test("watches schema files and reruns dev migrations on change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const cmsPath = join(dir, "cms.config.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  const migrationsDir = join(dir, ".hono-cms/migrations");
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const writeSchema = (withSummary: boolean) => writeFile(cmsPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export const schema = defineSchema({
      articles: defineCollection('articles', {
        title: fields.string({ required: true })${withSummary ? ",\n        summary: fields.text()" : ""}
      })
    });
    export default {
      db: { provider: 'test' },
      fetch: () => new Response('ready')
    };
  `);
  await writeSchema(false);

  const server = await startDevServer({ cmsPath, stateFile, migrationsDir, port: 0, watchPaths: [cmsPath] });
  try {
    await expect(readFile(join(dir, "cms/sdk/index.ts"), "utf8")).resolves.toContain("export type Articles");
    await writeSchema(true);
    await waitFor(async () => {
      const snapshot = JSON.parse(await readFile(stateFile, "utf8"));
      return Boolean(snapshot.collections?.articles?.fields?.summary);
    });
    await waitFor(async () => {
      const sdk = await readFile(join(dir, "cms/sdk/index.ts"), "utf8");
      return sdk.includes("\"summary\"?: string;");
    });
    await waitFor(async () => {
      const drizzle = await readFile(join(dir, "node_modules/.cms/drizzle-schema.ts"), "utf8");
      return drizzle.includes("summary: text(\"summary\")");
    });
    expect(await readdir(migrationsDir)).toHaveLength(2);
  } finally {
    await server.close();
  }
});

test("manual dev migration reruns refresh generated schema artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const cmsPath = join(dir, "cms.config.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  const migrationsDir = join(dir, ".hono-cms/migrations");
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const writeSchema = (withSummary: boolean) => writeFile(cmsPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export const schema = defineSchema({
      articles: defineCollection('articles', {
        title: fields.string({ required: true })${withSummary ? ",\n        summary: fields.text()" : ""}
      })
    });
    export default {
      db: { provider: 'test' },
      fetch: () => new Response('ready')
    };
  `);
  await writeSchema(false);

  const server = await startDevServer({ cmsPath, stateFile, migrationsDir, port: 0, watch: false });
  try {
    await writeSchema(true);
    const plan = await server.rerunMigrations();

    expect(plan?.changes.some((change) => change.type === "add_field" && change.collection === "articles" && change.field === "summary")).toBe(true);
    await expect(readFile(join(dir, "cms/sdk/index.ts"), "utf8")).resolves.toContain("\"summary\"?: string;");
    await expect(readFile(join(dir, "node_modules/.cms/drizzle-schema.ts"), "utf8")).resolves.toContain("summary: text(\"summary\")");
    await expect(readFile(join(dir, "node_modules/.cms/drizzle.config.ts"), "utf8")).resolves.toContain("schema: " + JSON.stringify(join(dir, "node_modules/.cms/drizzle-schema.ts")));
    expect(await readdir(migrationsDir)).toHaveLength(2);
  } finally {
    await server.close();
  }
});

test("reloads the CMS handler after watched dev file changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const cmsPath = join(dir, "cms.config.ts");
  const writeCMS = (version: string) => writeFile(cmsPath, `
    export default {
      db: { provider: 'test' },
      fetch: () => new Response(${JSON.stringify(version)})
    };
  `);
  await writeCMS("v1");

  const server = await startDevServer({ cmsPath, port: 0, autoMigrate: false, watchPaths: [cmsPath] });
  try {
    await expect(fetch(`${server.url}/api/version`).then((response) => response.text())).resolves.toBe("v1");
    await writeCMS("v2");
    await waitFor(async () => {
      const response = await fetch(`${server.url}/api/version`);
      return await response.text() === "v2";
    });
  } finally {
    await server.close();
  }
});

test("initializes a Node CMS preset while preserving package.json fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  await writeFile(join(dir, "package-lock.json"), "{}");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "existing-app", scripts: { test: "vitest" }, dependencies: { hono: "^4.0.0" } }));

  const result = await initProject({ cwd: dir, preset: "node", database: "postgres", storage: "local" });

  expect(result).toMatchObject({ packageManager: "npm", installCommand: ["npm", "install"], devDependencies: expect.arrayContaining(["@hono-cms/cli", "drizzle-kit"]) });
  const packageJson = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  expect(packageJson.name).toBe("existing-app");
  expect(packageJson.scripts).toMatchObject({
    test: "vitest",
    "cms:dev": "cms dev --cms cms.dev.ts --schema cms/collections --drizzle-kit",
    "cms:build": "cms build --schema cms.config.ts --state .hono-cms/schema-state.json --out cms/sdk/index.ts"
  });
  expect(packageJson.dependencies).toMatchObject({
    hono: "^4.0.0",
    "@hono-cms/adapter-postgres": "latest",
    "@hono-cms/storage-local": "latest",
    "qs": "latest"
  });
  expect(packageJson.devDependencies).toMatchObject({
    "@types/qs": "latest",
    "@hono-cms/cli": "latest",
    "drizzle-kit": "latest"
  });
  await expect(readFile(join(dir, ".env.example"), "utf8")).resolves.toContain("DATABASE_URL");
});

test("runs the interactive init wizard through prompt selections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const answers: unknown[] = ["editorial", "vercel", "postgres", "vercel-blob", ["users", "api-keys"], "resend", false];
  const seen: string[] = [];
  const prompts: InitPromptAdapter = {
    intro: (message) => seen.push(`intro:${message}`),
    outro: (message) => seen.push(`outro:${message}`),
    cancel: (message) => seen.push(`cancel:${message}`),
    isCancel: () => false,
    text: async (options) => {
      seen.push(options.message);
      return answers.shift();
    },
    select: async (options) => {
      seen.push(options.message);
      return answers.shift();
    },
    multiselect: async (options) => {
      seen.push(options.message);
      return answers.shift();
    },
    confirm: async (options) => {
      seen.push(options.message);
      return answers.shift();
    }
  };

  const result = await initProjectWizard({ cwd: dir, prompts });

  expect(result).toMatchObject({ projectName: "editorial", dependencies: expect.arrayContaining(["@hono-cms/adapter-postgres", "@hono-cms/storage-vercel-blob"]) });
  expect(seen).toContain("Hosting target");
  expect(seen.at(-1)).toContain("Created Hono CMS project");
  const cmsConfig = await readFile(join(dir, "cms.config.ts"), "utf8");
  expect(cmsConfig).toContain("import \"@hono-cms/adapter-postgres\";");
  expect(cmsConfig).toContain("import \"@hono-cms/storage-vercel-blob\";");
  expect(cmsConfig).toContain("import { collections } from './cms/schema';");
  expect(cmsConfig).toContain("contentTypeBuilder: false");
  await expect(readFile(join(dir, "cms.dev.ts"), "utf8")).resolves.toContain("writer: createContentTypeWriter");
  expect(cmsConfig).toContain("const env = typeof process === \"undefined\" ? {} : process.env;");
  expect(cmsConfig).toContain("db: { provider: \"postgres\", collections, url: env.DATABASE_URL }");
  expect(cmsConfig).toContain("storage: { provider: \"vercel-blob\", token: env.BLOB_READ_WRITE_TOKEN }");
  await expect(readFile(join(dir, ".env.example"), "utf8")).resolves.toContain("RESEND_API_KEY");
});

test("scaffolded Node memory/local config imports as a runnable CMS instance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  await initProject({ cwd: dir, preset: "node", database: "memory", storage: "local" });
  await linkWorkspacePackages(dir, ["core", "schema", "cli", "adapter-memory", "storage-local", "platform"]);

  const cms = await loadCMS(join(dir, "cms.config.ts"));
  const response = await cms.fetch(new Request("https://cms.test/cms/health/live"));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ status: "ok" });
});

test("scaffolded dev config handles Content-Type Builder writes through Web Request routes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  await initProject({ cwd: dir, preset: "node", database: "memory", storage: "local" });
  await linkWorkspacePackages(dir, ["core", "schema", "cli", "adapter-memory", "storage-local", "platform"]);
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    const cms = await loadCMS(join(dir, "cms.dev.ts"));
    const response = await cms.fetch(new Request("https://cms.test/cms/content-types", {
      method: "POST",
      headers: { authorization: "Bearer dev", "content-type": "application/json" },
      body: JSON.stringify({
        name: "sections",
        fields: {
          title: { kind: "string", required: true },
          layout: { kind: "enum", values: ["hero", "grid"] }
        },
        options: { draftAndPublish: true }
      })
    }));

    expect(response.status).toBe(201);
    const body = await response.json() as { path: string; artifacts: string[]; migrations: string[]; collection: { name: string } };
    expect(body.collection).toMatchObject({ name: "sections" });
    expect(body.path).toMatch(/cms\/collections\/sections\.ts$/);
    expect(body.artifacts).toEqual(expect.arrayContaining([
      expect.stringMatching(/cms\/sdk\/index\.ts$/),
      expect.stringMatching(/cms\/openapi\.json$/),
      expect.stringMatching(/node_modules\/\.cms\/drizzle-schema\.ts$/),
      expect.stringMatching(/node_modules\/\.cms\/drizzle\.config\.ts$/)
    ]));
    expect(body.migrations).toHaveLength(1);
    await expect(readFile(join(dir, "cms/collections/sections.ts"), "utf8")).resolves.toContain("defineCollection");
    await expect(readFile(join(dir, "cms/schema.ts"), "utf8")).resolves.toContain("sections");
    await expect(readFile(join(dir, "cms/sdk/index.ts"), "utf8")).resolves.toContain("export type Sections");
    await expect(readFile(join(dir, "cms/openapi.json"), "utf8")).resolves.toContain("\"/api/sections\"");
    await expect(readFile(join(dir, "node_modules/.cms/drizzle-schema.ts"), "utf8")).resolves.toContain("sectionsTable");
    await expect(readFile(body.migrations[0] ?? "", "utf8")).resolves.toContain("CREATE TABLE \"sections\"");
  } finally {
    process.chdir(originalCwd);
  }
});

test("scaffolded Cloudflare D1/R2 config imports with Worker-style bindings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  await initProject({ cwd: dir, preset: "cloudflare", database: "d1", storage: "r2" });
  await linkWorkspacePackages(dir, ["core", "schema", "cli", "adapter-kit", "adapter-d1", "storage-r2", "platform"]);
  const globals = globalThis as typeof globalThis & { DB?: unknown; R2_BUCKET?: unknown };
  globals.DB = {};
  globals.R2_BUCKET = {
    async put() {},
    async get() {
      return null;
    },
    async delete() {}
  };

  try {
    const cms = await loadCMS(join(dir, "cms.config.ts"));
    const response = await cms.fetch(new Request("https://cms.test/cms/health/live"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  } finally {
    delete globals.DB;
    delete globals.R2_BUCKET;
  }
});

test("scaffolded Vercel Postgres/Blob config imports as an edge handler target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  await initProject({ cwd: dir, preset: "vercel", database: "postgres", storage: "vercel-blob" });
  await linkWorkspacePackages(dir, ["core", "schema", "cli", "adapter-kit", "adapter-postgres", "storage-vercel-blob", "platform"]);

  const cms = await loadCMS(join(dir, "cms.config.ts"));
  const response = await cms.fetch(new Request("https://cms.test/cms/health/live"));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ status: "ok" });
});

test("scaffolded Next preset writes an App Router handler backed by the CMS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const result = await initProject({ cwd: dir, preset: "next", database: "memory", storage: "none" });
  await linkWorkspacePackages(dir, ["core", "schema", "cli", "adapter-memory", "storage-memory", "platform"]);

  expect(result.files).toEqual(expect.arrayContaining([
    join(dir, "cms.config.ts"),
    join(dir, "cms.dev.ts"),
    join(dir, "cms/collections/articles.ts"),
    join(dir, "cms/schema.ts"),
    join(dir, "app/api/cms/[...route]/route.ts")
  ]));
  expect(result.dependencies).toEqual(expect.arrayContaining(["@hono-cms/platform"]));
  const routeSource = await readFile(join(dir, "app/api/cms/[...route]/route.ts"), "utf8");
  expect(routeSource).toContain("import cms from \"../../../../cms.config\";");
  expect(routeSource).toContain("import { createNextRouteHandlers } from '@hono-cms/platform/next';");
  expect(routeSource).toContain("export const runtime = 'edge';");
  expect(routeSource).toContain("export const HEAD = handlers.HEAD;");

  const route = await import(`${join(dir, "app/api/cms/[...route]/route.ts")}?next=${Date.now()}`) as {
    GET(request: Request): Promise<Response>;
    POST(request: Request): Promise<Response>;
    HEAD(request: Request): Promise<Response>;
    runtime: string;
  };
  expect(route.runtime).toBe("edge");
  const response = await route.GET(new Request("https://cms.test/cms/health/live"));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ status: "ok" });
});

test("blocks incompatible init provider selections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  await expect(initProject({ cwd: dir, preset: "cloudflare", database: "d1", storage: "local" })).rejects.toThrow("D1");
  await expect(readFile(join(dir, "cms.config.ts"), "utf8")).rejects.toThrow();
});

test("plans, applies, and checks schema state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const schemaPath = join(dir, "cms.schema.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  const migrationsDir = join(dir, ".hono-cms/migrations");
  const outFile = join(dir, "src/generated.ts");
  const openapiOutFile = join(dir, "cms/openapi.json");
  const drizzleOutFile = join(dir, "node_modules/.cms/drizzle-schema.ts");
  const drizzleConfigOutFile = join(dir, "node_modules/.cms/drizzle.config.ts");
  await mkdir(join(dir, "src"));
  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', { title: fields.string({ required: true }) })
    });
  `);

  const planned = await schemaPlan({ schemaPath, stateFile });
  expect(planned.empty).toBe(false);
  expect(planned.changes).toContainEqual({ type: "create_collection", collection: "articles" });
  expect(schemaCheckJSON(planned)).toMatchObject({ clean: false, plan: { empty: false } });

  await expect(schemaApply({ schemaPath, stateFile })).rejects.toThrow("--yes");
  await schemaApply({ schemaPath, stateFile, yes: true, migrationsDir });
  await expect(schemaCheck({ schemaPath, stateFile })).resolves.toMatchObject({ empty: true });
  expect(schemaCheckJSON(await schemaCheck({ schemaPath, stateFile }))).toMatchObject({ clean: true, plan: { empty: true } });
  await expect(buildProject({ schemaPath, stateFile, outFile, openapiOutFile, drizzleOutFile, drizzleConfigOutFile, openapiTitle: "Build CMS" })).resolves.toMatchObject({ plan: { empty: true } });
  await expect(readFile(outFile, "utf8")).resolves.toContain("export type Articles");
  await expect(readFile(openapiOutFile, "utf8").then(JSON.parse)).resolves.toMatchObject({
    info: { title: "Build CMS" },
    paths: { "/api/articles": expect.any(Object) }
  });
  await expect(readFile(drizzleOutFile, "utf8")).resolves.toContain("export const articlesTable = sqliteTable(\"articles\"");
  await expect(readFile(drizzleConfigOutFile, "utf8")).resolves.toContain("dialect: \"sqlite\"");
  await expect(buildProject({ schemaPath, stateFile, outFile, openapiOutFile, drizzleOutFile, drizzleConfigOutFile, openapiTitle: "Build CMS", check: true })).resolves.toMatchObject({ plan: { empty: true } });
  const migrations = await readdir(migrationsDir);
  expect(migrations).toHaveLength(1);
  expect(migrations[0]).toMatch(/^\d{14}_create_articles\.sql$/);
  await expect(readFile(join(migrationsDir, migrations[0] ?? ""), "utf8")).resolves.toContain("CREATE TABLE \"articles\"");
});

test("schema check command emits CI JSON and marks drift as failed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const schemaPath = join(dir, "cms.schema.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const previousExitCode = process.exitCode;

  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', { title: fields.string({ required: true }) })
    });
  `);

  try {
    process.exitCode = undefined;
    await expect(main(["schema", "check", "--schema", schemaPath, "--state", stateFile, "--format", "json", "--assert-clean"])).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    const drift = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(drift).toMatchObject({
      clean: false,
      plan: {
        empty: false
      }
    });
    expect(drift.plan.changes).toContainEqual({ type: "create_collection", collection: "articles" });

    await schemaApply({ schemaPath, stateFile, yes: true });
    process.exitCode = undefined;
    await expect(main(["schema", "check", "--schema", schemaPath, "--state", stateFile, "--format", "json", "--assert-clean"])).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();
    const clean = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(clean).toMatchObject({ clean: true, plan: { empty: true } });
  } finally {
    process.exitCode = previousExitCode;
    log.mockRestore();
  }
});

test("doctor reports schema drift and generated artifact freshness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const schemaPath = join(dir, "cms.schema.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  const migrationsDir = join(dir, ".hono-cms/migrations");
  const sdkOutFile = join(dir, "cms/sdk/index.ts");
  const openapiOutFile = join(dir, "cms/openapi.json");
  const drizzleOutFile = join(dir, "node_modules/.cms/drizzle-schema.ts");
  const drizzleConfigOutFile = join(dir, "node_modules/.cms/drizzle.config.ts");
  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', { title: fields.string({ required: true }) })
    });
  `);

  const stale = await doctorProject({ schemaPath, stateFile, sdkOutFile, openapiOutFile, drizzleOutFile, drizzleConfigOutFile, migrationsDir });
  expect(stale.ok).toBe(false);
  expect(stale.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "schema", status: "ok" }),
    expect.objectContaining({ name: "schema-drift", status: "fail" }),
    expect.objectContaining({ name: "sdk", status: "fail" }),
    expect.objectContaining({ name: "openapi", status: "fail" }),
    expect.objectContaining({ name: "drizzle-schema", status: "fail" }),
    expect.objectContaining({ name: "drizzle-config", status: "fail" })
  ]));

  await schemaApply({ schemaPath, stateFile, migrationsDir, yes: true });
  await generateSDKArtifact({ schemaPath, outFile: sdkOutFile });
  await generateOpenAPIArtifact({ schemaPath, outFile: openapiOutFile });
  await generateDrizzleArtifact({ schemaPath, outFile: drizzleOutFile });
  await generateDrizzleConfigArtifact({ outFile: drizzleConfigOutFile, schemaOutFile: drizzleOutFile, migrationsDir });

  const clean = await doctorProject({ schemaPath, stateFile, sdkOutFile, openapiOutFile, drizzleOutFile, drizzleConfigOutFile, migrationsDir });
  expect(clean.ok).toBe(true);
  expect(clean.checks.every((check) => check.status === "ok")).toBe(true);
});

test("doctor command emits CI JSON and sets a failing exit code for stale workspaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const schemaPath = join(dir, "cms.schema.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const previousExitCode = process.exitCode;
  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', { title: fields.string({ required: true }) })
    });
  `);

  try {
    process.exitCode = undefined;
    await expect(main(["doctor", "--schema", schemaPath, "--state", stateFile, "--format", "json"])).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    const result = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(result).toMatchObject({ ok: false, checks: expect.arrayContaining([expect.objectContaining({ name: "schema-drift", status: "fail" })]) });
  } finally {
    process.exitCode = previousExitCode;
    log.mockRestore();
  }
});

test("schema plan includes Better Auth system tables from exported cms config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const coreImport = resolve(__dirname, "../../../core/src/index.ts");
  const schemaPath = join(dir, "cms.config.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  const migrationsDir = join(dir, ".hono-cms/migrations");
  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    import type { CMSConfig } from ${JSON.stringify(coreImport)};

    export const collections = defineSchema({
      articles: defineCollection('articles', { title: fields.string({ required: true }) })
    });

    export const cmsConfig = {
      collections,
      db: { provider: 'memory' },
      auth: { emailAndPassword: { enabled: true } }
    } satisfies CMSConfig<typeof collections>;
  `);

  const planned = await schemaPlan({ schemaPath, stateFile });
  expect(planned.changes).toContainEqual({ type: "create_system_table", table: "auth:user" });
  expect(formatSchemaPlan(planned)).toContain("+ system table auth:user");
  expect(renderSchemaMigrationSQL(planned)).toContain("CREATE TABLE \"user\"");

  await schemaApply({ schemaPath, stateFile, yes: true, migrationsDir });
  await expect(schemaCheck({ schemaPath, stateFile })).resolves.toMatchObject({ empty: true });

  const migrations = await readdir(migrationsDir);
  await expect(readFile(join(migrationsDir, migrations[0] ?? ""), "utf8")).resolves.toContain("CREATE TABLE \"user\"");
});

test("schema plan rejects content collections that conflict with Better Auth table names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const coreImport = resolve(__dirname, "../../../core/src/index.ts");
  const schemaPath = join(dir, "cms.config.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    import type { CMSConfig } from ${JSON.stringify(coreImport)};

    export const collections = defineSchema({
      users: defineCollection('users', { name: fields.string({ required: true }) })
    });

    export const cmsConfig = {
      collections,
      db: { provider: 'memory' },
      auth: { emailAndPassword: { enabled: true } }
    } satisfies CMSConfig<typeof collections>;
  `);

  await expect(schemaPlan({ schemaPath, stateFile })).rejects.toThrow("content type 'users' conflicts with better-auth's reserved table name 'user'");
});

test("dry-runs schema apply without writing state or migrations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const schemaPath = join(dir, "cms.schema.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  const migrationsDir = join(dir, ".hono-cms/migrations");
  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', { title: fields.string({ required: true }) })
    });
  `);

  const plan = await schemaApply({ schemaPath, stateFile, dryRun: true, migrationsDir });
  expect(plan).toMatchObject({ empty: false });
  expect(renderSchemaMigrationSQL(plan)).toContain("CREATE TABLE \"articles\"");
  await expect(readFile(stateFile, "utf8")).rejects.toThrow();
  await expect(readdir(migrationsDir)).rejects.toThrow();
});

test("schema plan detects collection option drift", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const schemaPath = join(dir, "cms.schema.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  const migrationsDir = join(dir, ".hono-cms/migrations");
  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      pages: defineCollection('pages', { title: fields.string({ required: true }) })
    });
  `);
  await schemaApply({ schemaPath, stateFile, yes: true, migrationsDir });
  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      pages: defineCollection('pages', { title: fields.string({ required: true }) }, {
        i18n: { locales: ['en', 'es'], defaultLocale: 'en' },
        draftAndPublish: true
      })
    });
  `);

  const plan = await schemaPlan({ schemaPath, stateFile });
  expect(plan).toMatchObject({ empty: false, destructive: false });
  expect(plan.changes).toEqual([
    {
      type: "alter_collection",
      collection: "pages",
      before: {},
      after: { draftAndPublish: true, i18n: { locales: ["en", "es"], defaultLocale: "en" } }
    }
  ]);
  expect(formatSchemaPlan(plan)).toContain("~ collection pages options");
  expect(renderSchemaMigrationSQL(plan)).toContain("Collection option change for pages");
  await schemaApply({ schemaPath, stateFile, yes: true, migrationsDir });
  await expect(schemaCheck({ schemaPath, stateFile })).resolves.toMatchObject({ empty: true });
});

test("guards destructive schema apply and clears stale locks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const schemaPath = join(dir, "cms.schema.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  const lockFile = join(dir, ".hono-cms/.cms-schema.lock");

  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', { title: fields.string({ required: true }) })
    });
  `);
  await schemaApply({ schemaPath, stateFile, yes: true, lockFile });

  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', {})
    });
  `);

  await expect(schemaApply({ schemaPath, stateFile, yes: true, lockFile })).rejects.toThrow("--allow-destructive");
  await writeFile(lockFile, JSON.stringify({ pid: 9_999_999, startedAt: new Date().toISOString(), operation: "schema apply" }));
  await expect(schemaApply({ schemaPath, stateFile, yes: true, allowDestructive: true, lockFile })).resolves.toMatchObject({ destructive: true });
  await expect(readFile(lockFile, "utf8")).rejects.toThrow();
});

test("rejects schema apply when a live lock exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const schemaPath = join(dir, "cms.schema.ts");
  const stateFile = join(dir, ".hono-cms/schema-state.json");
  const lockFile = join(dir, ".hono-cms/.cms-schema.lock");

  await mkdir(join(dir, ".hono-cms"), { recursive: true });
  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', { title: fields.string({ required: true }) })
    });
  `);
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), operation: "schema apply" }));

  await expect(schemaApply({ schemaPath, stateFile, yes: true, lockFile })).rejects.toThrow("Another schema apply is in progress");
});

test("renders platform deploy templates", () => {
  const cloudflare = deployTemplate("cloudflare", { entry: "src/worker.ts" });
  expect(cloudflare).toContain("main = \"src/worker.ts\"");
  expect(cloudflare).toContain("compatibility_date");
  expect(cloudflare).toContain("[[d1_databases]]");
  expect(cloudflare).toContain("[[r2_buckets]]");
  expect(cloudflare).toContain("[triggers]");
  const vercel = JSON.parse(deployTemplate("vercel")) as { functions: Record<string, { runtime: string }>; crons: Array<{ path: string; schedule: string }> };
  expect(vercel.functions["api/cms/[[...route]].ts"]).toEqual({ runtime: "edge" });
  expect(vercel.crons).toEqual(expect.arrayContaining([
    { path: "/cms/jobs/scheduled-publish", schedule: "*/15 * * * *" }
  ]));
  const node = deployTemplate("node");
  expect(node).toContain("===== Dockerfile =====");
  expect(node).toContain("FROM node:22-alpine AS base");
  expect(node).toContain("===== docker-compose.yml =====");
  expect(node).toContain("postgres:");
  expect(node).toContain("fetch: cms.fetch");
  expect(node).toContain("/cms/health/live");
  expect(node).toContain("start_period: 15s");
  const next = deployTemplate("next");
  expect(next).toContain("Save as app/api/cms/[...route]/route.ts");
  expect(next).toContain("import { createNextRouteHandlers } from '@hono-cms/platform/next';");
  expect(next).toContain("import cms from \"../../../../cms.config\";");
  expect(next).toContain("export const HEAD = handlers.HEAD;");
  expect(platformEntrypointTemplate("cloudflare")).toContain("fetch(request: Request");
  expect(platformEntrypointTemplate("cloudflare")).toContain("scheduled(event: ScheduledEvent");
  expect(platformEntrypointTemplate("vercel")).toContain("export const runtime = 'edge'");
  expect(platformEntrypointTemplate("vercel")).toContain("export const DELETE = GET");
  expect(platformEntrypointTemplate("vercel")).toContain("export const HEAD = GET");
  expect(platformEntrypointTemplate("next")).toContain("createNextRouteHandlers(cms)");
  expect(platformEntrypointTemplate("next")).toContain("export const HEAD = handlers.HEAD");
  expect(platformEntrypointTemplate("node")).toContain("fetch: (request) => cms.fetch(request)");
});

test("renders schema-aware deploy templates from collection capabilities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const schemaPath = join(dir, "cms.schema.ts");
  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      articles: defineCollection('articles', {
        title: fields.string({ required: true }),
        hero: fields.media(),
        gallery: fields.media({ multiple: true })
      }, { draftAndPublish: true }),
      pages: defineCollection('pages', {
        title: fields.string({ localized: true })
      }, { i18n: { locales: ['en', 'es'], defaultLocale: 'en' } })
    });
  `);

  const cloudflare = await deployTemplateFromSchema("cloudflare", { schemaPath, projectName: "newsroom" });
  expect(cloudflare).toContain("name = \"newsroom\"");
  expect(cloudflare).toContain("# Schema collections: articles, pages");
  expect(cloudflare).toContain("# Media fields: articles.hero, articles.gallery");
  expect(cloudflare).toContain("bucket_name = \"newsroom-media\"");
  expect(cloudflare).toContain("crons = [\"*/15 * * * *\",\"0 3 * * *\"]");

  const vercel = JSON.parse(await deployTemplateFromSchema("vercel", { schemaPath })) as {
    crons: Array<{ path: string; schedule: string }>;
    honoCms: { infrastructure: ReturnType<typeof planDeployInfrastructure>; env: Record<string, string> };
  };
  expect(vercel.honoCms.infrastructure).toMatchObject({
    collections: ["articles", "pages"],
    mediaFields: [
      { collection: "articles", field: "hero", multiple: false },
      { collection: "articles", field: "gallery", multiple: true }
    ],
    draftCollections: ["articles"],
    localizedCollections: ["pages"],
    requiresMediaStorage: true,
    requiresScheduledJobs: true
  });
  expect(vercel.honoCms.env.BLOB_READ_WRITE_TOKEN).toContain("media fields");
  expect(vercel.crons).toContainEqual({ path: "/cms/jobs/scheduled-publish", schedule: "*/15 * * * *" });

  const next = await deployTemplateFromSchema("next", { schemaPath });
  expect(next).toContain("// Schema collections: articles, pages");
  expect(next).toContain("\"requiresMediaStorage\": true");
  expect(next).toContain("\"requiresScheduledJobs\": true");
});

test("omits media and scheduled resources when schema does not require them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const schemaImport = resolve(__dirname, "../../../schema/src/index.ts");
  const schemaPath = join(dir, "cms.schema.ts");
  await writeFile(schemaPath, `
    import { defineCollection, defineSchema, fields } from ${JSON.stringify(schemaImport)};
    export default defineSchema({
      pages: defineCollection('pages', { title: fields.string({ required: true }) })
    });
  `);

  const cloudflare = await deployTemplateFromSchema("cloudflare", { schemaPath });
  expect(cloudflare).not.toContain("[[r2_buckets]]");
  expect(cloudflare).toContain("crons = [\"0 3 * * *\"]");

  const node = await deployTemplateFromSchema("node", { schemaPath });
  expect(node).toContain("\"requiresMediaStorage\": false");
  expect(node).not.toContain("MEDIA_ROOT");
  expect(planDeployInfrastructure({
    pages: {
      name: "pages",
      fields: { title: { kind: "string", required: true } },
      options: {}
    }
  })).toMatchObject({ requiresMediaStorage: false, requiresScheduledJobs: false });
});

test("writes deploy templates to disk with overwrite protection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const outFile = join(dir, "wrangler.toml");
  const content = deployTemplate("cloudflare");

  await expect(writeTemplateOutput(content)).resolves.toMatchObject({ outFile: null, written: false, content });
  await expect(writeTemplateOutput(content, { outFile })).resolves.toMatchObject({ outFile, written: true });
  await expect(readFile(outFile, "utf8")).resolves.toContain("compatibility_date");
  await expect(writeTemplateOutput("replacement", { outFile })).rejects.toThrow("Refusing to overwrite");
  await expect(writeTemplateOutput("replacement", { outFile, yes: true })).resolves.toMatchObject({ outFile, written: true });
  await expect(readFile(outFile, "utf8")).resolves.toBe("replacement");
});

test("discovers and runs seed files in order with dry-run support", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hono-cms-"));
  const seedsDir = join(dir, "seeds");
  await mkdir(seedsDir);
  const cmsPath = join(dir, "cms.ts");
  const outputPath = join(dir, "seed-output.json");

  await writeFile(cmsPath, `
    export default {
      db: { provider: 'test' },
      fetch: () => new Response('ok'),
      scheduled: async () => {}
    };
  `);

  await writeFile(join(seedsDir, "002-second.ts"), `
    export async function seed({ file }) {
      const { readFile, writeFile } = await import('node:fs/promises');
      const path = ${JSON.stringify(outputPath)};
      const current = JSON.parse(await readFile(path, 'utf8').catch(() => '[]'));
      current.push(file.split('/').at(-1));
      await writeFile(path, JSON.stringify(current));
    }
  `);
  await writeFile(join(seedsDir, "001-first.ts"), `
    export default async function ({ file }) {
      const { readFile, writeFile } = await import('node:fs/promises');
      const path = ${JSON.stringify(outputPath)};
      const current = JSON.parse(await readFile(path, 'utf8').catch(() => '[]'));
      current.push(file.split('/').at(-1));
      await writeFile(path, JSON.stringify(current));
    }
  `);
  await writeFile(join(seedsDir, "003-skip.ts"), `export const value = 1;`);
  await writeFile(join(seedsDir, "README.md"), `ignored`);

  const dryRun = await runSeeds({ cmsPath, seedsDir, dryRun: true });
  expect(dryRun).toMatchObject({ dryRun: true, results: [{ skipped: false }, { skipped: false }, { skipped: true }] });
  await expect(readFile(outputPath, "utf8")).rejects.toThrow();

  const summary = await runSeeds({ cmsPath, seedsDir });
  expect(summary).toMatchObject({ dryRun: false, results: [{ skipped: false }, { skipped: false }, { skipped: true }] });
  await expect(readFile(outputPath, "utf8").then(JSON.parse)).resolves.toEqual(["001-first.ts", "002-second.ts"]);
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("Timed out waiting for condition.");
}

async function linkWorkspacePackages(cwd: string, packages: string[]): Promise<void> {
  const scope = join(cwd, "node_modules/@hono-cms");
  await mkdir(scope, { recursive: true });
  for (const name of packages) {
    await symlink(resolve(__dirname, `../../../${name}`), join(scope, name), "dir");
  }
}
