import type { Hono } from "hono";
import type { HonoCMSEnv, PluginContext } from "@hono-cms/core";
import {
  defineCollection,
  defineSchema,
  generateCollectionFile,
  type CMSCollections,
  type CollectionDefinition,
  type CollectionOptions,
  type FieldDefinition,
  type FieldsDefinition,
  type RelationCardinality
} from "@hono-cms/schema";
import type { SchemaWriter, SchemaWriteResult } from "./writer";

/**
 * Mount the `/cms/content-types` admin CRUD surface on the plugin app.
 *
 * Routes (ported verbatim from `packages/core/src/create-cms.ts:121-261`):
 * - `GET /cms/content-types/capabilities` — describe what the writer supports.
 * - `GET /cms/content-types` — list current collections + capabilities.
 * - `POST /cms/content-types` — create a new collection, write the source
 *   via the writer, mutate `ctx.collections` in place, emit
 *   `schema:after-collection-add`.
 * - `PUT /cms/content-types/:name` — update / rename an existing collection;
 *   emits `schema:after-collection-update` (and `-add`/`-remove` on rename).
 * - `DELETE /cms/content-types/:name` — delete via `writer.removeCollection`
 *   (or `501` if the writer doesn't implement it); emits
 *   `schema:after-collection-remove`.
 *
 * The CRUD routes mutate `ctx.collections` directly — that object is the
 * kernel-shared live collection map, so other plugins (graphql, openapi,
 * drafts) see new collections immediately and can rebuild their schemas
 * via the emitted events.
 *
 * On each mutation we also call `ctx.db.ensureCollection?.(name)` so
 * adapters that maintain per-collection state (memory adapter, drizzle
 * schemas) can allocate storage before the first request lands.
 */
