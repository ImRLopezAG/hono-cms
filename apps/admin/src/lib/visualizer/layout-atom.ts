import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { EMPTY_WORKSPACE_LAYOUT, type WorkspaceLayout } from "./types";

const STORAGE_KEY = "hono-cms:visualizer-layout";

/**
 * Backwards-compatible loader: older sessions persisted only
 * { positions, collapsed }. We hydrate any missing keys with defaults
 * so older users see a fully-functional canvas without manual reset.
 */
const baseAtom = atomWithStorage<WorkspaceLayout>(STORAGE_KEY, EMPTY_WORKSPACE_LAYOUT, {
  getItem(key, fallback) {
    try {
      const raw = typeof window === "undefined" ? null : window.localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<WorkspaceLayout>;
      return {
        ...EMPTY_WORKSPACE_LAYOUT,
        ...parsed,
        positions: parsed.positions ?? {},
        collapsed: parsed.collapsed ?? {},
        colors: parsed.colors ?? {},
        sizes: parsed.sizes ?? {},
        areas: parsed.areas ?? {},
        notes: parsed.notes ?? {},
        ui: { ...EMPTY_WORKSPACE_LAYOUT.ui, ...(parsed.ui ?? {}) }
      };
    } catch {
      return fallback;
    }
  },
  setItem(key, value) {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(key, JSON.stringify(value));
    }
  },
  removeItem(key) {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(key);
    }
  }
});

export const visualizerLayoutAtom = baseAtom;

/* ----------------------------------------------------------------- */
/* History (undo/redo)                                                */
/* ----------------------------------------------------------------- */

export type LayoutHistory = {
  past: WorkspaceLayout[];
  future: WorkspaceLayout[];
};

const HISTORY_LIMIT = 50;

const layoutHistoryStateAtom = atom<LayoutHistory>({ past: [], future: [] });

/** Read-only view of the current undo/redo stack. */
export const layoutHistoryAtom = atom((get) => get(layoutHistoryStateAtom));

/**
 * Push a snapshot onto the undo stack. Should be called *before* mutating
 * the layout so the snapshot represents the pre-change state.
 */
export const pushLayoutHistoryAtom = atom(null, (get, set) => {
  const current = get(visualizerLayoutAtom);
  const history = get(layoutHistoryStateAtom);
  const past = [...history.past, current].slice(-HISTORY_LIMIT);
  set(layoutHistoryStateAtom, { past, future: [] });
});

export const undoLayoutAtom = atom(null, (get, set) => {
  const history = get(layoutHistoryStateAtom);
  const previous = history.past[history.past.length - 1];
  if (!previous) return;
  const current = get(visualizerLayoutAtom);
  set(visualizerLayoutAtom, previous);
  set(layoutHistoryStateAtom, {
    past: history.past.slice(0, -1),
    future: [...history.future, current]
  });
});

export const redoLayoutAtom = atom(null, (get, set) => {
  const history = get(layoutHistoryStateAtom);
  const next = history.future[history.future.length - 1];
  if (!next) return;
  const current = get(visualizerLayoutAtom);
  set(visualizerLayoutAtom, next);
  set(layoutHistoryStateAtom, {
    past: [...history.past, current],
    future: history.future.slice(0, -1)
  });
});

export const canUndoAtom = atom((get) => get(layoutHistoryStateAtom).past.length > 0);
export const canRedoAtom = atom((get) => get(layoutHistoryStateAtom).future.length > 0);
