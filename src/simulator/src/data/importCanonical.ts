import modules from "../modules";
import { newCircuit, switchCircuit, scopeList } from "../circuit";
import { SimulatorStore } from "#/store/SimulatorStore/SimulatorStore";
import { canonicaliseScope, canonicaliseProject, khansAlgorithm, STATEFUL_DEFAULT_STATE } from "./canonical";
import type {
  CanonicalComponent,
  CanonicalNet,
  IntermediateNet,
  CanonicalLayout,
  CanonicalScope,
  CanonicalProject,
} from "./canonical";
import { resetup } from "../setup";
import {
  updateSimulationSet,
  updateCanvasSet,
  updateSubcircuitSet,
  forceResetNodesSet,
  scheduleUpdate,
  update,
} from "../engine";
import Node from "../node";
import SubCircuit from "../subcircuit";

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
    title_x?: number;
    title_y?: number;
    titleEnabled?: boolean;
  };
  root: unknown;
  centerFocus?: (force: boolean) => void;
  initialize?: () => void;
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

export type ValidationResult = { valid: true; errors: [] } | { valid: false; errors: string[] };

export type ImportResult = {
  success: boolean;
  imported: number;
  errors: string[];
};

// TODO: Replace with JSON Schema validation (deferred).
export function validateCanonicalJson(_circuitData: CanonicalScope): ValidationResult {
  return { valid: true, errors: [] };
}

function getComponentLayout(
  layout: CanonicalLayout | undefined,
  id: string,
): { x?: number; y?: number; labelDirection?: unknown; layoutProperties?: unknown } {
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
    return entry as {
      x?: number;
      y?: number;
      labelDirection?: unknown;
      layoutProperties?: unknown;
    };
  }
  return { x: 0, y: 0 };
}