export function mountContentTypeRoutes(
  app: Hono<HonoCMSEnv>,
  ctx: PluginContext,
  opts: { writer: SchemaWriter; onCollectionChange: (name: string) => void }
): void {
  const { writer, onCollectionChange } = opts;

  app.get("/cms/content-types/capabilities", () => {
    return Response.json(contentTypeCapabilities(writer));
  });

  app.get("/cms/content-types", () => {
    return Response.json({
      ...schemaMetadata(ctx.collections),
      capabilities: contentTypeCapabilities(writer)
    });
  });

  app.post("/cms/content-types", async (context) => {
    const body = await context.req.json().catch(() => null);
    const parsed = parseContentTypeInput(body);
    if (parsed instanceof Response) return parsed;
    if (ctx.collections[parsed.name]) {
      return Response.json({ error: "collection_exists" }, { status: 409 });
    }
    const validation = validateContentTypeChange(ctx.collections, parsed.collection);
    if (validation) return validation;
    const source = generateCollectionFile(
      parsed.collection,
      writer.importPath ? { importPath: writer.importPath } : {}
    );
    const result = await writer.writeCollection({
      collection: parsed.collection,
      source,
      mode: "create"
    });

    // Mutate the kernel-shared collection map in place so other plugins
    // (graphql / openapi / drafts) and the kernel's existing route layer
    // see the new collection immediately.
    (ctx.collections as Record<string, typeof parsed.collection>)[parsed.name] =
      parsed.collection;
    try {
      (ctx.db as unknown as {
        ensureCollection?: (name: string) => void | Promise<void>;
      }).ensureCollection?.(parsed.name);
    } catch {
      // adapter ensureCollection failures must not block the admin response
    }
    onCollectionChange(parsed.name);
    await ctx.events.emit("schema:after-collection-add", {
      name: parsed.name,
      collection: parsed.collection
    });

    const afterWrite = await writer.afterWrite?.({
      collection: parsed.collection,
      source,
      mode: "create",
      result
    });
    return Response.json(
      contentTypeWriteResponse(parsed.collection, source, result, afterWrite),
      { status: 201 }
    );
  });

  app.put("/cms/content-types/:name", async (context) => {
    const currentName = context.req.param("name");
    const beforeCollection = ctx.collections[currentName];
    if (!beforeCollection) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const body = await context.req.json().catch(() => null);
    const parsed = parseContentTypeInput(body, currentName);
    if (parsed instanceof Response) return parsed;
    if (parsed.name !== currentName && ctx.collections[parsed.name]) {
      return Response.json({ error: "collection_exists" }, { status: 409 });
    }
    const validation = validateContentTypeChange(
      ctx.collections,
      parsed.collection,
      currentName
    );
    if (validation) return validation;
    const source = generateCollectionFile(
      parsed.collection,
      writer.importPath ? { importPath: writer.importPath } : {}
    );
    const result = await writer.writeCollection({
      collection: parsed.collection,
      source,
      mode: "update"
    });

    const mutableCollections = ctx.collections as Record<
      string,
      typeof parsed.collection
    >;
    const renamed = parsed.name !== currentName;
    if (renamed) {
      delete mutableCollections[currentName];
    }
    mutableCollections[parsed.name] = parsed.collection;
    try {
      (ctx.db as unknown as {
        ensureCollection?: (name: string) => void | Promise<void>;
      }).ensureCollection?.(parsed.name);
    } catch {
      // ignore
    }
    onCollectionChange(parsed.name);
    if (renamed) {
      // On rename: emit a remove for the old name + an add for the new one
      // *and* an update so subscribers can pick whichever signal is cheapest.
      await ctx.events.emit("schema:after-collection-remove", {
        name: currentName
      });
      await ctx.events.emit("schema:after-collection-add", {
        name: parsed.name,
        collection: parsed.collection
      });
    }
    await ctx.events.emit("schema:after-collection-update", {
      name: parsed.name,
      before: beforeCollection,
      after: parsed.collection
    });

    const afterWrite = await writer.afterWrite?.({
      collection: parsed.collection,
      source,
      mode: "update",
      result
    });
    return Response.json(
      contentTypeWriteResponse(parsed.collection, source, result, afterWrite)
    );
  });

  app.delete("/cms/content-types/:name", async (context) => {
    // The writer must opt in to deletes by implementing `removeCollection`.
    // Without it we cannot guarantee the underlying file is removed, so we
    // refuse rather than silently mutating the in-memory schema only.
    if (!writer.removeCollection) {
      return Response.json(
        {
          error: "content_type_remove_unsupported",
          message:
            "The configured schema writer does not implement removeCollection. Remove the collection from your schema source manually, or upgrade the writer."
        },
        { status: 501 }
      );
    }
    const currentName = context.req.param("name");
    const existing = ctx.collections[currentName];
    if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
    const result = await writer.removeCollection({ collection: existing });

    const mutableCollections = ctx.collections as Record<string, typeof existing>;
    delete mutableCollections[currentName];
    // Drop the collection from the live REST/GraphQL/OpenAPI surface. The
    // installed route handlers stay registered on the content sub-app (Hono
    // cannot un-register) but their `liveCollection()` guard now returns
    // null so they reply 404 — matching what callers expect post-delete.
    onCollectionChange(currentName);
    await ctx.events.emit("schema:after-collection-remove", {
      name: currentName
    });
    const afterRemove = await writer.afterRemove?.({
      collection: existing,
      mode: "remove",
      result
    });
    const deletedAt = new Date().toISOString();
    return Response.json({
      collection: { name: currentName, deletedAt },
      ...result,
      ...(afterRemove ?? {})
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers ported verbatim from packages/core/src/create-cms.ts (U22).
// ---------------------------------------------------------------------------

function schemaMetadata(collections: CMSCollections): Record<string, unknown> {
  return {
    collections: Object.fromEntries(
      Object.values(collections).map((collection) => [
        collection.name,
        schemaCollectionMetadata(collection)
      ])
    )
  };
}

function schemaCollectionMetadata(
  collection: CMSCollections[string]
): Record<string, unknown> {
  return {
    name: collection.name,
    options: collection.options,
    fields: Object.fromEntries(
      Object.entries(collection.fields).map(([name, field]) => [
        name,
        fieldMetadata(field)
      ])
    )
  };
}

function fieldMetadata(
  field: CMSCollections[string]["fields"][string]
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    kind: field.kind,
    required: field.required === true,
    unique: field.unique === true,
    localized: field.localized === true,
    private: field.private === true
  };
  if (field.permissions) metadata.permissions = field.permissions;
  if ("default" in field && field.default !== undefined)
    metadata.default = field.default;
  if (field.kind === "string") {
    if (field.min !== undefined) metadata.min = field.min;
    if (field.max !== undefined) metadata.max = field.max;
  }
  if (field.kind === "uid" && field.targetField)
    metadata.targetField = field.targetField;
  if (field.kind === "number") {
    metadata.int = field.int === true;
    if (field.min !== undefined) metadata.min = field.min;
    if (field.max !== undefined) metadata.max = field.max;
  }
  if (field.kind === "enum") metadata.values = field.values;
  if (field.kind === "media") metadata.multiple = field.multiple === true;
  if (field.kind === "relation") {
    metadata.target = field.target;
    metadata.cardinality = field.cardinality;
    if (field.inverse) metadata.inverse = field.inverse;
    if (field.onDelete) metadata.onDelete = field.onDelete;
  }
  return metadata;
}

function contentTypeCapabilities(
  writer: SchemaWriter
): Record<string, unknown> {
  return {
    writable: true,
    mode: "development",
    removable: Boolean(writer.removeCollection),
    endpoints: {
      list: "/cms/content-types",
      create: "/cms/content-types",
      update: "/cms/content-types/{name}",
      delete: "/cms/content-types/{name}"
    }
  };
}

function contentTypeWriteResponse(
  collection: CMSCollections[string],
  source: string,
  result: SchemaWriteResult,
  afterWrite?: SchemaWriteResult | void
): Record<string, unknown> {
  return {
    collection: schemaCollectionMetadata(collection),
    source,
    ...result,
    ...(afterWrite ?? {})
  };
}

function parseContentTypeInput(
  body: unknown,
  fallbackName?: string
):
  | { name: string; collection: CollectionDefinition<string, FieldsDefinition> }
  | Response {
  if (!body || typeof body !== "object") {
    return validationResponse([
      { path: [], message: "Body must be a collection definition object." }
    ]);
  }
  const input = body as { name?: unknown; fields?: unknown; options?: unknown };
  const name = typeof input.name === "string" ? input.name : fallbackName;
  const fields = input.fields;
  const options = input.options ?? {};
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  if (!name) issues.push({ path: ["name"], message: "Collection name is required." });
  if (name && !/^[a-z][a-z0-9-]*$/.test(name))
    issues.push({ path: ["name"], message: "Collection name must be kebab-case." });
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    issues.push({ path: ["fields"], message: "fields must be an object." });
  if (!options || typeof options !== "object" || Array.isArray(options))
    issues.push({
      path: ["options"],
      message: "options must be an object when provided."
    });
  if (fields && typeof fields === "object" && !Array.isArray(fields)) {
    const fieldEntries = Object.entries(fields as Record<string, unknown>);
    if (!fieldEntries.length)
      issues.push({ path: ["fields"], message: "At least one field is required." });
    for (const [fieldName, field] of fieldEntries) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(fieldName)) {
        issues.push({
          path: ["fields", fieldName],
          message: "Field names must be valid TypeScript identifiers."
        });
      }
      issues.push(...validateFieldDefinition(field, ["fields", fieldName]));
      if (
        isRecord(field) &&
        field.kind === "uid" &&
        typeof field.targetField === "string" &&
        field.targetField &&
        !(field.targetField in (fields as Record<string, unknown>))
      ) {
        issues.push({
          path: ["fields", fieldName, "targetField"],
          message: `UID targetField "${field.targetField}" must reference another field in this collection.`
        });
      }
    }
  }
  if (options && typeof options === "object" && !Array.isArray(options)) {
    issues.push(...validateCollectionOptions(options as Record<string, unknown>));
  }
  if (issues.length) return validationResponse(issues);

  try {
    return {
      name: name!,
      collection: defineCollection(
        name!,
        fields as FieldsDefinition,
        options as CollectionOptions
      )
    };
  } catch (error) {
    return validationResponse([
      {
        path: [],
        message:
          error instanceof Error
            ? error.message
            : "Invalid collection definition."
      }
    ]);
  }
}

function validateContentTypeChange(
  collections: CMSCollections,
  collection: CollectionDefinition<string, FieldsDefinition>,
  replacing?: string
): Response | null {
  try {
    const nextCollections = { ...collections };
    if (replacing && replacing !== collection.name)
      delete nextCollections[replacing];
    nextCollections[collection.name] = collection;
    defineSchema(nextCollections);
    return null;
  } catch (error) {
    return validationResponse([
      {
        path: [],
        message: error instanceof Error ? error.message : "Invalid schema."
      }
    ]);
  }
}

function validateFieldDefinition(
  field: unknown,
  path: Array<string | number>
): Array<{ path: Array<string | number>; message: string }> {
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    return [{ path, message: "Field definition must be an object." }];
  }
  const definition = field as Record<string, unknown>;
  const kind = definition.kind;
  if (typeof kind !== "string" || !isFieldKind(kind)) {
    issues.push({ path: [...path, "kind"], message: "Unsupported field kind." });
    return issues;
  }
  for (const flag of ["required", "unique", "localized", "private"] as const) {
    if (definition[flag] !== undefined && typeof definition[flag] !== "boolean") {
      issues.push({ path: [...path, flag], message: `${flag} must be a boolean.` });
    }
  }
  if (
    definition.permissions !== undefined &&
    (!definition.permissions ||
      typeof definition.permissions !== "object" ||
      Array.isArray(definition.permissions))
  ) {
    issues.push({
      path: [...path, "permissions"],
      message: "permissions must be an object."
    });
  }
  if (
    (kind === "string" || kind === "number") &&
    definition.min !== undefined &&
    typeof definition.min !== "number"
  ) {
    issues.push({ path: [...path, "min"], message: "min must be a number." });
  }
  if (
    (kind === "string" || kind === "number") &&
    definition.max !== undefined &&
    typeof definition.max !== "number"
  ) {
    issues.push({ path: [...path, "max"], message: "max must be a number." });
  }
  if (
    (kind === "string" || kind === "number") &&
    typeof definition.min === "number" &&
    typeof definition.max === "number" &&
    definition.min > definition.max
  ) {
    issues.push({
      path: [...path, "min"],
      message: "min cannot be greater than max."
    });
  }
  if (
    kind === "number" &&
    definition.int !== undefined &&
    typeof definition.int !== "boolean"
  ) {
    issues.push({ path: [...path, "int"], message: "int must be a boolean." });
  }
  if (
    kind === "uid" &&
    definition.targetField !== undefined &&
    typeof definition.targetField !== "string"
  ) {
    issues.push({
      path: [...path, "targetField"],
      message: "targetField must be a string."
    });
  }
  if (
    kind === "enum" &&
    (!Array.isArray(definition.values) ||
      definition.values.length === 0 ||
      definition.values.some(
        (value) => typeof value !== "string" || value.length === 0
      ))
  ) {
    issues.push({
      path: [...path, "values"],
      message: "Enum fields require at least one non-empty string value."
    });
  }
  if (
    kind === "enum" &&
    Array.isArray(definition.values) &&
    definition.values.every((value) => typeof value === "string") &&
    new Set(definition.values).size !== definition.values.length
  ) {
    issues.push({
      path: [...path, "values"],
      message: "Enum values must be unique."
    });
  }
  if (kind === "relation") {
    if (typeof definition.target !== "string" || !definition.target)
      issues.push({
        path: [...path, "target"],
        message: "Relation fields require a target collection."
      });
    if (!isRelationCardinality(definition.cardinality))
      issues.push({
        path: [...path, "cardinality"],
        message: "Relation fields require a supported cardinality."
      });
    if (definition.inverse !== undefined && typeof definition.inverse !== "string")
      issues.push({
        path: [...path, "inverse"],
        message: "inverse must be a string."
      });
    if (
      typeof definition.inverse === "string" &&
      definition.inverse &&
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(definition.inverse)
    ) {
      issues.push({
        path: [...path, "inverse"],
        message: "inverse must be a valid TypeScript identifier."
      });
    }
    if (
      definition.onDelete !== undefined &&
      definition.onDelete !== "cascade" &&
      definition.onDelete !== "restrict" &&
      definition.onDelete !== "set_null"
    ) {
      issues.push({
        path: [...path, "onDelete"],
        message: "onDelete must be cascade, restrict, or set_null."
      });
    }
  }
  if (
    kind === "media" &&
    definition.multiple !== undefined &&
    typeof definition.multiple !== "boolean"
  ) {
    issues.push({
      path: [...path, "multiple"],
      message: "multiple must be a boolean."
    });
  }
  return issues;
}

function validateCollectionOptions(
  options: Record<string, unknown>
): Array<{ path: Array<string | number>; message: string }> {
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  if (
    options.draftAndPublish !== undefined &&
    typeof options.draftAndPublish !== "boolean"
  ) {
    issues.push({
      path: ["options", "draftAndPublish"],
      message: "draftAndPublish must be a boolean."
    });
  }
  if (options.timestamps !== undefined && typeof options.timestamps !== "boolean") {
    issues.push({
      path: ["options", "timestamps"],
      message: "timestamps must be a boolean."
    });
  }
  if (options.i18n !== undefined) {
    const i18n = options.i18n as Record<string, unknown>;
    if (!i18n || typeof i18n !== "object" || Array.isArray(i18n)) {
      issues.push({
        path: ["options", "i18n"],
        message: "i18n must be an object."
      });
    } else {
      if (
        !Array.isArray(i18n.locales) ||
        i18n.locales.length === 0 ||
        i18n.locales.some((locale) => typeof locale !== "string")
      ) {
        issues.push({
          path: ["options", "i18n", "locales"],
          message: "i18n.locales must contain at least one locale string."
        });
      }
      if (typeof i18n.defaultLocale !== "string")
        issues.push({
          path: ["options", "i18n", "defaultLocale"],
          message: "i18n.defaultLocale is required."
        });
    }
  }
  return issues;
}

function isFieldKind(kind: string): kind is FieldDefinition["kind"] {
  return (
    kind === "string" ||
    kind === "text" ||
    kind === "richtext" ||
    kind === "number" ||
    kind === "boolean" ||
    kind === "datetime" ||
    kind === "date" ||
    kind === "time" ||
    kind === "json" ||
    kind === "email" ||
    kind === "url" ||
    kind === "password" ||
    kind === "uid" ||
    kind === "enum" ||
    kind === "media" ||
    kind === "relation"
  );
}

function isRelationCardinality(value: unknown): value is RelationCardinality {
  return (
    value === "one" ||
    value === "many" ||
    value === "one-to-one" ||
    value === "many-to-one" ||
    value === "one-to-many" ||
    value === "many-to-many"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validationResponse(
  issues: Array<{ path: Array<string | number>; message: string }>
): Response {
  return Response.json({ error: "validation_error", issues }, { status: 422 });
}
