import dagre from "dagre";
import type { CollectionNode, GraphResult, RelationEdge } from "./types";
import {
  COLLECTION_NODE_HEADER_HEIGHT,
  COLLECTION_NODE_ROW_HEIGHT,
  COLLECTION_NODE_WIDTH
} from "./types";

export type AutoLayoutOptions = {
  direction?: "TB" | "LR" | "BT" | "RL";
  ranksep?: number;
  nodesep?: number;
};

function estimateNodeHeight(node: CollectionNode): number {
  const fieldCount = Object.keys(node.data.collection.fields).length;
  return COLLECTION_NODE_HEADER_HEIGHT + Math.max(fieldCount, 1) * COLLECTION_NODE_ROW_HEIGHT + 24;
}

/**
 * Lay out the collection sub-graph with dagre. Area and note nodes are
 * passed through untouched — they have user-chosen positions and would
 * fight dagre for space.
 */
export function autoLayout(graph: GraphResult, options: AutoLayoutOptions = {}): GraphResult {
  const { direction = "LR", ranksep = 100, nodesep = 70 } = options;
  const collectionNodes = graph.nodes.filter((n): n is CollectionNode => n.type === "collection");
  const otherNodes = graph.nodes.filter((n) => n.type !== "collection");

  const g = new dagre.graphlib.Graph({ multigraph: true, compound: false });
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, ranksep, nodesep, marginx: 40, marginy: 40 });

  for (const node of collectionNodes) {
    g.setNode(node.id, {
      width: COLLECTION_NODE_WIDTH,
      height: estimateNodeHeight(node)
    });
  }
  for (const edge of graph.edges) {
    g.setEdge(edge.source, edge.target, {}, edge.id);
  }

  dagre.layout(g);

  const positionedCollections: CollectionNode[] = collectionNodes.map((node) => {
    const dagreNode = g.node(node.id);
    if (!dagreNode) return node;
    return {
      ...node,
      position: {
        x: dagreNode.x - COLLECTION_NODE_WIDTH / 2,
        y: dagreNode.y - dagreNode.height / 2
      }
    };
  });

  return {
    nodes: [...otherNodes, ...positionedCollections],
    edges: graph.edges as RelationEdge[]
  };
}
