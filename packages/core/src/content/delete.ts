import { isManyRelation, type CMSCollections, type ContentRecord, type DatabaseAdapter, type FieldDefinition } from "@hono-cms/schema";

export class RelationConstraintError extends Error {
  readonly code = "RELATION_CONSTRAINT";
  readonly status = 409;

  constructor(
    readonly collection: string,
    readonly field: string,
    readonly relatedCollection: string,
    readonly relatedIds: string[]
  ) {
    super(`Cannot delete this record: related records exist in "${relatedCollection}". Set onDelete: "cascade" on the relation to allow deletion.`);
  }
}

export type RelationDeleteResult = {
  affectedCollections: Set<string>;
};

export async function deleteWithRelationPolicy<Collections extends CMSCollections>(
  db: DatabaseAdapter<Collections>,
  collections: Collections,
  collectionName: keyof Collections & string,
  id: string,
  visited = new Set<string>()
): Promise<RelationDeleteResult> {
  const affectedCollections = new Set<string>([collectionName]);
  const key = `${collectionName}:${id}`;
  if (visited.has(key)) return { affectedCollections };
  visited.add(key);

  for (const relatedCollection of Object.values(collections)) {
    for (const [fieldName, field] of Object.entries(relatedCollection.fields)) {
      if (field.kind !== "relation" || field.target !== collectionName) continue;
      const references = await findReferencingRecords(db, relatedCollection.name as keyof Collections & string, fieldName, id);
      if (!references.length) continue;

      const onDelete = relationDeleteBehavior(field);
      if (onDelete === "restrict") {
        throw new RelationConstraintError(collectionName, fieldName, relatedCollection.name, references.map((record) => record.id));
      }

      affectedCollections.add(relatedCollection.name);
      if (onDelete === "set_null" || field.cardinality === "many-to-many") {
        await Promise.all(references.map((record) => db.update(
          relatedCollection.name as keyof Collections & string,
          record.id,
          nullRelationPatch(record, fieldName, field, id)
        )));
        continue;
      }

      for (const record of references) {
        const result = await deleteWithRelationPolicy(db, collections, relatedCollection.name as keyof Collections & string, record.id, visited);
        result.affectedCollections.forEach((collection) => affectedCollections.add(collection));
      }
    }
  }

  await db.delete(collectionName, id);
  return { affectedCollections };
}

async function findReferencingRecords<Collections extends CMSCollections>(
  db: DatabaseAdapter<Collections>,
  collectionName: keyof Collections & string,
  fieldName: string,
  id: string
): Promise<ContentRecord[]> {
  const matches: ContentRecord[] = [];
  let cursor: string | undefined;
  do {
    const result = await db.list(collectionName, cursor ? { cursor, limit: 100 } : { limit: 100 });
    matches.push(...result.items.filter((record) => relationIds(record, fieldName).includes(id)));
    cursor = result.nextCursor;
  } while (cursor);
  return matches;
}

function relationDeleteBehavior(field: Extract<FieldDefinition, { kind: "relation" }>): "cascade" | "restrict" | "set_null" {
  return field.onDelete ?? (field.cardinality === "many-to-many" ? "cascade" : "restrict");
}

function nullRelationPatch(record: ContentRecord, fieldName: string, field: Extract<FieldDefinition, { kind: "relation" }>, deletedId: string): Record<string, unknown> {
  if (isManyRelation(field)) {
    const ids = relationIds(record, fieldName).filter((id) => id !== deletedId);
    return { [fieldName]: ids, [`${fieldName}Id`]: ids };
  }
  return { [fieldName]: null, [`${fieldName}Id`]: null };
}

function relationIds(record: ContentRecord, fieldName: string): string[] {
  const explicitValue = record[`${fieldName}Id`];
  const value = explicitValue ?? record[fieldName];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}
