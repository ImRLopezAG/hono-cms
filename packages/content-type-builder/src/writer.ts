import type {
  CollectionDefinition,
  FieldsDefinition
} from "@hono-cms/schema";

/**
 * The on-disk projection of a `writeCollection` / `removeCollection` call.
 *
 * Returned by writers so the HTTP layer can echo path/source/migration info
 * back to admin clients. Carved verbatim out of
 * `packages/core/src/types/config.ts` per U22.
 */
export type SchemaWriteResult = {
  path?: string;
  source?: string;
  artifacts?: readonly string[];
  migrations?: readonly string[];
  message?: string;
};

export type SchemaWriteLifecycleInput = {
  collection: CollectionDefinition<string, FieldsDefinition>;
  source: string;
  mode: "create" | "update";
  result: SchemaWriteResult;
};

export type SchemaRemoveLifecycleInput = {
  collection: CollectionDefinition<string, FieldsDefinition>;
  mode: "remove";
  result: SchemaWriteResult;
};

/**
 * Contract for the userland adapter that persists collection definitions to
 * the project's schema source (a `.ts` file, a database table, a JSON blob,
 * etc.).
 *
 * Without a writer the plugin still exposes `GET /cms/content-types`
 * (read-only mode); mutations short-circuit with `403`.
 */
export type SchemaWriter = {
  importPath?: string;
  writeCollection(input: {
    collection: CollectionDefinition<string, FieldsDefinition>;
    source: string;
    mode: "create" | "update";
  }): Promise<SchemaWriteResult> | SchemaWriteResult;
  /**
   * Optional: remove a previously generated collection file (and any other
   * artifacts the writer manages). Without this hook the backend exposes the
   * `DELETE /cms/content-types/:name` route as 501 — the writer cannot
   * guarantee a clean removal on disk.
   */
  removeCollection?(input: {
    collection: CollectionDefinition<string, FieldsDefinition>;
  }): Promise<SchemaWriteResult> | SchemaWriteResult;
  afterWrite?(
    input: SchemaWriteLifecycleInput
  ): Promise<SchemaWriteResult | void> | SchemaWriteResult | void;
  afterRemove?(
    input: SchemaRemoveLifecycleInput
  ): Promise<SchemaWriteResult | void> | SchemaWriteResult | void;
};
