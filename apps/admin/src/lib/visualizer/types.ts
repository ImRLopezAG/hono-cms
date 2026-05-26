import type { Node, Edge } from "@xyflow/react";
import type { AdminSchemaCollection, AdminSchemaField } from "../api-client";

export type CollectionNodeData = {
  collection: AdminSchemaCollection;
  color?: string;
  expanded?: boolean;
  highlighted?: boolean;
  pendingChange?: "create" | "update" | "delete";
};

export type CollectionNode = Node<CollectionNodeData, "collection">;

/** Area group container. Stores label + background color + resize dimensions. */
export type AreaShape = {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AreaNodeData = {
  area: AreaShape;
};

export type AreaNode = Node<AreaNodeData, "area">;

/** Free-form sticky-note in the canvas. */
export type NoteShape = {
  id: string;
  content: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type NoteNodeData = {
  note: NoteShape;
};

export type NoteNode = Node<NoteNodeData, "note">;

export type RelationCardinality =
  | "one"
  | "many"
  | "one-to-one"
  | "many-to-one"
  | "one-to-many"
  | "many-to-many";

export type RelationEdgeData = {
  sourceCollection: string;
  sourceField: string;
  targetCollection: string;
  cardinality: RelationCardinality;
  onDelete?: string;
  required?: boolean;
};

export type RelationEdge = Edge<RelationEdgeData, "relation">;

export type GraphPosition = { x: number; y: number };
export type NodeSize = { width: number; height: number };

export type WorkspaceLayout = {
  positions: Record<string, GraphPosition>;
  collapsed: Record<string, boolean>;
  /** Per-collection accent color, keyed by collection name. */
  colors: Record<string, string>;
  /** Per-collection node size overrides (NodeResizer). */
  sizes: Record<string, NodeSize>;
  /** Area group nodes (id-keyed). */
  areas: Record<string, AreaShape>;
  /** Sticky note nodes (id-keyed). */
  notes: Record<string, NoteShape>;
  /** Optional canvas-wide UI flags. */
  ui?: {
    lockedView?: boolean;
    theme?: "light" | "dark";
  };
};

export type GraphResult = {
  nodes: (CollectionNode | AreaNode | NoteNode)[];
  edges: RelationEdge[];
};

export const COLLECTION_NODE_WIDTH = 280;
export const COLLECTION_NODE_MIN_HEIGHT = 120;
export const COLLECTION_NODE_ROW_HEIGHT = 28;
export const COLLECTION_NODE_HEADER_HEIGHT = 56;
export const COLLECTION_NODE_FOOTER_HEIGHT = 16;

/** Maximum fields shown when a collection node is collapsed. */
export const COLLECTION_MINIMIZED_FIELDS = 4;

export function fieldRelationTarget(field: AdminSchemaField): string | null {
  return field.kind === "relation" ? field.target ?? null : null;
}

export function fieldCardinality(field: AdminSchemaField): RelationCardinality {
  if (field.kind !== "relation") return "one";
  return (field.cardinality as RelationCardinality | undefined) ?? "many-to-one";
}

/** A field is treated as a primary identifier when its kind is `uid`. */
export function fieldIsPrimary(field: AdminSchemaField): boolean {
  return field.kind === "uid";
}

/** Empty workspace layout — used when no persisted state exists. */
export const EMPTY_WORKSPACE_LAYOUT: WorkspaceLayout = {
  positions: {},
  collapsed: {},
  colors: {},
  sizes: {},
  areas: {},
  notes: {},
  ui: { lockedView: false, theme: "light" }
};
