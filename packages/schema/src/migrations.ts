import type { CMSCollections, CollectionOptions, FieldDefinition } from "./index";

export type CollectionSnapshot = {
  fields: Record<string, FieldDefinition>;
  options: CollectionOptions;
};

export type SchemaSnapshot = {
  collections: Record<string, CollectionSnapshot>;
  systemTables?: Record<string, SystemTableSnapshot>;
};

export type SchemaChange =
  | { type: "create_collection"; collection: string }
  | { type: "drop_collection"; collection: string }
  | { type: "alter_collection"; collection: string; before: CollectionOptions; after: CollectionOptions }
  | { type: "add_field"; collection: string; field: string; definition: FieldDefinition }
  | { type: "drop_field"; collection: string; field: string }
  | { type: "alter_field"; collection: string; field: string; before: FieldDefinition; after: FieldDefinition }
  | { type: "create_system_table"; table: string }
  | { type: "drop_system_table"; table: string }
  | { type: "alter_system_table"; table: string };

export type SchemaPlan = {
  empty: boolean;
  destructive: boolean;
  changes: SchemaChange[];
  snapshot: SchemaSnapshot;
};

export type SystemTableSnapshot = {
  name: string;
  fields: Record<string, unknown>;
};

export type CreateSchemaSnapshotOptions = {
  systemTables?: Record<string, SystemTableSnapshot>;
};

export function createSchemaSnapshot(collections: CMSCollections, options: CreateSchemaSnapshotOptions = {}): SchemaSnapshot {
  const snapshot: SchemaSnapshot = {
    collections: Object.fromEntries(Object.values(collections)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((collection) => [
        collection.name,
        {
          fields: Object.fromEntries(Object.entries(collection.fields).sort(([a], [b]) => a.localeCompare(b))),
          options: normalizeCollectionOptions(collection.options)
        }
      ]))
  };
  const systemTables = normalizeSystemTables(options.systemTables);
  if (Object.keys(systemTables).length > 0) snapshot.systemTables = systemTables;
  return snapshot;
}

export function planSchemaMigration(previous: SchemaSnapshot | null, collections: CMSCollections, options: CreateSchemaSnapshotOptions = {}): SchemaPlan {
  const next = createSchemaSnapshot(collections, options);
  const changes: SchemaChange[] = [];
  const before = normalizeSnapshot(previous);
  const beforeCollections = before?.collections ?? {};
  const beforeSystemTables = before?.systemTables ?? {};
  const nextSystemTables = next.systemTables ?? {};

  for (const collection of Object.keys(next.collections)) {
    if (!beforeCollections[collection]) {
      changes.push({ type: "create_collection", collection });
    }
  }

  for (const collection of Object.keys(beforeCollections)) {
    if (!next.collections[collection]) {
      changes.push({ type: "drop_collection", collection });
    }
  }

  for (const [collection, snapshot] of Object.entries(next.collections)) {
    const beforeSnapshot = beforeCollections[collection];
    const beforeFields = beforeSnapshot?.fields ?? {};
    const fields = snapshot.fields;
    if (beforeSnapshot && stableStringify(beforeSnapshot.options) !== stableStringify(snapshot.options)) {
      changes.push({ type: "alter_collection", collection, before: beforeSnapshot.options, after: snapshot.options });
    }
    for (const [field, definition] of Object.entries(fields)) {
      if (!beforeFields[field]) {
        changes.push({ type: "add_field", collection, field, definition });
      } else if (stableStringify(beforeFields[field]) !== stableStringify(definition)) {
        changes.push({ type: "alter_field", collection, field, before: beforeFields[field], after: definition });
      }
    }
    for (const field of Object.keys(beforeFields)) {
      if (!fields[field]) {
        changes.push({ type: "drop_field", collection, field });
      }
    }
  }

  for (const table of Object.keys(nextSystemTables)) {
    if (!beforeSystemTables[table]) {
      changes.push({ type: "create_system_table", table });
    } else if (stableStringify(beforeSystemTables[table]) !== stableStringify(nextSystemTables[table])) {
      changes.push({ type: "alter_system_table", table });
    }
  }

  for (const table of Object.keys(beforeSystemTables)) {
    if (!nextSystemTables[table]) changes.push({ type: "drop_system_table", table });
  }

  return {
    empty: changes.length === 0,
    destructive: changes.some((change) => change.type === "drop_collection" || change.type === "drop_field" || change.type === "alter_field" || change.type === "drop_system_table"),
    changes,
    snapshot: next
  };
}

