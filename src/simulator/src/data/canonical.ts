import { circuitElementList } from "../metadata";

type WireNode = {
  bitWidth: number;
  connections: WireNode[];
  deleted?: boolean;
  type: number;
  x: number;
  y: number;
  [key: string]: unknown;
};

type NodeIndexMap = Map<WireNode, number>;

type ComponentSaveData = {
  nodes: Record<string, unknown>;
  values?: Record<string, unknown>;
  constructorParamaters?: unknown[];
};

type CVComponent = {
  objectType: string;
  label?: string;
  bitWidth: number;
  customSave: () => ComponentSaveData;
  direction?: unknown;
  propagationDelay?: number;
  state?: unknown;
  labelDirection?: unknown;
  x?: number;
  y?: number;
  [key: string]: unknown;
};

type CVScope = {
  id?: number;
  name?: string;
  timeStamp?: string | number | null;
  allNodes: WireNode[];
  layout?: {
    width?: number;
    height?: number;
    titleX?: number;
    titleY?: number;
    titleEnabled?: boolean;
  };
  scale?: number;
  ox?: number;
  oy?: number;
  verilogMetadata?: {
    isVerilogCircuit?: boolean;
    isMainCircuit?: boolean;
    code?: string;
    subCircuitScopeIds?: string[];
  };
  restrictedCircuitElementsUsed?: string[];
  [key: string]: unknown;
};

type ComponentDraft = {
  id?: string;
  type: string;
  label: string;
  bitWidth: number;
  properties: Record<string, unknown>;
  _connections: Record<string, number>;
  _state?: unknown;
  _labelDirection?: unknown;
  _x?: number;
  _y?: number;
  _instance?: CVComponent;
  _portDefs?: Record<string, unknown>;
  [key: string]: unknown;
};

export type CanonicalComponent = {
  id: string;
  type: string;
  label: string;
  bitWidth: number;
  connections: Record<string, string>;
  properties: Record<string, unknown>;
  defaultState?: unknown;
};

export type CanonicalNet = {
  id: string;
  bitWidth: number;
  connections: string[];
};

export type SubcircuitPort = {
  componentId: string;
  label: string;
  bitWidth: number;
  subcircuitExposed: true;
  order: number;
};

export type IntermediateNet = {
  nodes: Array<{ id: number; x: number; y: number }>;
  edges: Array<[number, number]>;
  portConnections: Array<{ portRef: string; nodeId: number }>;
};

export type SubcircuitSymbolLayout = {
  width: number;
  height: number;
  titleX: number;
  titleY: number;
  titleEnabled: boolean;
};

export type CanonicalProject = {
  formatVersion: "v1";
  canonicalHash: string;
  circuits: Record<number, CanonicalScope>;
};

export type CanonicalLayout = {
  [componentId: string]:
    | {
        x?: number;
        y?: number;
        labelDirection?: unknown;
        layoutProperties?: unknown;
        [key: string]: unknown;
      }
    | Record<string, IntermediateNet>
    | SubcircuitSymbolLayout
    | undefined;
  intermediateNodes?: Record<string, IntermediateNet>;
  subcircuitSymbol?: SubcircuitSymbolLayout;
};

export type CanonicalScope = {
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

export class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
    this.rank = Array.from({ length: size }, () => 0);
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }

  union(a: number, b: number) {
    let rootA = this.find(a);
    let rootB = this.find(b);

    if (rootA === rootB) return;

    if (this.rank[rootA] < this.rank[rootB]) {
      [rootA, rootB] = [rootB, rootA];
    }

    this.parent[rootB] = rootA;

    if (this.rank[rootA] === this.rank[rootB]) {
      this.rank[rootA]++;
    }
  }
}

// ─── Commutative Port Groups ─────────────────────────────────────────────────
// Ports within each group are functionally interchangeable.  Swapping the
// physical wires between ports in the same group produces a logically
// equivalent circuit, so the canonical representation must normalise the
// port→net assignment so that lower port indices always reference nets with
// lower canonical IDs.
//
// Single-string groups (e.g. `["inp"]`) denote an array port where all array
// elements are symmetric.  Multi-string groups (e.g. `["inpA", "inpB"]`) list
// scalar ports that are symmetric with each other.
//
// Multiplexer/Demultiplexer are deliberately absent: their data inputs/outputs
// are selected by a control signal, so position is semantically meaningful
// (inp_0 is the value when select=0, inp_1 when select=1, etc.).
//
// DEPENDENCY: Normalisation sorts symmetric ports by their net ID, which is
// assigned in canonical component order (determined by wlFingerprint +
// canonicalSort).  If canonicalSort ever ties two components in different ways
// across logically-equivalent circuits, this sorting would diverge and the
// hash would too.  Currently wlFingerprint converges to a unique colouring
// for non-isomorphic graphs, so this is safe.

