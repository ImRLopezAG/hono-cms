/**
 * SVG marker definitions for relation edges.
 *
 * Two visual families:
 *   - "crow's-foot" markers (`hcms-marker-one|many|zero-one|zero-many`)
 *     used as stroke markers on the BaseEdge path. They sit at the
 *     terminus of an edge to denote cardinality.
 *   - "dot" markers (`hcms-dot-one|many` × selected/not) used as inline
 *     bubbles overlaid on the edge mid-point — ported from chartdb's
 *     `marker-definitions.tsx`. They give a one-glance read of which
 *     side is the "1" and which side is the "N".
 *
 * Keeping these in one place means the rest of the visualizer can
 * reference markers by id and stay framework-agnostic.
 */
export function CanvasMarkers() {
  return (
    <svg
      className="hcms-marker-defs"
      width="0"
      height="0"
      style={{ position: "absolute" }}
      aria-hidden
    >
      <defs>
        {/* ---- Crow's-foot terminus markers --------------------- */}
        <marker
          id="hcms-marker-one"
          viewBox="-10 -10 20 20"
          refX="0"
          refY="0"
          markerWidth="14"
          markerHeight="14"
          orient="auto-start-reverse"
        >
          <line x1="-6" y1="-6" x2="-6" y2="6" stroke="currentColor" strokeWidth="1.5" />
          <line x1="-3" y1="0" x2="6" y2="0" stroke="currentColor" strokeWidth="1.5" />
        </marker>
        <marker
          id="hcms-marker-many"
          viewBox="-10 -10 20 20"
          refX="0"
          refY="0"
          markerWidth="14"
          markerHeight="14"
          orient="auto-start-reverse"
        >
          <line x1="-6" y1="-6" x2="6" y2="0" stroke="currentColor" strokeWidth="1.5" />
          <line x1="-6" y1="0" x2="6" y2="0" stroke="currentColor" strokeWidth="1.5" />
          <line x1="-6" y1="6" x2="6" y2="0" stroke="currentColor" strokeWidth="1.5" />
        </marker>
        <marker
          id="hcms-marker-zero-one"
          viewBox="-12 -10 22 20"
          refX="0"
          refY="0"
          markerWidth="16"
          markerHeight="14"
          orient="auto-start-reverse"
        >
          <circle cx="-7" cy="0" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <line x1="-3" y1="-6" x2="-3" y2="6" stroke="currentColor" strokeWidth="1.5" />
          <line x1="0" y1="0" x2="6" y2="0" stroke="currentColor" strokeWidth="1.5" />
        </marker>
        <marker
          id="hcms-marker-zero-many"
          viewBox="-12 -10 22 20"
          refX="0"
          refY="0"
          markerWidth="16"
          markerHeight="14"
          orient="auto-start-reverse"
        >
          <circle cx="-7" cy="0" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <line x1="-3" y1="-6" x2="6" y2="0" stroke="currentColor" strokeWidth="1.5" />
          <line x1="-3" y1="0" x2="6" y2="0" stroke="currentColor" strokeWidth="1.5" />
          <line x1="-3" y1="6" x2="6" y2="0" stroke="currentColor" strokeWidth="1.5" />
        </marker>

        {/* ---- Chartdb-style filled dot bubbles ----------------- */}
        {(["one", "many"] as const).flatMap((card) =>
          (["left", "right"] as const).flatMap((side) =>
            ([true, false] as const).map((selected) => (
              <marker
                key={`hcms-dot-${card}-${side}-${selected ? "sel" : "def"}`}
                id={`hcms-dot-${card}-${side}-${selected ? "sel" : "def"}`}
                viewBox="0 0 16 16"
                markerWidth="16"
                markerHeight="16"
                refX={side === "left" ? "15" : "1"}
                refY="8"
              >
                <circle
                  cx="8"
                  cy="8"
                  r="5"
                  fill={selected ? "var(--hcms-vz-accent, #4f46e5)" : "var(--hcms-vz-edge-muted, #64748b)"}
                  stroke="var(--hcms-vz-canvas-bg, #ffffff)"
                  strokeWidth="0.5"
                />
                <text
                  x="8"
                  y="8.4"
                  fontSize="6"
                  fontWeight="600"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="#ffffff"
                >
                  {card === "one" ? "1" : "N"}
                </text>
              </marker>
            ))
          )
        )}
      </defs>
    </svg>
  );
}
