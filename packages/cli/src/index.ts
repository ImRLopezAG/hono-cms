#!/usr/bin/env node
import { createReadStream, watch, type FSWatcher } from "node:fs";
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { CMSInstance, SchemaWriter } from "@hono-cms/core";
import { createAuthSchemaSnapshot, createOpenAPISpec, isAuthConfig } from "@hono-cms/core";
import { createNodeHandler } from "@hono-cms/platform/node";
import {
  createSchemaSnapshot,
  defineSchema,
  formatSchemaPlan,
  generateDrizzleSchema,
  generateTypeScriptSDK,
  planSchemaMigration,
  type CMSCollections,
  type DrizzleDialect,
  type FieldDefinition,
  type SchemaPlan,
  type SchemaSnapshot,
  type SystemTableSnapshot
} from "@hono-cms/schema";
import { loadSchema as loadCollectionDirectory } from "@hono-cms/schema/schema-compiler";

const execFileAsync = promisify(execFile);

export type GenerateOptions = {
  schemaPath: string;
  outFile: string;
  check?: boolean;
};

export type GenerateResult = {
  source: string;
  outFile: string;
  changed: boolean;
  checked: boolean;
};

export type GenerateOpenAPIOptions = {
  schemaPath: string;
  outFile: string;
  check?: boolean;
  title?: string;
  version?: string;
};

export type GenerateDrizzleOptions = GenerateOptions & {
  dialect?: DrizzleDialect;
};

export type GenerateDrizzleConfigOptions = {
  outFile: string;
  schemaOutFile: string;
  migrationsDir?: string;
  dialect?: DrizzleDialect;
  check?: boolean;
};

export type DrizzleKitAction = "generate" | "migrate";

export type DrizzleKitRunOptions = {
  schemaPath: string;
  action: DrizzleKitAction;
  drizzleOutFile?: string;
  drizzleConfigOutFile?: string;
  migrationsDir?: string;
  dialect?: DrizzleDialect;
  command?: string;
  commandArgs?: string[];
  runner?: DrizzleKitRunner;
};

export type DrizzleKitRunner = (command: string, args: string[], options: { cwd: string }) => Promise<{ stdout?: string; stderr?: string }>;

export type DrizzleKitRunResult = {
  action: DrizzleKitAction;
  command: string;
  args: string[];
  cwd: string;
  schema: GenerateResult;
  config: GenerateResult;
  stdout: string;
  stderr: string;
};

export type ContentTypeWriterOptions = {
  collectionsDir: string;
  schemaPath?: string;
  schemaIndexFile?: string;
  importPath?: string;
  sdkOutFile?: string;
  openapiOutFile?: string;
  openapiTitle?: string;
  openapiVersion?: string;
  stateFile?: string;
  migrationsDir?: string;
  drizzleOutFile?: string;
  drizzleConfigOutFile?: string;
  drizzleDialect?: DrizzleDialect;
  drizzleKit?: boolean;
  drizzleKitCommand?: string;
  drizzleKitRunner?: DrizzleKitRunner;
};

export type BuildProjectOptions = GenerateOptions & SchemaCommandOptions & {
  openapiOutFile?: string;
  openapiTitle?: string;
  openapiVersion?: string;
  drizzleOutFile?: string;
  drizzleConfigOutFile?: string;
  drizzleDialect?: DrizzleDialect;
  migrationsDir?: string;
};

export type DoctorOptions = SchemaCommandOptions & {
  sdkOutFile?: string;
  openapiOutFile?: string;
  openapiTitle?: string;
  openapiVersion?: string;
  drizzleOutFile?: string;
  drizzleConfigOutFile?: string;
  drizzleDialect?: DrizzleDialect;
  migrationsDir?: string;
};

export type DoctorCheck = {
  name: string;
  status: "ok" | "fail";
  message: string;
};

export type DoctorResult = {
  ok: boolean;
  checks: DoctorCheck[];
};

export type SchemaCommandOptions = {
  schemaPath: string;
  stateFile: string;
};

export type LoadedSchemaState = {
  collections: CMSCollections;
  systemTables?: Record<string, SystemTableSnapshot>;
};

export type SchemaApplyOptions = SchemaCommandOptions & {
  allowDestructive?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  lockFile?: string;
  migrationsDir?: string;
};

export type SeedOptions = {
  cmsPath: string;
  seedsDir: string;
  dryRun?: boolean;
};

export type SeedContext = {
  cms: CMSInstance;
  file: string;
  dryRun: boolean;
};

export type SeedResult = {
  file: string;
  skipped: boolean;
};

export type SeedSummary = {
  seedsDir: string;
  dryRun: boolean;
  results: SeedResult[];
};

export type InitPreset = "cloudflare" | "vercel" | "node" | "next";
export type DatabaseProvider = "d1" | "postgres" | "turso" | "convex" | "memory";
export type StorageProvider = "r2" | "local" | "s3" | "vercel-blob" | "none";
export type EmailProvider = "console" | "resend" | "postmark" | "smtp" | "none";

export type InitOptions = {
  cwd?: string;
  projectName?: string;
  preset: InitPreset;
  database?: DatabaseProvider;
  storage?: StorageProvider;
  authPlugins?: string[];
  email?: EmailProvider;
  install?: boolean;
};

export type InitResult = {
  cwd: string;
  projectName: string;
  packageManager: "bun" | "pnpm" | "yarn" | "npm";
  installCommand: string[];
  files: string[];
  dependencies: string[];
  devDependencies: string[];
};

export type InitPromptAdapter = {
  intro?(message: string): void;
  outro?(message: string): void;
  cancel?(message: string): void;
  isCancel(value: unknown): boolean;
  text(options: { message: string; placeholder?: string; initialValue?: string; validate?(value: string | undefined): string | void }): Promise<unknown>;
  select<Value extends string>(options: { message: string; options: Array<{ value: Value; label: string; hint?: string; disabled?: boolean }> }): Promise<unknown>;
  multiselect<Value extends string>(options: { message: string; options: Array<{ value: Value; label: string; hint?: string; disabled?: boolean }>; required?: boolean }): Promise<unknown>;
  confirm(options: { message: string; initialValue?: boolean }): Promise<unknown>;
};

export type InitWizardOptions = {
  cwd?: string;
  prompts?: InitPromptAdapter;
};

export type TemplateWriteResult = {
  outFile: string | null;
  content: string;
  written: boolean;
};

export type DeployTarget = "cloudflare" | "vercel" | "node" | "next";

export type DeployTemplateOptions = {
  entry?: string;
  collections?: CMSCollections;
  projectName?: string;
};

export type DeployTemplateFromSchemaOptions = Omit<DeployTemplateOptions, "collections"> & {
  schemaPath: string;
};

export type DeployInfrastructurePlan = {
  projectName: string;
  collections: string[];
  mediaFields: Array<{ collection: string; field: string; multiple: boolean }>;
  draftCollections: string[];
  localizedCollections: string[];
  requiresMediaStorage: boolean;
  requiresScheduledJobs: boolean;
};

export type DevServerOptions = {
  cmsPath: string;
  schemaPath?: string;
  sdkOutFile?: string;
  drizzleOutFile?: string;
  drizzleConfigOutFile?: string;
  drizzleDialect?: DrizzleDialect;
  stateFile?: string;
  migrationsDir?: string;
  adminDist?: string;
  adminProxyUrl?: string;
  watchPaths?: string[];
  watch?: boolean;
  host?: string;
  port?: number;
  open?: boolean;
  autoMigrate?: boolean;
  drizzleKit?: boolean;
  drizzleKitCommand?: string;
  drizzleKitRunner?: DrizzleKitRunner;
};

export type DevServerHandle = {
  server: Server;
  url: string;
  adminUrl: string;
  banner: string;
  port: number;
  reloadCMS(): Promise<CMSInstance>;
  rerunMigrations(): Promise<SchemaPlan | null>;
  close(): Promise<void>;
};

export async function generateSDK(options: GenerateOptions): Promise<string> {
  return (await generateSDKArtifact(options)).source;
}

export async function generateSDKArtifact(options: GenerateOptions): Promise<GenerateResult> {
  const collections = await loadSchema(options.schemaPath);
  const source = generateTypeScriptSDK(collections);
  const destination = resolve(options.outFile);
  await mkdir(dirname(destination), { recursive: true });

  let current: string | null = null;
  try {
    current = await readFile(destination, "utf8");
  } catch {
    current = null;
  }

  const changed = current !== source;
  if (options.check && changed) {
    throw new Error(`SDK types are out of date - run "cms schema generate --schema ${options.schemaPath} --out ${options.outFile}".`);
  }

  if (!options.check && changed) {
    await writeFile(destination, source);
  }

  return { source, outFile: destination, changed, checked: options.check ?? false };
}

export async function loadSchema(schemaPath: string): Promise<CMSCollections> {
  return (await loadSchemaState(schemaPath)).collections;
}

export async function loadSchemaState(schemaPath: string): Promise<LoadedSchemaState> {
  const resolved = resolve(schemaPath);
  const info = await stat(resolved);
  if (info.isDirectory()) return { collections: await loadCollectionDirectory(resolved) };

  const module = await importFresh(schemaPath);
  const config = schemaModuleConfig(module);
  const collections = config?.collections ?? module.collections ?? module.schema ?? module.default;
  if (!collections || typeof collections !== "object") {
    throw new Error(`Schema file "${schemaPath}" must export default collections, collections, schema, or cmsConfig.collections.`);
  }
  const schema = defineSchema(collections as CMSCollections);
  const systemTables = authSystemTablesFromModule(module, config);
  assertNoReservedSystemTableConflicts(schema, systemTables);
  return {
    collections: schema,
    ...(systemTables && Object.keys(systemTables).length > 0 ? { systemTables } : {})
  };
}

export async function loadCMS(cmsPath: string): Promise<CMSInstance> {
  const module = await importFresh(cmsPath);
  const cms = module.default ?? module.cms;
  const candidate = cms as { fetch?: unknown; db?: unknown } | null;
  if (!candidate || typeof candidate !== "object" || typeof candidate.fetch !== "function" || !("db" in candidate)) {
    throw new Error(`CMS file "${cmsPath}" must export default cms or cms from createCMS(...).`);
  }
  return candidate as CMSInstance;
}

function schemaModuleConfig(module: Record<string, unknown>): Record<string, unknown> | null {
  const candidate = module.cmsConfig ?? module.config;
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as Record<string, unknown>;
}

function authSystemTablesFromModule(module: Record<string, unknown>, config: Record<string, unknown> | null): Record<string, SystemTableSnapshot> | undefined {
  const auth = config?.auth ?? module.auth;
  if (!isAuthConfig(auth)) return undefined;
  return createAuthSchemaSnapshot(auth);
}

function assertNoReservedSystemTableConflicts(collections: CMSCollections, systemTables: Record<string, SystemTableSnapshot> | undefined): void {
  if (!systemTables) return;
  const reserved = new Map<string, string>();
  for (const table of Object.values(systemTables)) {
    reserved.set(table.name, table.name);
    reserved.set(`${table.name}s`, table.name);
  }
  for (const collection of Object.values(collections)) {
    const authTable = reserved.get(collection.name);
    if (authTable) {
      throw new Error(`Schema conflict: content type '${collection.name}' conflicts with better-auth's reserved table name '${authTable}'. Rename the content type.`);
    }
  }
}

export async function generateOpenAPIArtifact(options: GenerateOpenAPIOptions): Promise<GenerateResult> {
  const collections = await loadSchema(options.schemaPath);
  const spec = createOpenAPISpec(collections, {
    ...(options.title ? { title: options.title } : {}),
    ...(options.version ? { version: options.version } : {})
  });
  const source = `${JSON.stringify(spec, null, 2)}\n`;
  const destination = resolve(options.outFile);
  await mkdir(dirname(destination), { recursive: true });

  let current: string | null = null;
  try {
    current = await readFile(destination, "utf8");
  } catch {
    current = null;
  }

  const changed = current !== source;
  if (options.check && changed) {
    throw new Error(`OpenAPI spec is out of date - run "cms schema openapi --schema ${options.schemaPath} --out ${options.outFile}".`);
  }

  if (!options.check && changed) {
    await writeFile(destination, source);
  }

  return { source, outFile: destination, changed, checked: options.check ?? false };
}

