import { circuitElementList } from "../metadata";
import modules from "../modules";
import { canonicaliseScope } from "./canonical";
import { resetup } from "../setup";
import Node from "../node";

type CanonicalComponent = {
  id: string;
  type: string;
  label: string;
  bitWidth: number;
  connections: Record<string, string>;
  properties: Record<string, unknown>;
  defaultState?: unknown;
};

type CanonicalNet = {
  id: string;
  bitWidth: number;
  connections: string[];
};

type InterfacePort = {
  componentId: string;
  label: string;
  bitWidth: number;
  subcircuitExposed: true;
  order: number;
};

type IntermediateNet = {
  nodes: Array<{ x: number; y: number }>;
  edges: Array<[number, number]>;
  portConnections: Array<{ portRef: string; nodeId: number }>;
};

type CanonicalLayoutNode = {
  x?: number;
  y?: number;
  labelDirection?: unknown;
  [key: string]: unknown;
};

type CanonicalLayoutSymbol = {
  width: number;
  height: number;
  titleX: number;
  titleY: number;
  titleEnabled: boolean;
};

type CanonicalLayout = Record<string, CanonicalLayoutNode> & {
  intermediateNodes?: Record<string, IntermediateNet>;
  subcircuitSymbol?: CanonicalLayoutSymbol;
};

type CanonicalNetlist = {
  components: CanonicalComponent[];
  canonicalHash?: string;
  projectMetadata?: {
    id?: string;
    name?: string;
    timeStamp?: string | number | null;
    restrictedElementsUsed?: string[];
  };
  netlist: CanonicalNetlist;
  interfacePorts: {
    inputs: InterfacePort[];
    outputs: InterfacePort[];
  };
  layout?: CanonicalLayout;
  visual?: {
    canvas?: {
      scale?: number;
      ox?: number;
      oy?: number;
    };
  };
  verilogMetadata?: Record<string, unknown>;
};

type CanonicalJson = {
  formatVersion?: string;
  canonicalHash?: string;
  circuits: Record<string, CanonicalSingleScopeData>;
};

type ScopeLike = {
  id?: string;
  name?: string;
  timeStamp?: string | number | null;
  allNodes: unknown[];
  scale?: number;
  ox?: number;
  oy?: number;
  layout?: {
    width?: number;
    height?: number;
    titleX?: number;
    titleY?: number;
    titleEnabled?: boolean;
  };
  root: unknown;
  centerFocus?: (force: boolean) => void;
  [key: string]: unknown;
};

type PortNode = {
  connect(other: PortNode): void;
};

type ComponentConstructor = new (
  x: number,
  y: number,
  scope: ScopeLike,
  direction: string,
  ...rest: unknown[]
) => ComponentInstance;

type ComponentInstance = {
  label: string;
  propagationDelay?: number;
  labelDirection?: unknown;
  state?: unknown;
  [key: string]: unknown;
};

type NodeConstructor = new (
  x: number,
  y: number,
  type: number,
  parent: unknown,
  bitWidth?: number,
) => PortNode;

export type ValidationResult = { valid: true; errors: [] } | { valid: false; errors: string[] };

export type ImportResult = {
  success: boolean;
  imported: number;
  errors: string[];
};