const COMMUTATIVE_PORT_GROUPS: Record<string, string[][]> = {
  AndGate: [["inp"]],
  OrGate: [["inp"]],
  NandGate: [["inp"]],
  NorGate: [["inp"]],
  XorGate: [["inp"]],
  XnorGate: [["inp"]],
  Adder: [["inpA", "inpB"]],
  verilogMultiplier: [["inpA", "inpB"]],
};
// ─────────────────────────────────────────────────────────────────────────────

const STRUCTURAL_STATE: Set<string> = new Set(["ConstantVal"]);

const DIRECTION_BEARING: Set<string> = new Set([
  "Input",
  "Output",
  "NotGate",
  "OrGate",
  "AndGate",
  "NorGate",
  "NandGate",
  "XorGate",
  "XnorGate",
  "Multiplexer",
  "Demultiplexer",
  "BitSelector",
  "Splitter",
  "ConstantVal",
  "ControlledInverter",
  "TriState",
  "Adder",
  "ALU",
  "Buffer",
  "TwoComplement",
  "ForceGate",
  "DflipFlop",
  "TflipFlop",
  "SRflipFlop",
  "JKflipFlop",
  "Dlatch",
  "Clock",
  "Stepper",
  "Button",
  "Random",
  "RAM",
  "EEPROM",
  "verilogRAM",
  "verilogMultiplier",
  "verilogDivider",
  "verilogPower",
  "verilogShiftLeft",
  "verilogShiftRight",
  "MSB",
  "LSB",
  "PriorityEncoder",
  "Decoder",
  "Tunnel",
  "Flag",
  "SquareRGBLed",
  "TB_Input",
  "TB_Output",
]);