export async function generateDrizzleArtifact(options: GenerateDrizzleOptions): Promise<GenerateResult> {
  const collections = await loadSchema(options.schemaPath);
  const source = generateDrizzleSchema(collections, {
    ...(options.dialect ? { dialect: options.dialect } : {})
  });
  const destination = resolve(options.outFile);
  await mkdir(dirname(destination), { recursive: true });

  let current: string | null = null;
  try {
    current = await readFile(destination, "utf8");
  } catch {
    current = null;
  }

  const changed = current !== source;
  if (options.check && changed) {
    throw new Error(`Drizzle schema is out of date - run "cms schema drizzle --schema ${options.schemaPath} --out ${options.outFile}".`);
  }

  if (!options.check && changed) {
    await writeFile(destination, source);
  }

  return { source, outFile: destination, changed, checked: options.check ?? false };
}

export async function runSeeds(options: SeedOptions): Promise<SeedSummary> {
  const seedsDir = resolve(options.seedsDir);
  const cms = await loadCMS(options.cmsPath);
  const files = await discoverSeedFiles(seedsDir);
  const results: SeedResult[] = [];
  for (const file of files) {
    const seed = await loadSeed(file);
    if (!seed) {
      results.push({ file, skipped: true });
      continue;
    }
    if (!options.dryRun) await seed({ cms, file, dryRun: false });
    results.push({ file, skipped: false });
  }
  return { seedsDir, dryRun: options.dryRun ?? false, results };
}

export async function schemaPlan(options: SchemaCommandOptions): Promise<SchemaPlan> {
  const schema = await loadSchemaState(options.schemaPath);
  return planSchemaMigration(await readSnapshot(options.stateFile), schema.collections, schemaPlanOptions(schema));
}

export async function schemaApply(options: SchemaApplyOptions): Promise<SchemaPlan> {
  const schema = await loadSchemaState(options.schemaPath);
  const plan = planSchemaMigration(await readSnapshot(options.stateFile), schema.collections, schemaPlanOptions(schema));
  if (plan.empty) return plan;
  if (plan.destructive && !options.allowDestructive) {
    throw new Error("Schema plan contains destructive changes. Re-run with --allow-destructive after reviewing the plan.");
  }
  if (!options.dryRun && !options.yes) {
    throw new Error("Schema apply requires confirmation. Re-run with --yes after reviewing the plan.");
  }
  if (options.dryRun) return plan;

  return withSchemaApplyLock(options.lockFile ?? defaultLockFile(options.stateFile), async () => {
    const migrationFile = await writeMigrationFile(plan, options.migrationsDir ?? defaultMigrationsDir(options.stateFile));
    await mkdir(dirname(resolve(options.stateFile)), { recursive: true });
    await writeFile(resolve(options.stateFile), `${JSON.stringify(plan.snapshot, null, 2)}\n`);
    if (!migrationFile) throw new Error("Failed to write schema migration file.");
    return plan;
  });
}

export async function schemaCheck(options: SchemaCommandOptions): Promise<SchemaPlan> {
  return schemaPlan(options);
}

function schemaPlanOptions(schema: LoadedSchemaState): { systemTables?: Record<string, SystemTableSnapshot> } {
  return schema.systemTables ? { systemTables: schema.systemTables } : {};
}

export function schemaCheckJSON(plan: SchemaPlan): { clean: boolean; plan: SchemaPlan } {
  return { clean: plan.empty, plan };
}

export function renderSchemaMigrationSQL(plan: SchemaPlan): string {
  if (plan.empty) return "-- Schema is up to date.\n";
  return `${plan.changes.map((change) => {
    switch (change.type) {
      case "create_collection":
        return `CREATE TABLE ${quoteIdent(change.collection)} (\n  id TEXT PRIMARY KEY,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);`;
      case "drop_collection":
        return `DROP TABLE ${quoteIdent(change.collection)};`;
      case "alter_collection":
        return [
          `-- Collection option change for ${change.collection}`,
          "-- Review generated runtime artifacts after applying this snapshot.",
          `-- before: ${JSON.stringify(change.before)}`,
          `-- after: ${JSON.stringify(change.after)}`
        ].join("\n");
      case "add_field":
        return `ALTER TABLE ${quoteIdent(change.collection)} ADD COLUMN ${quoteIdent(change.field)} ${sqlType(change.definition)}${change.definition.required ? " NOT NULL" : ""};`;
      case "drop_field":
        return `ALTER TABLE ${quoteIdent(change.collection)} DROP COLUMN ${quoteIdent(change.field)};`;
      case "alter_field":
        return [
          `-- Manual review required for ${change.collection}.${change.field}`,
          `-- before: ${JSON.stringify(change.before)}`,
          `-- after: ${JSON.stringify(change.after)}`
        ].join("\n");
      case "create_system_table":
        return renderCreateSystemTableSQL(change.table, plan.snapshot.systemTables?.[change.table]);
      case "drop_system_table":
        return `-- System table ${change.table} was removed from the CMS provider schema.\n-- Review dependent auth data before dropping the table.`;
      case "alter_system_table":
        return `-- System table ${change.table} changed.\n-- Regenerate Drizzle artifacts and review the auth/provider migration.`;
    }
  }).join("\n\n")}\n`;
}

export async function generateDrizzleConfigArtifact(options: GenerateDrizzleConfigOptions): Promise<GenerateResult> {
  const dialect = options.dialect ?? "sqlite";
  const source = drizzleConfigSource({
    dialect,
    schemaOutFile: options.schemaOutFile,
    migrationsDir: options.migrationsDir ?? defaultMigrationsDirFromSchema(options.schemaOutFile)
  });
  const destination = resolve(options.outFile);
  await mkdir(dirname(destination), { recursive: true });

  let current: string | null = null;
  try {
    current = await readFile(destination, "utf8");
  } catch {
    current = null;
  }

  const changed = current !== source;
  if (options.check && changed) {
    throw new Error(`Drizzle config is out of date - run "cms schema drizzle-config --out ${options.outFile}".`);
  }

  if (!options.check && changed) {
    await writeFile(destination, source);
  }

  return { source, outFile: destination, changed, checked: options.check ?? false };
}