export function validateCanonicalJson(circuitData: CanonicalSingleScopeData): ValidationResult {
  const errors: string[] = [];
  const knownTypes = new Set<string>(circuitElementList);

  if (!circuitData.netlist) errors.push("Missing netlist");
  if (!Array.isArray(circuitData.netlist?.components))
    errors.push("netlist.components must be an array");
  if (!Array.isArray(circuitData.netlist?.nets)) errors.push("netlist.nets must be an array");
  if (!circuitData.interfacePorts) errors.push("Missing interfacePorts");

  if (Array.isArray(circuitData.netlist?.components)) {
    for (let i = 0; i < circuitData.netlist.components.length; i++) {
      const comp = circuitData.netlist.components[i];
      if (!comp?.id || typeof comp.id !== "string") errors.push(`component[${i}] missing valid id`);
      if (!comp?.type || !knownTypes.has(comp.type))
        errors.push(`component[${i}] has unknown type: ${comp?.type}`);
      if (!comp?.connections || typeof comp.connections !== "object")
        errors.push(`component[${i}] missing connections object`);
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors: [] };
}

function buildComponents(
  scope: ScopeLike,
  components: CanonicalComponent[],
  layout: CanonicalLayout | undefined,
): Map<string, ComponentInstance> {
  const instanceMap = new Map<string, ComponentInstance>();

  for (let i = 0; i < components.length; i++) {
    const { id, type, bitWidth, label, properties } = components[i];
    const pos: CanonicalLayoutNode = layout?.[id] ?? { x: 0, y: 0 };

    if (type === "SubCircuit") {
      console.warn(`[importCanonical] SubCircuit "${id}" will be implemented later`);
      continue;
    }

    const Constructor = (modules as Record<string, ComponentConstructor | undefined>)[type];
    if (typeof Constructor !== "function") {
      console.warn(`[importCanonical] No constructor for type "${type}" (id: ${id})`);
      continue;
    }

    // Use constructorParamaters from properties when available.
    // These are the exact positional args (beyond x, y, scope) from the
    // original component's customSave(), so they correctly reconstruct
    // every structural variant: gate input counts, mux select widths,
    // splitter lane widths, ROM data, etc.
    // Falls back to [direction, bitWidth] for older canonical files.
    const constructorArgs: unknown[] = Array.isArray(properties?.constructorParamaters)
      ? (properties.constructorParamaters as unknown[])
      : [(properties?.direction as string) ?? "RIGHT", bitWidth];

    let instance: ComponentInstance;
    try {
      instance = new Constructor(pos.x ?? 0, pos.y ?? 0, scope, ...constructorArgs);
    } catch (err) {
      console.error(`[importCanonical] Failed to construct "${type}" (id: ${id}):`, err);
      continue;
    }

    instance.label = label;

    if (typeof properties?.propagationDelay === "number") {
      instance.propagationDelay = properties.propagationDelay;
    }

    if (pos.labelDirection !== undefined) {
      instance.labelDirection = pos.labelDirection;
    }

    instanceMap.set(id, instance);
  }

  return instanceMap;
}

function resolvePortNode(
  portRef: string,
  instanceMap: Map<string, ComponentInstance>,
): PortNode | null {
  const dotIdx = portRef.indexOf(".");
  if (dotIdx === -1) return null;

  const compId = portRef.substring(0, dotIdx);
  const portName = portRef.substring(dotIdx + 1);

  const instance = instanceMap.get(compId);
  if (!instance) {
    console.warn(`[importCanonical] resolvePortNode: no instance for "${compId}"`);
    return null;
  }

  const lastUnderscoreIdx = portName.lastIndexOf("_");
  if (lastUnderscoreIdx > 0) {
    const base = portName.substring(0, lastUnderscoreIdx);
    const idx = parseInt(portName.substring(lastUnderscoreIdx + 1), 10);

    if (!isNaN(idx) && idx >= 0 && Array.isArray(instance[base])) {
      const node = (instance[base] as PortNode[])[idx];
      if (node) return node;
      console.warn(`[importCanonical] Array port "${portRef}" index out of range`);
      return null;
    }
  }

  const node = instance[portName] as PortNode | undefined;
  if (node) return node;

  console.warn(`[importCanonical] Port not found: "${portName}" on "${compId}"`);
  return null;
}

function wireComponents(
  instanceMap: Map<string, ComponentInstance>,
  nets: CanonicalNet[],
  intermediateNodesByNet?: Record<string, IntermediateNet> | null,
): void {
  const graphRoutedNetIds = new Set<string>(
    Object.entries(intermediateNodesByNet ?? {})
      .filter(
        ([, routing]) =>
          routing != null &&
          !Array.isArray(routing) &&
          Array.isArray(routing.nodes) &&
          routing.nodes.length > 0,
      )
      .map(([netId]) => netId),
  );

  for (const net of nets) {
    if (graphRoutedNetIds.has(net.id)) continue;

    const portNodes = net.connections
      .map((ref) => resolvePortNode(ref, instanceMap))
      .filter((node): node is PortNode => node !== null);

    if (portNodes.length < 2) {
      if (portNodes.length === 1)
        console.warn(`[importCanonical] net "${net.id}": only 1 node resolved, skipping`);
      continue;
    }

    for (let i = 1; i < portNodes.length; i++) {
      try {
        portNodes[i - 1].connect(portNodes[i]);
      } catch (err) {
        console.error(
          `[importCanonical] Wire failed on net "${net.id}": ${net.connections[i - 1]} and ${net.connections[i]}`,
          err,
        );
      }
    }
  }
}

// Registry of stateful component types and the instance property that holds
// their initial output value.  Mirrors STATEFUL_DEFAULT_STATE in canonical.ts.
const STATEFUL_TYPES: Record<string, string> = {
  Input: "state",
  ConstantVal: "state",
  DflipFlop: "slaveState",
  TflipFlop: "slaveState",
  SRflipFlop: "state",
  JKflipFlop: "state",
  Dlatch: "state",
  Counter: "value",
  Stepper: "state",
};

function restoreDefaultState(
  instanceMap: Map<string, ComponentInstance>,
  components: CanonicalComponent[],
): void {
  for (const compData of components) {
    if (compData.defaultState === undefined) continue;

    const instance = instanceMap.get(compData.id);
    if (!instance) continue;

    const stateProp = STATEFUL_TYPES[compData.type];
    if (stateProp) {
      (instance as Record<string, unknown>)[stateProp] = compData.defaultState;
    }
  }
}

function restoreIntermediateNodes(
  scope: ScopeLike,
  intermediateNodes: Record<string, IntermediateNet>,
  instanceMap: Map<string, ComponentInstance>,
  nets: CanonicalNet[] = [],
): void {
  if (!intermediateNodes || Object.keys(intermediateNodes).length === 0) return;

  const netBitWidthMap = new Map<string, number>(
    (nets ?? []).map((net) => [net.id, net.bitWidth] as [string, number]),
  );

  for (const [netId, routing] of Object.entries(intermediateNodes)) {
    const { nodes: junctionPoints, edges, portConnections } = routing;
    if (!junctionPoints || junctionPoints.length === 0) continue;

    const netBitWidth = netBitWidthMap.get(netId);
    const NodeCtor = Node as unknown as NodeConstructor;
    const junctionNodes: (PortNode | null)[] = [];
    for (const point of junctionPoints) {
      try {
        const node: PortNode =
          netBitWidth !== undefined
            ? new NodeCtor(point.x, point.y, 2, scope.root, netBitWidth)
            : new NodeCtor(point.x, point.y, 2, scope.root);
        junctionNodes.push(node);
      } catch (err) {
        console.error(
          `[importCanonical] Failed to create junction at (${point.x},${point.y}) for ${netId}:`,
          err,
        );
        junctionNodes.push(null);
      }
    }

    for (const [fromId, toId] of edges) {
      const fromNode = junctionNodes[fromId];
      const toNode = junctionNodes[toId];
      if (fromNode && toNode) {
        try {
          fromNode.connect(toNode);
        } catch (err) {
          console.error(
            `[importCanonical] junction-to-junction connection failed for net "${netId}" (${fromId} -> ${toId}):`,
            err,
          );
        }
      }
    }

    for (const { portRef, nodeId } of portConnections) {
      const junctionNode = junctionNodes[nodeId];
      if (!junctionNode) continue;

      const portNode = resolvePortNode(portRef, instanceMap);
      if (!portNode) {
        console.warn(`[importCanonical] portConnection: cannot resolve "${portRef}"`);
        continue;
      }

      try {
        portNode.connect(junctionNode);
      } catch (err) {
        console.error(
          `[importCanonical] port-to-junction connection failed for net "${netId}" (port "${portRef}" -> node ${nodeId}):`,
          err,
        );
      }
    }
  }
}

function restoreScopeMetadata(scope: ScopeLike, circuitData: CanonicalSingleScopeData): void {
  if (circuitData.projectMetadata?.name) {
    scope.name = circuitData.projectMetadata.name;
  }

  if (circuitData.visual?.canvas) {
    const { scale, ox, oy } = circuitData.visual.canvas;
    scope.scale = scale ?? 1;
    scope.ox = ox ?? 0;
    scope.oy = oy ?? 0;
  }

  if (circuitData.layout?.subcircuitSymbol) {
    const sym = circuitData.layout.subcircuitSymbol;
    scope.layout = {
      width: sym.width ?? 100,
      height: sym.height ?? 100,
      titleX: sym.titleX ?? 50,
      titleY: sym.titleY ?? 13,
      titleEnabled: sym.titleEnabled ?? true,
    };
  }
}

function refreshCanvas(scope: ScopeLike, hasRestoredViewport = false): void {
  try {
    if (!hasRestoredViewport && typeof scope.centerFocus === "function") {
      scope.centerFocus(true);
    }
    if (typeof resetup === "function") resetup();
    const renderCanvas = (globalThis as unknown as { renderCanvas?: () => void }).renderCanvas;
    if (typeof renderCanvas === "function") {
      renderCanvas();
    }
  } catch (err) {
    console.warn("[importCanonical] Canvas refresh failed:", err);
  }
}

async function verifyRoundTrip(
  scope: ScopeLike,
  expectedHash: string,
): Promise<{ match: boolean; actualHash: string | undefined; expectedHash: string }> {
  const reExported = await canonicaliseScope(scope as Parameters<typeof canonicaliseScope>[0]);
  const actualHash = reExported.canonicalHash;

  const match = actualHash === expectedHash;

  const header =
    "[importCanonical] Round-trip check\n" +
    `  scopeId: ${String(scope?.id)}\n` +
    `  present hash: ${expectedHash}\n` +
    "  now exporting...\n" +
    `  exported hash: ${actualHash}\n`;

  if (match) {
    console.log(header + "  result: PASS");
  } else {
    console.warn(
      header + "  result: FAIL\n" + "  Import did not reproduce the original netlist exactly.",
    );
  }

  return { match, actualHash, expectedHash };
}

export async function importCanonical(
  json: CanonicalJson,
  targetScope: ScopeLike | null | undefined,
): Promise<ImportResult> {
  const results: ImportResult = {
    success: false,
    imported: 0,
    errors: [],
  };

  if (!json.circuits || typeof json.circuits !== "object") {
    results.errors.push("Missing circuits object in JSON");
    return results;
  }

  const circuits = Object.entries(json.circuits).map(([scopeId, circuitData]) => ({
    scopeId,
    circuitData,
  }));

  if (circuits.length === 0) {
    results.errors.push("No circuits found in JSON");
    return results;
  }

  for (const { scopeId, circuitData } of circuits) {
    const validation = validateCanonicalJson(circuitData);
    if (!validation.valid) {
      console.error(`[importCanonical] Validation failed for "${scopeId}":`);
      results.errors.push(...validation.errors);
      continue;
    }

    if (!targetScope) {
      results.errors.push(`No scope provided for circuit "${scopeId}"`);
      continue;
    }

    const scope = targetScope;
    const layout = circuitData.layout;
    const { components, nets } = circuitData.netlist;

    const instanceMap = buildComponents(scope, components, layout);

    if (components.length > 0 && instanceMap.size === 0) {
      results.errors.push(`[${scopeId}] no components could be constructed`);
      continue;
    }

    wireComponents(instanceMap, nets, layout?.intermediateNodes);
    restoreDefaultState(instanceMap, components);

    if (layout?.intermediateNodes) {
      restoreIntermediateNodes(scope, layout.intermediateNodes, instanceMap, nets);
    }

    restoreScopeMetadata(scope, circuitData);

    refreshCanvas(scope, Boolean(circuitData.visual?.canvas));

    if (circuitData.canonicalHash) {
      const verification = await verifyRoundTrip(scope, circuitData.canonicalHash);
      if (!verification.match) {
        console.warn(`[importCanonical] Round-trip mismatch for "${scopeId}"`);
      }
    }

    if (instanceMap.size > 0 || components.length === 0) {
      results.imported++;
    }
  }

  results.success = results.imported > 0;
  return results;
}

if (typeof window !== "undefined") {
  (
    window as Window & {
      importCanonical?: typeof importCanonical;
      validateCanonicalJson?: typeof validateCanonicalJson;
    }
  ).importCanonical = importCanonical;
  (
    window as Window & {
      importCanonical?: typeof importCanonical;
      validateCanonicalJson?: typeof validateCanonicalJson;
    }
  ).validateCanonicalJson = validateCanonicalJson;
}
