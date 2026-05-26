import { useCallback, type ReactNode, type MouseEvent } from "react";
import { useReactFlow } from "@xyflow/react";
import { useSetAtom } from "jotai";
import {
  Copy,
  Group,
  LayoutGrid,
  Lock,
  Maximize,
  Palette,
  Plus,
  Sparkles,
  StickyNote,
  Trash2,
  Unlock
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from "../ui/context-menu";
import {
  pushLayoutHistoryAtom,
  visualizerLayoutAtom
} from "../../lib/visualizer/layout-atom";
import {
  DEFAULT_AREA_COLOR,
  DEFAULT_NOTE_COLOR,
  VISUALIZER_COLOR_OPTIONS
} from "./ColorPicker";

type ContextTarget =
  | { kind: "canvas" }
  | { kind: "collection"; collectionName: string };

export type CanvasContextMenuProps = {
  /** Element the right-click menu attaches to (typically the ReactFlow wrapper). */
  children: ReactNode;
  /** Current target (canvas or collection node). */
  target: ContextTarget;
  /** Whether the schema is writable (gates create/edit). */
  writable: boolean;
  /** Whether the canvas is locked (gates view-only items). */
  locked: boolean;
  onToggleLock: () => void;
  onAutoLayout: () => void;
  onFitView: () => void;
  onCreateCollection: () => void;
  onEditCollection?: (name: string) => void;
  onDeleteCollection?: (name: string) => void;
  onDuplicateCollection?: (name: string) => void;
  /** Last contextmenu screen-coords — used to spawn areas/notes near the cursor. */
  cursor: { x: number; y: number };
};

/**
 * Right-click menu for the canvas. Two shapes:
 *   - Canvas: create collection / area / note, auto-layout, fit-view,
 *     lock toggle.
 *   - Collection node: edit, duplicate, change-color (12-swatch),
 *     move-to-area, delete.
 *
 * The component wraps its `children` with a `ContextMenuTrigger`, so
 * place it at the outermost canvas element that should receive right
 * clicks.
 */
export function CanvasContextMenu({
  children,
  target,
  writable,
  locked,
  onToggleLock,
  onAutoLayout,
  onFitView,
  onCreateCollection,
  onEditCollection,
  onDeleteCollection,
  onDuplicateCollection,
  cursor
}: CanvasContextMenuProps) {
  const { screenToFlowPosition } = useReactFlow();
  const setLayout = useSetAtom(visualizerLayoutAtom);
  const pushHistory = useSetAtom(pushLayoutHistoryAtom);

  const createArea = useCallback(() => {
    const position = screenToFlowPosition({ x: cursor.x, y: cursor.y });
    const id = `area-${Date.now().toString(36)}`;
    pushHistory();
    setLayout((current) => ({
      ...current,
      areas: {
        ...current.areas,
        [id]: {
          id,
          name: "New area",
          color: DEFAULT_AREA_COLOR,
          x: position.x - 120,
          y: position.y - 80,
          width: 320,
          height: 220
        }
      }
    }));
  }, [cursor, pushHistory, screenToFlowPosition, setLayout]);

  const createNote = useCallback(() => {
    const position = screenToFlowPosition({ x: cursor.x, y: cursor.y });
    const id = `note-${Date.now().toString(36)}`;
    pushHistory();
    setLayout((current) => ({
      ...current,
      notes: {
        ...current.notes,
        [id]: {
          id,
          content: "",
          color: DEFAULT_NOTE_COLOR,
          x: position.x - 100,
          y: position.y - 60,
          width: 220,
          height: 160
        }
      }
    }));
  }, [cursor, pushHistory, screenToFlowPosition, setLayout]);

  const setCollectionColor = useCallback(
    (collectionName: string, color: string) => {
      pushHistory();
      setLayout((current) => ({
        ...current,
        colors: { ...current.colors, [collectionName]: color }
      }));
    },
    [pushHistory, setLayout]
  );

  const swallowMouseDown = (event: MouseEvent) => event.stopPropagation();

  return (
    <ContextMenu>
      <ContextMenuTrigger className="block h-full" onMouseDown={swallowMouseDown}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        <ContextMenuGroup>
        {target.kind === "canvas" ? (
          <>
            {writable ? (
              <>
                <ContextMenuItem onClick={onCreateCollection}>
                  <Plus className="size-3.5" />
                  <span>New collection</span>
                </ContextMenuItem>
                <ContextMenuItem onClick={createArea}>
                  <Group className="size-3.5" />
                  <span>New area</span>
                </ContextMenuItem>
                <ContextMenuItem onClick={createNote}>
                  <StickyNote className="size-3.5" />
                  <span>New note</span>
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            ) : null}
            <ContextMenuItem onClick={onFitView}>
              <Maximize className="size-3.5" />
              <span>Fit view</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={onAutoLayout}>
              <LayoutGrid className="size-3.5" />
              <span>Auto-layout</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={onToggleLock}>
              {locked ? <Unlock className="size-3.5" /> : <Lock className="size-3.5" />}
              <span>{locked ? "Unlock view" : "Lock view"}</span>
            </ContextMenuItem>
          </>
        ) : (
          <CollectionContextItems
            collectionName={target.collectionName}
            writable={writable}
            onEditCollection={onEditCollection}
            onDeleteCollection={onDeleteCollection}
            onDuplicateCollection={onDuplicateCollection}
            onChangeColor={(color) => setCollectionColor(target.collectionName, color)}
          />
        )}
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CollectionContextItems({
  collectionName,
  writable,
  onEditCollection,
  onDeleteCollection,
  onDuplicateCollection,
  onChangeColor
}: {
  collectionName: string;
  writable: boolean;
  onEditCollection?: (name: string) => void;
  onDeleteCollection?: (name: string) => void;
  onDuplicateCollection?: (name: string) => void;
  onChangeColor: (color: string) => void;
}) {
  return (
    <>
      <ContextMenuItem disabled className="opacity-100">
        <Sparkles className="size-3.5" />
        <span className="font-semibold">{collectionName}</span>
      </ContextMenuItem>
      <ContextMenuSeparator />
      {writable && onEditCollection ? (
        <ContextMenuItem onClick={() => onEditCollection(collectionName)}>
          <Sparkles className="size-3.5" />
          <span>Edit collection</span>
        </ContextMenuItem>
      ) : null}
      {writable && onDuplicateCollection ? (
        <ContextMenuItem onClick={() => onDuplicateCollection(collectionName)}>
          <Copy className="size-3.5" />
          <span>Duplicate</span>
        </ContextMenuItem>
      ) : null}
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Palette className="size-3.5" />
          <span>Change color</span>
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="p-2">
          <div className="grid grid-cols-4 gap-2">
            {VISUALIZER_COLOR_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                className="hcms-color-swatch"
                style={{ background: option }}
                onClick={() => onChangeColor(option)}
                aria-label={`Use color ${option}`}
              />
            ))}
          </div>
        </ContextMenuSubContent>
      </ContextMenuSub>
      {writable && onDeleteCollection ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onClick={() => onDeleteCollection(collectionName)}
          >
            <Trash2 className="size-3.5" />
            <span>Delete collection</span>
          </ContextMenuItem>
        </>
      ) : null}
    </>
  );
}