export function formatSchemaPlan(plan: SchemaPlan): string {
  if (plan.empty) return "Schema is up to date.";
  return plan.changes.map((change) => {
    switch (change.type) {
      case "create_collection":
        return `+ collection ${change.collection}`;
      case "drop_collection":
        return `- collection ${change.collection}`;
      case "alter_collection":
        return `~ collection ${change.collection} options`;
      case "add_field":
        return `+ field ${change.collection}.${change.field}`;
      case "drop_field":
        return `- field ${change.collection}.${change.field}`;
      case "alter_field":
        return `~ field ${change.collection}.${change.field}`;
      case "create_system_table":
        return `+ system table ${change.table}`;
      case "drop_system_table":
        return `- system table ${change.table}`;
      case "alter_system_table":
        return `~ system table ${change.table}`;
    }
  }).join("\n");
}

function normalizeSnapshot(snapshot: SchemaSnapshot | null): SchemaSnapshot | null {
  if (!snapshot) return null;
  const rawCollections = snapshot.collections as Record<string, unknown>;
  const normalized: SchemaSnapshot = {
    collections: Object.fromEntries(Object.entries(rawCollections).map(([collection, value]): [string, CollectionSnapshot] => {
      if (isCollectionSnapshot(value)) {
        return [collection, {
          fields: sortFields(value.fields),
          options: normalizeCollectionOptions(value.options)
        }];
      }
      return [collection, {
        fields: sortFields(value as Record<string, FieldDefinition>),
        options: {}
      }];
    }))
  };
  const systemTables = normalizeSystemTables((snapshot as { systemTables?: Record<string, SystemTableSnapshot> }).systemTables);
  if (Object.keys(systemTables).length > 0) normalized.systemTables = systemTables;
  return normalized;
}

function isCollectionSnapshot(value: unknown): value is CollectionSnapshot {
  return typeof value === "object" && value !== null && "fields" in value && "options" in value;
}

function sortFields(fields: Record<string, FieldDefinition>): Record<string, FieldDefinition> {
  return Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))) as Record<string, FieldDefinition>;
}

function normalizeCollectionOptions(options: CollectionOptions = {}): CollectionOptions {
  const normalized: CollectionOptions = {};
  if (options.draftAndPublish !== undefined) normalized.draftAndPublish = options.draftAndPublish;
  if (options.timestamps !== undefined) normalized.timestamps = options.timestamps;
  if (options.i18n) {
    normalized.i18n = {
      locales: [...options.i18n.locales].sort() as [string, ...string[]],
      defaultLocale: options.i18n.defaultLocale
    };
  }
  if (options.rbac) {
    normalized.rbac = Object.fromEntries(
      Object.entries(options.rbac).map(([audience, actions]) => [audience, [...actions].sort()])
    ) as NonNullable<CollectionOptions["rbac"]>;
  }
  return normalized;
}

function normalizeSystemTables(tables: Record<string, SystemTableSnapshot> = {}): Record<string, SystemTableSnapshot> {
  return Object.fromEntries(Object.entries(tables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, table]) => [
      key,
      {
        name: table.name,
        fields: Object.fromEntries(Object.entries(table.fields).sort(([left], [right]) => left.localeCompare(right)))
      }
    ]));
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