export const STATEFUL_DEFAULT_STATE: Record<string, string> = {
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

function indexNodes(allNodes: WireNode[]) {
  const map = new Map<WireNode, number>();
  for (let i = 0; i < allNodes.length; i++) {
    map.set(allNodes[i], i);
  }
  return map;
}

function discoverNets(scope: CVScope, nodeIndexMap: NodeIndexMap) {
  const { allNodes } = scope;
  const uf = new UnionFind(allNodes.length);

  for (let i = 0; i < allNodes.length; i++) {
    const node = allNodes[i];
    for (let j = 0; j < node.connections.length; j++) {
      const neighbourIdx = nodeIndexMap.get(node.connections[j]);
      if (neighbourIdx !== undefined) {
        uf.union(i, neighbourIdx);
      }
    }
  }

  return uf;
}

function buildComponentDrafts(scope: CVScope, uf: UnionFind, nodeIndexMap: NodeIndexMap) {
  const components: ComponentDraft[] = [];

  for (let i = 0; i < circuitElementList.length; i++) {
    const typeName = circuitElementList[i];
    const instances = scope[typeName] as CVComponent[] | undefined;
    if (!instances || instances.length === 0) continue;

    for (let j = 0; j < instances.length; j++) {
      const comp = instances[j];
      const saveData = comp.customSave();
      const portDefs = saveData.nodes;

      if (!portDefs || Object.keys(portDefs).length === 0) continue;

      const portRootIndices: Record<string, number> = {};

      for (const portName of Object.keys(portDefs)) {
        const savedVal = portDefs[portName];

        if (Array.isArray(savedVal)) {
          const nodeArray = comp[portName] as WireNode[];
          for (let offset = 0; offset < nodeArray.length; offset++) {
            const idx = nodeIndexMap.get(nodeArray[offset]);
            if (idx === undefined) continue;
            portRootIndices[`${portName}_${offset}`] = uf.find(idx);
          }
        } else {
          const node = comp[portName] as WireNode | undefined;
          const idx = node ? nodeIndexMap.get(node) : undefined;
          if (idx === undefined) continue;
          portRootIndices[portName] = uf.find(idx);
        }
      }

      const properties: Record<string, unknown> = {};

      if (comp.propagationDelay !== undefined && comp.propagationDelay !== 0) {
        properties.propagationDelay = comp.propagationDelay;
      }

      if (saveData.constructorParamaters !== undefined) {
        properties.constructorParamaters = normalizeConstructorParamaters(
          typeName,
          saveData.constructorParamaters,
        );
      }

      // Capture layoutProperties for Input/Output before normalize strips it,
      // so buildLayout doesn't need a second call to customSave().
      let layoutProperties: unknown;
      if (
        (typeName === "Input" || typeName === "Output") &&
        Array.isArray(saveData.constructorParamaters) &&
        saveData.constructorParamaters.length > 2
      ) {
        layoutProperties = sortRecordDeep(saveData.constructorParamaters[2]);
      }

      const statePropKey = STATEFUL_DEFAULT_STATE[typeName];
      if (saveData.values) {
        for (const [key, value] of Object.entries(saveData.values)) {
          if (key === statePropKey) continue;
          properties[key] = value;
        }
      }

      const defaultState =
        statePropKey !== undefined && (comp as Record<string, unknown>)[statePropKey] !== undefined
          ? (comp as Record<string, unknown>)[statePropKey]
          : undefined;

      components.push({
        type: comp.objectType,
        label: comp.label || "",
        bitWidth: comp.bitWidth,
        properties,
        _connections: portRootIndices,
        _state: defaultState,
        _labelDirection: comp.labelDirection,
        _x: comp.x,
        _y: comp.y,
        _instance: comp,
        _portDefs: saveData.nodes,
        ...(layoutProperties !== undefined ? { _layoutProperties: layoutProperties } : {}),
      });
    }
  }

  return components;
}

// Locale-free natural-order comparator — pure charcode arithmetic produces
// identical output in every JavaScript engine so canonical hashes are stable.
// Embedded digit sequences are compared numerically:
// "inp_9" < "inp_10", "Input_10" > "Input_2", etc.
function naturalCompare(a: string, b: string): number {
  let ai = 0,
    bi = 0;
  while (ai < a.length && bi < b.length) {
    const aDigit = a[ai] >= "0" && a[ai] <= "9";
    const bDigit = b[bi] >= "0" && b[bi] <= "9";
    if (aDigit && bDigit) {
      let an = 0,
        bn = 0;

      while (ai < a.length && a[ai] >= "0" && a[ai] <= "9") {
        an = an * 10 + +a[ai++];
      }
      while (bi < b.length && b[bi] >= "0" && b[bi] <= "9") {
        bn = bn * 10 + +b[bi++];
      }

      if (an !== bn) return an - bn;
    } else {
      if (a[ai] !== b[bi]) return a.charCodeAt(ai) - b.charCodeAt(bi);
      ai++;
      bi++;
    }
  }
  return a.length - b.length;
}

function portKey(comp: ComponentDraft): string {
  return Object.keys(comp._connections).sort(naturalCompare).join(",");
}

function compressColourSignatures(signatures: Map<number, string>): Map<number, string> {
  const unique = [...new Set(signatures.values())].sort();
  const signatureToColour = new Map(
    unique.map((signature, index) => [signature, index.toString(36)]),
  );
  const colours = new Map<number, string>();

  for (const [id, signature] of signatures) {
    colours.set(id, signatureToColour.get(signature)!);
  }

  return colours;
}

function sortRecordDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortRecordDeep);
  }

  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort(naturalCompare)) {
      sorted[key] = sortRecordDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  return value;
}

function normalizeConstructorParamaters(type: string, params: unknown[]) {
  const normalized = params.slice();
  if ((type === "Input" || type === "Output") && normalized.length > 2) {
    normalized.splice(2, 1);
  }
  return normalized;
}

function sameColours(a: Map<number, string>, b: Map<number, string>): boolean {
  if (a.size !== b.size) return false;

  for (const [id, colour] of a) {
    if (b.get(id) !== colour) return false;
  }

  return true;
}

function buildWLAdjacency(components: ComponentDraft[]) {
  const netToComps = new Map<number, number[]>();

  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    for (const val of Object.values(comp._connections)) {
      if (!netToComps.has(val)) netToComps.set(val, []);
      netToComps.get(val)!.push(i);
    }
  }

  const adjacency = new Map<number, Set<number>>();
  for (let i = 0; i < components.length; i++) adjacency.set(i, new Set());

  for (const compIds of netToComps.values()) {
    for (const compId of compIds) {
      for (const otherId of compIds) {
        if (otherId !== compId) adjacency.get(compId)!.add(otherId);
      }
    }
  }

  const result = new Map<number, number[]>();
  for (const [id, neighbours] of adjacency) {
    result.set(
      id,
      [...neighbours].sort((a, b) => a - b),
    );
  }
  return result;
}