function buildComponents(
  scope: ScopeLike,
  components: CanonicalComponent[],
  layout: CanonicalLayout | undefined,
  scopeMap: Map<number, ScopeLike>,
): Map<string, ComponentInstance> {
  const instanceMap = new Map<string, ComponentInstance>();

  for (let i = 0; i < components.length; i++) {
    const { id, type, bitWidth, label, properties, connections } = components[i];
    const pos = getComponentLayout(layout, id);

    let instance: ComponentInstance;

    if (type === "SubCircuit") {
      const subcircuitId = Number((properties?.constructorParamaters as unknown[])?.[0]);
      if (!scopeMap.has(subcircuitId)) {
        console.warn(
          `[importCanonical] SubCircuit scope ${subcircuitId} not found for component "${id}" — skipping`,
        );
        continue;
      }

      // Resolve the scope's actual .id — it may differ in type (string vs
      // number) from the canonical JSON key, and the SubCircuit constructor
      // needs whatever format scopeList is keyed by.
      const actualSubcircuitId = scopeMap.get(subcircuitId)!.id;

      const Constructor =
        (modules as Record<string, ComponentConstructor | undefined>)["SubCircuit"] ||
        (SubCircuit as unknown as ComponentConstructor);
      try {
        instance = new Constructor(pos.x ?? 0, pos.y ?? 0, scope, String(actualSubcircuitId));
      } catch (err) {
        console.error(`[importCanonical] Failed to construct SubCircuit "${id}":`, err);
        continue;
      }

      // The SubCircuit constructor is called without savedData so its
      // inputNodes/outputNodes arrays remain empty and the makeConnections()
      // call inside the constructor silently does nothing.  Without these
      // nodes, wireComponents later cannot resolve SubCircuit port references
      // (e.g. "SubCircuit_0.inputNodes_0") and the SubCircuit never connects
      // to the parent circuit — all outputs become X (unknown).
      // Create one Node per Input/Output of the referenced subcircuit scope,
      // populate the instance arrays, then wire them up.
      const subcircuitScope = scopeMap.get(subcircuitId);
      if (subcircuitScope && instance.inputNodes !== undefined && instance.outputNodes !== undefined) {
        const NodeCon = Node as unknown as NodeConstructor;
        const subInputs = (subcircuitScope as unknown as Record<string, unknown[]>).Input ?? [];
        const subOutputs = (subcircuitScope as unknown as Record<string, unknown[]>).Output ?? [];

        for (let j = 0; j < subInputs.length; j++) {
          const inp = subInputs[j] as Record<string, unknown>;
          const lp = (inp.layoutProperties as Record<string, number>) ?? {};
          const bw = Number(inp.bitWidth) || 1;
          const node = new NodeCon(lp.x ?? 0, lp.y ?? 0, 1, instance, bw);
          (instance.inputNodes as unknown[]).push(node);
        }
        for (let j = 0; j < subOutputs.length; j++) {
          const out = subOutputs[j] as Record<string, unknown>;
          const lp = (out.layoutProperties as Record<string, number>) ?? {};
          const bw = Number(out.bitWidth) || 1;
          const node = new NodeCon(lp.x ?? 0, lp.y ?? 0, 0, instance, bw);
          (instance.outputNodes as unknown[]).push(node);
        }
        (instance as unknown as Record<string, () => void>).makeConnections?.();
      }
    } else {
      const Constructor = (modules as Record<string, ComponentConstructor | undefined>)[type];
      if (typeof Constructor !== "function") {
        console.warn(`[importCanonical] No constructor for type "${type}" (id: ${id})`);
        continue;
      }

      // Older files without constructorParamaters lose direction — "RIGHT" is the
      // least-bad default; the round-trip hash will flag the mismatch.
      const constructorArgs: unknown[] = Array.isArray(properties?.constructorParamaters)
        ? [...(properties.constructorParamaters as unknown[])]
        : ["RIGHT", bitWidth];

      if (
        (type === "Input" || type === "Output") &&
        pos.layoutProperties !== undefined &&
        constructorArgs.length < 3
      ) {
        constructorArgs.push(pos.layoutProperties);
      }

      try {
        instance = new Constructor(pos.x ?? 0, pos.y ?? 0, scope, ...constructorArgs);
      } catch (err) {
        console.error(`[importCanonical] Failed to construct "${type}" (id: ${id}):`, err);
        continue;
      }
    }

    instance.label = label;

    if (typeof properties?.propagationDelay === "number") {
      instance.propagationDelay = properties.propagationDelay;
    }

    if (pos.labelDirection !== undefined) {
      instance.labelDirection = pos.labelDirection;
    }

    // Restore extra values from customSave().values stored in properties
    // (e.g., Flag.identifier, Tunnel.identifier).
    //
    // IMPORTANT: some component types (TriState, ALU, Adder, BitSelector, …)
    // can report a "value" whose key coincides with an actual node/port name
    // on the instance (e.g. a control/enable value sharing a name with its
    // pin).  Assigning it here — before wireComponents() runs — would replace
    // the live Node reference with a primitive, permanently breaking that
    // port's wiring (it then reads back as X).  Skip any property key that
    // matches one of this component's own port names (scalar or array base)
    // so node references can never be clobbered.
    if (properties) {
      const portBaseNames = new Set<string>();
      for (const portKey of Object.keys(connections)) {
        portBaseNames.add(portKey);
        const underIdx = portKey.lastIndexOf("_");
        if (underIdx > 0 && !isNaN(Number(portKey.substring(underIdx + 1)))) {
          portBaseNames.add(portKey.substring(0, underIdx));
        }
      }

      for (const [key, value] of Object.entries(properties)) {
        if (key === "constructorParamaters" || key === "propagationDelay") continue;
        if (portBaseNames.has(key)) continue;
        if (value !== undefined) {
          (instance as Record<string, unknown>)[key] = value;
        }
      }
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

  // Try array port (e.g. "inp_2" → instance["inp"][2])
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

  // Scalar port fallback
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
  // Nets with intermediate (junction) nodes are wired separately in
  // restoreIntermediateNodes; skip them here to avoid double-connecting.
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
      if (portNodes.length === 1) {
        console.warn(`[importCanonical] net "${net.id}": only 1 node resolved, skipping`);
      }
      continue;
    }

    // Chain: port[0]↔port[1]↔port[2]…  One connected chain suffices.
    for (let j = 1; j < portNodes.length; j++) {
      try {
        portNodes[j - 1].connect(portNodes[j]);
      } catch (err) {
        console.error(
          `[importCanonical] Wire failed on net "${net.id}": ` +
            `${net.connections[j - 1]} ↔ ${net.connections[j]}`,
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

    const stateProp = STATEFUL_DEFAULT_STATE[compData.type];
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

  const NodeCon = Node as unknown as NodeConstructor;

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
            ? new NodeCon(point.x, point.y, 2, scope.root, netBitWidth)
            : new NodeCon(point.x, point.y, 2, scope.root);
        junctionNodes.push(node);
      } catch (err) {
        console.error(
          `[importCanonical] Failed to create junction at (${point.x},${point.y}) for ${netId}:`,
          err,
        );
        junctionNodes.push(null);
      }
    }

    // Junction-to-junction connections
    for (let i = 0; i < edges.length; i++) {
      const [fromId, toId] = edges[i];
      const fromNode = junctionNodes[fromId];
      const toNode = junctionNodes[toId];
      if (fromNode && toNode) {
        try {
          fromNode.connect(toNode);
        } catch (err) {
          console.error(
            `[importCanonical] Junction-to-junction failed for net "${netId}" (${fromId} → ${toId}):`,
            err,
          );
        }
      }
    }

    // Port-to-junction connections
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
          `[importCanonical] Port-to-junction failed for net "${netId}" ("${portRef}" → node ${nodeId}):`,
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

  const { scale, ox, oy } = circuitData.visual.canvas;
  scope.scale = scale;
  scope.ox = ox;
  scope.oy = oy;

  if (circuitData.layout.subcircuitSymbol) {
    const sym = circuitData.layout.subcircuitSymbol;
    // title_x/title_y are backwards-compat aliases used by SubCircuit.draw()
    // and layoutMode; both must be synced so rendered subcircuit symbols and
    // the layout editor agree on title position.
    scope.layout = {
      width: sym.width,
      height: sym.height,
      titleX: sym.titleX,
      titleY: sym.titleY,
      title_x: sym.titleX,
      title_y: sym.titleY,
      titleEnabled: sym.titleEnabled,
    };
  }

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

function diffObjects(obj1: any, obj2: any, path = ""): void {
  if (obj1 === obj2) return;
  if (typeof obj1 !== typeof obj2) {
    console.warn(`[DIFF] Type mismatch at ${path}: ${typeof obj1} vs ${typeof obj2}`);
    return;
  }
  if (obj1 && typeof obj1 === "object") {
    const keys1 = Object.keys(obj1).sort();
    const keys2 = Object.keys(obj2).sort();
    for (const k of keys1) {
      if (!(k in obj2)) {
        console.warn(`[DIFF] Key ${k} missing in actual at ${path}`);
      } else {
        diffObjects(obj1[k], obj2[k], path ? `${path}.${k}` : k);
      }
    }
    for (const k of keys2) {
      if (!(k in obj1)) {
        console.warn(`[DIFF] Key ${k} missing in expected at ${path}`);
      }
    }
  } else {
    console.warn(`[DIFF] Value mismatch at ${path}: ${JSON.stringify(obj1)} vs ${JSON.stringify(obj2)}`);
  }
}

async function verifyRoundTrip(
  scope: ScopeLike,
  expectedScope: CanonicalScope,
  canonicalGeometries?: Record<string, CanonicalScope>,
  /** Original hash map from the source JSON (id → canonicalHash), used
   *  instead of canonicalGeometries-derived hashes when available.  Using the
   *  original hashes ensures that WL fingerprinting inside canonicaliseScope
   *  sees the same subcircuit hashes as the original export, producing
   *  identical component sorting and commutative-port normalisation. */
  originalChildHashes?: Map<number, string>,
): Promise<{ match: boolean; actualHash: string; expectedHash: string; reExported?: CanonicalScope }> {

  // Use the original child hashes when available; fall back to extracting
  // from canonicalGeometries (less ideal because those are re-exported values
  // that may diverge after round-trip passes for nested subcircuits).
  const subHashes = originalChildHashes ?? (canonicalGeometries
    ? new Map(
        Object.entries(canonicalGeometries).map(([id, cs]) => [Number(id), cs.canonicalHash]),
      )
    : undefined);

  const reExported = await canonicaliseScope(
    scope as Parameters<typeof canonicaliseScope>[0],
    subHashes,
  );
  const expectedHash = expectedScope.canonicalHash;
  const actualHash = reExported.canonicalHash;
  const match = actualHash === expectedHash;

  const header =
    "[importCanonical] Round-trip check\n" +
    `  scopeId:       ${String(scope?.id)}\n` +
    `  expected hash: ${expectedHash}\n` +
    `  actual hash:   ${actualHash}\n`;

  if (match) {
    console.log(header + "  result: PASS");
  } else {
    console.warn(header + "  result: FAIL\n  Import did not reproduce the original netlist exactly.");
    diffObjects(expectedScope, reExported);
  }

  return { match, actualHash, expectedHash: expectedHash || "", reExported };
}

async function importSingleScope(
  circuitData: CanonicalScope,
  scope: ScopeLike,
  scopeMap: Map<number, ScopeLike>,
  canonicalGeometries?: Record<string, CanonicalScope>,
  originalChildHashes?: Map<number, string>,
): Promise<{ success: boolean; error?: string; reExported?: CanonicalScope }> {
  const { components, nets } = circuitData.netlist;
  const { layout } = circuitData;

  const instanceMap = buildComponents(scope, components, layout, scopeMap);

  if (components.length > 0 && instanceMap.size === 0) {
    return { success: false, error: "no components could be constructed" };
  }

  wireComponents(instanceMap, nets, layout.intermediateNodes);
  restoreDefaultState(instanceMap, components);

  if (layout.intermediateNodes) {
    restoreIntermediateNodes(scope, layout.intermediateNodes, instanceMap, nets);
  }

  restoreScopeMetadata(scope, circuitData);

  // Round-trip check runs before any canvas refresh so that resetup() does
  // not alter the node collection between import and re-export.
  let reExported: CanonicalScope | undefined;
  if (circuitData.canonicalHash) {
    const res = await verifyRoundTrip(scope, circuitData, canonicalGeometries, originalChildHashes);
    reExported = res.reExported;
  }

  // Canvas refresh is intentionally deferred: importCanonical calls it once
  // after all scopes are imported, avoiding O(n) redundant redraws.
  return { success: true, reExported };
}

/**
 * Compute a topological order for circuits based on SubCircuit references
 * in the canonical JSON.  Unlike canonicaliseProject (which reads SubCircuit
 * entries from live Scope objects), this works purely from the serialized
 * CanonicalScope data, so it can run during import before real scopes exist.
 */
export function computeImportOrder(circuits: Record<number, CanonicalScope>): number[] {
  const inDegreeMap = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  const scopeIds = new Set(Object.keys(circuits).map(Number).filter((id) => !isNaN(id)));

  for (const [idStr, circuit] of Object.entries(circuits)) {
    const circuitId = Number(idStr);
    if (!dependents.has(circuitId)) dependents.set(circuitId, []);

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
  }

  const topologicalOrder = khansAlgorithm(inDegreeMap, dependents);
  if (!topologicalOrder) {
    throw new Error("A cyclic dependency was detected among the subcircuits!");
  }
  return topologicalOrder;
}

export async function importCanonical(
  json: CanonicalProject,
  targetScope: ScopeLike | null | undefined,
): Promise<ImportResult> {
  const results: ImportResult = { success: false, imported: 0, errors: [] };

  if (!json.circuits || typeof json.circuits !== "object") {
    results.errors.push("Missing circuits object in JSON");
    return results;
  }

  if (Object.keys(json.circuits).length === 0) {
    results.errors.push("No circuits found in JSON");
    return results;
  }

  if (!targetScope) {
    results.errors.push("No target scope provided");
    return results;
  }

  let topologicalOrder: number[];
  try {
    topologicalOrder = computeImportOrder(json.circuits);
  } catch (err) {
    results.errors.push(err instanceof Error ? err.message : String(err));
    return results;
  }

  // Match targetScope to its circuit by ID if there is a match.
  // Otherwise, look for a circuit named "Main" (case-insensitive) or marked as Verilog main.
  // Fall back to the last entry in topologicalOrder if none found.
  let anchorCircuitId = topologicalOrder[topologicalOrder.length - 1];
  const targetScopeNumericId =
    targetScope.id != null ? Number(targetScope.id) : null;

  if (targetScopeNumericId != null && json.circuits[targetScopeNumericId]) {
    anchorCircuitId = targetScopeNumericId;
  } else {
    for (const canonicalId of topologicalOrder) {
      const circuit = json.circuits[canonicalId];
      const name = circuit.projectMetadata?.name;
      if (
        (name && name.toLowerCase() === "main") ||
        circuit.verilogMetadata?.isMainCircuit === true
      ) {
        anchorCircuitId = canonicalId;
        break;
      }
    }
  }

  // Reset the target scope to a clean slate before importing into it.
  // initialize() clears allNodes, wires, nodes, and every module-type array
  // so the import starts from empty rather than layering on top of whatever
  // was already on the scope.
  if (typeof targetScope.initialize === "function") {
    targetScope.initialize();
  }

  const oldTargetScopeId = targetScope.id;
  const newTargetScopeId = String(anchorCircuitId);

  if (oldTargetScopeId !== newTargetScopeId) {
    if (oldTargetScopeId !== undefined) {
      delete (scopeList as Record<string, unknown>)[String(oldTargetScopeId)];
    }
    targetScope.id = newTargetScopeId;
    (scopeList as Record<string, unknown>)[String(newTargetScopeId)] = targetScope;

    try {
      const simulatorStore = SimulatorStore();
      const index = simulatorStore.circuit_list.findIndex((c: any) => c.id === oldTargetScopeId);
      if (index !== -1) {
        simulatorStore.circuit_list[index].id = newTargetScopeId;
      }
      if (simulatorStore.activeCircuit && simulatorStore.activeCircuit.id === oldTargetScopeId) {
        simulatorStore.activeCircuit.id = newTargetScopeId;
      }
    } catch (e) {
      // Ignore during headless tests where the store may not be initialized
    }
  }

  const scopeMap = new Map<number, ScopeLike>();
  const canonicalGeometries: Record<string, CanonicalScope> = {};

  // Build child hash map from the ORIGINAL canonical JSON so that
  // verifyRoundTrip passes the same subcircuit hashes that canonicaliseProject
  // used during the original export.  This keeps WL fingerprinting and
  // commutative-port normalisation stable across the round trip.
  const originalChildHashes = new Map<number, string>();
  for (const cid of topologicalOrder) {
    const ch = json.circuits[cid]?.canonicalHash;
    if (ch) originalChildHashes.set(cid, ch);
  }

  for (const canonicalId of topologicalOrder) {
    const circuitData = json.circuits[canonicalId];

    let currentScope: ScopeLike;
    if (canonicalId === anchorCircuitId) {
      // Reuse the existing targetScope — do NOT call newCircuit.
      // newCircuit would allocate a second scope object with the same numeric
      // id and register it in scopeList, overwriting the targetScope entry.
      // When a SubCircuit later references this id, its constructor would see
      // two different scope objects with the same id string and falsely report
      // a cyclic dependency via checkDependency.
      currentScope = targetScope;
    } else {
      // newCircuit registers the scope in scopeList under the given id,
      // which is what SubCircuit constructors rely on when they call scopeList[id].
      const newScope = newCircuit(
        circuitData.projectMetadata.name,
        String(canonicalId),
        circuitData.verilogMetadata?.isVerilogCircuit ?? false,
        circuitData.verilogMetadata?.isMainCircuit ?? false,
      );
      if (!newScope) {
        results.errors.push(`[${canonicalId}] Failed to create scope — name may be empty`);
        continue;
      }
      currentScope = newScope as unknown as ScopeLike;
    }

    scopeMap.set(canonicalId, currentScope);

    const validation = validateCanonicalJson(circuitData);
    if (!validation.valid) {
      results.errors.push(`[${canonicalId}] validation: ${validation.errors.join(", ")}`);
      continue;
    }

    const outcome = await importSingleScope(circuitData, currentScope, scopeMap, canonicalGeometries, originalChildHashes);
    if (!outcome.success) {
      results.errors.push(`[${canonicalId}] ${outcome.error ?? "unknown error"}`);
    } else {
      results.imported++;
      if (outcome.reExported) {
        canonicalGeometries[String(canonicalId)] = outcome.reExported;
      }
    }
  }

  results.success = results.imported > 0;

  // Verify the complete project round-trip hash, but only if every circuit
  // in the JSON was imported successfully — partial imports guarantee a
  // mismatch and the per-circuit round-trip checks already flagged failures.
  const allCircuitsImported = results.imported === topologicalOrder.length;
  if (allCircuitsImported && json.canonicalHash) {
    try {
      const projectResult = await canonicaliseProject(
        Array.from(scopeMap.values()) as Parameters<typeof canonicaliseProject>[0],
      );
      const match = projectResult.canonicalHash === json.canonicalHash;
      console.log(
        `[importCanonical] Project Round-trip check\n` +
        `  Expected project hash: ${json.canonicalHash}\n` +
        `  Actual project hash:   ${projectResult.canonicalHash}\n` +
        `  Result:                ${match ? "PASS" : "FAIL"}`,
      );
    } catch (err) {
      console.warn("[importCanonical] Project Round-trip canonicalise failed:", err);
    }
  }

  // One canvas refresh after all imports — avoids O(n) redraws from importSingleScope.
  if (results.imported > 0) {
    refreshCanvas(targetScope, true);
  }

  // switchCircuit() restores focus to targetScope and triggers the simulation/UI update pipeline.
  if (results.success && targetScope.id !== undefined) {
    switchCircuit(String(targetScope.id));
  }

  // Force simulation propagation on imported project
  if (results.success) {
    try {
      updateSimulationSet(true);
      updateSubcircuitSet(true);
      forceResetNodesSet(true);
      updateCanvasSet(true);
      update(globalScope, true);
    } catch (e) {
      // Ignore in headless/mock environments where engine is not fully present
    }
  }

  return results;
}

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
