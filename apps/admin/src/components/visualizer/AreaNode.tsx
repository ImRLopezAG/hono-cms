import { memo, useCallback, useEffect, useRef, useState } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { useSetAtom } from "jotai";
import { Check, GripVertical, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AreaNode as AreaNodeShape } from "../../lib/visualizer/types";
import {
  pushLayoutHistoryAtom,
  visualizerLayoutAtom
} from "../../lib/visualizer/layout-atom";
import { ColorPicker } from "./ColorPicker";

/**
 * Resizable group container — the visual equivalent of chartdb's AreaNode.
 *
 * Collections that happen to sit inside an area's bounding rect are
 * rendered above it (xyflow z-index based on node-order). Areas
 * themselves persist position, size, label and accent color through
 * the workspace layout atom.
 */
export const AreaNode = memo(function AreaNode({
  data,
  selected,
  dragging
}: NodeProps<AreaNodeShape>) {
  const { area } = data;
  const setLayout = useSetAtom(visualizerLayoutAtom);
  const pushHistory = useSetAtom(pushLayoutHistoryAtom);
  const [editMode, setEditMode] = useState(false);
  const [draftName, setDraftName] = useState(area.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const focused = !!selected && !dragging;

  useEffect(() => {
    setDraftName(area.name);
  }, [area.name]);

  const commitName = useCallback(() => {
    if (!editMode) return;
    const next = draftName.trim();
    if (next && next !== area.name) {
      pushHistory();
      setLayout((current) => ({
        ...current,
        areas: { ...current.areas, [area.id]: { ...area, name: next } }
      }));
    }
    setEditMode(false);
  }, [area, draftName, editMode, pushHistory, setLayout]);

  const cancelEdit = useCallback(() => {
    setEditMode(false);
    setDraftName(area.name);
  }, [area.name]);

  const handleColorChange = useCallback(
    (color: string) => {
      pushHistory();
      setLayout((current) => ({
        ...current,
        areas: { ...current.areas, [area.id]: { ...area, color } }
      }));
    },
    [area, pushHistory, setLayout]
  );

  return (
    <div
      className={cn(
        "hcms-area",
        selected && "hcms-area--selected"
      )}
      style={{
        backgroundColor: `${area.color}1a`,
        borderColor: selected ? "var(--hcms-vz-accent, #4f46e5)" : area.color
      }}
    >
      <NodeResizer
        isVisible={focused}
        minHeight={120}
        minWidth={160}
        lineClassName="hcms-area-resize-line"
        handleClassName="hcms-area-resize-handle"
      />
      <div className="hcms-area-header group">
        <GripVertical size={14} className="hcms-area-grip" aria-hidden />
        {editMode ? (
          <div className="hcms-area-edit">
            <input
              ref={inputRef}
              autoFocus
              type="text"
              value={draftName}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitName();
                else if (event.key === "Escape") cancelEdit();
              }}
              onBlur={commitName}
              className="hcms-area-input"
              aria-label="Area name"
            />
            <button
              type="button"
              className="hcms-area-edit-confirm"
              onClick={commitName}
              aria-label="Save area name"
            >
              <Check size={12} />
            </button>
          </div>
        ) : (
          <>
            <div
              className="hcms-area-label"
              onDoubleClick={(event) => {
                event.stopPropagation();
                setEditMode(true);
              }}
            >
              {area.name || "Untitled area"}
            </div>
            <div className="hcms-area-actions">
              <ColorPicker
                color={area.color}
                onChange={handleColorChange}
                ariaLabel="Pick area color"
              />
              <button
                type="button"
                className="hcms-area-edit-button"
                onClick={(event) => {
                  event.stopPropagation();
                  setEditMode(true);
                }}
                aria-label="Rename area"
              >
                <Pencil size={12} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
});

AreaNode.displayName = "AreaNode";