function wlFingerprint(components: ComponentDraft[]): Map<number, string> {
  if (components.length === 0) return new Map<number, string>();

  const initialSignatures = new Map<number, string>();
  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    let signature = `${comp.type}|${comp.bitWidth ?? 1}|${portKey(comp)}`;
    if (comp.type === "SubCircuit") {
      const subId = (comp.properties?.constructorParamaters as unknown[])?.[0] ?? "";
      signature += `|${subId}`;
    }
    initialSignatures.set(i, signature);
  }

  let colours = compressColourSignatures(initialSignatures);
  if (components.length === 1) return colours;

  const adjacency = buildWLAdjacency(components);

  for (let round = 0; round < components.length; round++) {
    const signatures = new Map<number, string>();

    for (let i = 0; i < components.length; i++) {
      const neighbours = adjacency.get(i) ?? [];
      const neighbourColours = neighbours
        .map((neighId) => colours.get(neighId) ?? "")
        .sort()
        .join(",");

      signatures.set(i, `${colours.get(i)}|${neighbourColours}`);
    }

    const nextColours = compressColourSignatures(signatures);
    if (sameColours(colours, nextColours)) return nextColours;
    colours = nextColours;
  }

  return colours;
}

function canonicalSort(components: ComponentDraft[]) {
  const fpMap = new Map<ComponentDraft, string>();

  for (const comp of components) {
    let signature = `${comp.type}|${comp.bitWidth}|${portKey(comp)}`;
    if (comp.type === "SubCircuit") {
      const subId = (comp.properties?.constructorParamaters as unknown[])?.[0] ?? "";
      signature += `|${subId}`;
    }
    fpMap.set(comp, signature);
  }

  const wlColours = wlFingerprint(components);
  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    fpMap.set(comp, `${fpMap.get(comp)}|${wlColours.get(i) ?? ""}`);
  }

  components.sort((a, b) => naturalCompare(fpMap.get(a)!, fpMap.get(b)!));
}

function assignComponentIds(components: ComponentDraft[]) {
  const countByType: Record<string, number> = {};
  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    if (!countByType[comp.type]) countByType[comp.type] = 0;
    comp.id = `${comp.type}_${countByType[comp.type]++}`;
  }
}

function assignNetIds(components: ComponentDraft[]) {
  const netIdMap = new Map<number, string>();
  const netConnections = new Map<string, string[]>();
  let netCounter = 0;

  for (let componentIndex = 0; componentIndex < components.length; componentIndex++) {
    const comp = components[componentIndex];
    const portNames = Object.keys(comp._connections).sort(naturalCompare);

    for (let portIndex = 0; portIndex < portNames.length; portIndex++) {
      const portName = portNames[portIndex];
      const groupRoot = comp._connections[portName];

      if (!netIdMap.has(groupRoot)) {
        const netId = `net_${netCounter++}`;
        netIdMap.set(groupRoot, netId);
        netConnections.set(netId, []);
      }

      const netId = netIdMap.get(groupRoot)!;
      netConnections.get(netId)!.push(`${comp.id}.${portName}`);
    }
  }

  return { netIdMap, netConnections };
}

function buildCanonicalNets(
  netIdMap: Map<number, string>,
  netConnections: Map<string, string[]>,
  allNodes: WireNode[],
) {
  const nets: CanonicalNet[] = [];
  for (const [groupRoot, netId] of netIdMap) {
    const members = netConnections.get(netId) || [];

    const netEntry: CanonicalNet = {
      id: netId,
      bitWidth: allNodes[groupRoot]?.bitWidth ?? 0,
      connections: members,
    };

    nets.push(netEntry);
  }

  const usedNets = nets.filter((net) => net.connections.length >= 2);
  for (let i = 0; i < usedNets.length; i++) {
    usedNets[i].connections.sort(naturalCompare);
  }

  const renameMap = new Map<string, string>();
  let counter = 0;
  for (const net of usedNets) {
    const newId = `net_${counter++}`;
    renameMap.set(net.id, newId);
    net.id = newId;
  }

  return { nets: usedNets, renameMap };
}