export async function runDrizzleKit(options: DrizzleKitRunOptions): Promise<DrizzleKitRunResult> {
  const drizzleOutFile = options.drizzleOutFile ?? defaultDrizzleOutFile(options.schemaPath);
  const drizzleConfigOutFile = options.drizzleConfigOutFile ?? defaultDrizzleConfigOutFile(options.schemaPath);
  const schema = await generateDrizzleArtifact({
    schemaPath: options.schemaPath,
    outFile: drizzleOutFile,
    ...(options.dialect ? { dialect: options.dialect } : {})
  });
  const config = await generateDrizzleConfigArtifact({
    outFile: drizzleConfigOutFile,
    schemaOutFile: drizzleOutFile,
    ...(options.migrationsDir ? { migrationsDir: options.migrationsDir } : {}),
    ...(options.dialect ? { dialect: options.dialect } : {})
  });
  const command = options.command ?? "bunx";
  const args = [...(options.commandArgs ?? ["drizzle-kit"]), options.action, "--config", config.outFile];
  const cwd = projectRootFromSchemaPath(options.schemaPath);
  const result = await (options.runner ?? defaultDrizzleKitRunner)(command, args, { cwd });

  return {
    action: options.action,
    command,
    args,
    cwd,
    schema,
    config,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

export function createContentTypeWriter(options: ContentTypeWriterOptions): SchemaWriter {
  const collectionsDir = resolve(options.collectionsDir);
  const schemaPath = options.schemaPath ?? collectionsDir;

  return {
    ...(options.importPath ? { importPath: options.importPath } : {}),
    async writeCollection(input) {
      const outFile = join(collectionsDir, `${collectionFileBaseName(input.collection.name)}.ts`);
      await mkdir(dirname(outFile), { recursive: true });
      await writeFile(outFile, input.source);
      await writeSchemaIndex(options.schemaIndexFile ?? defaultSchemaIndexFile(collectionsDir), collectionsDir);
      return { path: outFile };
    },
    async afterWrite() {
      const artifacts: string[] = [];
      const migrations = options.migrationsDir ? await listFilesIfPresent(options.migrationsDir) : [];

      const sdk = await generateSDKArtifact({
        schemaPath,
        outFile: options.sdkOutFile ?? defaultSDKOutFile(schemaPath)
      });
      artifacts.push(sdk.outFile);

      if (options.openapiOutFile) {
        const openapi = await generateOpenAPIArtifact({
          schemaPath,
          outFile: options.openapiOutFile,
          ...(options.openapiTitle ? { title: options.openapiTitle } : {}),
          ...(options.openapiVersion ? { version: options.openapiVersion } : {})
        });
        artifacts.push(openapi.outFile);
      }

      if (options.stateFile) {
        await schemaApply({
          schemaPath,
          stateFile: options.stateFile,
          yes: true,
          allowDestructive: false,
          ...(options.migrationsDir ? { migrationsDir: options.migrationsDir } : {})
        });
      }

      const drizzleOutFile = options.drizzleOutFile ?? defaultDrizzleOutFile(schemaPath);
      const drizzleConfigOutFile = options.drizzleConfigOutFile ?? defaultDrizzleConfigOutFile(schemaPath);
      const drizzle = await generateDrizzleArtifact({
        schemaPath,
        outFile: drizzleOutFile,
        ...(options.drizzleDialect ? { dialect: options.drizzleDialect } : {})
      });
      artifacts.push(drizzle.outFile);

      const drizzleConfig = await generateDrizzleConfigArtifact({
        outFile: drizzleConfigOutFile,
        schemaOutFile: drizzleOutFile,
        migrationsDir: options.migrationsDir ?? (options.stateFile ? defaultMigrationsDir(options.stateFile) : defaultMigrationsDirFromSchema(drizzleOutFile)),
        ...(options.drizzleDialect ? { dialect: options.drizzleDialect } : {})
      });
      artifacts.push(drizzleConfig.outFile);

      if (options.drizzleKit) {
        const base = {
          schemaPath,
          drizzleOutFile,
          drizzleConfigOutFile,
          migrationsDir: options.migrationsDir ?? (options.stateFile ? defaultMigrationsDir(options.stateFile) : defaultMigrationsDirFromSchema(drizzleOutFile)),
          ...(options.drizzleDialect ? { dialect: options.drizzleDialect } : {}),
          ...(options.drizzleKitCommand ? { command: options.drizzleKitCommand } : {}),
          ...(options.drizzleKitRunner ? { runner: options.drizzleKitRunner } : {})
        } satisfies Omit<DrizzleKitRunOptions, "action">;
        await runDrizzleKit({ ...base, action: "generate" });
        await runDrizzleKit({ ...base, action: "migrate" });
      }

      const afterMigrations = options.migrationsDir ? await listFilesIfPresent(options.migrationsDir) : [];
      return {
        artifacts: uniqueStrings(artifacts),
        migrations: afterMigrations.filter((file) => !migrations.includes(file)),
        message: "Schema artifacts refreshed"
      };
    }
  };
}

export async function buildProject(options: BuildProjectOptions): Promise<{ plan: SchemaPlan; sdk: string; openapi: string; drizzle: string; drizzleConfig: string }> {
  const plan = await schemaCheck(options);
  if (!plan.empty) {
    throw new Error("Schema artifacts are stale. Run cms schema apply before build.");
  }
  const sdk = await generateSDKArtifact(options);
  const openapi = await generateOpenAPIArtifact({
    schemaPath: options.schemaPath,
    outFile: options.openapiOutFile ?? "cms/openapi.json",
    ...(options.check !== undefined ? { check: options.check } : {}),
    ...(options.openapiTitle ? { title: options.openapiTitle } : {}),
    ...(options.openapiVersion ? { version: options.openapiVersion } : {})
  });
  const drizzle = await generateDrizzleArtifact({
    schemaPath: options.schemaPath,
    outFile: options.drizzleOutFile ?? defaultDrizzleOutFile(options.schemaPath),
    ...(options.drizzleDialect ? { dialect: options.drizzleDialect } : {}),
    ...(options.check !== undefined ? { check: options.check } : {})
  });
  const drizzleConfig = await generateDrizzleConfigArtifact({
    outFile: options.drizzleConfigOutFile ?? defaultDrizzleConfigOutFile(options.schemaPath),
    schemaOutFile: options.drizzleOutFile ?? defaultDrizzleOutFile(options.schemaPath),
    migrationsDir: options.migrationsDir ?? defaultMigrationsDir(options.stateFile),
    ...(options.drizzleDialect ? { dialect: options.drizzleDialect } : {}),
    ...(options.check !== undefined ? { check: options.check } : {})
  });
  return { plan, sdk: sdk.source, openapi: openapi.source, drizzle: drizzle.source, drizzleConfig: drizzleConfig.source };
}

export async function doctorProject(options: DoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const push = (name: string, status: DoctorCheck["status"], message: string) => checks.push({ name, status, message });

  try {
    const state = await loadSchemaState(options.schemaPath);
    const count = Object.keys(state.collections).length;
    push("schema", "ok", `Loaded ${count} collection${count === 1 ? "" : "s"}.`);
  } catch (error) {
    push("schema", "fail", error instanceof Error ? error.message : "Failed to load schema.");
    return { ok: false, checks };
  }

  try {
    const plan = await schemaCheck(options);
    push("schema-drift", plan.empty ? "ok" : "fail", plan.empty ? "Schema snapshot is clean." : `Schema snapshot has ${plan.changes.length} pending change${plan.changes.length === 1 ? "" : "s"}.`);
  } catch (error) {
    push("schema-drift", "fail", error instanceof Error ? error.message : "Failed to check schema drift.");
  }

  await checkDoctorArtifact(checks, "sdk", () => generateSDKArtifact({
    schemaPath: options.schemaPath,
    outFile: options.sdkOutFile ?? defaultSDKOutFile(options.schemaPath),
    check: true
  }));
  await checkDoctorArtifact(checks, "openapi", () => generateOpenAPIArtifact({
    schemaPath: options.schemaPath,
    outFile: options.openapiOutFile ?? "cms/openapi.json",
    check: true,
    ...(options.openapiTitle ? { title: options.openapiTitle } : {}),
    ...(options.openapiVersion ? { version: options.openapiVersion } : {})
  }));
  await checkDoctorArtifact(checks, "drizzle-schema", () => generateDrizzleArtifact({
    schemaPath: options.schemaPath,
    outFile: options.drizzleOutFile ?? defaultDrizzleOutFile(options.schemaPath),
    check: true,
    ...(options.drizzleDialect ? { dialect: options.drizzleDialect } : {})
  }));
  await checkDoctorArtifact(checks, "drizzle-config", () => generateDrizzleConfigArtifact({
    outFile: options.drizzleConfigOutFile ?? defaultDrizzleConfigOutFile(options.schemaPath),
    schemaOutFile: options.drizzleOutFile ?? defaultDrizzleOutFile(options.schemaPath),
    migrationsDir: options.migrationsDir ?? defaultMigrationsDir(options.stateFile),
    check: true,
    ...(options.drizzleDialect ? { dialect: options.drizzleDialect } : {})
  }));

  return { ok: checks.every((check) => check.status === "ok"), checks };
}

async function checkDoctorArtifact(checks: DoctorCheck[], name: string, action: () => Promise<GenerateResult>): Promise<void> {
  try {
    const result = await action();
    checks.push({ name, status: "ok", message: `Fresh: ${result.outFile}` });
  } catch (error) {
    checks.push({ name, status: "fail", message: error instanceof Error ? error.message : `${name} artifact is stale.` });
  }
}

export async function initProject(options: InitOptions): Promise<InitResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const projectName = options.projectName ?? basename(cwd);
  const database = options.database ?? defaultDatabase(options.preset);
  const storage = options.storage ?? defaultStorage(options.preset, database);
  const authPlugins = options.authPlugins ?? [];
  const email = options.email ?? "console";
  validateInitSelection({ database, storage });

  const packageManager = await detectPackageManager(cwd);
  const dependencies = initDependencies(options.preset, database, storage, authPlugins, email);
  const devDependencies = initDevDependencies();
  const files = [
    join(cwd, "cms.config.ts"),
    join(cwd, "cms.dev.ts"),
    join(cwd, "cms/collections/articles.ts"),
    join(cwd, "cms/schema.ts"),
    join(cwd, ".env.example"),
    join(cwd, "package.json"),
    ...(options.preset === "next" ? [join(cwd, "app/api/cms/[...route]/route.ts")] : [])
  ];

  await mkdir(cwd, { recursive: true });
  await writeFile(files[0] ?? "", cmsConfigTemplate({ database, storage, authPlugins, email }));
  await writeFile(files[1] ?? "", cmsDevConfigTemplate());
  await mkdir(join(cwd, "cms/collections"), { recursive: true });
  await writeFile(files[2] ?? "", initialArticleCollectionTemplate());
  await writeSchemaIndex(files[3] ?? join(cwd, "cms/schema.ts"), join(cwd, "cms/collections"));
  await writeFile(files[4] ?? "", envTemplate({ database, storage, email }));
  await updatePackageJson(join(cwd, "package.json"), projectName, dependencies, devDependencies);
  if (options.preset === "next") {
    const routeFile = join(cwd, "app/api/cms/[...route]/route.ts");
    await mkdir(dirname(routeFile), { recursive: true });
    await writeFile(routeFile, nextRouteTemplate("app/api/cms/[...route]/route.ts"));
  }

  return {
    cwd,
    projectName,
    packageManager,
    installCommand: installCommand(packageManager),
    files,
    dependencies,
    devDependencies
  };
}

export async function initProjectWizard(options: InitWizardOptions = {}): Promise<InitResult> {
  const prompts = options.prompts ?? await loadClackPrompts();
  prompts.intro?.("create-hono-cms");

  const cwd = resolve(options.cwd ?? process.cwd());
  const defaultName = basename(cwd);
  const projectName = await promptValue<string>(prompts, prompts.text({
    message: "Project name",
    initialValue: defaultName,
    placeholder: defaultName,
    validate(value) {
      if (!value?.trim()) return "Project name is required.";
    }
  }));
  const preset = await promptValue<InitPreset>(prompts, prompts.select({
    message: "Hosting target",
    options: [
      { value: "cloudflare", label: "Cloudflare", hint: "Workers, D1, R2" },
      { value: "vercel", label: "Vercel", hint: "Edge functions and Vercel storage" },
      { value: "next", label: "Next.js", hint: "App Router route handler" },
      { value: "node", label: "Node", hint: "Any Node runtime" }
    ]
  }));
  const database = await promptValue<DatabaseProvider>(prompts, prompts.select({
    message: "Database",
    options: databaseOptions(preset)
  }));
  const storage = await promptValue<StorageProvider>(prompts, prompts.select({
    message: "Storage",
    options: storageOptions(preset, database)
  }));
  const authPlugins = await promptValue<string[]>(prompts, prompts.multiselect({
    message: "Auth plugins",
    required: false,
    options: [
      { value: "users", label: "Users", hint: "basic editorial accounts" },
      { value: "organization", label: "Organizations", hint: "teams and roles" },
      { value: "api-keys", label: "API keys", hint: "server-to-server access" }
    ]
  }));
  const email = await promptValue<EmailProvider>(prompts, prompts.select({
    message: "Email provider",
    options: [
      { value: "console", label: "Console", hint: "local development" },
      { value: "resend", label: "Resend" },
      { value: "postmark", label: "Postmark" },
      { value: "smtp", label: "SMTP" },
      { value: "none", label: "None" }
    ]
  }));
  const install = await promptValue<boolean>(prompts, prompts.confirm({
    message: "Install dependencies after scaffolding?",
    initialValue: true
  }));

  const result = await initProject({
    cwd,
    projectName: projectName.trim(),
    preset,
    database,
    storage,
    authPlugins,
    email,
    install
  });
  prompts.outro?.(`Created Hono CMS project in ${result.cwd}`);
  return result;
}

export async function startDevServer(options: DevServerOptions): Promise<DevServerHandle> {
  const host = options.host ?? "localhost";
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const schemaPath = options.schemaPath ?? options.cmsPath;
  const sdkOutFile = options.sdkOutFile ?? defaultSDKOutFile(schemaPath);
  const drizzleOutFile = options.drizzleOutFile ?? defaultDrizzleOutFile(schemaPath);
  const drizzleConfigOutFile = options.drizzleConfigOutFile ?? defaultDrizzleConfigOutFile(schemaPath);
  const drizzleDialect = options.drizzleDialect ?? "sqlite";
  const stateFile = options.stateFile ?? ".hono-cms/schema-state.json";
  const generateDevSDK = () => generateSDKArtifact({ schemaPath, outFile: sdkOutFile });
  const generateDevDrizzle = () => generateDrizzleArtifact({ schemaPath, outFile: drizzleOutFile, dialect: drizzleDialect });
  const generateDevDrizzleConfig = () => generateDrizzleConfigArtifact({
    outFile: drizzleConfigOutFile,
    schemaOutFile: drizzleOutFile,
    migrationsDir: options.migrationsDir ?? defaultMigrationsDir(stateFile),
    dialect: drizzleDialect
  });
  const runDevDrizzleKit = async () => {
    if (!options.drizzleKit) return [];
    const base = {
      schemaPath,
      drizzleOutFile,
      drizzleConfigOutFile,
      migrationsDir: options.migrationsDir ?? defaultMigrationsDir(stateFile),
      dialect: drizzleDialect,
      ...(options.drizzleKitCommand ? { command: options.drizzleKitCommand } : {}),
      ...(options.drizzleKitRunner ? { runner: options.drizzleKitRunner } : {})
    } satisfies Omit<DrizzleKitRunOptions, "action">;
    return [
      await runDrizzleKit({ ...base, action: "generate" }),
      await runDrizzleKit({ ...base, action: "migrate" })
    ];
  };
  const runMigration = () => runDevSchemaMigration({
    schemaPath,
    stateFile,
    ...(options.migrationsDir ? { migrationsDir: options.migrationsDir } : {})
  });
  const refreshDevSchemaArtifacts = async (): Promise<SchemaPlan> => {
    const plan = await runMigration();
    await generateDevSDK();
    await generateDevDrizzle();
    await generateDevDrizzleConfig();
    await runDevDrizzleKit();
    return plan;
  };
  let migrationMessage = "Schema auto-migration skipped.";

  if (options.autoMigrate ?? true) {
    const plan = await refreshDevSchemaArtifacts();
    migrationMessage = devMigrationMessage(plan);
  }

  let cms = await loadCMS(options.cmsPath);
  let cmsHandler = createNodeHandler(cms);
  const reloadCMS = async () => {
    cms = await loadCMS(options.cmsPath);
    cmsHandler = createNodeHandler(cms);
    return cms;
  };
  const server = createServer((request, response) => {
    void routeDevRequest(cmsHandler, request, response, {
      adminDist: options.adminDist ?? "apps/admin/dist",
      adminProxyUrl: options.adminProxyUrl ?? "http://localhost:5173"
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;
  const adminUrl = `${url}/admin`;
  const banner = devBanner({ url, adminUrl, migrationMessage });
  const watchPaths = options.watchPaths ?? Array.from(new Set([schemaPath, options.cmsPath]));
  const watchers = options.watch === false ? [] : watchSchemaPaths(watchPaths, async () => {
    if (options.autoMigrate ?? true) {
      await refreshDevSchemaArtifacts();
    }
    await reloadCMS();
  });
  if (options.open) await openBrowser(adminUrl);

  return {
    server,
    url,
    adminUrl,
    banner,
    port: actualPort,
    reloadCMS,
    rerunMigrations: refreshDevSchemaArtifacts,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      for (const watcher of watchers) watcher.close();
      server.close((error) => error ? rejectClose(error) : resolveClose());
    })
  };
}

function defaultSDKOutFile(schemaPath: string): string {
  const resolved = resolve(schemaPath);
  const baseDir = extname(resolved) ? dirname(resolved) : resolved;
  const sdkRoot = basename(baseDir) === "collections" ? dirname(baseDir) : join(baseDir, "cms");
  return join(sdkRoot, "sdk", "index.ts");
}

function collectionFileBaseName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "collection";
}

async function listFilesIfPresent(dir: string): Promise<string[]> {
  try {
    const resolved = resolve(dir);
    return (await readdir(resolved)).sort().map((file) => join(resolved, file));
  } catch {
    return [];
  }
}

async function writeSchemaIndex(indexFile: string, collectionsDir: string): Promise<void> {
  const destination = resolve(indexFile);
  const entries = await readdir(resolve(collectionsDir)).catch(() => []);
  const collectionFiles = entries
    .filter((entry) => !entry.endsWith(".d.ts"))
    .filter((entry) => [".ts", ".mts", ".js", ".mjs"].includes(extname(entry)))
    .filter((entry) => resolve(collectionsDir, entry) !== destination)
    .sort((a, b) => a.localeCompare(b));
  const imports = collectionFiles.map((entry, index) => ({
    name: `collection${index}`,
    specifier: relativeImportSpecifier(dirname(destination), join(resolve(collectionsDir), entry))
  }));
  const source = [
    "/* eslint-disable */",
    "// Generated by @hono-cms/cli. Do not edit by hand.",
    "import { defineSchema } from \"@hono-cms/schema\";",
    ...imports.map((item) => `import ${item.name} from ${JSON.stringify(item.specifier)};`),
    "",
    "export const collections = defineSchema({",
    ...imports.map((item) => `  [${item.name}.name]: ${item.name},`),
    "});",
    "",
    "export default collections;",
    ""
  ].join("\n");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, source);
}

function relativeImportSpecifier(fromDir: string, targetFile: string): string {
  const withoutExtension = join(dirname(targetFile), basename(targetFile, extname(targetFile)));
  const specifier = relative(fromDir, withoutExtension).replaceAll("\\", "/");
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

function defaultSchemaIndexFile(collectionsDir: string): string {
  return join(dirname(resolve(collectionsDir)), "schema.ts");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function defaultDrizzleOutFile(schemaPath = "cms.schema.ts"): string {
  return join(projectRootFromSchemaPath(schemaPath), "node_modules", ".cms", "drizzle-schema.ts");
}

function defaultDrizzleConfigOutFile(schemaPath = "cms.schema.ts"): string {
  return join(projectRootFromSchemaPath(schemaPath), "node_modules", ".cms", "drizzle.config.ts");
}

function projectRootFromSchemaPath(schemaPath: string): string {
  const resolved = resolve(schemaPath);
  const baseDir = extname(resolved) ? dirname(resolved) : resolved;
  return basename(baseDir) === "collections" ? dirname(dirname(baseDir)) : baseDir;
}

function defaultMigrationsDirFromSchema(schemaOutFile: string): string {
  const resolved = resolve(schemaOutFile);
  const cmsDir = dirname(dirname(dirname(resolved)));
  return join(cmsDir, ".hono-cms", "migrations");
}

function drizzleConfigSource(options: { dialect: DrizzleDialect; schemaOutFile: string; migrationsDir: string }): string {
  const schema = resolve(options.schemaOutFile);
  const out = resolve(options.migrationsDir);
  const credentials = options.dialect === "pg"
    ? "  dbCredentials: { url: process.env.DATABASE_URL ?? \"postgres://localhost:5432/hono_cms\" },"
    : "  dbCredentials: { url: process.env.DATABASE_URL ?? process.env.TURSO_DATABASE_URL ?? \"file:.hono-cms/dev.db\" },";
  return [
    "/* eslint-disable */",
    "// Generated by @hono-cms/cli. Do not edit by hand.",
    "import { defineConfig } from \"drizzle-kit\";",
    "",
    "export default defineConfig({",
    `  dialect: ${JSON.stringify(options.dialect === "pg" ? "postgresql" : "sqlite")},`,
    `  schema: ${JSON.stringify(schema)},`,
    `  out: ${JSON.stringify(out)},`,
    credentials,
    "  strict: true,",
    "  verbose: true",
    "});",
    ""
  ].join("\n");
}

async function defaultDrizzleKitRunner(command: string, args: string[], options: { cwd: string }): Promise<{ stdout?: string; stderr?: string }> {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (error) {
    const output = error as Error & { stdout?: string; stderr?: string };
    const message = [
      `Failed to run ${command} ${args.join(" ")}`,
      output.stderr,
      output.stdout,
      output.message
    ].filter(Boolean).join("\n");
    throw new Error(message);
  }
}

async function runDevSchemaMigration(options: { schemaPath: string; stateFile: string; migrationsDir?: string }): Promise<SchemaPlan> {
  return schemaApply({
    schemaPath: options.schemaPath,
    stateFile: options.stateFile,
    yes: true,
    allowDestructive: false,
    ...(options.migrationsDir ? { migrationsDir: options.migrationsDir } : {})
  });
}

function devMigrationMessage(plan: SchemaPlan): string {
  return plan.empty ? "Schema is clean." : `Auto-migration applied (${plan.changes.length} change${plan.changes.length === 1 ? "" : "s"}).`;
}

function watchSchemaPaths(paths: string[], onChange: () => Promise<unknown>): FSWatcher[] {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  for (const path of paths) {
    try {
      watchers.push(watch(resolve(path), { recursive: false }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void onChange();
        }, 100);
      }));
    } catch {
      // Missing watch paths are allowed; many projects create collection folders after init.
    }
  }
  return watchers;
}

