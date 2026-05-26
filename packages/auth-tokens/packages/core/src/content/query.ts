import { isManyRelation, type CMSCollections, type CollectionDefinition, type DatabaseAdapter, type FieldDefinition, type FieldsDefinition, type PopulateMap } from "@hono-cms/schema";
import qs, { type ParsedQs } from "qs";
import type { ContentRecord, ContentStatus, ListQuery } from "../types/providers";
import { parsePopulateParams } from "./populate";

const SYSTEM_FIELDS = new Set(["id", "createdAt", "updatedAt", "status", "publishedAt", "scheduledAt", "locale"]);
const VALID_OPERATORS = new Set(["$eq", "$ne", "$contains", "$notContains", "$startsWith", "$endsWith", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$null", "$notNull", "$between"]);
const MAX_FILTER_NODES = 25;
const MAX_IN_VALUES = 100;
const MAX_SORT_FIELDS = 3;
const MAX_FIELD_SELECTIONS = 50;

type SortSpec = {
  field: string;
  direction: "asc" | "desc";
};

export type QueryValidationIssue = {
  path: string[];
  message: string;
};

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor");
  }
}

type QueryValidationOptions = {
  fields?: boolean;
  filters?: boolean;
  sort?: boolean;
  populate?: boolean;
};

export type RelationFilter = {
  fieldName: string;
  targetName: string;
  many: boolean;
  filters: Record<string, unknown>;
};

export function parseQueryParams(url: URL): ListQuery {
  const parsed = qs.parse(url.searchParams.toString());
  const filters = normalizeFilters(firstObject(parsed.filters, parsed.filter));
  const pagination = firstObject(parsed.pagination);
  const pageSize = toPositiveInteger(firstScalar(pagination?.pageSize, parsed.pageSize));
  const limitValue = pageSize ?? toPositiveInteger(firstScalar(pagination?.limit, parsed.limit)) ?? 25;
  const page = toPositiveInteger(firstScalar(pagination?.page, parsed.page));
  const status = firstScalar(parsed.status) as ContentStatus | null;

  const query: ListQuery = {
    filters,
    limit: Math.min(Math.max(limitValue, 1), 100)
  };
  const cursor = firstScalar(pagination?.cursor, parsed.cursor);
  const sortValues = normalizeListParam(parsed.sort);
  const sort = sortValues.length ? sortValues.join(",") : csvOrArrayParam(url, "sort");
  const locale = firstScalar(parsed.locale);
  const fallback = booleanQueryParam(firstScalar(parsed.fallback));
  const fields = normalizeListParam(parsed.fields);
  if (cursor) {
    const decoded = decodeCursor(cursor);
    query.cursor = decoded.id;
    query.cursorCreatedAt = decoded.createdAt;
  }
  if (page) query.page = page;
  if (pageSize) query.pageSize = Math.min(Math.max(pageSize, 1), 100);
  if (sort) query.sort = sort;
  if (status) query.status = status;
  if (locale) query.locale = locale;
  if (fallback !== undefined) query.fallback = fallback;
  if (fields.length) query.fields = fields;
  const populate = parsePopulateParams(url);
  if (populate) query.populate = populate;
  return query;
}

function booleanQueryParam(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  return undefined;
}

export function applyListQuery(records: ContentRecord[], query: ListQuery = {}): { items: ContentRecord[]; nextCursor?: string; total?: number } {
  const limit = query.limit ?? 25;
  let rows = [...records];

  if (query.status) rows = rows.filter((record) => record.status === query.status);
  if (query.locale) rows = rows.filter((record) => record.locale === query.locale);

  for (const [key, value] of Object.entries(query.filters ?? {})) {
    rows = rows.filter((record) => matchesFilter(record[key], value));
  }

  if (query.sort) {
    for (const sort of parseSortSpecs(query.sort).reverse()) {
      rows.sort((a, b) => String(a[sort.field] ?? "").localeCompare(String(b[sort.field] ?? "")) * (sort.direction === "desc" ? -1 : 1));
    }
  } else {
    rows.sort(compareDefaultCursorOrder);
  }

  const cursor = query.cursor ? cursorRecord(query.cursor, query.cursorCreatedAt) : null;
  const start = cursor ? cursorStart(rows, cursor) : offsetStart(query, limit);
  const items = rows.slice(start, start + limit);
  const last = items.at(-1);
  const result = start + limit < rows.length && last ? { items, nextCursor: encodeCursor(last) } : { items };
  return query.page || query.pageSize ? { ...result, total: rows.length } : result;
}

