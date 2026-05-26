import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type EdgeTypes,
  type Node,
  type NodeTypes
} from "@xyflow/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import "@xyflow/react/dist/style.css";

import { AdminApiError, createAdminApiClient, type AdminSchemaCollection, type ContentTypeInput } from "../../lib/api-client";
import { authTokenAtom } from "../../state/admin-atoms";
import { schemaToGraph } from "../../lib/visualizer/schema-to-graph";
import { autoLayout } from "../../lib/visualizer/auto-layout";
import type {
  AreaNode as AreaNodeShape,
  CollectionNode as CollectionNodeShape,
  NoteNode as NoteNodeShape,
  RelationEdge as RelationEdgeShape,
  WorkspaceLayout
} from "../../lib/visualizer/types";
import {
  pushLayoutHistoryAtom,
  visualizerLayoutAtom
} from "../../lib/visualizer/layout-atom";
import { CollectionNode } from "./CollectionNode";
import { CollectionNodeProvider, type CollectionNodeApi } from "./CollectionNodeContext";
import { AreaNode } from "./AreaNode";
import { NoteNode } from "./NoteNode";
import { RelationEdge } from "./RelationEdge";
import { CanvasMarkers } from "./CanvasMarkers";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { CanvasToolbar } from "./CanvasToolbar";
import { AddCollectionDialog, type AddCollectionInput } from "./AddCollectionDialog";
import {
  RelationConnectionDialog,
  type RelationConnectionInput
} from "./RelationConnectionDialog";
import { CollectionFormSheet } from "./CollectionFormSheet";

const nodeTypes: NodeTypes = {
  collection: CollectionNode as unknown as NodeTypes[string],
  area: AreaNode as unknown as NodeTypes[string],
  note: NoteNode as unknown as NodeTypes[string]
};
const edgeTypes: EdgeTypes = { relation: RelationEdge as unknown as EdgeTypes[string] };

type AnyNode = CollectionNodeShape | AreaNodeShape | NoteNodeShape;

function useAdminClient() {
  const token = useAtomValue(authTokenAtom);
  return useMemo(() => createAdminApiClient(undefined, token), [token]);
}

type VisualizerCanvasProps = {
  header?: ReactNode;
};

