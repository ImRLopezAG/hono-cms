import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps
} from "@xyflow/react";
import { cn } from "@/lib/utils";
import type { RelationEdge as RelationEdgeShape } from "../../lib/visualizer/types";

/**
 * Map a `RelationCardinality` to the (start, end) crow's-foot terminus
 * markers. The convention used here matches chartdb:
 *   - "many-to-one"  source = many, target = one
 *   - "one-to-many"  source = one, target = many
 *   - "*-zero-*"     when the field is optional we show the "zero or"
 *                    bubble at the corresponding side.
 *
 * When the relation field is optional (`required: false`) we substitute
 * the "zero or {one,many}" marker so the edge tells you the row may not
 * exist on that side without opening a tooltip.
 */
function pickMarkers(
  cardinality: RelationEdgeShape["data"] extends infer D ? D extends { cardinality: infer C } ? C : never : never,
  required: boolean | undefined
): { start: string; end: string } {
  const opt = required === false;
  const startMany = opt ? "hcms-marker-zero-many" : "hcms-marker-many";
  const startOne = opt ? "hcms-marker-zero-one" : "hcms-marker-one";
  const endMany = "hcms-marker-many";
  const endOne = "hcms-marker-one";
  switch (cardinality) {
    case "one":
    case "one-to-one":
      return { start: startOne, end: endOne };
    case "many":
    case "many-to-one":
      return { start: startMany, end: endOne };
    case "one-to-many":
      return { start: startOne, end: endMany };
    case "many-to-many":
      return { start: startMany, end: endMany };
    default:
      return { start: startMany, end: endOne };
  }
}

const CARDINALITY_LABEL: Record<string, string> = {
  one: "1",
  many: "N",
  "one-to-one": "1—1",
  "many-to-one": "N—1",
  "one-to-many": "1—N",
  "many-to-many": "N—N"
};

export const RelationEdge = memo(function RelationEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  id
}: EdgeProps<RelationEdgeShape>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 8
  });
  const cardinality = data?.cardinality ?? "many-to-one";
  const { start, end } = pickMarkers(cardinality, data?.required);
  const startMarker = `url(#${start})`;
  const endMarker = `url(#${end})`;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerStart={startMarker}
        markerEnd={endMarker}
        className={cn(
          "hcms-edge",
          selected && "hcms-edge--selected"
        )}
        style={{
          stroke: selected
            ? "var(--hcms-vz-accent, #4f46e5)"
            : "var(--hcms-vz-edge-muted, #94a3b8)",
          strokeWidth: selected ? 2 : 1.5,
          color: selected
            ? "var(--hcms-vz-accent, #4f46e5)"
            : "var(--hcms-vz-edge-muted, #94a3b8)"
        }}
      />
      <EdgeLabelRenderer>
        <div
          className={cn("hcms-edge-label", selected && "hcms-edge-label--visible")}
          style={{
            position: "absolute",
            transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: "none"
          }}
        >
          <span className="hcms-edge-label-text">{data?.sourceField ?? ""}</span>
          <span className="hcms-edge-label-card">
            {CARDINALITY_LABEL[cardinality] ?? cardinality}
          </span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