function offsetStart(query: ListQuery, limit: number): number {
  const page = query.page ?? 1;
  return Math.max(page - 1, 0) * limit;
}

export function encodeCursor(record: Pick<ContentRecord, "id"> & { createdAt?: unknown }): string {
  const payload = JSON.stringify({ id: record.id, createdAt: typeof record.createdAt === "string" ? record.createdAt : "" });
  return bytesToBase64Url(new TextEncoder().encode(payload));
}

export function decodeCursor(token: string): { id: string; createdAt: string } {
  try {
    const decoded = new TextDecoder().decode(base64UrlToBytes(token));
    const parsed = JSON.parse(decoded) as { id?: unknown; createdAt?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.createdAt !== "string") throw new InvalidCursorError();
    return { id: parsed.id, createdAt: parsed.createdAt };
  } catch (error) {
    if (error instanceof InvalidCursorError) throw error;
    throw new InvalidCursorError();
  }
}

export function publicListResult(result: { items: ContentRecord[]; nextCursor?: string; total?: number }): { items: ContentRecord[]; nextCursor?: string; total?: number } {
  const last = result.items.at(-1);
  return result.nextCursor && last ? { ...result, nextCursor: encodeCursor(last) } : result;
}

function cursorRecord(cursor: string, createdAt?: string): { id: string; createdAt?: string } {
  if (createdAt) return { id: cursor, createdAt };
  try {
    return decodeCursor(cursor);
  } catch {
    return { id: cursor };
  }
}

