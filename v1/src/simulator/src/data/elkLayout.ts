// NOTE:Clean git diff

import ELKConstructor, { type ELK as ELKApi } from "elkjs/lib/elk-api";
import ELKWorker from "elkjs/lib/elk-worker.min.js?worker";
import type { ElkExtendedEdge, ElkNode, ElkPoint, ElkPort } from "elkjs/lib/elk-api";

import type Node from "../node";
import type {
  CanonicalComponent,
  CanonicalLayout,
  CanonicalNet,
  ComponentInstance,
  Direction,
  IntermediateNet,
  SubcircuitSymbol,
} from "../types/canonical.types";

type LayoutInstance = ComponentInstance & {
  x: number;
  y: number;
  oldx?: number;
  oldy?: number;
  direction: Direction;
  directionFixed?: boolean;
  overrideDirectionRotation?: boolean;
  leftDimensionX: number;
  rightDimensionX: number;
  upDimensionY: number;
  downDimensionY: number;
  nodeList: Node[];
};

type Bounds = {
  left: number;
  right: number;
  up: number;
  down: number;
};

type EdgeMetadata = {
  netId: string;
  source: string;
  target: string;
};

const GRID_SIZE = 10;

let elk: ELKApi | undefined;

function getElk(): ELKApi {
  elk ??= new ELKConstructor({
    algorithms: ["layered"],
    workerFactory: () => new ELKWorker(),
  });
  return elk;
}

function resolvePortNode(
  portRef: string,
  instanceMap: Map<string, ComponentInstance>,
): Node | null {
  const dotIdx = portRef.indexOf(".");
  if (dotIdx === -1) return null;

  const instance = instanceMap.get(portRef.substring(0, dotIdx));
  if (!instance) return null;

  const portName = portRef.substring(dotIdx + 1);
  const lastUnderscoreIdx = portName.lastIndexOf("_");
  if (lastUnderscoreIdx > 0) {
    const base = portName.substring(0, lastUnderscoreIdx);
    const idx = Number(portName.substring(lastUnderscoreIdx + 1));
    const ports = Reflect.get(instance, base);
    if (Array.isArray(ports)) {
      return (ports[idx] as Node | undefined) ?? null;
    }
  }

  return (Reflect.get(instance, portName) as Node | undefined) ?? null;
}

function getBounds(instance: LayoutInstance): Bounds {
  let left = instance.leftDimensionX;
  let right = instance.rightDimensionX;
  let up = instance.upDimensionY;
  let down = instance.downDimensionY;

  if (!instance.directionFixed && !instance.overrideDirectionRotation) {
    if (instance.direction === "LEFT") {
      [left, right] = [right, left];
    } else if (instance.direction === "DOWN") {
      [left, right, up, down] = [down, up, left, right];
    } else if (instance.direction === "UP") {
      [left, right, up, down] = [down, up, right, left];
    }
  }

  return { left, right, up, down };
}

function portSide(node: Node, bounds: Bounds): string {
  const distances = [
    { side: "WEST", distance: Math.abs(node.x + bounds.left) },
    { side: "EAST", distance: Math.abs(bounds.right - node.x) },
    { side: "NORTH", distance: Math.abs(node.y + bounds.up) },
    { side: "SOUTH", distance: Math.abs(bounds.down - node.y) },
  ];
  distances.sort((a, b) => a.distance - b.distance);
  return distances[0].side;
}

function buildElkNode(
  component: CanonicalComponent,
  instanceMap: Map<string, ComponentInstance>,
  portRefs: Set<string>,
): ElkNode {
  const instance = instanceMap.get(component.id) as LayoutInstance;
  const bounds = getBounds(instance);

  const ports: ElkPort[] = [];
  for (const portRef of portRefs) {
    if (!portRef.startsWith(`${component.id}.`)) continue;
    const node = resolvePortNode(portRef, instanceMap);
    if (!node) continue;

    ports.push({
      id: portRef,
      x: node.x + bounds.left,
      y: node.y + bounds.up,
      width: 1,
      height: 1,
      layoutOptions: {
        "elk.port.side": portSide(node, bounds),
      },
    });
  }

  return {
    id: component.id,
    width: bounds.left + bounds.right,
    height: bounds.up + bounds.down,
    ports,
    layoutOptions: {
      "elk.portConstraints": "FIXED_POS",
    },
  };
}

function buildElkEdges(
  nets: CanonicalNet[],
  instanceMap: Map<string, ComponentInstance>,
): { edges: ElkExtendedEdge[]; metadata: Map<string, EdgeMetadata> } {
  const edges: ElkExtendedEdge[] = [];
  const metadata = new Map<string, EdgeMetadata>();

  for (const net of nets) {
    if (net.connections.length < 2) continue;

    const outputRef = net.connections.find(
      (portRef) => resolvePortNode(portRef, instanceMap)?.type === 1,
    );
    const source = outputRef ?? net.connections[0];
    const targets = net.connections.filter((portRef) => portRef !== source);

    for (let i = 0; i < targets.length; i++) {
      const id = `${net.id}:elk:${String(i)}`;
      const target = targets[i];
      edges.push({ id, sources: [source], targets: [target] });
      metadata.set(id, { netId: net.id, source, target });
    }
  }

  return { edges, metadata };
}