export async function deployTemplateFromSchema(target: DeployTarget, options: DeployTemplateFromSchemaOptions): Promise<string> {
  return deployTemplate(target, {
    ...options,
    collections: await loadSchema(options.schemaPath)
  });
}

export function deployTemplate(target: DeployTarget, options: DeployTemplateOptions = {}): string {
  const entry = options.entry ?? (target === "vercel" ? "api/cms/[[...route]].ts" : target === "next" ? "app/api/cms/[...route]/route.ts" : "src/cms.ts");
  const infrastructure = planDeployInfrastructure(options.collections, options.projectName);
  if (target === "cloudflare") {
    return [
      "# Generated by @hono-cms/cli. Review before deploying; this command does not provision cloud resources.",
      `name = ${JSON.stringify(infrastructure.projectName)}`,
      `main = ${JSON.stringify(entry)}`,
      "compatibility_date = \"2026-05-22\"",
      "compatibility_flags = [\"nodejs_compat\"]",
      "",
      schemaSummaryComment(infrastructure, "# "),
      "[vars]",
      "NODE_ENV = \"production\"",
      "",
      "[[d1_databases]]",
      "binding = \"DB\"",
      `database_name = ${JSON.stringify(infrastructure.projectName)}`,
      "database_id = \"replace-me\"",
      ...cloudflareMediaSection(infrastructure),
      "[triggers]",
      `crons = ${JSON.stringify(cronSchedules(infrastructure))}`,
      "",
      `# Create the D1 database${infrastructure.requiresMediaStorage ? " and R2 bucket" : ""} manually, then replace the IDs/names above.`,
      "# The worker entrypoint should call cms.fetch(request, env, ctx) and cms.scheduled(event, env, ctx)."
    ].join("\n");
  }
  if (target === "vercel") {
    return JSON.stringify({
      version: 2,
      functions: {
        [entry]: {
          runtime: "edge"
        }
      },
      crons: vercelCrons(infrastructure),
      rewrites: [
        { source: "/cms/(.*)", destination: "/api/cms/$1" },
        { source: "/api/(.*)", destination: "/api/cms/api/$1" }
      ],
      honoCms: {
        entry,
        infrastructure,
        env: {
          DATABASE_URL: "required",
          ...(infrastructure.requiresMediaStorage ? { BLOB_READ_WRITE_TOKEN: "required for media fields" } : {})
        },
        note: "Generated template only. Review provider storage/database env vars before deploy."
      }
    }, null, 2);
  }
  if (target === "next") {
    return [
      "// Generated by @hono-cms/cli. Save as app/api/cms/[...route]/route.ts in a Next.js App Router project.",
      schemaSummaryComment(infrastructure, "// ").trimEnd(),
      nextRouteTemplate(entry),
      "",
      "export const honoCms = " + JSON.stringify({ entry, infrastructure }, null, 2) + ";"
    ].join("\n");
  }
  return [
    "# Generated by @hono-cms/cli. Split these sections into the named files.",
    "",
    "===== Dockerfile =====",
    "FROM node:22-alpine AS base",
    "WORKDIR /app",
    "",
    "FROM base AS deps",
    "COPY package.json package-lock.json* pnpm-lock.yaml* bun.lock* yarn.lock* ./",
    "RUN corepack enable && \\",
    "  if [ -f bun.lock ]; then npm install -g bun && bun install --frozen-lockfile; \\",
    "  elif [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \\",
    "  elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; \\",
    "  else npm ci; fi",
    "",
    "FROM deps AS build",
    "COPY . .",
    "RUN npm run build",
    "",
    "FROM base AS runtime",
    "ENV NODE_ENV=production",
    "COPY --from=build /app/package.json ./package.json",
    "COPY --from=build /app/node_modules ./node_modules",
    "COPY --from=build /app/dist ./dist",
    "COPY --from=build /app/cms.config.ts ./cms.config.ts",
    "EXPOSE 3000",
    "CMD [\"node\", \"dist/index.js\"]",
    "",
    "===== docker-compose.yml =====",
    "services:",
    "  cms:",
    "    build: .",
    "    ports:",
    "      - \"3000:3000\"",
    "    environment:",
    "      NODE_ENV: production",
    "      DATABASE_URL: postgres://hono_cms:hono_cms@postgres:5432/hono_cms",
    "      PORT: 3000",
    ...(infrastructure.requiresMediaStorage ? [
      "      MEDIA_ROOT: /app/uploads"
    ] : []),
    "    depends_on:",
    "      postgres:",
    "        condition: service_healthy",
    "    healthcheck:",
    "      test: [\"CMD-SHELL\", \"node -e \\\"fetch('http://127.0.0.1:3000/cms/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\\\"\"]",
    "      interval: 10s",
    "      timeout: 5s",
    "      retries: 6",
    "      start_period: 15s",
    ...(infrastructure.requiresMediaStorage ? [
      "    volumes:",
      "      - hono-cms-media:/app/uploads"
    ] : []),
    "  postgres:",
    "    image: postgres:16-alpine",
    "    environment:",
    "      POSTGRES_DB: hono_cms",
    "      POSTGRES_USER: hono_cms",
    "      POSTGRES_PASSWORD: hono_cms",
    "    volumes:",
    "      - hono-cms-postgres:/var/lib/postgresql/data",
    "    healthcheck:",
    "      test: [\"CMD-SHELL\", \"pg_isready -U hono_cms -d hono_cms\"]",
    "      interval: 5s",
    "      timeout: 5s",
    "      retries: 10",
    "volumes:",
    "  hono-cms-postgres:",
    ...(infrastructure.requiresMediaStorage ? [
      "  hono-cms-media:"
    ] : []),
    "",
    "===== infrastructure.json =====",
    JSON.stringify(infrastructure, null, 2),
    "",
    "===== src/server.ts =====",
    "import { serve } from '@hono/node-server';",
    `import cms from ${JSON.stringify(relativeImport(entry))};`,
    "",
    "serve({",
    "  fetch: cms.fetch,",
    "  port: Number(process.env.PORT ?? 3000)",
    "});"
  ].join("\n");
}