function cursorStart(rows: ContentRecord[], cursor: { id: string; createdAt?: string }): number {
  if (cursor.createdAt) {
    const exactIndex = rows.findIndex((record) => record.id === cursor.id && record.createdAt === cursor.createdAt);
    if (exactIndex >= 0) return exactIndex + 1;
  }
  return Math.max(rows.findIndex((record) => record.id === cursor.id) + 1, 0);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function validateQueryParams<Collections extends CMSCollections>(
  collections: Collections,
  collectionName: keyof Collections & string,
  query: ListQuery,
  options: QueryValidationOptions = {}
): QueryValidationIssue[] {
  const collection = collections[collectionName];
  if (!collection) return [{ path: ["collection"], message: `Unknown collection "${collectionName}"` }];

  const checks = {
    fields: options.fields ?? true,
    filters: options.filters ?? true,
    sort: options.sort ?? true,
    populate: options.populate ?? true
  };
  const issues: QueryValidationIssue[] = [];

  if (checks.fields) {
    for (const field of query.fields ?? []) {
      validateSelectableField(collection, field, ["fields"], issues);
    }
  }

  if (checks.filters) {
    const complexityIssues = validateFilterComplexity(query.filters ?? {});
    issues.push(...complexityIssues);
    if (!complexityIssues.length) {
      for (const [field, filter] of Object.entries(query.filters ?? {})) {
        const definition = validateQueryableField(collection, field, ["filter", field], issues);
        if (definition?.kind === "relation" && isNestedRelationFilter(filter)) {
          validateNestedRelationFilter(collections, definition, field, filter, issues);
        } else {
          validateFilterOperators(field, filter, issues);
        }
      }
    }
  }

  if (checks.sort && query.sort) {
    const sortSpecs = parseSortSpecs(query.sort);
    if (sortSpecs.length > MAX_SORT_FIELDS) {
      issues.push({ path: ["sort"], message: `Sort is limited to ${MAX_SORT_FIELDS} fields` });
    }
    for (const sort of sortSpecs) {
      if (!sort.field) {
        issues.push({ path: ["sort"], message: "Sort field must be non-empty" });
        continue;
      }
      validateQueryableField(collection, sort.field, ["sort"], issues);
    }
  }

  if ((query.fields?.length ?? 0) > MAX_FIELD_SELECTIONS) {
    issues.push({ path: ["fields"], message: `Field selection is limited to ${MAX_FIELD_SELECTIONS} fields` });
  }

  if (checks.populate && query.populate) {
    validatePopulateMap(collections, collection, query.populate, ["populate"], issues);
  }

  return issues;
}

export function splitRelationFilters<Collections extends CMSCollections>(
  collections: Collections,
  collectionName: keyof Collections & string,
  filters: Record<string, unknown> = {}
): { directFilters: Record<string, unknown>; relationFilters: RelationFilter[] } {
  const collection = collections[collectionName];
  const directFilters: Record<string, unknown> = {};
  const relationFilters: RelationFilter[] = [];
  if (!collection) return { directFilters: filters, relationFilters };
  for (const [fieldName, filter] of Object.entries(filters)) {
    const field = collection.fields[fieldName];
    if (field?.kind === "relation" && isNestedRelationFilter(filter)) {
      relationFilters.push({
        fieldName,
        targetName: field.target,
        many: isManyRelation(field),
        filters: filter as Record<string, unknown>
      });
    } else {
      directFilters[fieldName] = filter;
    }
  }
  return { directFilters, relationFilters };
}

export async function filterRecordsByRelations<Collections extends CMSCollections>(
  adapter: DatabaseAdapter<Collections>,
  collections: Collections,
  records: ContentRecord[],
  relationFilters: readonly RelationFilter[],
  options: { status?: "published" } = {}
): Promise<ContentRecord[]> {
  if (relationFilters.length === 0 || records.length === 0) return records;
  const result: ContentRecord[] = [];
  for (const record of records) {
    if (await recordMatchesRelationFilters(adapter, collections, record, relationFilters, options)) {
      result.push(record);
    }
  }
  return result;
}

export function recordMatchesFilters(record: ContentRecord, filters: Record<string, unknown> = {}): boolean {
  return Object.entries(filters).every(([key, value]) => matchesFilter(record[key], value));
}

function matchesFilter(value: unknown, filter: unknown): boolean {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return value === filter;
  return Object.entries(filter).every(([operator, expected]) => {
    switch (operator) {
      case "$eq":
        return value === expected;
      case "$ne":
        return value !== expected;
      case "$contains":
        return String(value ?? "").includes(String(expected));
      case "$notContains":
        return !String(value ?? "").includes(String(expected));
      case "$startsWith":
        return String(value ?? "").startsWith(String(expected));
      case "$endsWith":
        return String(value ?? "").endsWith(String(expected));
      case "$gt":
        return compareValues(value, expected) > 0;
      case "$gte":
        return compareValues(value, expected) >= 0;
      case "$lt":
        return compareValues(value, expected) < 0;
      case "$lte":
        return compareValues(value, expected) <= 0;
      case "$in":
        return Array.isArray(expected) && expected.includes(value);
      case "$nin":
        return Array.isArray(expected) && !expected.includes(value);
      case "$null":
        return Boolean(expected) ? value === null || value === undefined : value !== null && value !== undefined;
      case "$notNull":
        return Boolean(expected) ? value !== null && value !== undefined : value === null || value === undefined;
      case "$between":
        return Array.isArray(expected) && expected.length >= 2 && compareValues(value, expected[0]) >= 0 && compareValues(value, expected[1]) <= 0;
      default:
        return false;
    }
  });
}

async function recordMatchesRelationFilters<Collections extends CMSCollections>(
  adapter: DatabaseAdapter<Collections>,
  collections: Collections,
  record: ContentRecord,
  relationFilters: readonly RelationFilter[],
  options: { status?: "published" }
): Promise<boolean> {
  for (const relationFilter of relationFilters) {
    const ids = readRelationIds(record, relationFilter.fieldName);
    if (ids.length === 0) return false;
    const children = adapter.findManyByIds
      ? await adapter.findManyByIds(relationFilter.targetName as keyof Collections & string, ids)
      : await Promise.all(ids.map((id) => adapter.get(relationFilter.targetName as keyof Collections & string, id)));
    const target = collections[relationFilter.targetName as keyof Collections & string];
    const matches = children.filter((child): child is ContentRecord => {
      if (!child) return false;
      if (options.status === "published" && target?.options.draftAndPublish && child.status !== "published") return false;
      return recordMatchesFilters(child, relationFilter.filters);
    });
    if (relationFilter.many ? matches.length === 0 : !matches[0]) return false;
  }
  return true;
}

function readRelationIds(record: ContentRecord, fieldName: string): string[] {
  const relationValue = record[fieldName];
  const explicitValue = record[`${fieldName}Id`];
  const value = explicitValue ?? relationValue;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

function compareValues(value: unknown, expected: unknown): number {
  const valueNumber = Number(value);
  const expectedNumber = Number(expected);
  if (Number.isFinite(valueNumber) && Number.isFinite(expectedNumber)) return valueNumber - expectedNumber;
  return String(value ?? "").localeCompare(String(expected ?? ""));
}

function compareDefaultCursorOrder(left: ContentRecord, right: ContentRecord): number {
  const createdAt = String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""));
  return createdAt || left.id.localeCompare(right.id);
}