function pointKey(point: ElkPoint): string {
  const x = Math.round(point.x / GRID_SIZE) * GRID_SIZE;
  const y = Math.round(point.y / GRID_SIZE) * GRID_SIZE;
  return `${String(x)},${String(y)}`;
}

function addPoint(
  point: ElkPoint,
  routing: IntermediateNet,
  pointIds: Map<string, number>,
): number {
  const key = pointKey(point);
  const existing = pointIds.get(key);
  if (existing !== undefined) return existing;

  const id = routing.nodes.length;
  routing.nodes.push({
    x: Math.round(point.x / GRID_SIZE) * GRID_SIZE,
    y: Math.round(point.y / GRID_SIZE) * GRID_SIZE,
  });
  pointIds.set(key, id);
  return id;
}

function addPortConnection(routing: IntermediateNet, portRef: string, nodeId: number): void {
  if (routing.portConnections.some((entry) => entry.portRef === portRef)) return;
  routing.portConnections.push({ portRef, nodeId });
}

function buildIntermediateNodes(
  edges: ElkExtendedEdge[],
  metadata: Map<string, EdgeMetadata>,
): Record<string, IntermediateNet> {
  const result: Record<string, IntermediateNet> = {};
  const pointIdsByNet = new Map<string, Map<string, number>>();

  for (const edge of edges) {
    const info = metadata.get(edge.id);
    if (!info || !edge.sections?.length) continue;

    const routing = (result[info.netId] ??= {
      nodes: [],
      edges: [],
      portConnections: [],
    });
    const pointIds = pointIdsByNet.get(info.netId) ?? new Map<string, number>();
    pointIdsByNet.set(info.netId, pointIds);

    let firstNodeId: number | undefined;
    let lastNodeId: number | undefined;

    for (const section of edge.sections) {
      const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
      const nodeIds = points.map((point) => addPoint(point, routing, pointIds));

      firstNodeId ??= nodeIds[0];
      lastNodeId = nodeIds[nodeIds.length - 1];

      for (let i = 1; i < nodeIds.length; i++) {
        if (nodeIds[i - 1] === nodeIds[i]) continue;
        const segment: [number, number] = [nodeIds[i - 1], nodeIds[i]];
        if (
          !routing.edges.some(
            ([from, to]) =>
              (from === segment[0] && to === segment[1]) ||
              (from === segment[1] && to === segment[0]),
          )
        ) {
          routing.edges.push(segment);
        }
      }

      if (section.incomingShape === info.source) {
        addPortConnection(routing, info.source, nodeIds[0]);
      }
      if (section.outgoingShape === info.target) {
        addPortConnection(routing, info.target, nodeIds[nodeIds.length - 1]);
      }
    }

    if (firstNodeId !== undefined) {
      addPortConnection(routing, info.source, firstNodeId);
    }
    if (lastNodeId !== undefined) {
      addPortConnection(routing, info.target, lastNodeId);
    }
  }

  for (const [netId, routing] of Object.entries(result)) {
    if (routing.nodes.length === 0 || routing.portConnections.length < 2) {
      delete result[netId];
    }
  }

  return result;
}

function defaultSubcircuitSymbol(componentCount: number): SubcircuitSymbol {
  return {
    width: 100,
    height: Math.max(40, componentCount * 10),
    titleX: 50,
    titleY: 13,
    titleEnabled: true,
  };
}

export async function generateElkLayout(
  components: CanonicalComponent[],
  nets: CanonicalNet[],
  instanceMap: Map<string, ComponentInstance>,
): Promise<CanonicalLayout> {
  const portRefs = new Set(nets.flatMap((net) => net.connections));
  const { edges, metadata } = buildElkEdges(nets, instanceMap);

  const graph: ElkNode = {
    id: "root",
    children: components.map((component) => buildElkNode(component, instanceMap, portRefs)),
    edges,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "60",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.randomSeed": "1",
      "elk.padding": "[top=30,left=30,bottom=30,right=30]",
    },
  };

  const laidOut = await getElk().layout(graph);
  const layout: CanonicalLayout = {
    subcircuitSymbol: defaultSubcircuitSymbol(components.length),
  };

  for (const child of laidOut.children ?? []) {
    const instance = instanceMap.get(child.id) as LayoutInstance | undefined;
    if (!instance || child.x === undefined || child.y === undefined) continue;
    const bounds = getBounds(instance);
    layout[child.id] = {
      x: Math.round((child.x + bounds.left) / GRID_SIZE) * GRID_SIZE,
      y: Math.round((child.y + bounds.up) / GRID_SIZE) * GRID_SIZE,
      labelDirection: instance.labelDirection,
    };
  }

  const intermediateNodes = buildIntermediateNodes(laidOut.edges ?? [], metadata);
  if (Object.keys(intermediateNodes).length > 0) {
    layout.intermediateNodes = intermediateNodes;
  }

  return layout;
}
