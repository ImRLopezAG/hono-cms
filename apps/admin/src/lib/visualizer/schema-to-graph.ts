import type { AdminSchemaMetadata } from "../api-client";
import type {
  AreaNode,
  CollectionNode,
  GraphResult,
  NoteNode,
  RelationEdge,
  WorkspaceLayout
} from "./types";
import {
  COLLECTION_MINIMIZED_FIELDS,
  COLLECTION_NODE_FOOTER_HEIGHT,
  COLLECTION_NODE_HEADER_HEIGHT,
  COLLECTION_NODE_ROW_HEIGHT,
  fieldCardinality,
  fieldRelationTarget
} from "./types";

/** Estimate a collection node's initial height based on field count (for ReactFlow measurement hint). */
function estimateNodeHeight(fieldCount: number): number {
  const rows = Math.min(fieldCount, COLLECTION_MINIMIZED_FIELDS);
  return COLLECTION_NODE_HEADER_HEIGHT + rows * COLLECTION_NODE_ROW_HEIGHT + COLLECTION_NODE_FOOTER_HEIGHT;
}

/**
 * Convert the admin-schema snapshot plus the persisted layout atom into
 * ReactFlow nodes and edges.
 *
 * Three categories of nodes are emitted, in this order so xyflow
 * z-stacks correctly: areas → notes → collections (collections render
 * on top because we want them clickable above area backdrops).
 */
export function schemaToGraph(
  schema: AdminSchemaMetadata,
  layout?: WorkspaceLayout
): GraphResult {
  const collections = Object.values(schema.collections).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  const areaNodes: AreaNode[] = [];
  if (layout?.areas) {
    for (const area of Object.values(layout.areas)) {
      areaNodes.push({
        id: `area:${area.id}`,
        type: "area",
        position: { x: area.x, y: area.y },
        initialWidth: area.width,
        initialHeight: area.height,
        style: { width: area.width, height: area.height },
        data: { area }
      });
    }
  }

  const noteNodes: NoteNode[] = [];
  if (layout?.notes) {
    for (const note of Object.values(layout.notes)) {
      noteNodes.push({
        id: `note:${note.id}`,
        type: "note",
        position: { x: note.x, y: note.y },
        initialWidth: note.width,
        initialHeight: note.height,
        style: { width: note.width, height: note.height },
        data: { note }
      });
    }
  }

  const collectionNodes: CollectionNode[] = collections.map((collection) => {
    const stored = layout?.positions[collection.name];
    const size = layout?.sizes[collection.name];
    const nodeWidth = size?.width ?? 280;
    const fieldCount = Object.keys(collection.fields).length;
    const estimatedHeight = size?.height ?? estimateNodeHeight(fieldCount);
    return {
      id: collection.name,
      type: "collection",
      position: stored ?? { x: 0, y: 0 },
      initialWidth: nodeWidth,
      initialHeight: estimatedHeight,
      style: { width: nodeWidth },
      data: {
        collection,
        color: layout?.colors[collection.name],
        expanded: !(layout?.collapsed[collection.name] ?? false)
      }
    };
  });

  const edges: RelationEdge[] = [];
  const seenPairs = new Set<string>();

  for (const collection of collections) {
    for (const [fieldName, field] of Object.entries(collection.fields)) {
      const target = fieldRelationTarget(field);
      if (!target) continue;
      const cardinality = fieldCardinality(field);
      const id = `${collection.name}__${fieldName}__${target}`;
      const pair = `${collection.name}::${fieldName}::${target}`;
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      edges.push({
        id,
        source: collection.name,
        target,
        type: "relation",
        sourceHandle: `right_rel_${fieldName}`,
        targetHandle: "incoming",
        data: {
          sourceCollection: collection.name,
          sourceField: fieldName,
          targetCollection: target,
          cardinality,
          required: field.required,
          ...(field.onDelete ? { onDelete: field.onDelete } : {})
        }
      });
    }
  }

  return {
    nodes: [...areaNodes, ...noteNodes, ...collectionNodes],
    edges
  };
}
