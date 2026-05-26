import { isManyRelation, type CMSCollections, type ContentRecord, type DatabaseAdapter, type PopulateMap } from "@hono-cms/schema";
import qs, { type ParsedQs } from "qs";
import { projectRecord } from "./projection";
import type { AuthSession } from "../types/providers";

export const MAX_POPULATE_DEPTH = 3;
export const MAX_POPULATE_NODES = 100;

export function parsePopulateParams(url: URL): PopulateMap | undefined {
  const parsed = qs.parse(url.searchParams.toString(), { depth: 10 });
  const parsedPopulate = parsed.populate;
  const populateValues = normalizePopulateList(parsedPopulate);
  const map: PopulateMap = {};

  if (populateValues.includes("*")) {
    return { "*": true };
  }

  for (const path of populateValues) {
    addPopulatePath(map, path.split("."), 0, []);
  }

  mergePopulateValue(map, parsedPopulate, 0);

  return Object.keys(map).length ? map : undefined;
}

function parseCSV(value: string | null | undefined): string[] {
  return value?.split(",").map((field) => field.trim()).filter(Boolean) ?? [];
}

function normalizePopulateList(value: unknown): string[] {
  if (typeof value === "string") return parseCSV(value);
  if (Array.isArray(value)) return value.flatMap((item) => normalizePopulateList(item));
  if (isParsedObject(value)) {
    return Object.entries(value).flatMap(([key, item]) => /^\d+$/.test(key) ? normalizePopulateList(item) : []);
  }
  return [];
}

function mergePopulateValue(map: PopulateMap, value: unknown, depth: number): void {
  if (Array.isArray(value)) {
    for (const item of value) mergePopulateValue(map, item, depth);
    return;
  }
  if (isParsedObject(value)) mergePopulateObject(map, value, depth);
}

function mergePopulateObject(map: PopulateMap, value: ParsedQs, depth: number): void {
  if (depth >= MAX_POPULATE_DEPTH) {
    warnPopulateDepth(Object.keys(value).filter((key) => !/^\d+$/.test(key) && key !== "fields"));
    return;
  }
  for (const [fieldName, node] of Object.entries(value)) {
    if (/^\d+$/.test(fieldName) || fieldName === "fields" || !isParsedObject(node)) continue;
    const current = map[fieldName];
    const currentNode = current && current !== true ? current : {};
    const nextNode = { ...currentNode };
    const fields = normalizePopulateFields(node.fields);
    if (fields.length) nextNode.fields = fields;
    if (isParsedObject(node.populate)) {
      const nested = nextNode.populate ?? {};
      mergePopulateObject(nested, node.populate, depth + 1);
      if (Object.keys(nested).length) nextNode.populate = nested;
    }
    map[fieldName] = Object.keys(nextNode).length ? nextNode : true;
  }
}

function normalizePopulateFields(value: unknown): string[] {
  if (typeof value === "string") return parseCSV(value);
  if (Array.isArray(value)) return value.flatMap((item) => normalizePopulateFields(item));
  if (isParsedObject(value)) return Object.values(value).flatMap((item) => normalizePopulateFields(item));
  return [];
}

function isParsedObject(value: unknown): value is ParsedQs {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function populateRecords<Collections extends CMSCollections>(
  adapter: DatabaseAdapter<Collections>,
  collections: Collections,
  collectionName: keyof Collections & string,
  records: ContentRecord[],
  populate: PopulateMap | undefined,
  options: { status?: "published"; session?: AuthSession | null } = {}
): Promise<ContentRecord[]> {
  if (!populate || records.length === 0) return records;
  const budget = { nodes: 0 };
  return Promise.all(records.map((record) => populateRecord(adapter, collections, collectionName, record, populate, 0, budget, options)));
}

async function populateRecord<Collections extends CMSCollections>(
  adapter: DatabaseAdapter<Collections>,
  collections: Collections,
  collectionName: keyof Collections & string,
  record: ContentRecord,
  populate: PopulateMap,
  depth: number,
  budget: { nodes: number },
  options: { status?: "published"; session?: AuthSession | null }
): Promise<ContentRecord> {
  if (depth >= MAX_POPULATE_DEPTH || budget.nodes >= MAX_POPULATE_NODES) return record;
  const collection = collections[collectionName];
  if (!collection) return record;
  const next: ContentRecord = { ...record };

  for (const [fieldName, field] of Object.entries(collection.fields)) {
    if (field.kind !== "relation") continue;
    const request = populate["*"] ?? populate[fieldName];
    if (!request) continue;

    const relationIds = readRelationIds(record, fieldName).slice(0, MAX_POPULATE_NODES - budget.nodes);
    if (relationIds.length === 0) continue;
    budget.nodes += relationIds.length;
    const targetName = field.target as keyof Collections & string;
    const children = adapter.findManyByIds
      ? await adapter.findManyByIds(targetName, relationIds)
      : await Promise.all(relationIds.map((id) => adapter.get(targetName, id)));
    const nestedPopulate = request === true ? undefined : request.populate;
    const visibleChildren = children.filter((child): child is ContentRecord => {
      if (!child) return false;
      return options.status !== "published" || !collections[targetName]?.options.draftAndPublish || child.status === "published";
    });
    const populatedChildren = await populateRecords(
      adapter,
      collections,
      targetName,
      visibleChildren,
      nestedPopulate,
      options,
    );

    const target = collections[targetName];
    const projected = target
      ? populatedChildren.map((child) => projectRecord(target, child, request === true ? undefined : request.fields, options.session ?? null))
      : populatedChildren;
    next[fieldName] = isManyRelation(field) ? projected : projected[0] ?? null;
  }

  return next;
}

function addPopulatePath(map: PopulateMap, parts: string[], depth: number, trail: string[]): void {
  const [head, ...tail] = parts;
  if (!head) return;
  if (depth >= MAX_POPULATE_DEPTH) {
    warnPopulateDepth([...trail, head]);
    return;
  }
  if (tail.length === 0) {
    map[head] = true;
    return;
  }
  const current = map[head];
  const node = current && current !== true ? current : {};
  const childMap = node.populate ?? {};
  addPopulatePath(childMap, tail, depth + 1, [...trail, head]);
  map[head] = { ...node, populate: childMap };
}

function warnPopulateDepth(path: string[]): void {
  if (path.length === 0) return;
  console.warn(`[hono-cms/populate] Populate depth is limited to ${MAX_POPULATE_DEPTH}; dropped "${path.join(".")}".`);
}

function readRelationIds(record: ContentRecord, fieldName: string): string[] {
  const relationValue = record[fieldName];
  const explicitValue = record[`${fieldName}Id`];
  const value = explicitValue ?? relationValue;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}