function VisualizerCanvasInner({ header }: VisualizerCanvasProps) {
  const client = useAdminClient();
  const queryClient = useQueryClient();
  const [layout, setLayout] = useAtom(visualizerLayoutAtom);
  const pushHistory = useSetAtom(pushLayoutHistoryAtom);
  const reactFlow = useReactFlow();

  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null);
  const [editingCollectionName, setEditingCollectionName] = useState<string | null>(null);
  const [formSheetCollection, setFormSheetCollection] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [contextTarget, setContextTarget] = useState<
    { kind: "canvas" } | { kind: "collection"; collectionName: string }
  >({ kind: "canvas" });
  const canvasRef = useRef<HTMLDivElement>(null);

  const schemaQuery = useQuery({
    queryKey: ["schema"],
    queryFn: () => client.schema()
  });

  const capabilitiesQuery = useQuery({
    queryKey: ["content-type-capabilities"],
    queryFn: () => client.contentTypes()
  });

  const writable = capabilitiesQuery.data?.capabilities.writable ?? false;
  const schema = schemaQuery.data;
  const locked = layout.ui?.lockedView ?? false;

  const graph = useMemo(() => {
    if (!schema) return { nodes: [] as AnyNode[], edges: [] as RelationEdgeShape[] };
    const initial = schemaToGraph(schema, layout);
    const needsLayout = initial.nodes
      .filter((node): node is CollectionNodeShape => node.type === "collection")
      .some((node) => node.position.x === 0 && node.position.y === 0);
    return needsLayout ? autoLayout(initial) : initial;
  }, [schema, layout]);

  const [nodes, setNodes, onNodesChange] = useNodesState<AnyNode>(graph.nodes as AnyNode[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RelationEdgeShape>(graph.edges);

  useEffect(() => {
    setNodes(graph.nodes as AnyNode[]);
    setEdges(graph.edges);
  }, [graph.nodes, graph.edges, setNodes, setEdges]);

  const persistNodeChanges = useCallback(
    (changed: Node[]) => {
      setLayout((current) => {
        const next: WorkspaceLayout = {
          ...current,
          positions: { ...current.positions },
          sizes: { ...current.sizes },
          areas: { ...current.areas },
          notes: { ...current.notes }
        };
        for (const node of changed) {
          if (!node.position) continue;
          if (node.type === "area" && node.id.startsWith("area:")) {
            const areaId = node.id.slice("area:".length);
            const existing = next.areas[areaId];
            if (existing) {
              next.areas[areaId] = {
                ...existing,
                x: node.position.x,
                y: node.position.y,
                width: node.width ?? existing.width,
                height: node.height ?? existing.height
              };
            }
          } else if (node.type === "note" && node.id.startsWith("note:")) {
            const noteId = node.id.slice("note:".length);
            const existing = next.notes[noteId];
            if (existing) {
              next.notes[noteId] = {
                ...existing,
                x: node.position.x,
                y: node.position.y,
                width: node.width ?? existing.width,
                height: node.height ?? existing.height
              };
            }
          } else if (node.type === "collection") {
            next.positions[node.id] = { x: node.position.x, y: node.position.y };
            if (node.width) {
              next.sizes[node.id] = {
                width: node.width,
                height: node.height ?? next.sizes[node.id]?.height ?? 0
              };
            }
          }
        }
        return next;
      });
    },
    [setLayout]
  );

  /**
   * Update a content-type. We accept an explicit `currentName` so callers can
   * rename a collection without losing the previous identity (the server's
   * PUT route addresses the collection by its current name in the path).
   */
  const updateContentType = useMutation({
    mutationFn: ({ currentName, input }: { currentName: string; input: ContentTypeInput }) =>
      client.updateContentType(currentName, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["schema"] });
      void queryClient.invalidateQueries({ queryKey: ["content-types"] });
      void queryClient.invalidateQueries({ queryKey: ["content-type-capabilities"] });
    }
  });

  const createContentType = useMutation({
    mutationFn: (input: ContentTypeInput) => client.createContentType(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["schema"] });
      void queryClient.invalidateQueries({ queryKey: ["content-types"] });
      void queryClient.invalidateQueries({ queryKey: ["content-type-capabilities"] });
    }
  });

  const submitNewCollection = useCallback(
    async (input: AddCollectionInput) => {
      const fieldName = input.primaryStringField.trim() || "title";
      await createContentType.mutateAsync({
        name: input.name,
        options: input.draftAndPublish ? { draftAndPublish: true, timestamps: true } : { timestamps: true },
        fields: {
          [fieldName]: {
            kind: "string",
            required: true,
            unique: false,
            localized: false,
            private: false
          }
        }
      });
    },
    [createContentType]
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!schema || !connection.source || !connection.target) return;
      if (!schema.collections[connection.source]) return;
      setPendingConnection(connection);
    },
    [schema]
  );

  const closeRelationDialog = useCallback(() => setPendingConnection(null), []);

  const submitRelation = useCallback(
    async (input: RelationConnectionInput) => {
      if (!schema || !pendingConnection?.source || !pendingConnection?.target) return;
      const sourceName = pendingConnection.source;
      const targetName = pendingConnection.target;
      const sourceCollection = schema.collections[sourceName];
      if (!sourceCollection) return;
      if (sourceCollection.fields[input.fieldName]) {
        throw new Error(`A field named "${input.fieldName}" already exists on ${sourceName}`);
      }
      await updateContentType.mutateAsync({
        currentName: sourceName,
        input: {
          name: sourceName,
          options: sourceCollection.options,
          fields: {
            ...Object.fromEntries(
              Object.entries(sourceCollection.fields).map(([k, v]) => [k, { ...v, kind: v.kind }])
            ),
            [input.fieldName]: {
              kind: "relation",
              target: targetName,
              cardinality: input.cardinality,
              required: input.required,
              unique: false,
              localized: false,
              private: false
            }
          }
        }
      });
      toast.success(`Linked ${sourceName} → ${targetName}`);
    },
    [schema, pendingConnection, updateContentType]
  );

  const pendingSource = pendingConnection?.source ?? null;
  const pendingTarget = pendingConnection?.target ?? null;
  const pendingSourceFieldNames = useMemo(
    () => (pendingSource && schema ? Object.keys(schema.collections[pendingSource]?.fields ?? {}) : []),
    [pendingSource, schema]
  );

  const existingNames = useMemo(() => Object.keys(schema?.collections ?? {}), [schema]);

  const handleAutoLayout = useCallback(() => {
    if (!schema) return;
    pushHistory();
    const laidOut = autoLayout(schemaToGraph(schema, layout));
    setNodes(laidOut.nodes as AnyNode[]);
    setLayout((current) => {
      const next: WorkspaceLayout = { ...current, positions: { ...current.positions } };
      for (const node of laidOut.nodes) {
        if (node.type === "collection") {
          next.positions[node.id] = { x: node.position.x, y: node.position.y };
        }
      }
      return next;
    });
  }, [schema, layout, pushHistory, setNodes, setLayout]);

  const handleFitView = useCallback(() => {
    reactFlow.fitView({ duration: 320, padding: 0.18, maxZoom: 1.2 });
  }, [reactFlow]);

  const handleToggleLock = useCallback(() => {
    setLayout((current) => ({
      ...current,
      ui: { ...(current.ui ?? {}), lockedView: !(current.ui?.lockedView ?? false) }
    }));
  }, [setLayout]);

  const handleDuplicateCollection = useCallback(
    (name: string) => {
      if (!schema) return;
      const original = schema.collections[name];
      if (!original) return;
      // Pick a unique candidate so repeated duplicates don't collide.
      let candidate = `${name}Copy`;
      let counter = 2;
      while (schema.collections[candidate]) {
        candidate = `${name}Copy${counter++}`;
      }
      void createContentType
        .mutateAsync({
          name: candidate,
          options: original.options,
          fields: Object.fromEntries(
            Object.entries(original.fields).map(([k, v]) => [k, { ...v, kind: v.kind }])
          )
        })
        .then(() => toast.success(`Duplicated ${name} → ${candidate}`))
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Duplicate failed");
        });
    },
    [createContentType, schema]
  );

  /**
   * Delete a collection through the CT Builder. Optimistically prunes the
   * affected node + edges from the canvas after the server confirms the
   * delete; React Query then refetches the schema and snaps the layout to
   * the authoritative shape.
   */
  const deleteContentType = useMutation({
    mutationFn: (name: string) => client.deleteContentType(name),
    onSuccess: (_, name) => {
      void queryClient.invalidateQueries({ queryKey: ["schema"] });
      void queryClient.invalidateQueries({ queryKey: ["content-types"] });
      void queryClient.invalidateQueries({ queryKey: ["content-type-capabilities"] });
      setNodes((current) => current.filter((node) => !(node.type === "collection" && node.id === name)));
      setEdges((current) => current.filter((edge) => edge.source !== name && edge.target !== name));
      toast.success(`Deleted "${name}"`);
    },
    onError: (error: unknown, name) => {
      if (error instanceof AdminApiError && error.status === 404) {
        toast.error(`Collection "${name}" was already removed.`);
        void queryClient.invalidateQueries({ queryKey: ["schema"] });
        void queryClient.invalidateQueries({ queryKey: ["content-types"] });
        return;
      }
      toast.error(error instanceof Error ? error.message : `Failed to delete "${name}"`);
    }
  });

  const handleDeleteCollection = useCallback(
    (name: string) => {
      if (!writable) return;
      // `confirm` keeps this lightweight — the form view drives the full
      // AlertDialog flow. Visualizer right-click + Delete is destructive but
      // the user already had to navigate the context menu to get here.
      if (typeof window !== "undefined" && !window.confirm(`Delete collection "${name}"? This removes the schema file from disk.`)) {
        return;
      }
      deleteContentType.mutate(name);
    },
    [deleteContentType, writable]
  );

  /* ----- inline edit / form-sheet context wiring -------------- */
  const beginEdit = useCallback(
    (name: string) => {
      setEditingCollectionName(name);
    },
    []
  );
  const endEdit = useCallback(() => setEditingCollectionName(null), []);
  const openFormView = useCallback((name: string) => setFormSheetCollection(name), []);
  const closeFormView = useCallback(() => setFormSheetCollection(null), []);

  const saveCollection = useCallback(
    async (input: ContentTypeInput) => {
      // The inline editor only mutates fields, never the collection name, so
      // currentName === input.name here. Renames go through `renameCollection`.
      await updateContentType.mutateAsync({ currentName: input.name, input });
    },
    [updateContentType]
  );

  const renameCollection = useCallback(
    async (current: AdminSchemaCollection, nextName: string) => {
      await updateContentType.mutateAsync({
        currentName: current.name,
        input: {
          name: nextName,
          options: current.options,
          fields: Object.fromEntries(
            Object.entries(current.fields).map(([k, v]) => [k, { ...v, kind: v.kind }])
          )
        }
      });
    },
    [updateContentType]
  );

  const collectionApi: CollectionNodeApi = useMemo(
    () => ({
      writable,
      editingCollection: editingCollectionName,
      beginEdit,
      endEdit,
      saveCollection,
      renameCollection,
      openFormView,
      saving: updateContentType.isPending || createContentType.isPending
    }),
    [
      writable,
      editingCollectionName,
      beginEdit,
      endEdit,
      saveCollection,
      renameCollection,
      openFormView,
      updateContentType.isPending,
      createContentType.isPending
    ]
  );

  const trackContextMenu = useCallback(
    (event: React.MouseEvent) => {
      setCursor({ x: event.clientX, y: event.clientY });
      // Inspect target to decide whether we're over a node.
      const collectionEl = (event.target as HTMLElement | null)?.closest(
        "[data-collection]"
      ) as HTMLElement | null;
      const collectionName = collectionEl?.dataset.collection ?? null;
      setContextTarget(collectionName ? { kind: "collection", collectionName } : { kind: "canvas" });
    },
    []
  );

  return (
    <>
      {header}
      <div className="hcms-vz-actionbar">
        <div className="hcms-vz-actionbar-left">
          <span className="hcms-vz-mode-pill" data-state={writable ? "ready" : "readonly"}>
            {writable ? "Writable" : "Read-only"}
          </span>
          <div className="hcms-vz-stats">
            <div className="hcms-vz-stats-row">
              <span>
                <strong>{existingNames.length}</strong> collection
                {existingNames.length === 1 ? "" : "s"}
              </span>
              <span>
                <strong>{edges.length}</strong> relation{edges.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>
        </div>
        {writable ? (
          <button
            type="button"
            className="hcms-btn hcms-btn--primary"
            onClick={() => setAddDialogOpen(true)}
          >
            + New collection
          </button>
        ) : null}
      </div>
      <AddCollectionDialog
        open={addDialogOpen && writable}
        onClose={() => setAddDialogOpen(false)}
        onSubmit={submitNewCollection}
        existingNames={existingNames}
      />
      <RelationConnectionDialog
        open={writable && pendingSource !== null && pendingTarget !== null}
        sourceName={pendingSource ?? ""}
        targetName={pendingTarget ?? ""}
        existingFieldNames={pendingSourceFieldNames}
        defaultFieldName={pendingTarget ? `${pendingTarget}Ref` : ""}
        onClose={closeRelationDialog}
        onSubmit={submitRelation}
      />
      <CollectionFormSheet
        collectionName={formSheetCollection}
        open={formSheetCollection !== null}
        onClose={closeFormView}
      />
      <div
        className="hcms-vz-canvas"
        role="region"
        aria-label="Schema canvas"
        ref={canvasRef}
        onContextMenu={trackContextMenu}
      >
        <CanvasMarkers />
        <CollectionNodeProvider value={collectionApi}>
        <CanvasContextMenu
          target={contextTarget}
          writable={writable}
          locked={locked}
          cursor={cursor}
          onToggleLock={handleToggleLock}
          onAutoLayout={handleAutoLayout}
          onFitView={handleFitView}
          onCreateCollection={() => setAddDialogOpen(true)}
          onEditCollection={(name) => beginEdit(name)}
          onDuplicateCollection={handleDuplicateCollection}
          onDeleteCollection={handleDeleteCollection}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={(changes) => {
              onNodesChange(changes);
              const moved = changes
                .filter(
                  (
                    c
                  ): c is Extract<
                    (typeof changes)[number],
                    { type: "position" | "dimensions"; id: string }
                  > => c.type === "position" || c.type === "dimensions"
                )
                .map((c) => {
                  const node = nodes.find((n) => n.id === c.id);
                  if (!node) return null;
                  return {
                    ...node,
                    position:
                      c.type === "position" && c.position ? c.position : node.position,
                    width:
                      c.type === "dimensions" && c.dimensions
                        ? c.dimensions.width
                        : node.width,
                    height:
                      c.type === "dimensions" && c.dimensions
                        ? c.dimensions.height
                        : node.height
                  } as Node;
                })
                .filter((n): n is Node => n !== null);
              if (moved.length > 0) persistNodeChanges(moved);
            }}
            onEdgesChange={onEdgesChange}
            onConnect={writable && !locked ? handleConnect : undefined}
            onNodeDoubleClick={
              writable && !locked
                ? (event, node) => {
                    // Header double-click handles rename; canvas-wide double-click
                    // toggles inline edit mode. Header rename targets the rename
                    // input directly, so this fires only when the user double-
                    // clicks the body, the chips area, or the resize bg.
                    if (
                      node.type === "collection" &&
                      !(event.target as HTMLElement | null)?.closest(".hcms-node-rename-input")
                    ) {
                      beginEdit(node.id);
                    }
                  }
                : undefined
            }
            fitView
            minZoom={0.1}
            maxZoom={2.4}
            nodesDraggable={!locked}
            nodesConnectable={!locked && writable}
            elementsSelectable
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
            <CanvasToolbar
              onAutoLayout={handleAutoLayout}
              onToggleLock={handleToggleLock}
              locked={locked}
            />
          </ReactFlow>
        </CanvasContextMenu>
        </CollectionNodeProvider>
        {updateContentType.isPending || createContentType.isPending ? (
          <div className="hcms-vz-toast hcms-vz-toast--info">Saving…</div>
        ) : null}
        {updateContentType.isError ? (
          <div className="hcms-vz-toast hcms-vz-toast--error">
            Update failed: {(updateContentType.error as Error).message}
          </div>
        ) : null}
      </div>
    </>
  );
}

export function VisualizerCanvas({ header }: VisualizerCanvasProps = {}) {
  return (
    <ReactFlowProvider>
      <VisualizerCanvasInner header={header} />
    </ReactFlowProvider>
  );
}
