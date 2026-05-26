import { createContext, useContext } from "react";
import type { AdminSchemaCollection, ContentTypeInput } from "../../lib/api-client";

/**
 * Shared state surface for the visualizer's collection nodes. Created by
 * `VisualizerCanvas` and consumed by `CollectionNode` so the canvas can
 * coordinate inline editing without each node owning the network calls.
 *
 * Why a context? React Flow renders `nodeTypes` through its own factory,
 * so we cannot pass callbacks via props from the canvas. A focused
 * context lets the node read the active edit target, the writability
 * flag, and the small set of side-effects (save/rename/open form) it
 * needs to drive — and keeps the wiring centralised.
 */
export type CollectionNodeApi = {
  writable: boolean;
  /** Name of the collection currently in inline edit mode, or null. */
  editingCollection: string | null;
  /** Begin inline editing the given collection name. */
  beginEdit: (name: string) => void;
  /** Cancel inline editing. */
  endEdit: () => void;
  /** Persist a full content-type update; resolves on success. */
  saveCollection: (input: ContentTypeInput) => Promise<void>;
  /** Rename a collection (delegates to saveCollection with the new name). */
  renameCollection: (current: AdminSchemaCollection, nextName: string) => Promise<void>;
  /** Open the legacy form-based editor for richer field options. */
  openFormView: (name: string) => void;
  /** True while a mutation is in flight (any save). */
  saving: boolean;
};

const NOOP_API: CollectionNodeApi = {
  writable: false,
  editingCollection: null,
  beginEdit: () => undefined,
  endEdit: () => undefined,
  saveCollection: async () => undefined,
  renameCollection: async () => undefined,
  openFormView: () => undefined,
  saving: false
};

const CollectionNodeContext = createContext<CollectionNodeApi>(NOOP_API);

export function CollectionNodeProvider({
  value,
  children
}: {
  value: CollectionNodeApi;
  children: React.ReactNode;
}) {
  return <CollectionNodeContext.Provider value={value}>{children}</CollectionNodeContext.Provider>;
}

export function useCollectionNodeApi(): CollectionNodeApi {
  return useContext(CollectionNodeContext);
}
