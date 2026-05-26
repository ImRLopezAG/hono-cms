import type { CollectionDefinition, ContentRecord, FieldsDefinition } from "@hono-cms/schema";
import type { AuthSession } from "../types/providers";

const SYSTEM_FIELDS = ["id", "createdAt", "updatedAt"] as const;
const OPTIONAL_SYSTEM_FIELDS = ["status", "publishedAt", "scheduledAt", "locale"] as const;

export function projectRecord(
  collection: CollectionDefinition<string, FieldsDefinition>,
  record: ContentRecord,
  fields?: readonly string[],
  session: AuthSession | null = null
): ContentRecord {
  const selected = fields?.length ? new Set(fields) : null;
  const projected: ContentRecord = {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };

  for (const field of OPTIONAL_SYSTEM_FIELDS) {
    if (field in record && (!selected || selected.has(field))) {
      (projected as Record<string, unknown>)[field] = record[field];
    }
  }

  for (const [name, definition] of Object.entries(collection.fields)) {
    if (definition.private) continue;
    if (!canReadField(definition, session)) continue;
    if (selected && !selected.has(name)) continue;
    if (name in record) projected[name] = record[name];
  }

  for (const key of Object.keys(record)) {
    if (SYSTEM_FIELDS.includes(key as (typeof SYSTEM_FIELDS)[number])) continue;
    if (OPTIONAL_SYSTEM_FIELDS.includes(key as (typeof OPTIONAL_SYSTEM_FIELDS)[number])) continue;
    if (key in collection.fields) continue;
    if (selected && !selected.has(key)) continue;
    projected[key] = record[key];
  }

  return projected;
}

export function projectRecords(
  collection: CollectionDefinition<string, FieldsDefinition>,
  records: readonly ContentRecord[],
  fields?: readonly string[],
  session: AuthSession | null = null
): ContentRecord[] {
  return records.map((record) => projectRecord(collection, record, fields, session));
}

export function forbiddenWriteFields(
  collection: CollectionDefinition<string, FieldsDefinition>,
  input: Record<string, unknown>,
  session: AuthSession | null
): string[] {
  return Object.keys(input).filter((fieldName) => {
    const field = collection.fields[fieldName];
    return field ? !canWriteField(field, session) : false;
  });
}

function canReadField(field: FieldsDefinition[string], session: AuthSession | null): boolean {
  return audienceAllows(field.permissions?.read, session);
}

function canWriteField(field: FieldsDefinition[string], session: AuthSession | null): boolean {
  return audienceAllows(field.permissions?.write, session);
}

function audienceAllows(audiences: readonly string[] | undefined, session: AuthSession | null): boolean {
  if (!audiences?.length) return true;
  if (audiences.includes("public")) return true;
  if (!session) return false;
  if (session.roles.includes("admin")) return true;
  if (audiences.includes("authenticated")) return true;
  return audiences.some((audience) => session.roles.includes(audience));
}
