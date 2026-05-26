import { useEffect } from "react";
import { X } from "lucide-react";
import { ContentTypesView } from "../views/ContentTypesView";

/**
 * Slide-out drawer that hosts the legacy form-based content-type editor as
 * a secondary surface alongside the canvas. The canvas is the primary
 * editing surface (chartdb-style inline edit); this sheet is opened from
 * the per-node "Open form view" button when authors need advanced field
 * options (component nesting, enums, dynamic zones, advanced JSON options,
 * etc.) that aren't surfaced inline.
 *
 * Implementation note: we intentionally render `ContentTypesView` as a
 * peer rather than re-implementing its features. The view already has its
 * own internal state for the selected collection; since it auto-selects
 * "no collection" we hand it a `key` derived from the requested name so
 * it remounts and picks the right one through its own list UI.
 *
 * The sheet is mounted via fixed positioning + a backdrop overlay rather
 * than a portal because the visualizer route does not yet host a
 * `<DialogProvider>` and we want to keep the dependency list minimal.
 */
export function CollectionFormSheet({
  collectionName,
  open,
  onClose
}: {
  collectionName: string | null;
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="hcms-form-sheet-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Content type form view"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="hcms-form-sheet"
        role="document"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="hcms-form-sheet-header">
          <div>
            <p className="hcms-dialog-eyebrow">Form view</p>
            <h2 className="hcms-form-sheet-title">{collectionName ?? "Content types"}</h2>
          </div>
          <button
            type="button"
            className="hcms-dialog-close"
            onClick={onClose}
            aria-label="Close form view"
          >
            <X size={16} />
          </button>
        </header>
        <div className="hcms-form-sheet-body" key={collectionName ?? "__none__"}>
          <ContentTypesView />
        </div>
      </div>
    </div>
  );
}
