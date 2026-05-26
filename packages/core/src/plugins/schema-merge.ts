import type { CMSCollections } from "@hono-cms/schema";
import { assertNoReservedSystemTableConflicts, type SystemTableSnapshot } from "@hono-cms/schema";
import {
  CMSPluginError,
  type FieldDef,
  type Plugin,
  type PluginTableDef
} from "./types";

export type MergedSystemTables = ReadonlyMap<string, PluginTableDef>;

export function mergeSchemas<Collections extends CMSCollections>(
  plugins: readonly Plugin<Collections>[]
): MergedSystemTables {
  const merged = new Map<string, PluginTableDef>();
  const owners = new Map<string, string>();
  const modelNames = new Map<string, string>();

  for (const plugin of plugins) {
    if (!plugin.schema) continue;
    for (const [tableName, definition] of Object.entries(plugin.schema)) {
      if (merged.has(tableName)) {
        const prior = owners.get(tableName);
        throw new CMSPluginError(
          `Plugin "${plugin.id}" declares schema table "${tableName}" which is already declared by plugin "${prior}".`
        );
      }
      if (definition.modelName) {
        const priorModel = modelNames.get(definition.modelName);
        if (priorModel) {
          throw new CMSPluginError(
            `Plugin "${plugin.id}" declares modelName "${definition.modelName}" which is already used by plugin "${priorModel}".`
          );
        }
        modelNames.set(definition.modelName, plugin.id);
      }
      merged.set(tableName, definition);
      owners.set(tableName, plugin.id);
    }
  }

  return merged;
}

export function toSystemTablesSnapshot(merged: MergedSystemTables): Record<string, SystemTableSnapshot> {
  const out: Record<string, SystemTableSnapshot> = {};
  for (const [tableName, def] of merged.entries()) {
    const snapshot: SystemTableSnapshot = {
      name: tableName,
      fields: serializeFields(def.fields)
    };
    if (def.disableMigration) snapshot.disableMigration = true;
    out[tableName] = snapshot;
  }
  return out;
}

export function assertNoCollectionConflicts<Collections extends CMSCollections>(
  collections: Collections,
  merged: MergedSystemTables
): void {
  const snapshot = toSystemTablesSnapshot(merged);
  assertNoReservedSystemTableConflicts(collections, snapshot);
}

function serializeFields(fields: Record<string, FieldDef>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(fields)) {
    out[name] = {
      type: def.type,
      ...(def.required ? { required: true } : {}),
      ...(def.unique ? { unique: true } : {}),
      ...(def.references ? { references: def.references } : {})
    };
  }
  return out;
}
