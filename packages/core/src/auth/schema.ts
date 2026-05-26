import { getAuthTables, type BetterAuthDBSchema, type DBFieldAttribute } from "better-auth/db";
import type { AuthConfig } from "./better-auth";

export type AuthTableFieldSnapshot = {
  type: string;
  required: boolean;
  index: boolean;
  references?: string;
};

export type AuthTableSnapshot = {
  name: string;
  fields: Record<string, AuthTableFieldSnapshot>;
};

export type AuthSchemaSnapshot = Record<string, AuthTableSnapshot>;

export function getAuthSchema(config: AuthConfig = {}): BetterAuthDBSchema {
  return getAuthTables(config);
}

export function createAuthSchemaSnapshot(config: AuthConfig = {}): AuthSchemaSnapshot {
  return authTablesToSnapshot(getAuthSchema(config));
}

export function authTablesToSnapshot(schema: BetterAuthDBSchema): AuthSchemaSnapshot {
  return Object.fromEntries(Object.entries(schema)
    .filter(([, table]) => table.disableMigrations !== true)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, table]) => [
      `auth:${key}`,
      {
        name: table.modelName,
        fields: Object.fromEntries(Object.entries(table.fields)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([fieldName, field]) => [fieldName, authFieldToSnapshot(field)]))
      }
    ]));
}

function authFieldToSnapshot(field: DBFieldAttribute): AuthTableFieldSnapshot {
  const snapshot: AuthTableFieldSnapshot = {
    type: Array.isArray(field.type) ? field.type.join("|") : field.type,
    required: field.required !== false,
    index: field.index === true
  };
  if (field.references?.model) snapshot.references = field.references.model;
  return snapshot;
}