export async function writeTemplateOutput(content: string, options: { outFile?: string; yes?: boolean } = {}): Promise<TemplateWriteResult> {
  if (!options.outFile) return { outFile: null, content, written: false };
  const destination = resolve(options.outFile);
  if (!options.yes && await pathExists(destination)) {
    throw new Error(`Refusing to overwrite ${options.outFile}. Re-run with --yes to replace it.`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
  return { outFile: destination, content, written: true };
}

export function planDeployInfrastructure(collections?: CMSCollections, projectName = "hono-cms"): DeployInfrastructurePlan {
  const hasSchema = Boolean(collections);
  const collectionEntries = Object.values(collections ?? {});
  const mediaFields = collectionEntries.flatMap((collection) =>
    Object.entries(collection.fields)
      .filter((entry): entry is [string, FieldDefinition & { kind: "media" }] => entry[1].kind === "media")
      .map(([field, definition]) => ({ collection: collection.name, field, multiple: definition.multiple === true }))
  );
  const draftCollections = collectionEntries
    .filter((collection) => collection.options.draftAndPublish === true)
    .map((collection) => collection.name);
  const localizedCollections = collectionEntries
    .filter((collection) => Boolean(collection.options.i18n))
    .map((collection) => collection.name);

  return {
    projectName,
    collections: collectionEntries.map((collection) => collection.name),
    mediaFields,
    draftCollections,
    localizedCollections,
    requiresMediaStorage: !hasSchema || mediaFields.length > 0,
    requiresScheduledJobs: !hasSchema || draftCollections.length > 0
  };
}

function schemaSummaryComment(infrastructure: DeployInfrastructurePlan, prefix: string): string {
  if (infrastructure.collections.length === 0) {
    return `${prefix}No schema was provided; resource sections use conservative defaults.\n`;
  }
  return [
    `${prefix}Schema collections: ${infrastructure.collections.join(", ")}`,
    `${prefix}Media fields: ${infrastructure.mediaFields.length ? infrastructure.mediaFields.map((field) => `${field.collection}.${field.field}`).join(", ") : "none"}`,
    `${prefix}Draft workflow: ${infrastructure.draftCollections.length ? infrastructure.draftCollections.join(", ") : "none"}`,
    `${prefix}Localized collections: ${infrastructure.localizedCollections.length ? infrastructure.localizedCollections.join(", ") : "none"}`,
    ""
  ].join("\n");
}

function cloudflareMediaSection(infrastructure: DeployInfrastructurePlan): string[] {
  if (!infrastructure.requiresMediaStorage) return [""];
  return [
    "",
    "[[r2_buckets]]",
    "binding = \"R2_BUCKET\"",
    `bucket_name = ${JSON.stringify(`${infrastructure.projectName}-media`)}`,
    ""
  ];
}

function cronSchedules(infrastructure: DeployInfrastructurePlan): string[] {
  return infrastructure.requiresScheduledJobs ? ["*/15 * * * *", "0 3 * * *"] : ["0 3 * * *"];
}

function vercelCrons(infrastructure: DeployInfrastructurePlan): Array<{ path: string; schedule: string }> {
  return [
    ...(infrastructure.requiresScheduledJobs ? [{ path: "/cms/jobs/scheduled-publish", schedule: "*/15 * * * *" }] : []),
    { path: "/cms/jobs/audit-log-cleanup", schedule: "0 3 * * *" },
    { path: "/cms/jobs/cache-sweep", schedule: "0 * * * *" }
  ];
}

export function platformEntrypointTemplate(target: DeployTarget, options: { entry?: string } = {}): string {
  const entry = options.entry ?? "src/cms.ts";
  const importPath = relativeImport(entry);
  if (target === "cloudflare") {
    return [
      `import cms from ${JSON.stringify(importPath)};`,
      "",
      "export default {",
      "  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {",
      "    return cms.fetch(request, env, ctx);",
      "  },",
      "  async scheduled(event: ScheduledEvent, env: unknown, ctx: ExecutionContext): Promise<void> {",
      "    await cms.scheduled?.(event, env, ctx);",
      "  }",
      "};"
    ].join("\n");
  }
  if (target === "vercel") {
    return [
      `import cms from ${JSON.stringify(importPath)};`,
      "",
      "export const runtime = 'edge';",
      "",
      "export function GET(request: Request): Promise<Response> {",
      "  return cms.fetch(request);",
      "}",
      "",
      "export const POST = GET;",
      "export const PATCH = GET;",
      "export const PUT = GET;",
      "export const DELETE = GET;",
      "export const OPTIONS = GET;",
      "export const HEAD = GET;"
    ].join("\n");
  }
  if (target === "next") {
    return nextRouteTemplate(entry);
  }
  return [
    "import { serve } from '@hono/node-server';",
    `import cms from ${JSON.stringify(importPath)};`,
    "",
    "serve({",
    "  fetch: (request) => cms.fetch(request),",
    "  port: Number(process.env.PORT ?? 3000)",
    "});"
  ].join("\n");
}

function devBanner(options: { url: string; adminUrl: string; migrationMessage: string }): string {
  return [
    "@hono-cms/dev",
    "----------------",
    `Server: ${options.url}`,
    `Admin:  ${options.adminUrl}`,
    "Mode:   development",
    options.migrationMessage
  ].join("\n");
}

async function routeDevRequest(
  cmsHandler: ReturnType<typeof createNodeHandler>,
  request: IncomingMessage,
  response: ServerResponse,
  options: { adminDist: string; adminProxyUrl: string }
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (!path.startsWith("/admin")) {
    cmsHandler(request, response);
    return;
  }

  if (await serveAdminAsset(request, response, options.adminDist, path)) return;
  await proxyAdminRequest(request, response, options.adminProxyUrl);
}

async function serveAdminAsset(request: IncomingMessage, response: ServerResponse, adminDist: string, path: string): Promise<boolean> {
  const root = resolve(adminDist);
  if (!await pathExists(root)) return false;
  const assetPath = path === "/admin" || path === "/admin/" ? "index.html" : decodeURIComponent(path.replace(/^\/admin\/?/, ""));
  const candidate = resolve(root, assetPath);
  const relativeCandidate = relative(root, candidate);
  if (relativeCandidate.startsWith("..") || isAbsolute(relativeCandidate)) {
    response.writeHead(403).end("Forbidden");
    return true;
  }
  const file = await stat(candidate).catch(() => null);
  const target = file?.isFile() ? candidate : join(root, "index.html");
  const targetInfo = await stat(target).catch(() => null);
  if (!targetInfo?.isFile()) return false;
  response.statusCode = 200;
  response.setHeader("content-type", contentType(target));
  if (request.method === "HEAD") {
    response.end();
    return true;
  }
  await new Promise<void>((resolvePipe, rejectPipe) => {
    const stream = createReadStream(target);
    stream.on("error", rejectPipe);
    response.on("error", rejectPipe);
    response.on("finish", resolvePipe);
    stream.pipe(response);
  });
  return true;
}

async function proxyAdminRequest(request: IncomingMessage, response: ServerResponse, proxyBaseUrl: string): Promise<void> {
  const target = new URL(request.url ?? "/admin", proxyBaseUrl);
  target.pathname = target.pathname.replace(/^\/admin\/?/, "/");
  try {
    const proxied = await fetch(target, {
      method: request.method,
      headers: requestHeaders(request),
      body: request.method === "GET" || request.method === "HEAD" ? undefined : Readable.toWeb(request) as unknown as BodyInit,
      duplex: request.method === "GET" || request.method === "HEAD" ? undefined : "half"
    } as RequestInit & { duplex?: "half" });
    response.statusCode = proxied.status;
    proxied.headers.forEach((value, key) => response.setHeader(key, value));
    if (!proxied.body) {
      response.end();
      return;
    }
    const stream = Readable.fromWeb(proxied.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
    await new Promise<void>((resolvePipe, rejectPipe) => {
      stream.on("error", rejectPipe);
      response.on("error", rejectPipe);
      response.on("finish", resolvePipe);
      stream.pipe(response);
    });
  } catch (error) {
    response.statusCode = 502;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "admin_proxy_error", message: error instanceof Error ? error.message : "proxy failed" }));
  }
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  return headers;
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function defaultDatabase(preset: InitPreset): DatabaseProvider {
  if (preset === "cloudflare") return "d1";
  if (preset === "vercel" || preset === "next") return "postgres";
  return "memory";
}

function defaultStorage(preset: InitPreset, database: DatabaseProvider): StorageProvider {
  if (database === "convex") return "none";
  if (preset === "cloudflare") return "r2";
  if (preset === "vercel" || preset === "next") return "vercel-blob";
  return "local";
}

function validateInitSelection(options: { database: DatabaseProvider; storage: StorageProvider }): void {
  if (options.database === "d1" && options.storage !== "r2" && options.storage !== "none") {
    throw new Error("D1 requires Cloudflare runtime - choose R2 storage or switch to a Postgres adapter.");
  }
  if (options.database === "d1" && options.storage === "local") {
    throw new Error("Local storage is incompatible with Cloudflare D1.");
  }
  if (options.database === "convex" && options.storage !== "none") {
    throw new Error("Convex uses its own storage - use storage=none.");
  }
}

function databaseOptions(preset: InitPreset): Array<{ value: DatabaseProvider; label: string; hint?: string; disabled?: boolean }> {
  if (preset === "cloudflare") {
    return [
      { value: "d1", label: "Cloudflare D1", hint: "recommended" },
      { value: "turso", label: "Turso" },
      { value: "memory", label: "Memory", hint: "local only" }
    ];
  }
  if (preset === "vercel" || preset === "next") {
    return [
      { value: "postgres", label: "Postgres", hint: "recommended" },
      { value: "turso", label: "Turso" },
      { value: "convex", label: "Convex" },
      { value: "memory", label: "Memory", hint: "local only" }
    ];
  }
  return [
    { value: "memory", label: "Memory", hint: "quick start" },
    { value: "postgres", label: "Postgres" },
    { value: "turso", label: "Turso" },
    { value: "convex", label: "Convex" }
  ];
}

function storageOptions(preset: InitPreset, database: DatabaseProvider): Array<{ value: StorageProvider; label: string; hint?: string; disabled?: boolean }> {
  if (database === "convex") return [{ value: "none", label: "None", hint: "Convex manages storage" }];
  if (preset === "cloudflare") {
    return [
      { value: "r2", label: "Cloudflare R2", hint: "recommended" },
      { value: "none", label: "None" }
    ];
  }
  if (preset === "vercel" || preset === "next") {
    return [
      { value: "vercel-blob", label: "Vercel Blob", hint: "recommended" },
      { value: "s3", label: "S3 compatible" },
      { value: "none", label: "None" }
    ];
  }
  return [
    { value: "local", label: "Local filesystem", hint: "recommended" },
    { value: "s3", label: "S3 compatible" },
    { value: "none", label: "None" }
  ];
}

async function loadClackPrompts(): Promise<InitPromptAdapter> {
  const prompts = await import("@clack/prompts");
  return {
    intro: prompts.intro,
    outro: prompts.outro,
    cancel: prompts.cancel,
    isCancel: prompts.isCancel,
    text: (options) => prompts.text(options as Parameters<typeof prompts.text>[0]),
    select: (options) => prompts.select(options as Parameters<typeof prompts.select>[0]),
    multiselect: (options) => prompts.multiselect(options as Parameters<typeof prompts.multiselect>[0]),
    confirm: (options) => prompts.confirm(options as Parameters<typeof prompts.confirm>[0])
  };
}

async function promptValue<Value>(prompts: InitPromptAdapter, value: Promise<unknown>): Promise<Value> {
  const resolved = await value;
  if (prompts.isCancel(resolved)) {
    prompts.cancel?.("Operation cancelled.");
    throw new Error("Operation cancelled.");
  }
  return resolved as Value;
}

async function detectPackageManager(cwd: string): Promise<InitResult["packageManager"]> {
  if (await pathExists(join(cwd, "bun.lock"))) return "bun";
  if (await pathExists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(join(cwd, "yarn.lock"))) return "yarn";
  if (await pathExists(join(cwd, "package-lock.json"))) return "npm";
  return "bun";
}

function installCommand(packageManager: InitResult["packageManager"]): string[] {
  if (packageManager === "npm") return ["npm", "install"];
  if (packageManager === "yarn") return ["yarn", "install"];
  return [packageManager, "install"];
}

function initDependencies(preset: InitPreset, database: DatabaseProvider, storage: StorageProvider, authPlugins: string[], email: EmailProvider): string[] {
  const dependencies = new Set(["@hono-cms/core", "@hono-cms/schema", "qs"]);
  const adapterPackage = {
    d1: "@hono-cms/adapter-d1",
    postgres: "@hono-cms/adapter-postgres",
    turso: "@hono-cms/adapter-turso",
    convex: "@hono-cms/adapter-convex",
    memory: "@hono-cms/adapter-memory"
  } satisfies Record<DatabaseProvider, string>;
  dependencies.add(adapterPackage[database]);
  if (storage === "local") dependencies.add("@hono-cms/storage-local");
  if (storage === "r2") dependencies.add("@hono-cms/storage-r2");
  if (storage === "s3") dependencies.add("@hono-cms/storage-s3");
  if (storage === "vercel-blob") dependencies.add("@hono-cms/storage-vercel-blob");
  if (storage === "none") dependencies.add("@hono-cms/storage-memory");
  if (preset === "next") dependencies.add("@hono-cms/platform");
  for (const plugin of authPlugins) dependencies.add(`@hono-cms/auth-${plugin}`);
  if (email !== "console" && email !== "none") dependencies.add(`@hono-cms/email-${email}`);
  return [...dependencies].sort((a, b) => a.localeCompare(b));
}

function initDevDependencies(): string[] {
  return ["@hono-cms/cli", "@types/qs", "drizzle-kit"].sort((a, b) => a.localeCompare(b));
}

function nextRouteTemplate(routeFile: string): string {
  return [
    `import cms from ${JSON.stringify(nextRouteCMSImport(routeFile))};`,
    "import { createNextRouteHandlers } from '@hono-cms/platform/next';",
    "",
    "export const runtime = 'edge';",
    "",
    "const handlers = createNextRouteHandlers(cms);",
    "",
    "export const GET = handlers.GET;",
    "export const POST = handlers.POST;",
    "export const PUT = handlers.PUT;",
    "export const PATCH = handlers.PATCH;",
    "export const DELETE = handlers.DELETE;",
    "export const OPTIONS = handlers.OPTIONS;",
    "export const HEAD = handlers.HEAD;"
  ].join("\n");
}

function cmsConfigTemplate(options: { database: DatabaseProvider; storage: StorageProvider; authPlugins: string[]; email: EmailProvider }): string {
  return [
    "import { createCMS, type CMSConfig } from '@hono-cms/core';",
    "import { collections } from './cms/schema';",
    ...providerImports(options),
    "",
    "const env = typeof process === \"undefined\" ? {} : process.env;",
    ...bindingDeclarations(options),
    "",
    "export const cmsConfig = {",
    "  collections,",
    `  db: ${providerConfig("database", options.database)},`,
    `  storage: ${providerConfig("storage", options.storage)},`,
    "  auth: {",
    "    tokens: {",
    "      dev: { userId: \"dev\", roles: [\"admin\"] }",
    "    }",
    "  },",
    "  contentTypeBuilder: false",
    "} satisfies CMSConfig<typeof collections>;",
    "",
    "export default createCMS(cmsConfig);",
    ""
  ].join("\n");
}

function cmsDevConfigTemplate(): string {
  return [
    "import { createCMS } from '@hono-cms/core';",
    "import { createContentTypeWriter } from '@hono-cms/cli';",
    "import { cmsConfig } from './cms.config';",
    "",
    "export default createCMS({",
    "  ...cmsConfig,",
    "  contentTypeBuilder: {",
    "    writer: createContentTypeWriter({",
    "      collectionsDir: 'cms/collections',",
    "      schemaIndexFile: 'cms/schema.ts',",
    "      sdkOutFile: 'cms/sdk/index.ts',",
    "      openapiOutFile: 'cms/openapi.json',",
    "      stateFile: '.hono-cms/schema-state.json',",
    "      migrationsDir: '.hono-cms/migrations'",
    "    })",
    "  }",
    "});",
    ""
  ].join("\n");
}

function initialArticleCollectionTemplate(): string {
  return [
    "import { defineCollection, fields } from '@hono-cms/schema';",
    "",
    "export default defineCollection('articles', {",
    "  title: fields.string({ required: true }),",
    "  slug: fields.string({ required: true, unique: true }),",
    "  body: fields.text(),",
    "  featured: fields.boolean()",
    "}, { draftAndPublish: true, timestamps: true });",
    ""
  ].join("\n");
}

function envTemplate(options: { database: DatabaseProvider; storage: StorageProvider; email: EmailProvider }): string {
  const vars = new Map<string, string>();
  if (options.database === "d1") vars.set("CLOUDFLARE_D1_DATABASE_ID", "replace-me");
  if (options.database === "postgres") vars.set("DATABASE_URL", "postgres://localhost:5432/hono_cms");
  if (options.database === "turso") {
    vars.set("TURSO_DATABASE_URL", "libsql://example.turso.io");
    vars.set("TURSO_AUTH_TOKEN", "replace-me");
  }
  if (options.database === "convex") vars.set("CONVEX_URL", "https://example.convex.cloud");
  if (options.storage === "r2") vars.set("R2_BUCKET_NAME", "hono-cms-media");
  if (options.storage === "s3") vars.set("S3_BUCKET_NAME", "hono-cms-media");
  if (options.storage === "vercel-blob") vars.set("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_replace_me");
  if (options.email === "resend") vars.set("RESEND_API_KEY", "re_replace_me");
  if (options.email === "postmark") vars.set("POSTMARK_SERVER_TOKEN", "replace-me");
  if (options.email === "smtp") vars.set("SMTP_URL", "smtp://localhost:1025");
  if (vars.size === 0) return "# No required environment variables for this preset.\n";
  return `${[...vars.entries()].map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function providerConfig(kind: "database", provider: DatabaseProvider): string;
function providerConfig(kind: "storage", provider: StorageProvider): string;
function providerConfig(kind: "email", provider: EmailProvider): string;
function providerConfig(kind: "database" | "storage" | "email", provider: DatabaseProvider | StorageProvider | EmailProvider): string {
  if (kind === "database") return databaseConfig(provider as DatabaseProvider);
  if (kind === "storage") return storageConfig(provider as StorageProvider);
  return `{ provider: ${JSON.stringify(provider)} }`;
}

function providerImports(options: { database: DatabaseProvider; storage: StorageProvider }): string[] {
  const imports = new Set<string>();
  const databaseImports = {
    d1: "@hono-cms/adapter-d1",
    postgres: "@hono-cms/adapter-postgres",
    turso: "@hono-cms/adapter-turso",
    convex: "@hono-cms/adapter-convex",
    memory: "@hono-cms/adapter-memory"
  } satisfies Record<DatabaseProvider, string>;
  imports.add(databaseImports[options.database]);
  const storageImports = {
    local: "@hono-cms/storage-local",
    r2: "@hono-cms/storage-r2",
    s3: "@hono-cms/storage-s3",
    "vercel-blob": "@hono-cms/storage-vercel-blob",
    none: null
  } satisfies Record<StorageProvider, string | null>;
  const storageImport = storageImports[options.storage];
  if (storageImport) imports.add(storageImport);
  return [...imports].sort((a, b) => a.localeCompare(b)).map((module) => `import ${JSON.stringify(module)};`);
}

function databaseConfig(provider: DatabaseProvider): string {
  if (provider === "d1") return "{ provider: \"d1\", collections, binding: DB }";
  if (provider === "postgres") return "{ provider: \"postgres\", collections, url: env.DATABASE_URL }";
  if (provider === "turso") return "{ provider: \"turso\", collections, url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN }";
  if (provider === "convex") return "{ provider: \"convex\", collections, url: env.CONVEX_URL }";
  return "{ provider: \"memory\", collections }";
}

function storageConfig(provider: StorageProvider): string {
  if (provider === "local") return "{ provider: \"local\", rootDir: \".hono-cms/media\", publicBaseUrl: \"/media\" }";
  if (provider === "r2") return "{ provider: \"r2\", bucket: R2_BUCKET, publicBaseUrl: env.R2_PUBLIC_BASE_URL }";
  if (provider === "s3") return "{ provider: \"s3\", bucket: env.S3_BUCKET_NAME ?? \"hono-cms-media\", region: env.S3_REGION, endpoint: env.S3_ENDPOINT, publicBaseUrl: env.S3_PUBLIC_BASE_URL }";
  if (provider === "vercel-blob") return "{ provider: \"vercel-blob\", token: env.BLOB_READ_WRITE_TOKEN }";
  return "undefined";
}

function bindingDeclarations(options: { database: DatabaseProvider; storage: StorageProvider }): string[] {
  const lines: string[] = [];
  if (options.database === "d1") {
    lines.push("", "const DB = (globalThis as typeof globalThis & { DB?: import(\"@hono-cms/adapter-d1\").D1DatabaseLike }).DB;");
  }
  if (options.storage === "r2") {
    lines.push("", "const R2_BUCKET = (globalThis as typeof globalThis & { R2_BUCKET: import(\"@hono-cms/storage-r2\").R2BucketBinding }).R2_BUCKET;");
  }
  return lines;
}

async function updatePackageJson(packageJsonPath: string, projectName: string, dependencies: string[], devDependencies: string[]): Promise<void> {
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    current = {};
  }
  const existingDependencies = current.dependencies && typeof current.dependencies === "object" && !Array.isArray(current.dependencies)
    ? current.dependencies as Record<string, string>
    : {};
  const existingDevDependencies = current.devDependencies && typeof current.devDependencies === "object" && !Array.isArray(current.devDependencies)
    ? current.devDependencies as Record<string, string>
    : {};
  const existingScripts = current.scripts && typeof current.scripts === "object" && !Array.isArray(current.scripts)
    ? current.scripts as Record<string, string>
    : {};
  current.name = typeof current.name === "string" ? current.name : projectName;
  current.type = typeof current.type === "string" ? current.type : "module";
  current.scripts = {
    "cms:dev": "cms dev --cms cms.dev.ts --schema cms/collections --drizzle-kit",
    "cms:build": "cms build --schema cms.config.ts --state .hono-cms/schema-state.json --out cms/sdk/index.ts",
    "cms:schema:generate": "cms schema drizzle-generate --schema cms.config.ts",
    "cms:schema:migrate": "cms schema drizzle-migrate --schema cms.config.ts",
    ...existingScripts
  };
  current.dependencies = Object.fromEntries([
    ...Object.entries(existingDependencies),
    ...dependencies.map((dependency) => [dependency, "latest"] as const)
  ].sort(([a], [b]) => a.localeCompare(b)));
  current.devDependencies = Object.fromEntries([
    ...Object.entries(existingDevDependencies),
    ...devDependencies.map((dependency) => [dependency, "latest"] as const)
  ].sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(packageJsonPath, `${JSON.stringify(current, null, 2)}\n`);
}

async function readSnapshot(stateFile: string): Promise<SchemaSnapshot | null> {
  try {
    return JSON.parse(await readFile(resolve(stateFile), "utf8")) as SchemaSnapshot;
  } catch {
    return null;
  }
}

async function writeMigrationFile(plan: SchemaPlan, migrationsDir: string): Promise<string | null> {
  if (plan.empty) return null;
  const destinationDir = resolve(migrationsDir);
  await mkdir(destinationDir, { recursive: true });
  const filename = `${migrationTimestamp()}_${migrationSlug(plan)}.sql`;
  const destination = join(destinationDir, filename);
  await writeFile(destination, renderSchemaMigrationSQL(plan));
  return destination;
}

function migrationTimestamp(date = new Date()): string {
  return date.toISOString().replace(/\D/g, "").slice(0, 14);
}

function migrationSlug(plan: SchemaPlan): string {
  const first = plan.changes[0];
  if (!first) return "schema";
  if (first.type === "create_collection") return `create_${first.collection}`;
  if (first.type === "drop_collection") return `drop_${first.collection}`;
  if (first.type === "alter_collection") return `alter_${first.collection}_options`;
  if (first.type === "add_field") return `add_${first.collection}_${first.field}`;
  if (first.type === "drop_field") return `drop_${first.collection}_${first.field}`;
  if (first.type === "create_system_table") return `create_${first.table.replaceAll(":", "_")}`;
  if (first.type === "drop_system_table") return `drop_${first.table.replaceAll(":", "_")}`;
  if (first.type === "alter_system_table") return `alter_${first.table.replaceAll(":", "_")}`;
  return `alter_${first.collection}_${first.field}`;
}

function sqlType(field: FieldDefinition): string {
  switch (field.kind) {
    case "number":
      return field.int ? "INTEGER" : "REAL";
    case "boolean":
      return "INTEGER";
    case "json":
      return "TEXT";
    case "relation":
      return field.cardinality === "many" ? "TEXT" : "TEXT";
    default:
      return "TEXT";
  }
}

function renderCreateSystemTableSQL(tableKey: string, table: SystemTableSnapshot | undefined): string {
  if (!table) return `-- System table ${tableKey} is missing from the schema snapshot.`;
  const fields = Object.entries(table.fields);
  const columns = fields.length > 0
    ? fields.map(([name, field]) => `  ${quoteIdent(name)} ${systemFieldSQLType(field)}${systemFieldRequired(field) ? " NOT NULL" : ""}${name === "id" ? " PRIMARY KEY" : ""}`)
    : ["  id TEXT PRIMARY KEY"];
  return `CREATE TABLE ${quoteIdent(table.name)} (\n${columns.join(",\n")}\n);`;
}

function systemFieldSQLType(field: unknown): string {
  if (!field || typeof field !== "object" || !("type" in field)) return "TEXT";
  const type = String((field as { type?: unknown }).type);
  if (type.includes("number")) return "REAL";
  if (type.includes("boolean")) return "INTEGER";
  if (type.includes("date")) return "TEXT";
  return "TEXT";
}

function systemFieldRequired(field: unknown): boolean {
  return Boolean(field && typeof field === "object" && (field as { required?: unknown }).required === true);
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

async function withSchemaApplyLock<T>(lockFile: string, action: () => Promise<T>): Promise<T> {
  const lockPath = resolve(lockFile);
  await mkdir(dirname(lockPath), { recursive: true });
  const handle = await acquireSchemaLock(lockPath);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await handle.close();
    await rm(lockPath, { force: true });
  };
  const signalHandler = () => {
    void release();
  };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  try {
    return await action();
  } finally {
    process.off("SIGINT", signalHandler);
    process.off("SIGTERM", signalHandler);
    await release();
  }
}

async function acquireSchemaLock(lockPath: string) {
  await clearStaleLock(lockPath);
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(`${JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      operation: "schema apply"
    }, null, 2)}\n`);
    return handle;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`Another schema apply is in progress (${lockPath}). Remove the lock only if that process is no longer running.`);
    }
    throw error;
  }
}

async function clearStaleLock(lockPath: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }

  try {
    const lock = JSON.parse(content) as { pid?: number };
    if (typeof lock.pid === "number" && processIsRunning(lock.pid)) return;
  } catch {
    return;
  }

  await rm(lockPath, { force: true });
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultLockFile(stateFile: string): string {
  return join(dirname(resolve(stateFile)), ".cms-schema.lock");
}

function defaultMigrationsDir(stateFile: string): string {
  return join(dirname(resolve(stateFile)), "migrations");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  const subcommand = args[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usageText());
    return;
  }

  if (command === "check-sdk" || (command === "schema" && subcommand === "check-sdk")) {
    const schemaPath = readFlag(args, "--schema") ?? "cms.schema.ts";
    const outFile = readFlag(args, "--out") ?? "cms/sdk/index.ts";
    const result = await generateSDKArtifact({ schemaPath, outFile, check: true });
    console.log(`SDK types are up to date: ${result.outFile}`);
    return;
  }

  if (command === "check-openapi" || (command === "schema" && subcommand === "check-openapi")) {
    const schemaPath = readFlag(args, "--schema") ?? "cms.schema.ts";
    const outFile = readFlag(args, "--out") ?? "cms/openapi.json";
    const title = readFlag(args, "--title");
    const version = readFlag(args, "--version");
    const result = await generateOpenAPIArtifact({
      schemaPath,
      outFile,
      check: true,
      ...(title ? { title } : {}),
      ...(version ? { version } : {})
    });
    console.log(`OpenAPI spec is up to date: ${result.outFile}`);
    return;
  }

  if (command === "check-drizzle" || (command === "schema" && subcommand === "check-drizzle")) {
    const schemaPath = readFlag(args, "--schema") ?? "cms.schema.ts";
    const outFile = readFlag(args, "--out") ?? defaultDrizzleOutFile(schemaPath);
    const dialect = readDrizzleDialect(args);
    const result = await generateDrizzleArtifact({ schemaPath, outFile, check: true, ...(dialect ? { dialect } : {}) });
    console.log(`Drizzle schema is up to date: ${result.outFile}`);
    return;
  }

  if (command === "check-drizzle-config" || (command === "schema" && subcommand === "check-drizzle-config")) {
    const schemaPath = readFlag(args, "--schema") ?? "cms.schema.ts";
    const schemaOutFile = readFlag(args, "--schema-out") ?? readFlag(args, "--drizzle-out") ?? defaultDrizzleOutFile(schemaPath);
    const outFile = readFlag(args, "--out") ?? defaultDrizzleConfigOutFile(schemaPath);
    const migrationsDir = readFlag(args, "--migrations-dir");
    const dialect = readDrizzleDialect(args);
    const result = await generateDrizzleConfigArtifact({
      outFile,
      schemaOutFile,
      check: true,
      ...(migrationsDir ? { migrationsDir } : {}),
      ...(dialect ? { dialect } : {})
    });
    console.log(`Drizzle config is up to date: ${result.outFile}`);
    return;
  }

  if (command === "generate" || (command === "schema" && subcommand === "generate")) {
    const schemaPath = readFlag(args, "--schema") ?? "cms.schema.ts";
    const outFile = readFlag(args, "--out") ?? "cms/sdk/index.ts";
    const result = await generateSDKArtifact({ schemaPath, outFile, check: args.includes("--check") });
    console.log(result.checked ? `SDK types are up to date: ${outFile}` : `Generated ${outFile} (${result.source.length} bytes)`);
    return;
  }

  if (command === "openapi" || (command === "schema" && subcommand === "openapi")) {
    const schemaPath = readFlag(args, "--schema") ?? "cms.schema.ts";
    const outFile = readFlag(args, "--out") ?? "cms/openapi.json";
    const title = readFlag(args, "--title");
    const version = readFlag(args, "--version");
    const result = await generateOpenAPIArtifact({
      schemaPath,
      outFile,
      check: args.includes("--check"),
      ...(title ? { title } : {}),
      ...(version ? { version } : {})
    });
    console.log(result.checked ? `OpenAPI spec is up to date: ${outFile}` : `Generated ${outFile} (${result.source.length} bytes)`);
    return;
  }

  if (command === "drizzle" || (command === "schema" && subcommand === "drizzle")) {
    const schemaPath = readFlag(args, "--schema") ?? "cms.schema.ts";
    const outFile = readFlag(args, "--out") ?? defaultDrizzleOutFile(schemaPath);
    const dialect = readDrizzleDialect(args);
    const result = await generateDrizzleArtifact({ schemaPath, outFile, check: args.includes("--check"), ...(dialect ? { dialect } : {}) });
    console.log(result.checked ? `Drizzle schema is up to date: ${outFile}` : `Generated ${outFile} (${result.source.length} bytes)`);
    return;
  }

  if (command === "drizzle-config" || (command === "schema" && subcommand === "drizzle-config")) {
    const schemaPath = readFlag(args, "--schema") ?? "cms.schema.ts";
    const schemaOutFile = readFlag(args, "--schema-out") ?? readFlag(args, "--drizzle-out") ?? defaultDrizzleOutFile(schemaPath);
    const outFile = readFlag(args, "--out") ?? defaultDrizzleConfigOutFile(schemaPath);
    const migrationsDir = readFlag(args, "--migrations-dir");
    const dialect = readDrizzleDialect(args);
    const result = await generateDrizzleConfigArtifact({
      outFile,
      schemaOutFile,
      check: args.includes("--check"),
      ...(migrationsDir ? { migrationsDir } : {}),
      ...(dialect ? { dialect } : {})
    });
    console.log(result.checked ? `Drizzle config is up to date: ${outFile}` : `Generated ${outFile} (${result.source.length} bytes)`);
    return;
  }

  if (
    command === "drizzle-generate"
    || command === "drizzle-migrate"
    || (command === "schema" && (subcommand === "drizzle-generate" || subcommand === "drizzle-migrate"))
  ) {
    const action: DrizzleKitAction = command === "drizzle-migrate" || subcommand === "drizzle-migrate" ? "migrate" : "generate";
    const schemaPath = readFlag(args, "--schema") ?? "cms.schema.ts";
    const drizzleOutFile = readFlag(args, "--drizzle-out");
    const drizzleConfigOutFile = readFlag(args, "--drizzle-config-out");
    const migrationsDir = readFlag(args, "--migrations-dir");
    const dialect = readDrizzleDialect(args);
    const drizzleKitCommand = readFlag(args, "--command");
    const result = await runDrizzleKit({
      schemaPath,
      action,
      ...(drizzleOutFile ? { drizzleOutFile } : {}),
      ...(drizzleConfigOutFile ? { drizzleConfigOutFile } : {}),
      ...(migrationsDir ? { migrationsDir } : {}),
      ...(dialect ? { dialect } : {}),
      ...(drizzleKitCommand ? { command: drizzleKitCommand } : {})
    });
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    console.log(output || `Drizzle Kit ${action} completed with ${result.config.outFile}`);
    return;
  }

  if (command === "check" || (command === "schema" && subcommand === "check")) {
    const schemaPath = readFlag(args, "--schema") ?? "cms.schema.ts";
    const stateFile = readFlag(args, "--state") ?? ".hono-cms/schema-state.json";
    const plan = await schemaCheck({ schemaPath, stateFile });
    if (readFlag(args, "--format") === "json") console.log(JSON.stringify(schemaCheckJSON(plan), null, 2));
    else console.log(plan.empty ? "Schema is clean." : `${formatSchemaPlan(plan)}\nSchema drift detected - run \`cms schema apply\` to fix.`);
    if (args.includes("--assert-clean") && !plan.empty) process.exitCode = 1;
    return;
  }

  if (command === "schema" && subcommand === "plan") {
    const schemaPath = readFlag(args, "--schema") ?? "cms.schema.ts";
    const stateFile = readFlag(args, "--state") ?? ".hono-cms/schema-state.json";
    const plan = await schemaPlan({ schemaPath, stateFile });
    console.log(args.includes("--json") ? JSON.stringify(plan, null, 2) : formatSchemaPlan(plan));
    return;
  }

  if (command === "schema" && subcommand === "apply") {
    const schemaPath = readFlag(args, "--schema") ?? "cms.schema.ts";
    const stateFile = readFlag(args, "--state") ?? ".hono-cms/schema-state.json";
    const lockFile = readFlag(args, "--lock");
    const migrationsDir = readFlag(args, "--migrations-dir");
    const plan = await schemaApply({
      schemaPath,
      stateFile,
      allowDestructive: args.includes("--allow-destructive"),
      dryRun: args.includes("--dry-run"),
      yes: args.includes("--yes"),
      ...(lockFile ? { lockFile } : {}),
      ...(migrationsDir ? { migrationsDir } : {})
    });
    if (args.includes("--dry-run")) {
      console.log(`${formatSchemaPlan(plan)}\n\n${renderSchemaMigrationSQL(plan)}`);
    } else {
      console.log(plan.empty ? "No schema changes." : `Applied schema snapshot:\n${formatSchemaPlan(plan)}`);
    }
    return;
  }

  if (command === "build") {
    const schemaPath = readFlag(args, "--schema") ?? "cms.schema.ts";
    const stateFile = readFlag(args, "--state") ?? ".hono-cms/schema-state.json";
    const outFile = readFlag(args, "--out") ?? "src/hono-cms.generated.ts";
    const openapiOutFile = readFlag(args, "--openapi-out") ?? "cms/openapi.json";
    const openapiTitle = readFlag(args, "--openapi-title");
    const openapiVersion = readFlag(args, "--openapi-version");
    const drizzleOutFile = readFlag(args, "--drizzle-out") ?? defaultDrizzleOutFile(schemaPath);
    const drizzleConfigOutFile = readFlag(args, "--drizzle-config-out") ?? defaultDrizzleConfigOutFile(schemaPath);
    const drizzleDialect = readDrizzleDialect(args);
    await buildProject({
      schemaPath,
      stateFile,
      outFile,
      openapiOutFile,
      drizzleOutFile,
      drizzleConfigOutFile,
      check: args.includes("--check"),
      ...(drizzleDialect ? { drizzleDialect } : {}),
      ...(openapiTitle ? { openapiTitle } : {}),
      ...(openapiVersion ? { openapiVersion } : {})
    });
    console.log("Build artifacts are fresh.");
    return;
  }

  if (command === "doctor") {
    const schemaPath = readFlag(args, "--schema") ?? "cms.schema.ts";
    const stateFile = readFlag(args, "--state") ?? ".hono-cms/schema-state.json";
    const sdkOutFile = readFlag(args, "--out") ?? readFlag(args, "--sdk-out");
    const openapiOutFile = readFlag(args, "--openapi-out");
    const openapiTitle = readFlag(args, "--openapi-title");
    const openapiVersion = readFlag(args, "--openapi-version");
    const drizzleOutFile = readFlag(args, "--drizzle-out");
    const drizzleConfigOutFile = readFlag(args, "--drizzle-config-out");
    const migrationsDir = readFlag(args, "--migrations-dir");
    const drizzleDialect = readDrizzleDialect(args);
    const result = await doctorProject({
      schemaPath,
      stateFile,
      ...(sdkOutFile ? { sdkOutFile } : {}),
      ...(openapiOutFile ? { openapiOutFile } : {}),
      ...(openapiTitle ? { openapiTitle } : {}),
      ...(openapiVersion ? { openapiVersion } : {}),
      ...(drizzleOutFile ? { drizzleOutFile } : {}),
      ...(drizzleConfigOutFile ? { drizzleConfigOutFile } : {}),
      ...(migrationsDir ? { migrationsDir } : {}),
      ...(drizzleDialect ? { drizzleDialect } : {})
    });
    if (readFlag(args, "--format") === "json") {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatDoctorResult(result));
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "dev") {
    const cmsPath = readFlag(args, "--cms") ?? "cms.config.ts";
    const schemaPath = readFlag(args, "--schema");
    const stateFile = readFlag(args, "--state") ?? ".hono-cms/schema-state.json";
    const migrationsDir = readFlag(args, "--migrations-dir");
    const watchPath = readFlag(args, "--watch");
    const sdkOutFile = readFlag(args, "--sdk-out");
    const drizzleOutFile = readFlag(args, "--drizzle-out");
    const drizzleConfigOutFile = readFlag(args, "--drizzle-config-out");
    const drizzleDialect = readDrizzleDialect(args);
    const drizzleKitCommand = readFlag(args, "--drizzle-kit-command");
    const adminDist = readFlag(args, "--admin-dist");
    const adminProxyUrl = readFlag(args, "--admin-proxy");
    const portFlag = readFlag(args, "--port");
    const server = await startDevServer({
      cmsPath,
      stateFile,
      open: args.includes("--open"),
      watch: !args.includes("--no-watch"),
      ...(schemaPath ? { schemaPath } : {}),
      ...(sdkOutFile ? { sdkOutFile } : {}),
      ...(drizzleOutFile ? { drizzleOutFile } : {}),
      ...(drizzleConfigOutFile ? { drizzleConfigOutFile } : {}),
      ...(drizzleDialect ? { drizzleDialect } : {}),
      drizzleKit: args.includes("--drizzle-kit"),
      ...(drizzleKitCommand ? { drizzleKitCommand } : {}),
      ...(migrationsDir ? { migrationsDir } : {}),
      ...(watchPath ? { watchPaths: [watchPath] } : {}),
      ...(adminDist ? { adminDist } : {}),
      ...(adminProxyUrl ? { adminProxyUrl } : {}),
      ...(portFlag ? { port: Number(portFlag) } : {})
    });
    console.log(server.banner);
    const shutdown = () => {
      void server.close().then(() => {
        console.log("Shutting down...");
        process.exit(0);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }

  if (command === "init") {
    const preset = readFlag(args, "--preset");
    if (!preset) {
      const result = await initProjectWizard();
      console.log(`Created Hono CMS project in ${result.cwd}`);
      console.log(`Run ${result.installCommand.join(" ")} to install ${result.dependencies.length} dependencies.`);
      return;
    }
    if (preset !== "cloudflare" && preset !== "vercel" && preset !== "node" && preset !== "next") {
      throw new Error("cms init --preset must be one of cloudflare|vercel|node|next.");
    }
    const projectName = readFlag(args, "--name");
    const database = readProviderFlag(args, "--database", ["d1", "postgres", "turso", "convex", "memory"]);
    const storage = readProviderFlag(args, "--storage", ["r2", "local", "s3", "vercel-blob", "none"]);
    const authPlugins = readListFlag(args, "--auth");
    const email = readProviderFlag(args, "--email", ["console", "resend", "postmark", "smtp", "none"]);
    const result = await initProject({
      preset,
      install: !args.includes("--no-install"),
      ...(projectName ? { projectName } : {}),
      ...(database ? { database } : {}),
      ...(storage ? { storage } : {}),
      ...(authPlugins ? { authPlugins } : {}),
      ...(email ? { email } : {})
    });
    console.log(`Created Hono CMS project in ${result.cwd}`);
    console.log(`Run ${result.installCommand.join(" ")} to install ${result.dependencies.length} dependencies.`);
    return;
  }

  if (command === "seed") {
    const cmsPath = readFlag(args, "--cms") ?? "cms.ts";
    const seedsDir = readFlag(args, "--dir") ?? "seeds";
    const summary = await runSeeds({ cmsPath, seedsDir, dryRun: args.includes("--dry-run") });
    const ran = summary.results.filter((result) => !result.skipped).length;
    const skipped = summary.results.length - ran;
    console.log(`${summary.dryRun ? "Discovered" : "Ran"} ${ran} seed${ran === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped)` : ""}.`);
    return;
  }

  if (command === "deploy") {
    const target = readFlag(args, "--target");
    if (target !== "cloudflare" && target !== "vercel" && target !== "node" && target !== "next") {
      throw new Error("deploy requires --target=cloudflare|vercel|node|next");
    }
    const entry = readFlag(args, "--entry");
    const schemaPath = readFlag(args, "--schema");
    const projectName = readFlag(args, "--name");
    const options = {
      ...(entry ? { entry } : {}),
      ...(projectName ? { projectName } : {})
    };
    const content = schemaPath
      ? await deployTemplateFromSchema(target, { ...options, schemaPath })
      : deployTemplate(target, options);
    const outFile = readFlag(args, "--out");
    const output = await writeTemplateOutput(content, { yes: args.includes("--yes"), ...(outFile ? { outFile } : {}) });
    console.log(output.written ? `Wrote ${output.outFile}` : content);
    return;
  }

  if (command === "entrypoint") {
    const target = readFlag(args, "--target");
    if (target !== "cloudflare" && target !== "vercel" && target !== "node" && target !== "next") {
      throw new Error("entrypoint requires --target=cloudflare|vercel|node|next");
    }
    const entry = readFlag(args, "--entry");
    console.log(platformEntrypointTemplate(target, entry ? { entry } : {}));
    return;
  }

  if (command === "info") {
    const schemaPath = readFlag(args, "--schema") ?? "cms.schema.ts";
    const collections = await loadSchema(schemaPath);
    console.log(JSON.stringify({ collections: Object.keys(collections), snapshot: createSchemaSnapshot(collections) }, null, 2));
    return;
  }

  console.log(usageText());
}

function formatDoctorResult(result: DoctorResult): string {
  const lines = [
    result.ok ? "CMS workspace doctor passed." : "CMS workspace doctor found issues.",
    ...result.checks.map((check) => `${check.status === "ok" ? "OK" : "FAIL"} ${check.name}: ${check.message}`)
  ];
  return lines.join("\n");
}

export function usageText(): string {
  return [
    "Usage: cms <command> [options]",
    "",
    "Schema and generated API artifacts:",
    "  cms schema plan --schema cms.schema.ts --state .hono-cms/schema-state.json",
    "  cms schema apply --schema cms.schema.ts --yes [--allow-destructive]",
    "  cms schema check --schema cms.schema.ts [--assert-clean] [--format json]",
    "  cms schema generate --schema cms.schema.ts --out cms/sdk/index.ts [--check]",
    "  cms schema check-sdk --schema cms.schema.ts --out cms/sdk/index.ts",
    "  cms schema openapi --schema cms.schema.ts --out cms/openapi.json [--check] [--title name] [--version version]",
    "  cms schema check-openapi --schema cms.schema.ts --out cms/openapi.json",
    "  cms schema drizzle --schema cms.schema.ts --out node_modules/.cms/drizzle-schema.ts [--dialect sqlite|pg] [--check]",
    "  cms schema check-drizzle --schema cms.schema.ts --out node_modules/.cms/drizzle-schema.ts [--dialect sqlite|pg]",
    "  cms schema drizzle-config --schema cms.schema.ts --out node_modules/.cms/drizzle.config.ts [--schema-out node_modules/.cms/drizzle-schema.ts] [--dialect sqlite|pg] [--check]",
    "  cms schema check-drizzle-config --schema cms.schema.ts --out node_modules/.cms/drizzle.config.ts [--dialect sqlite|pg]",
    "  cms schema drizzle-generate --schema cms.schema.ts [--drizzle-dialect sqlite|pg]",
    "  cms schema drizzle-migrate --schema cms.schema.ts [--drizzle-dialect sqlite|pg]",
    "",
    "Development:",
    "  cms dev --cms cms.config.ts [--schema cms.schema.ts] [--port 3000] [--drizzle-dialect sqlite|pg] [--drizzle-kit] [--open]",
    "  cms build --schema cms.schema.ts --state .hono-cms/schema-state.json --out src/hono-cms.generated.ts --openapi-out cms/openapi.json --drizzle-out node_modules/.cms/drizzle-schema.ts --drizzle-config-out node_modules/.cms/drizzle.config.ts [--drizzle-dialect sqlite|pg] [--check]",
    "  cms doctor --schema cms.schema.ts --state .hono-cms/schema-state.json [--format json]",
    "  cms seed --cms cms.config.ts --dir seeds [--dry-run]",
    "  cms info --schema cms.schema.ts",
    "",
    "Project setup:",
    "  cms init",
    "  cms init --preset cloudflare|vercel|node|next [--database d1|postgres|turso|convex|memory] [--storage r2|local|s3|vercel-blob|none]",
    "",
    "Deployment templates:",
    "  cms deploy --target cloudflare|vercel|node|next [--schema cms.schema.ts] [--entry path] [--out file] [--yes]",
    "  cms entrypoint --target cloudflare|vercel|node|next [--entry src/cms.ts]"
  ].join("\n");
}

function relativeImport(entry: string): string {
  const withoutTs = entry.replace(/\.[cm]?tsx?$/, "");
  return withoutTs.startsWith(".") ? withoutTs : `./${withoutTs.replace(/^src\//, "")}`;
}

function nextRouteCMSImport(routeFile: string): string {
  const routeDir = dirname(routeFile);
  const importPath = relative(routeDir, "cms.config.ts").replaceAll("\\", "/").replace(/\.[cm]?tsx?$/, "");
  return importPath.startsWith(".") ? importPath : `./${importPath}`;
}

async function discoverSeedFiles(seedsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(seedsDir);
    const files = await Promise.all(entries.map(async (entry) => {
      const file = join(seedsDir, entry);
      const info = await stat(file);
      return info.isFile() && [".js", ".mjs", ".ts", ".mts"].includes(extname(file)) ? file : null;
    }));
    return files.filter((file): file is string => Boolean(file)).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function loadSeed(file: string): Promise<((context: SeedContext) => Promise<void> | void) | null> {
  const module = await importFresh(file);
  const seed = module.default ?? module.seed;
  return typeof seed === "function" ? seed as (context: SeedContext) => Promise<void> | void : null;
}

async function importFresh(file: string): Promise<Record<string, unknown>> {
  const resolved = resolve(file);
  const info = await stat(resolved);
  return import(`${pathToFileURL(resolved).href}?mtime=${info.mtimeMs}&size=${info.size}`) as Promise<Record<string, unknown>>;
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function readListFlag(args: string[], flag: string): string[] | undefined {
  const value = readFlag(args, flag);
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined;
}

function readProviderFlag<const Value extends string>(args: string[], flag: string, values: readonly Value[]): Value | undefined {
  const value = readFlag(args, flag);
  if (!value) return undefined;
  if ((values as readonly string[]).includes(value)) return value as Value;
  throw new Error(`${flag} must be one of ${values.join("|")}`);
}

function readDrizzleDialect(args: string[]): DrizzleDialect | undefined {
  return readProviderFlag(args, "--drizzle-dialect", ["sqlite", "pg"])
    ?? readProviderFlag(args, "--dialect", ["sqlite", "pg"]);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
