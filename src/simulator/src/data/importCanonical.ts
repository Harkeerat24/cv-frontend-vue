import modules from "../modules";
import { canonicaliseScope } from "./canonical";
import { resetup } from "../setup";
import Node from "../node";

// ── Types mirroring canonical.ts ──────────────────────────────────────────

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

type SubcircuitPort = {
  componentId: string;
  label: string;
  bitWidth: number;
  subcircuitExposed: true;
  order: number;
};

// IntermediateNet.nodes carries an `id` field matching canonical.ts (line 101)
type IntermediateNet = {
  nodes: Array<{ id: number; x: number; y: number }>;
  edges: Array<[number, number]>;
  portConnections: Array<{ portRef: string; nodeId: number }>;
};

type SubcircuitSymbolLayout = {
  width: number;
  height: number;
  titleX: number;
  titleY: number;
  titleEnabled: boolean;
};

type CanonicalLayout = {
  [componentId: string]:
    | { x?: number; y?: number; labelDirection?: unknown; [key: string]: unknown }
    | Record<string, IntermediateNet>
    | SubcircuitSymbolLayout
    | undefined;
  intermediateNodes?: Record<string, IntermediateNet>;
  subcircuitSymbol?: SubcircuitSymbolLayout;
};

// Single scope — mirrors CanonicalScope in canonical.ts exactly
type CanonicalScope = {
  canonicalHash: string;
  projectMetadata: {
    id?: number;
    name: string;
    timeStamp: string | number | null;
    restrictedElementsUsed: string[];
  };
  netlist: {
    components: CanonicalComponent[];
    nets: CanonicalNet[];
  };
  interfacePorts: {
    inputs: SubcircuitPort[];
    outputs: SubcircuitPort[];
  };
  layout: CanonicalLayout;
  visual: {
    canvas: {
      scale: number;
      ox: number;
      oy: number;
    };
  };
  verilogMetadata: {
    isVerilogCircuit: boolean;
    isMainCircuit: boolean;
    code: string;
    subCircuitScopeIds: string[];
  };
};

// Top-level project file — mirrors CanonicalProject in canonical.ts
type CanonicalProject = {
  formatVersion: "v1";
  canonicalHash: string;
  circuits: Record<number, CanonicalScope>;
};

// ── Internal runtime types (not exported) ─────────────────────────────────