function coerce(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

function parseCSV(value: string | null): string[] {
  return value?.split(",").map((field) => field.trim()).filter(Boolean) ?? [];
}

function firstParam(url: URL, ...names: string[]): string | null {
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value) return value;
  }
  return null;
}

function parseParamList(url: URL, name: string): string[] {
  return [
    ...parseCSV(url.searchParams.get(name)),
    ...url.searchParams.getAll(`${name}[]`).flatMap((value) => parseCSV(value))
  ];
}

function csvOrArrayParam(url: URL, name: string): string | null {
  const values = parseParamList(url, name);
  return values.length ? values.join(",") : null;
}

function normalizeListParam(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => normalizeListParam(item));
  if (typeof value === "string") return parseCSV(value);
  if (isParsedObject(value)) return Object.values(value).flatMap((item) => normalizeListParam(item));
  return [];
}

function normalizeFilters(input: ParsedQs | undefined): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  if (!input) return filters;
  for (const [field, value] of Object.entries(input)) {
    filters[field] = normalizeFilterValue(value);
  }
  return filters;
}

function normalizeFilterValue(value: unknown): unknown {
  if (isParsedObject(value)) {
    const operators: Record<string, unknown> = {};
    for (const [operator, operatorValue] of Object.entries(value)) {
      operators[operator] = VALID_OPERATORS.has(operator)
        ? normalizeOperatorValue(operator, operatorValue)
        : normalizeFilterValue(operatorValue);
    }
    return operators;
  }
  return normalizeScalarValue(value);
}

function normalizeOperatorValue(operator: string, value: unknown): unknown {
  if (operator !== "$in" && operator !== "$nin" && operator !== "$between") return normalizeScalarValue(value);
  return normalizeArrayValue(value);
}

function normalizeArrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => normalizeArrayValue(item));
  const scalar = firstScalar(value);
  if (scalar === null) return [];
  return parseCSV(scalar).map(coerce);
}

function normalizeScalarValue(value: unknown): unknown {
  const scalar = firstScalar(value);
  return scalar === null ? undefined : coerce(scalar);
}

function firstObject(...values: unknown[]): ParsedQs | undefined {
  for (const value of values) {
    if (isParsedObject(value)) return value;
  }
  return undefined;
}

