import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateCollectionFile } from "@hono-cms/schema";
import type { SchemaWriter, SchemaWriteResult } from "@hono-cms/core";

export type CreateFileSchemaWriterOptions = {
  baseDir: string;
  importPath?: string;
};

export function createFileSchemaWriter(options: CreateFileSchemaWriterOptions): SchemaWriter {
  const { baseDir, importPath } = options;
  return {
    ...(importPath ? { importPath } : {}),
    async writeCollection({ collection, source }): Promise<SchemaWriteResult> {
      const contents = source ?? generateCollectionFile(collection, importPath ? { importPath } : {});
      const fileName = `${collection.name}.ts`;
      const path = join(baseDir, fileName);
      await mkdir(baseDir, { recursive: true });
      await writeFile(path, contents, "utf8");
      return { path, source: contents, artifacts: [path] };
    }
  };
}