type ScopeLike = {
  id?: string | number;
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

// ── Public result types ───────────────────────────────────────────────────

export type ValidationResult = { valid: true; errors: [] } | { valid: false; errors: string[] };

export type ImportResult = {
  success: boolean;
  imported: number;
  errors: string[];
};

// ── Constants ─────────────────────────────────────────────────────────────

// Registry of stateful component types and the instance property that holds
// their initial output value. Mirrors STATEFUL_DEFAULT_STATE in canonical.ts.
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

// ── Validation ────────────────────────────────────────────────────────────

// TODO: Replace with JSON Schema validation (deferred).
export function validateCanonicalJson(_circuitData: CanonicalScope): ValidationResult {
  return { valid: true, errors: [] };
}

// ── Layout helpers ────────────────────────────────────────────────────────

// Narrows a CanonicalLayout entry to a component position record.
// Returns a safe default when the entry is absent or is an IntermediateNet /
// SubcircuitSymbolLayout slot rather than a component position.
function getComponentLayout(
  layout: CanonicalLayout | undefined,
  id: string,
): { x?: number; y?: number; labelDirection?: unknown } {
  if (id === "intermediateNodes" || id === "subcircuitSymbol") {
    return { x: 0, y: 0 };
  }
  const entry = layout?.[id];
  if (
    entry != null &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    !("width" in entry && "height" in entry && "titleEnabled" in entry) &&
    !("nodes" in entry)
  ) {
    return entry as { x?: number; y?: number; labelDirection?: unknown };
  }
  return { x: 0, y: 0 };
}

// ── Core import helpers ───────────────────────────────────────────────────

function buildComponents(
  scope: ScopeLike,
  components: CanonicalComponent[],
  layout: CanonicalLayout | undefined,
): Map<string, ComponentInstance> {
  const instanceMap = new Map<string, ComponentInstance>();

  for (let i = 0; i < components.length; i++) {
    const { id, type, bitWidth, label, properties } = components[i];
    const pos = getComponentLayout(layout, id);

    if (type === "SubCircuit") {
      // Part 2: SubCircuit instantiation
      console.warn(`[importCanonical] SubCircuit "${id}" not yet supported`);
      continue;
    }

    const Constructor = (modules as Record<string, ComponentConstructor | undefined>)[type];
    if (typeof Constructor !== "function") {
      console.warn(`[importCanonical] No constructor for type "${type}" (id: ${id})`);
      continue;
    }

    // Older files without constructorParamaters lose direction — "RIGHT" is the
    // least-bad default; round-trip hash will flag the mismatch.
    const constructorArgs: unknown[] = Array.isArray(properties?.constructorParamaters)
      ? (properties.constructorParamaters as unknown[])
      : ["RIGHT", bitWidth];

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

// ── Core wiring / net reconstruction ──────────────────────────────────────

function wireComponents(
  instanceMap: Map<string, ComponentInstance>,
  nets: CanonicalNet[],
  intermediateNodesByNet?: Record<string, IntermediateNet> | null,
): void {
  const graphRoutedNetIds = new Set<string>();
  if (intermediateNodesByNet) {
    for (const netId of Object.keys(intermediateNodesByNet)) {
      const routing = intermediateNodesByNet[netId];
      if (routing && Array.isArray(routing.nodes) && routing.nodes.length > 0) {
        graphRoutedNetIds.add(netId);
      }
    }
  }

  for (let i = 0; i < nets.length; i++) {
    const net = nets[i];
    if (graphRoutedNetIds.has(net.id)) continue;

    const portNodes: PortNode[] = [];
    for (let j = 0; j < net.connections.length; j++) {
      const node = resolvePortNode(net.connections[j], instanceMap);
      if (node !== null) portNodes.push(node);
    }

    if (portNodes.length < 2) {
      if (portNodes.length === 1)
        console.warn(`[importCanonical] net "${net.id}": only 1 node resolved, skipping`);
      continue;
    }

    for (let j = 1; j < portNodes.length; j++) {
      try {
        portNodes[j - 1].connect(portNodes[j]);
      } catch (err) {
        console.error(
          `[importCanonical] Wire failed on net "${net.id}": ${net.connections[j - 1]} and ${net.connections[j]}`,
          err,
        );
      }
    }
  }
}

function restoreDefaultState(
  instanceMap: Map<string, ComponentInstance>,
  components: CanonicalComponent[],
): void {
  for (let i = 0; i < components.length; i++) {
    const compData = components[i];
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

  const netBitWidthMap = new Map<string, number>();
  for (let i = 0; i < nets.length; i++) {
    netBitWidthMap.set(nets[i].id, nets[i].bitWidth);
  }

  const NodeCtor = Node as unknown as NodeConstructor;

  for (const [netId, routing] of Object.entries(intermediateNodes)) {
    const { nodes: junctionPoints, edges, portConnections } = routing;
    if (!junctionPoints || junctionPoints.length === 0) continue;

    const netBitWidth = netBitWidthMap.get(netId);
    const junctionNodes: (PortNode | null)[] = [];

    for (let i = 0; i < junctionPoints.length; i++) {
      const point = junctionPoints[i];
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

    for (let i = 0; i < edges.length; i++) {
      const [fromId, toId] = edges[i];
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

    for (let i = 0; i < portConnections.length; i++) {
      const { portRef, nodeId } = portConnections[i];
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

function restoreScopeMetadata(scope: ScopeLike, circuitData: CanonicalScope): void {
  if (circuitData.projectMetadata.name) {
    scope.name = circuitData.projectMetadata.name;
  }

  // visual.canvas fields are non-optional in CanonicalScope — no fallbacks needed.
  const { scale, ox, oy } = circuitData.visual.canvas;
  scope.scale = scale;
  scope.ox = ox;
  scope.oy = oy;

  if (circuitData.layout.subcircuitSymbol) {
    const sym = circuitData.layout.subcircuitSymbol;
    scope.layout = {
      width: sym.width,
      height: sym.height,
      titleX: sym.titleX,
      titleY: sym.titleY,
      titleEnabled: sym.titleEnabled,
    };
  }

  // Restore verilogMetadata onto the scope (was missing in the old importer).
  if (circuitData.verilogMetadata) {
    scope.verilogMetadata = circuitData.verilogMetadata;
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
): Promise<{ match: boolean; actualHash: string; expectedHash: string }> {
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
      header + "  result: FAIL\n  Import did not reproduce the original netlist exactly.",
    );
  }

  return { match, actualHash, expectedHash };
}

// ── Single-scope import (core logic) ─────────────────────────────────────

async function importSingleScope(
  circuitData: CanonicalScope,
  scope: ScopeLike,
): Promise<{ success: boolean; error?: string }> {
  const { components, nets } = circuitData.netlist;
  const { layout } = circuitData;

  const instanceMap = buildComponents(scope, components, layout);

  if (components.length > 0 && instanceMap.size === 0) {
    return { success: false, error: "no components could be constructed" };
  }

  wireComponents(instanceMap, nets, layout.intermediateNodes);
  restoreDefaultState(instanceMap, components);

  if (layout.intermediateNodes) {
    restoreIntermediateNodes(scope, layout.intermediateNodes, instanceMap, nets);
  }

  restoreScopeMetadata(scope, circuitData);

  // Run the round-trip check on the imported components/wires before canvas/resetup
  // potentially alters the node collection.
  if (circuitData.canonicalHash) {
    await verifyRoundTrip(scope, circuitData.canonicalHash);
  }

  // visual.canvas is always present in CanonicalScope — viewport was restored above.
  refreshCanvas(scope, true);

  return { success: true };
}

// ── Public entry point ────────────────────────────────────────────────────

export async function importCanonical(
  json: CanonicalProject,
  targetScope: ScopeLike | null | undefined,
): Promise<ImportResult> {
  const results: ImportResult = { success: false, imported: 0, errors: [] };

  if (!json.circuits || typeof json.circuits !== "object") {
    results.errors.push("Missing circuits object in JSON");
    return results;
  }

  const circuitEntries = Object.entries(json.circuits) as [string, CanonicalScope][];

  if (circuitEntries.length === 0) {
    results.errors.push("No circuits found in JSON");
    return results;
  }

  if (circuitEntries.length > 1) {
    results.errors.push(
      `Multi-circuit projects not yet supported; importing only "${circuitEntries[0][0]}" (${circuitEntries.length - 1} skipped)`,
    );
  }

  // Part 2: multi-circuit orchestration (topological order, scope creation) goes here.
  // For now, import only the first circuit into the provided targetScope.
  const [scopeId, circuitData] = circuitEntries[0];

  if (!targetScope) {
    results.errors.push(`No scope provided for circuit "${scopeId}"`);
    return results;
  }

  // TODO: Replace stub with real JSON Schema validation.
  const validation = validateCanonicalJson(circuitData);
  if (!validation.valid) {
    console.error(`[importCanonical] Validation failed for "${scopeId}":`, validation.errors);
    results.errors.push(...validation.errors);
    return results;
  }

  const outcome = await importSingleScope(circuitData, targetScope);
  if (!outcome.success) {
    results.errors.push(`[${scopeId}] ${outcome.error ?? "unknown error"}`);
  } else {
    results.imported++;
  }

  results.success = results.imported > 0;
  return results;
}

// ── Window extension ──────────────────────────────────────────────────────

// Typed window extension — eliminates unsafe casting / implicit any on window
declare global {
  interface Window {
    importCanonical?: typeof importCanonical;
    validateCanonicalJson?: typeof validateCanonicalJson;
  }
}

if (typeof window !== "undefined") {
  window.importCanonical = importCanonical;
  window.validateCanonicalJson = validateCanonicalJson;
}
