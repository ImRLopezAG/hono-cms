import { memo, useCallback, useEffect, useRef, useState } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { useSetAtom } from "jotai";
import { Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NoteNode as NoteNodeShape } from "../../lib/visualizer/types";
import {
  pushLayoutHistoryAtom,
  visualizerLayoutAtom
} from "../../lib/visualizer/layout-atom";
import { ColorPicker } from "./ColorPicker";

/**
 * Mix a hex color with white (light) or black (dark) so the note body
 * stays readable. Matches chartdb's note-node light/dark blend (30 % of
 * the original color, 70 % of the base).
 */
function tintNoteColor(color: string, mode: "light" | "dark"): string {
  const hex = color.replace("#", "");
  if (hex.length !== 6) return color;
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  if (mode === "dark") {
    return `rgb(${Math.round(r * 0.3)}, ${Math.round(g * 0.3)}, ${Math.round(b * 0.3)})`;
  }
  return `rgb(${Math.round(r * 0.3 + 255 * 0.7)}, ${Math.round(g * 0.3 + 255 * 0.7)}, ${Math.round(b * 0.3 + 255 * 0.7)})`;
}

/**
 * Free-form sticky-note. Markdown-light: we render with `pre-wrap`
 * whitespace so newlines and indents are preserved without pulling in a
 * full markdown parser, which keeps the dep surface small in the admin
 * bundle.
 */
export const NoteNode = memo(function NoteNode({
  data,
  selected,
  dragging
}: NodeProps<NoteNodeShape>) {
  const { note } = data;
  const setLayout = useSetAtom(visualizerLayoutAtom);
  const pushHistory = useSetAtom(pushLayoutHistoryAtom);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState(note.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const focused = !!selected && !dragging;
  const theme: "light" | "dark" =
    typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
      ? "dark"
      : "light";

  useEffect(() => setDraft(note.content), [note.content]);

  const commit = useCallback(() => {
    if (!editMode) return;
    if (draft.trim() !== note.content) {
      pushHistory();
      setLayout((current) => ({
        ...current,
        notes: { ...current.notes, [note.id]: { ...note, content: draft.trim() } }
      }));
    }
    setEditMode(false);
  }, [draft, editMode, note, pushHistory, setLayout]);

  const cancel = useCallback(() => {
    setEditMode(false);
    setDraft(note.content);
  }, [note.content]);

  const handleColorChange = useCallback(
    (color: string) => {
      pushHistory();
      setLayout((current) => ({
        ...current,
        notes: { ...current.notes, [note.id]: { ...note, color } }
      }));
    },
    [note, pushHistory, setLayout]
  );

  const handleDelete = useCallback(() => {
    pushHistory();
    setLayout((current) => {
      const next = { ...current.notes };
      delete next[note.id];
      return { ...current, notes: next };
    });
  }, [note.id, pushHistory, setLayout]);

  return (
    <div
      className={cn("hcms-note", selected && "hcms-note--selected")}
      style={{ background: tintNoteColor(note.color, theme) }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        setEditMode(true);
      }}
    >
      <div className="hcms-note-strip" style={{ background: note.color }} aria-hidden />
      <NodeResizer
        isVisible={focused}
        minHeight={120}
        minWidth={180}
        lineClassName="hcms-note-resize-line"
        handleClassName="hcms-note-resize-handle"
      />
      <div className="hcms-note-body group">
        <div className="hcms-note-fold" aria-hidden />
        {editMode ? (
          <textarea
            ref={textareaRef}
            className="hcms-note-textarea nodrag"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") cancel();
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                commit();
              }
            }}
            onBlur={commit}
            placeholder="Type a note… (Markdown-friendly text, Cmd+Enter to save)"
            autoFocus
          />
        ) : (
          <div className="hcms-note-content">
            {note.content ? (
              <pre className="hcms-note-pre">{note.content}</pre>
            ) : (
              <span className="hcms-note-placeholder">Double-click to write</span>
            )}
          </div>
        )}
        <div className="hcms-note-actions">
          <button
            type="button"
            className="hcms-note-action"
            onClick={(event) => {
              event.stopPropagation();
              setEditMode(true);
            }}
            aria-label="Edit note"
          >
            <Pencil size={12} />
          </button>
          <ColorPicker color={note.color} onChange={handleColorChange} ariaLabel="Pick note color" />
          <button
            type="button"
            className="hcms-note-action hcms-note-action--danger"
            onClick={(event) => {
              event.stopPropagation();
              handleDelete();
            }}
            aria-label="Delete note"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    </div>
  );
});

NoteNode.displayName = "NoteNode";