function buildWireJunctions(
  scope: CVScope,
  nodeIndexMap: NodeIndexMap,
  uf: UnionFind,
  composedNetMap: Map<number, string>,
  components: ComponentDraft[],
) {
  const allNodes = scope.allNodes;
  const nodePortRefs = new Map<number, string>();

  for (const comp of components) {
    const instance = comp._instance;
    if (!instance || !comp._portDefs || !comp.id) continue;

    for (const portName of Object.keys(comp._portDefs)) {
      const savedVal = comp._portDefs[portName];

      if (Array.isArray(savedVal)) {
        const nodeArray = instance[portName] as WireNode[];
        for (let portIndex = 0; portIndex < nodeArray.length; portIndex++) {
          const idx = nodeIndexMap.get(nodeArray[portIndex]);
          if (idx !== undefined) {
            nodePortRefs.set(idx, `${comp.id}.${portName}_${portIndex}`);
          }
        }
      } else {
        const node = instance[portName] as WireNode | undefined;
        const idx = node ? nodeIndexMap.get(node) : undefined;
        if (idx !== undefined) {
          nodePortRefs.set(idx, `${comp.id}.${portName}`);
        }
      }
    }
  }

  const intermediatesByNet = new Map<string, Array<{ node: WireNode; idx: number }>>();
  for (let i = 0; i < allNodes.length; i++) {
    const node = allNodes[i];
    if (node.deleted || node.type !== 2) continue;
    if (node.connections.length === 0) continue;

    const root = uf.find(i);
    const finalNetId = composedNetMap.get(root);
    if (finalNetId === undefined) continue;

    if (!intermediatesByNet.has(finalNetId)) intermediatesByNet.set(finalNetId, []);
    intermediatesByNet.get(finalNetId)!.push({ node, idx: i });
  }

  const result: Record<string, IntermediateNet> = {};

  for (const [finalNetId, intermediates] of intermediatesByNet) {
    intermediates.sort((a, b) =>
      a.node.x !== b.node.x ? a.node.x - b.node.x : a.node.y - b.node.y,
    );

    const nodeToLocalId = new Map<number, number>();
    const nodes: Array<{ id: number; x: number; y: number }> = [];
    for (let i = 0; i < intermediates.length; i++) {
      nodeToLocalId.set(intermediates[i].idx, i);
      nodes.push({ id: i, x: intermediates[i].node.x, y: intermediates[i].node.y });
    }

    const edgeSet = new Set<string>();
    const edges: Array<[number, number]> = [];
    for (const { node, idx } of intermediates) {
      const fromLocalId = nodeToLocalId.get(idx);
      if (fromLocalId === undefined) continue;

      for (const neighbour of node.connections) {
        const neighbourIdx = nodeIndexMap.get(neighbour);
        if (neighbourIdx === undefined || neighbour.deleted) continue;
        if (!nodeToLocalId.has(neighbourIdx)) continue;

        const toLocalId = nodeToLocalId.get(neighbourIdx);
        if (toLocalId === undefined) continue;

        const edgeKey = `${Math.min(fromLocalId, toLocalId)}-${Math.max(fromLocalId, toLocalId)}`;
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          edges.push([Math.min(fromLocalId, toLocalId), Math.max(fromLocalId, toLocalId)]);
        }
      }
    }
    edges.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));

    const seenPortConns = new Set<string>();
    const portConnections: Array<{ portRef: string; nodeId: number }> = [];
    for (const { node: junctionNode, idx: junctionIdx } of intermediates) {
      const localId = nodeToLocalId.get(junctionIdx);
      if (localId === undefined) continue;

      for (const neighbour of junctionNode.connections) {
        const neighbourIdx = nodeIndexMap.get(neighbour);
        if (neighbourIdx === undefined || neighbour.deleted) continue;
        if (neighbour.type === 2) continue;

        const portRef = nodePortRefs.get(neighbourIdx);
        if (!portRef) continue;

        const dedupeKey = `${portRef}|${localId}`;
        if (!seenPortConns.has(dedupeKey)) {
          seenPortConns.add(dedupeKey);
          portConnections.push({ portRef, nodeId: localId });
        }
      }
    }
    portConnections.sort((a, b) => naturalCompare(a.portRef, b.portRef));

    result[finalNetId] = { nodes, edges, portConnections };
  }

  const sorted: Record<string, IntermediateNet> = {};
  Object.keys(result)
    .sort((a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10))
    .forEach((key) => {
      sorted[key] = result[key];
    });

  return sorted;
}

