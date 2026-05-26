import { useCallback, useEffect, useState } from "react";
import { useReactFlow, useOnViewportChange } from "@xyflow/react";
import { useAtomValue, useSetAtom } from "jotai";
import { toPng } from "html-to-image";
import {
  Download,
  LayoutGrid,
  Lock,
  Maximize2,
  Moon,
  Redo2,
  Search,
  Sun,
  Undo2,
  Unlock,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "../ui/tooltip";
import {
  canRedoAtom,
  canUndoAtom,
  redoLayoutAtom,
  undoLayoutAtom,
  visualizerLayoutAtom
} from "../../lib/visualizer/layout-atom";
import { cn } from "@/lib/utils";

export type CanvasToolbarProps = {
  /** Re-runs dagre and applies the new positions to the workspace layout. */
  onAutoLayout: () => void;
  /** Toggle the lock-view UI flag. */
  onToggleLock: () => void;
  /** Whether the canvas is currently locked. */
  locked: boolean;
};

/**
 * Top-floating canvas toolbar. Contains the controls chartdb groups in
 * its own toolbar:
 *   - undo / redo (against our jotai history stack)
 *   - lock view
 *   - auto-layout (re-runs dagre)
 *   - fit view
 *   - zoom-in / zoom-out / reset zoom (current %)
 *   - export PNG (html-to-image)
 *   - theme toggle (writes data-theme on <html>)
 */
export function CanvasToolbar({ onAutoLayout, onToggleLock, locked }: CanvasToolbarProps) {
  const { zoomIn, zoomOut, fitView, getZoom, getNodes } = useReactFlow();
  const [zoomPct, setZoomPct] = useState<number>(() => Math.round((getZoom?.() ?? 1) * 100));
  const undo = useSetAtom(undoLayoutAtom);
  const redo = useSetAtom(redoLayoutAtom);
  const canUndo = useAtomValue(canUndoAtom);
  const canRedo = useAtomValue(canRedoAtom);
  const layout = useAtomValue(visualizerLayoutAtom);
  const theme = layout.ui?.theme ?? "light";
  const setLayout = useSetAtom(visualizerLayoutAtom);

  useOnViewportChange({
    onChange: ({ zoom }) => setZoomPct(Math.round(zoom * 100))
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setLayout((current) => ({
      ...current,
      ui: { ...(current.ui ?? {}), theme: current.ui?.theme === "dark" ? "light" : "dark" }
    }));
  }, [setLayout]);

  const showAll = useCallback(() => {
    fitView({ duration: 320, padding: 0.18, maxZoom: 1.2 });
  }, [fitView]);

  const resetZoom = useCallback(() => {
    fitView({ minZoom: 1, maxZoom: 1, duration: 200 });
  }, [fitView]);

  const exportImage = useCallback(async () => {
    if (typeof document === "undefined") return;
    const viewport = document.querySelector(".react-flow__viewport") as HTMLElement | null;
    const container = document.querySelector(".hcms-vz-canvas") as HTMLElement | null;
    const target = viewport ?? container;
    if (!target) return;
    try {
      // Use the larger of viewport bounds vs node bounds so off-screen
      // nodes are included in the exported PNG.
      const nodes = getNodes();
      const padding = 40;
      const xs = nodes.map((n) => n.position.x);
      const ys = nodes.map((n) => n.position.y);
      const widths = nodes.map((n) => (n.width ?? 280));
      const heights = nodes.map((n) => (n.height ?? 200));
      const minX = Math.min(...xs, 0) - padding;
      const minY = Math.min(...ys, 0) - padding;
      const maxX = Math.max(...xs.map((x, i) => x + widths[i]!), 0) + padding;
      const maxY = Math.max(...ys.map((y, i) => y + heights[i]!), 0) + padding;
      const dataUrl = await toPng(target, {
        cacheBust: true,
        backgroundColor: theme === "dark" ? "#0f172a" : "#ffffff",
        width: Math.max(800, maxX - minX),
        height: Math.max(600, maxY - minY)
      });
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = `schema-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.png`;
      link.click();
    } catch (error) {
      // Surface failures into the console; user can retry — non-fatal.
      console.error("[visualizer] PNG export failed", error);
    }
  }, [getNodes, theme]);

  return (
    <TooltipProvider delay={150}>
      <div className="hcms-vz-toolbar" role="toolbar" aria-label="Canvas tools">
        <ToolbarButton tip="Undo (Cmd+Z)" onClick={undo} disabled={!canUndo}>
          <Undo2 size={14} />
        </ToolbarButton>
        <ToolbarButton tip="Redo (Cmd+Shift+Z)" onClick={redo} disabled={!canRedo}>
          <Redo2 size={14} />
        </ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton tip={locked ? "Unlock view" : "Lock view"} onClick={onToggleLock} active={locked}>
          {locked ? <Lock size={14} /> : <Unlock size={14} />}
        </ToolbarButton>
        <ToolbarButton tip="Auto-layout" onClick={onAutoLayout}>
          <LayoutGrid size={14} />
        </ToolbarButton>
        <ToolbarButton tip="Fit to view" onClick={showAll}>
          <Maximize2 size={14} />
        </ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton tip="Zoom out" onClick={() => zoomOut({ duration: 200 })}>
          <ZoomOut size={14} />
        </ToolbarButton>
        <button
          type="button"
          className="hcms-vz-toolbar-zoom"
          onClick={resetZoom}
          aria-label="Reset zoom"
        >
          {zoomPct}%
        </button>
        <ToolbarButton tip="Zoom in" onClick={() => zoomIn({ duration: 200 })}>
          <ZoomIn size={14} />
        </ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton tip="Export PNG" onClick={exportImage}>
          <Download size={14} />
        </ToolbarButton>
        <ToolbarButton tip={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={toggleTheme}>
          {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton tip="Filter (coming soon)" onClick={() => undefined} disabled>
          <Search size={14} />
        </ToolbarButton>
      </div>
    </TooltipProvider>
  );
}

function ToolbarSeparator() {
  return <span className="hcms-vz-toolbar-sep" aria-hidden />;
}

function ToolbarButton({
  tip,
  onClick,
  children,
  disabled,
  active
}: {
  tip: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={tip}
        className={cn(
          "hcms-vz-toolbar-btn",
          active && "hcms-vz-toolbar-btn--active",
          disabled && "hcms-vz-toolbar-btn--disabled"
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