function firstScalar(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const nested = firstScalar(...value);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function toPositiveInteger(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isParsedObject(value: unknown): value is ParsedQs {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseSortFields(sort: string): string[] {
  return parseCSV(sort).map((field) => field.trim()).filter(Boolean);
}

function parseSortSpecs(sort: string): SortSpec[] {
  return parseSortFields(sort).map((field): SortSpec => {
    if (field.startsWith("-")) return { field: field.slice(1), direction: "desc" };
    const [name, direction] = field.split(":");
    if (direction === "desc") return { field: name ?? "", direction: "desc" };
    return { field: name ?? "", direction: "asc" };
  });
}

function validateFilterComplexity(filters: Record<string, unknown>): QueryValidationIssue[] {
  const issues: QueryValidationIssue[] = [];
  const filterCount = Object.keys(filters).length;
  if (filterCount > MAX_FILTER_NODES) {
    issues.push({ path: ["filter"], message: `Filters are limited to ${MAX_FILTER_NODES} fields` });
  }
  const nodeCount = filterNodeCount(filters);
  if (filterCount <= MAX_FILTER_NODES && nodeCount > MAX_FILTER_NODES) {
    issues.push({ path: ["filter"], message: `Filter complexity is limited to ${MAX_FILTER_NODES} nodes` });
  }
  return issues;
}

function filterNodeCount(filters: Record<string, unknown>): number {
  let count = 0;
  for (const filter of Object.values(filters)) {
    count += 1 + filterOperatorCount(filter);
  }
  return count;
}

function filterOperatorCount(filter: unknown): number {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return 0;
  return Object.keys(filter).length;
}

function validateFilterOperators(field: string, filter: unknown, issues: QueryValidationIssue[]): void {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return;
  for (const [operator, value] of Object.entries(filter)) {
    if (!VALID_OPERATORS.has(operator)) {
      issues.push({ path: ["filter", field, operator], message: `Unknown filter operator "${operator}"` });
      continue;
    }
    if ((operator === "$in" || operator === "$nin") && Array.isArray(value) && value.length > MAX_IN_VALUES) {
      issues.push({ path: ["filter", field, operator], message: `${operator} filters are limited to ${MAX_IN_VALUES} values` });
    }
    if (operator === "$between" && (!Array.isArray(value) || value.length !== 2)) {
      issues.push({ path: ["filter", field, "$between"], message: "$between filters require exactly 2 values" });
    }
  }
}

function validateSelectableField(
  collection: CollectionDefinition<string, FieldsDefinition>,
  fieldName: string,
  path: string[],
  issues: QueryValidationIssue[]
): void {
  if (SYSTEM_FIELDS.has(fieldName)) return;
  const field = collection.fields[fieldName];
  if (!field) {
    issues.push({ path: [...path, fieldName], message: `Unknown field "${fieldName}"` });
    return;
  }
  if (field.private) {
    issues.push({ path: [...path, fieldName], message: `Field "${fieldName}" is private` });
  }
}

function validateQueryableField(
  collection: CollectionDefinition<string, FieldsDefinition>,
  fieldName: string,
  path: string[],
  issues: QueryValidationIssue[]
): FieldDefinition | null {
  if (SYSTEM_FIELDS.has(fieldName)) return null;
  const field = collection.fields[fieldName];
  if (!field) {
    issues.push({ path, message: `Unknown field "${fieldName}"` });
    return null;
  }
  if (field.private) {
    issues.push({ path, message: `Field "${fieldName}" is private` });
    return null;
  }
  return field;
}

function validateNestedRelationFilter<Collections extends CMSCollections>(
  collections: Collections,
  field: Extract<FieldDefinition, { kind: "relation" }>,
  fieldName: string,
  filter: unknown,
  issues: QueryValidationIssue[]
): void {
  const target = collections[field.target as keyof Collections & string];
  if (!target) {
    issues.push({ path: ["filter", fieldName], message: `Unknown relation target "${field.target}"` });
    return;
  }
  for (const [targetField, targetFilter] of Object.entries(filter as Record<string, unknown>)) {
    validateQueryableField(target, targetField, ["filter", fieldName, targetField], issues);
    validateFilterOperators(targetField, targetFilter, issues);
  }
}

function isNestedRelationFilter(filter: unknown): boolean {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return false;
  return Object.keys(filter).some((key) => !VALID_OPERATORS.has(key));
}

function validatePopulateMap<Collections extends CMSCollections>(
  collections: Collections,
  collection: CollectionDefinition<string, FieldsDefinition>,
  populate: PopulateMap,
  path: string[],
  issues: QueryValidationIssue[]
): void {
  for (const [fieldName, node] of Object.entries(populate)) {
    if (fieldName === "*") continue;
    const field = collection.fields[fieldName];
    if (!field) {
      issues.push({ path: [...path, fieldName], message: `Unknown relation "${fieldName}"` });
      continue;
    }
    if (field.kind === "component" || field.kind === "dynamiczone") {
      // Components and dynamic zones are always populated since they are embedded JSON.
      // Accept the populate key but skip nested validation.
      continue;
    }
    if (field.kind !== "relation") {
      issues.push({ path: [...path, fieldName], message: `Field "${fieldName}" is not a relation` });
      continue;
    }
    const target = collections[field.target as keyof Collections & string];
    if (!target) {
      issues.push({ path: [...path, fieldName], message: `Unknown relation target "${field.target}"` });
      continue;
    }
    if (node === true) continue;
    for (const nestedField of node.fields ?? []) {
      validateSelectableField(target, nestedField, [...path, fieldName, "fields"], issues);
    }
    if (node.populate) validatePopulateMap(collections, target, node.populate, [...path, fieldName, "populate"], issues);
  }
}
