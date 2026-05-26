import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateCollectionFile } from "@hono-cms/schema";
import type { SchemaRemoveLifecycleInput, SchemaWriter, SchemaWriteLifecycleInput, SchemaWriteResult } from "@hono-cms/core";

export type CreateFileSchemaWriterOptions = {
  /**
   * Absolute filesystem path where generated collection `.ts` files should be written.
   * The directory will be created (recursively) on first write.
   */
  baseDir: string;
  /**
   * Optional import path embedded in the generated file. Defaults to
   * `@hono-cms/schema` (the value `generateCollectionFile` uses if unset).
   */
  importPath?: string;
  /**
   * Optional logger used by `afterWrite`. Defaults to `console.log`.
   * Pass `false` to disable post-write logging.
   */
  logger?: ((message: string) => void) | false;
};

/**
 * Returns a `SchemaWriter` that persists generated content-type files to disk.
 *
 * Wire this into `createCMS({ contentTypeBuilder: { writer } })` to make the
 * Content-Type Builder's "Create" / "Update" actions writable from the admin UI.
 */
export function createFileSchemaWriter(options: CreateFileSchemaWriterOptions): SchemaWriter {
  const { baseDir, importPath } = options;
  const logger = options.logger === false ? null : options.logger ?? ((message: string) => console.log(message));

  const writer: SchemaWriter = {
    ...(importPath ? { importPath } : {}),
    async writeCollection({ collection, source }): Promise<SchemaWriteResult> {
      // Prefer the pre-rendered source from `createCMS` (it already honors `writer.importPath`),
      // but fall back to regenerating it so the writer is usable standalone.
      const contents = source ?? generateCollectionFile(collection, importPath ? { importPath } : {});
      const fileName = `${collection.name}.ts`;
      const path = join(baseDir, fileName);
      await mkdir(baseDir, { recursive: true });
      await writeFile(path, contents, "utf8");
      return {
        path,
        source: contents,
        artifacts: [path]
      };
    },
    async removeCollection({ collection }): Promise<SchemaWriteResult> {
      const fileName = `${collection.name}.ts`;
      const path = join(baseDir, fileName);
      // `force: true` swallows ENOENT so deleting a collection whose file was
      // already removed (or never written by this writer) is idempotent.
      await rm(path, { force: true });
      return {
        path,
        artifacts: [path]
      };
    },
    afterWrite(input: SchemaWriteLifecycleInput): void {
      if (!logger) return;
      const target = input.result.path ?? `${baseDir}/${input.collection.name}.ts`;
      logger(`[hono-cms/newsroom] wrote collection ${input.collection.name} (${input.mode}) -> ${target}`);
    },
    afterRemove(input: SchemaRemoveLifecycleInput): void {
      if (!logger) return;
      const target = input.result.path ?? `${baseDir}/${input.collection.name}.ts`;
      logger(`[hono-cms/newsroom] removed collection ${input.collection.name} -> ${target}`);
    }
  };

  return writer;
}
