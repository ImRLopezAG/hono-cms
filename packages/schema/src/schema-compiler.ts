import { SchemaLoadError } from "./errors";
import { defineSchema, isCMSCollection, type CMSCollections, type CollectionDefinition, type FieldsDefinition } from "./index";

export type SchemaLoadOptions = {
  extensions?: readonly string[];
};

export type SchemaCacheListener = (collections: CMSCollections) => void;

const DEFAULT_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"] as const;

export async function loadSchema(dir: string, options: SchemaLoadOptions = {}): Promise<CMSCollections> {
  const extensions = new Set(options.extensions ?? DEFAULT_EXTENSIONS);
  const files = await collectionFiles(dir, extensions);
  const collections: CMSCollections = {};

  for (const filePath of files) {
    const collection = await importCollection(filePath);
    if (!collection) continue;
    if (collections[collection.name]) {
      throw new SchemaLoadError(`Duplicate collection name "${collection.name}"`, { filePath });
    }
    collections[collection.name] = collection;
  }

  try {
    return defineSchema(collections);
  } catch (error) {
    throw error instanceof SchemaLoadError
      ? error
      : new SchemaLoadError(error instanceof Error ? error.message : "Schema validation failed", { cause: error });
  }
}

export class SchemaCache {
  #collections: CMSCollections | null = null;
  #listeners = new Set<SchemaCacheListener>();

  async load(dir: string, options: SchemaLoadOptions = {}): Promise<CMSCollections> {
    const collections = await loadSchema(dir, options);
    this.#collections = collections;
    for (const listener of this.#listeners) listener(collections);
    return collections;
  }

  set(collections: CMSCollections): CMSCollections {
    const validated = defineSchema(collections);
    this.#collections = validated;
    for (const listener of this.#listeners) listener(validated);
    return validated;
  }

  get(): CMSCollections {
    if (!this.#collections) throw new SchemaLoadError("Schema not loaded");
    return this.#collections;
  }

  invalidate(): void {
    this.#collections = null;
  }

  onChange(listener: SchemaCacheListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

async function collectionFiles(dir: string, extensions: Set<string>): Promise<string[]> {
  let entries: string[];
  try {
    const { readdir } = await import("node:fs/promises");
    entries = await readdir(dir);
  } catch (error) {
    throw new SchemaLoadError("Unable to read schema directory", { filePath: dir, cause: error });
  }

  return entries
    .filter((entry) => !entry.endsWith(".d.ts"))
    .filter((entry) => extensions.has(fileExtension(entry)))
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => joinPath(dir, entry));
}

async function importCollection(filePath: string): Promise<CollectionDefinition<string, FieldsDefinition> | null> {
  let moduleExports: Record<string, unknown>;
  try {
    const { stat } = await import("node:fs/promises");
    const { pathToFileURL } = await import("node:url");
    const stats = await stat(filePath);
    moduleExports = await import(`${pathToFileURL(filePath).href}?mtime=${Math.trunc(stats.mtimeMs)}`);
  } catch (error) {
    throw new SchemaLoadError("Unable to import collection file", { filePath, cause: error });
  }

  if (isCMSCollection(moduleExports.default)) return moduleExports.default;
  const namedCollections = Object.keys(moduleExports)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => moduleExports[key])
    .filter(isCMSCollection);
  return namedCollections[0] ?? null;
}

function fileExtension(filePath: string): string {
  const basename = filePath.split(/[\\/]/).pop() ?? filePath;
  const index = basename.lastIndexOf(".");
  return index > 0 ? basename.slice(index) : "";
}

function joinPath(dir: string, entry: string): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${entry}` : `${dir}/${entry}`;
}