function buildLayout(
  scope: CVScope,
  components: ComponentDraft[],
  nodeIndexMap: NodeIndexMap,
  uf: UnionFind,
  composedNetMap: Map<number, string>,
) {
  const layout: CanonicalLayout = {};

  const intermediateNodes = buildWireJunctions(scope, nodeIndexMap, uf, composedNetMap, components);

  if (Object.keys(intermediateNodes).length > 0) {
    layout.intermediateNodes = intermediateNodes;
  }

  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    if (!comp.id) continue;
    layout[comp.id] = {
      x: comp._x,
      y: comp._y,
      labelDirection: comp._labelDirection,
    };

    if (
      (comp.type === "Input" || comp.type === "Output") &&
      comp._layoutProperties !== undefined
    ) {
      (layout[comp.id] as Record<string, unknown>).layoutProperties = comp._layoutProperties;
    }
  }

  if (scope.layout && typeof scope.layout === "object") {
    layout.subcircuitSymbol = {
      width: scope.layout.width ?? 100,
      height: scope.layout.height ?? 100,
      titleX: scope.layout.titleX ?? 50,
      titleY: scope.layout.titleY ?? 13,
      titleEnabled: scope.layout.titleEnabled ?? true,
    };
  }

  return layout;
}

function buildVisual(scope: CVScope) {
  return {
    canvas: {
      scale: scope.scale ?? 1,
      ox: scope.ox ?? 0,
      oy: scope.oy ?? 0,
    },
  };
}

function buildSubcircuitPorts(components: ComponentDraft[]) {
  const inputs: SubcircuitPort[] = [];
  const outputs: SubcircuitPort[] = [];

  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    if (!comp.id) continue;
    const entry = {
      componentId: comp.id,
      label: comp.label,
      bitWidth: comp.bitWidth,
      subcircuitExposed: true as const,
    };

    if (comp.type === "Input") {
      inputs.push({ ...entry, order: inputs.length });
    } else if (comp.type === "Output") {
      outputs.push({ ...entry, order: outputs.length });
    }
  }

  return { inputs, outputs };
}

/**
 * Normalise commutative-port → net assignments so the canonical
 * representation is independent of which physical wire connects to which
 * symmetric pin.  For a two-input AND gate, swapping inp_0 ↔ inp_1 produces
 * a logically equivalent circuit — the canonical output must reflect that.
 *
 * Mutates components and nets in-place, rewriting port refs in both so they
 * stay consistent.
 */
function normalizeCommutativePorts(
  canonicalComponents: CanonicalComponent[],
  nets: CanonicalNet[],
): Map<string, string> {
  // Build net → index lookup for deterministic sorting.
  const netIndex = new Map<string, number>();
  for (let i = 0; i < nets.length; i++) {
    netIndex.set(nets[i].id, i);
  }

  // Collect old → new port-reference renames.
  const portRename = new Map<string, string>();

  for (const comp of canonicalComponents) {
    const groups = COMMUTATIVE_PORT_GROUPS[comp.type];
    if (!groups) continue;

    groupLoop: for (const group of groups) {
      const isSingleBase = group.length === 1;

      // Gather every port that belongs to this group.
      const entries: { portName: string; netId: string }[] = [];
      for (const portName of Object.keys(comp.connections)) {
        const inGroup = isSingleBase
          ? portName === group[0] || portName.startsWith(group[0] + "_")
          : group.includes(portName);
        if (inGroup) {
          entries.push({ portName, netId: comp.connections[portName] });
          delete comp.connections[portName];
        }
      }

      if (entries.length <= 1) {
        // Put back unchanged.
        for (const e of entries) comp.connections[e.portName] = e.netId;
        continue groupLoop;
      }

      // Sort entries so lower port indices receive nets with lower indices.
      entries.sort((a, b) => {
        const ai = netIndex.get(a.netId) ?? Infinity;
        const bi = netIndex.get(b.netId) ?? Infinity;
        return ai - bi;
      });

      // Reassign to canonical port names.
      // Array-port groups (isSingleBase) always use `base_N` naming
      // to match what buildComponentDrafts generates (inp_0, inp_1…),
      // avoiding bare name like "inp" that would break import resolution:
      //   resolvePortNode("comp.inp_0") → instance["inp"][0] ✓
      //   resolvePortNode("comp.inp")   → instance["inp"] = array ❌
      for (let i = 0; i < entries.length; i++) {
        const canonicalName = isSingleBase
          ? `${group[0]}_${i}`
          : group[i];

        // Guard against named-group overflow (should never happen, but
        // protect against future types with more entries than declared).
        if (canonicalName === undefined) {
          console.warn(
            `[canonical] normalizeCommutativePorts: ` +
              `${comp.type} has ${entries.length} commutative ports ` +
              `but only ${group.length} names declared; keeping original.`,
          );
          comp.connections[entries[i].portName] = entries[i].netId;
          continue;
        }

        comp.connections[canonicalName] = entries[i].netId;

        const oldRef = `${comp.id}.${entries[i].portName}`;
        const newRef = `${comp.id}.${canonicalName}`;
        if (oldRef !== newRef) {
          portRename.set(oldRef, newRef);
        }
      }
    }
  }

  // Apply rename map to every net's member list.
  for (const net of nets) {
    for (let i = 0; i < net.connections.length; i++) {
      const renamed = portRename.get(net.connections[i]);
      if (renamed) net.connections[i] = renamed;
    }
    net.connections.sort(naturalCompare);
  }

  return portRename;
}

function buildCanonicalComponents(
  components: ComponentDraft[],
  composedNetMap: Map<number, string>,
) {
  return components.map((component) => {
    const connections: Record<string, string> = {};
    for (const port of Object.keys(component._connections).sort(naturalCompare)) {
      const root = component._connections[port];
      const netId = composedNetMap.get(root);
      if (netId !== undefined) {
        connections[port] = netId;
      }
    }

    const entry: CanonicalComponent = {
      id: component.id ?? "",
      type: component.type,
      label: component.label,
      bitWidth: component.bitWidth,
      connections,
      properties: sortRecordDeep(component.properties) as Record<string, unknown>,
    };

    if (component._state !== undefined) {
      entry.defaultState = component._state;
    }

    return entry;
  });
}

async function sha256(text: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("[canonical] crypto.subtle is unavailable");
  }

  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function canonicaliseScope(scope: CVScope): Promise<CanonicalScope> {
  const nodeIndexMap = indexNodes(scope.allNodes);
  const uf = discoverNets(scope, nodeIndexMap);

  const components = buildComponentDrafts(scope, uf, nodeIndexMap);
  canonicalSort(components);
  assignComponentIds(components);

  const { netIdMap, netConnections } = assignNetIds(components);
  const { nets, renameMap } = buildCanonicalNets(netIdMap, netConnections, scope.allNodes);

  const composedNetMap = new Map<number, string>();
  for (const [root, intermediateId] of netIdMap) {
    const finalId = renameMap.get(intermediateId);
    if (finalId !== undefined) {
      composedNetMap.set(root, finalId);
    }
  }

  const interfacePorts = buildSubcircuitPorts(components);
  const layout = buildLayout(scope, components, nodeIndexMap, uf, composedNetMap);
  const visual = buildVisual(scope);
  const canonicalComponents = buildCanonicalComponents(components, composedNetMap);

  // Normalise commutative gate input assignments so logically equivalent
  // wiring produces the same canonical output and hash.  Operates on
  // canonicalComponents and nets in-place.  Returns a rename map we also
  // apply to intermediate-node portConnections so the layout stays consistent.
  const portRename = normalizeCommutativePorts(canonicalComponents, nets);
  if (portRename.size > 0 && layout.intermediateNodes) {
    for (const routing of Object.values(layout.intermediateNodes)) {
      for (const pc of routing.portConnections) {
        const renamed = portRename.get(pc.portRef);
        if (renamed) pc.portRef = renamed;
      }
      routing.portConnections.sort((a, b) => naturalCompare(a.portRef, b.portRef));
    }
  }

  const netlist = { components: canonicalComponents, nets };

  const netlistForHash = {
    components: canonicalComponents.map((c) => {
      let comp = { ...c, label: "" };
      if (!STRUCTURAL_STATE.has(c.type)) {
        comp = { ...comp, defaultState: undefined };
      }
      if (DIRECTION_BEARING.has(c.type) && Array.isArray(comp.properties?.constructorParamaters)) {
        const params = (comp.properties.constructorParamaters as unknown[]).slice();
        // Null direction (index 0) for direction-bearing components.
        if (params.length > 0) {
          params[0] = null;
        }
        comp = { ...comp, properties: { ...comp.properties, constructorParamaters: params } };
      }
      return comp;
    }),
    nets,
  };
  const interfacePortsForHash = {
    inputs: interfacePorts.inputs.map((p) => ({ ...p, label: "" })),
    outputs: interfacePorts.outputs.map((p) => ({ ...p, label: "" })),
  };
  const canonicalHash = await sha256(
    JSON.stringify(
      sortRecordDeep({ netlist: netlistForHash, interfacePorts: interfacePortsForHash }),
    ),
  );

  console.log(`[canonical] Canonical hash for scope "${scope.name}": ${canonicalHash}`);

  const verilogMetadata = {
    isVerilogCircuit: scope.verilogMetadata?.isVerilogCircuit ?? false,
    isMainCircuit: scope.verilogMetadata?.isMainCircuit ?? false,
    code: scope.verilogMetadata?.code ?? "// Write Some Verilog Code Here!",
    subCircuitScopeIds: scope.verilogMetadata?.subCircuitScopeIds ?? [],
  };

  const projectMetadata = {
    id: scope.id,
    name: scope.name || "Untitled",
    timeStamp: scope.timeStamp || null,
    restrictedElementsUsed: scope.restrictedCircuitElementsUsed || [],
  };

  return {
    canonicalHash,
    projectMetadata,
    netlist,
    interfacePorts,
    layout,
    visual,
    verilogMetadata,
  };
}

function khansAlgorithm(
  indegreeMap: Map<number, number>,
  dependents: Map<number, number[]>,
): number[] | null {
  const queue: number[] = [];
  let head = 0;

  for (const [circuitId, indegree] of indegreeMap.entries()) {
    if (indegree === 0) queue.push(circuitId);
  }

  queue.sort((a, b) => a - b);

  const topologicalOrder: number[] = [];

  while (queue.length > head) {
    const dequeuedScope = queue[head++]!;
    topologicalOrder.push(dequeuedScope);

    for (const dep of dependents.get(dequeuedScope) ?? []) {
      const newIndegree = indegreeMap.get(dep)! - 1;
      indegreeMap.set(dep, newIndegree);
      if (newIndegree === 0) {
        queue.push(dep);
        queue.sort((a, b) => a - b);
      }
    }
  }

  return topologicalOrder.length === indegreeMap.size ? topologicalOrder : null;
}

export async function canonicaliseProject(
  scopeOrScopes: CVScope | CVScope[],
): Promise<CanonicalProject> {
  const scopes = Array.isArray(scopeOrScopes) ? scopeOrScopes : [scopeOrScopes];
  const pairs = new Map<number, CanonicalScope>();
  const circuitHashes: string[] = [];
  const inDegreeMap = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  const scopeIds = new Set(scopes.map((scope) => Number(scope?.id)).filter((id) => !isNaN(id)));

  for (let i = 0; i < scopes.length; i++) {
    const scope = scopes[i];
    if (!scope || !scope.allNodes) continue;

    const circuitId = Number(scope.id);
    if (!dependents.has(circuitId)) dependents.set(circuitId, []);

    const circuit = await canonicaliseScope(scope);

    const subcircuitRefs = [
      ...new Set(
        circuit.netlist.components
          .filter((c) => c.type === "SubCircuit")
          .map((c) => Number((c.properties.constructorParamaters as unknown[])?.[0]))
          .filter((id) => !isNaN(id) && scopeIds.has(id) && id !== circuitId),
      ),
    ];

    for (const targetId of subcircuitRefs) {
      if (!dependents.has(targetId)) dependents.set(targetId, []);
      dependents.get(targetId)!.push(circuitId);
    }

    inDegreeMap.set(circuitId, subcircuitRefs.length);
    pairs.set(circuitId, circuit);
    circuitHashes.push(circuit.canonicalHash);
  }

  const topologicalOrder = khansAlgorithm(inDegreeMap, dependents);

  if (!topologicalOrder) {
    throw new Error("A cyclic dependency was detected among the subcircuits!");
  }

  const circuits: Record<number, CanonicalScope> = {};
  for (const id of topologicalOrder) {
    const circuit = pairs.get(id);
    if (circuit) circuits[id] = circuit;
  }

  const projectHash = await sha256(JSON.stringify([...circuitHashes].sort()));
  console.log(`[canonical] Canonical hash for project: ${projectHash}`);

  return {
    formatVersion: "v1",
    canonicalHash: projectHash,
    circuits,
  };
}

// Typed window extension — eliminates unsafe casting / implicit any on window
declare global {
  interface Window {
    canonicaliseProject?: typeof canonicaliseProject;
  }
}
// await window.canonicaliseProject(globalScope) --> in console
if (typeof window !== "undefined") {
  window.canonicaliseProject = canonicaliseProject;
}
