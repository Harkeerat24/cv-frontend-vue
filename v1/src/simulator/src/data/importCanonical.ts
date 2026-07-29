import modules from "../modules";
import { newCircuit, switchCircuit, scopeList } from "../circuit";
import type Scope from "../circuit";
import { SimulatorStore } from "#/store/SimulatorStore/SimulatorStore";
import { canonicaliseProject, khansAlgorithm, STATEFUL_DEFAULT_STATE } from "./canonical";
import type {
  CanonicalLayout,
  CanonicalComponent,
  CanonicalComponentPosition,
  IntermediateNet,
  CanonicalJsonValue,
  CanonicalNet,
  CanonicalProjectInput,
  CanonicalScopeInput,
  ComponentInstance,
} from "../types/canonical.types";
import { resetup } from "../setup";
import {
  updateSimulationSet,
  updateCanvasSet,
  updateSubcircuitSet,
  forceResetNodesSet,
  gridUpdateSet,
  scheduleUpdate,
  renderCanvas,
  update,
} from "../engine";
import Node from "../node";
import SubCircuit from "../subcircuit";

/** Constructor shared by component classes registered in modules.js. */
type ComponentConstructor = new (
  x: number,
  y: number,
  scope: Scope,
  ...rest: CanonicalJsonValue[]
) => ComponentInstance;

export type ImportResult = {
  success: boolean;
  imported: number;
  errors: string[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Returns constructor parameters emitted by customSave(). */
function getConstructorParams(properties: CanonicalComponent["properties"]): CanonicalJsonValue[] {
  const params = properties.constructorParamaters;
  return Array.isArray(params) ? params : [];
}

/** Constructs all component instances from the canonical JSON and returns them in a map keyed by component ID. */
function buildComponents(
  scope: Scope,
  components: CanonicalComponent[],
  layout: CanonicalLayout | undefined,
  scopeMap: Map<number, Scope>,
): { instanceMap: Map<string, ComponentInstance>; errors: string[] } {
  const instanceMap = new Map<string, ComponentInstance>();
  const errors: string[] = [];
  // modules.js is untyped and stores constructors by component name.
  const registry = modules as Record<string, ComponentConstructor | undefined>;

  for (let i = 0; i < components.length; i++) {
    const { id, type, label, properties } = components[i];
    const position = layout?.[id] as CanonicalComponentPosition | undefined;
    const x = position?.x ?? 0;
    const y = position?.y ?? 0;

    let instance: ComponentInstance;

    if (type === "SubCircuit") {
      const subcircuitId = Number(getConstructorParams(properties)[0]);
      if (!scopeMap.has(subcircuitId)) {
        errors.push(`SubCircuit "${id}": scope ${subcircuitId} not found`);
        continue;
      }

      try {
        instance = new SubCircuit(x, y, scope, String(subcircuitId)) as ComponentInstance;
      } catch (err) {
        errors.push(`SubCircuit "${id}": ${errorMessage(err)}`);
        continue;
      }
    } else {
      const Constructor = registry[type];
      if (typeof Constructor !== "function") {
        errors.push(`"${id}": unknown type "${type}"`);
        continue;
      }

      const constructorArgs = getConstructorParams(properties);

      try {
        instance = new Constructor(x, y, scope, ...constructorArgs);
      } catch (err) {
        errors.push(`"${id}" (${type}): ${errorMessage(err)}`);
        continue;
      }
    }

    instance.label = label ?? "";

    instance.propagationDelay = properties.propagationDelay;

    if (position) {
      instance.labelDirection = position.labelDirection;
    }

    instanceMap.set(id, instance);
  }

  return { instanceMap, errors };
}

function applyComponentLayout(
  instanceMap: Map<string, ComponentInstance>,
  layout: CanonicalLayout,
): void {
  for (const [id, instance] of instanceMap) {
    const position = layout[id] as CanonicalComponentPosition;
    Reflect.set(instance, "x", position.x);
    Reflect.set(instance, "y", position.y);
    Reflect.set(instance, "oldx", position.x);
    Reflect.set(instance, "oldy", position.y);
    instance.labelDirection = position.labelDirection;
  }
}

/** Resolves a "ComponentId.portName" reference string to a live Node on the constructed instance. */
function resolvePortNode(
  portRef: string,
  instanceMap: Map<string, ComponentInstance>,
): Node | null {
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
    const idx = Number(portName.substring(lastUnderscoreIdx + 1));
    const ports = Reflect.get(instance, base);

    if (Array.isArray(ports)) {
      return (ports[idx] as Node | undefined) ?? null;
    }
  }

  return (Reflect.get(instance, portName) as Node | undefined) ?? null;
}

/** Wires component ports together by connecting them through shared nets. Skips nets that have intermediate routing. */
function wireComponents(
  instanceMap: Map<string, ComponentInstance>,
  nets: CanonicalNet[],
  intermediateNodesByNet?: Record<string, IntermediateNet>,
): string[] {
  const errors: string[] = [];

  for (let i = 0; i < nets.length; i++) {
    const net = nets[i];
    if (intermediateNodesByNet?.[net.id]?.nodes.length) continue;

    const portNodes: Node[] = [];
    for (let j = 0; j < net.connections.length; j++) {
      const node = resolvePortNode(net.connections[j], instanceMap);
      if (node !== null) portNodes.push(node);
    }

    if (portNodes.length < 2) {
      if (portNodes.length === 1) {
        errors.push(`net "${net.id}": only 1 node resolved, skipping`);
      }
      continue;
    }

    // Chain: port[0]↔port[1]↔port[2]…
    for (let j = 1; j < portNodes.length; j++) {
      try {
        portNodes[j - 1].connect(portNodes[j]);
      } catch {
        errors.push(
          `Wire failed on net "${net.id}": ` + `${net.connections[j - 1]} ↔ ${net.connections[j]}`,
        );
      }
    }
  }
  return errors;
}

/** Restores saved default state values (e.g. FlipFlop initial value) from the canonical JSON onto constructed instances. */
function restoreDefaultState(
  instanceMap: Map<string, ComponentInstance>,
  components: CanonicalComponent[],
): void {
  for (const comp of components) {
    if (comp.defaultState === undefined) continue;
    Reflect.set(instanceMap.get(comp.id)!, STATEFUL_DEFAULT_STATE[comp.type]!, comp.defaultState);
  }
}

/** Creates junction nodes and restores intermediate routing nodes from the canonical layout data. */
function restoreIntermediateNodes(
  scope: Scope,
  intermediateNodes: Record<string, IntermediateNet>,
  instanceMap: Map<string, ComponentInstance>,
  nets: CanonicalNet[],
): string[] {
  const errors: string[] = [];

  const netBitWidthMap = new Map<string, number>();
  for (let i = 0; i < nets.length; i++) {
    netBitWidthMap.set(nets[i].id, nets[i].bitWidth);
  }

  for (const [netId, routing] of Object.entries(intermediateNodes)) {
    const { nodes: junctionPoints, edges, portConnections } = routing;

    const netBitWidth = netBitWidthMap.get(netId);
    if (netBitWidth === undefined) {
      errors.push(`intermediateNodes references unknown net "${netId}"`);
      continue;
    }
    const junctionNodes: Node[] = [];

    for (let i = 0; i < junctionPoints.length; i++) {
      const point = junctionPoints[i];
      // node.js makes TypeScript infer bitWidth as undefined even though its JSDoc and runtime accept a number.
      const node = Reflect.construct(Node, [point.x, point.y, 2, scope.root, netBitWidth]) as Node;
      junctionNodes.push(node);
    }

    // Junction-to-junction connections
    for (let i = 0; i < edges.length; i++) {
      const [fromId, toId] = edges[i];
      const fromNode = junctionNodes[fromId];
      const toNode = junctionNodes[toId];
      try {
        fromNode.connect(toNode);
      } catch {
        errors.push(`Junction-to-junction failed for net "${netId}" (${fromId} → ${toId})`);
      }
    }

    // Port-to-junction connections
    for (let i = 0; i < portConnections.length; i++) {
      const { portRef, nodeId } = portConnections[i];
      const junctionNode = junctionNodes[nodeId];

      const portNode = resolvePortNode(portRef, instanceMap);
      if (!portNode) {
        errors.push(`portConnection: cannot resolve "${portRef}"`);
        continue;
      }

      try {
        portNode.connect(junctionNode);
      } catch {
        errors.push(`Port-to-junction failed for net "${netId}" ("${portRef}" → node ${nodeId})`);
      }
    }
  }
  return errors;
}

/** Copies visual metadata from the canonical JSON back onto the scope object. */
function restoreScopeMetadata(
  scope: Scope,
  circuitData: CanonicalScopeInput,
  layout: CanonicalLayout,
): void {
  scope.name = circuitData.projectMetadata.name;
  scope.restrictedCircuitElementsUsed = [...circuitData.projectMetadata.restrictedElementsUsed];

  const { scale, ox, oy } = circuitData.visual.canvas;
  scope.scale = scale;
  scope.ox = ox;
  scope.oy = oy;

  const sym = layout.subcircuitSymbol;
  scope.layout = {
    width: sym.width,
    height: sym.height,
    title_x: sym.titleX,
    title_y: sym.titleY,
    titleEnabled: sym.titleEnabled,
  };

  scope.verilogMetadata = {
    ...circuitData.verilogMetadata,
    subCircuitScopeIds: [...circuitData.verilogMetadata.subCircuitScopeIds],
  };
}

/** Imports a single circuit's components, wiring, default state, and metadata into the given scope. */
async function importSingleScope(
  circuitData: CanonicalScopeInput,
  scope: Scope,
  scopeMap: Map<number, Scope>,
): Promise<string[]> {
  const { components, nets } = circuitData.netlist;
  let { layout } = circuitData;

  const { instanceMap, errors: buildErrors } = buildComponents(scope, components, layout, scopeMap);

  if (buildErrors.length > 0) {
    return buildErrors;
  }

  if (layout === undefined) {
    try {
      const { generateElkLayout } = await import("./elkLayout");
      layout = await generateElkLayout(components, nets, instanceMap);
      console.log(
        `[importCanonical] Generated ELK layout for scope "${circuitData.projectMetadata.name}"`,
      );
    } catch (err) {
      return [`Automatic layout failed: ${errorMessage(err)}`];
    }
  }

  applyComponentLayout(instanceMap, layout);

  const wireErrors = wireComponents(instanceMap, nets, layout.intermediateNodes);
  restoreDefaultState(instanceMap, components);

  const routingErrors = layout.intermediateNodes
    ? restoreIntermediateNodes(scope, layout.intermediateNodes, instanceMap, nets)
    : [];

  restoreScopeMetadata(scope, circuitData, layout);

  return [...wireErrors, ...routingErrors];
}

function computeImportOrder(circuits: Record<string, CanonicalScopeInput>): number[] {
  const inDegreeMap = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  const scopeIds = new Set<number>();

  for (const id of Object.keys(circuits)) {
    const circuitId = Number(id);
    scopeIds.add(circuitId);
    dependents.set(circuitId, []);
  }

  for (const [idStr, circuit] of Object.entries(circuits)) {
    const circuitId = Number(idStr);

    const subcircuitRefs = new Set<number>();
    for (const comp of circuit.netlist.components) {
      if (comp.type !== "SubCircuit") continue;
      const targetId = Number(getConstructorParams(comp.properties)[0]);
      if (!scopeIds.has(targetId)) {
        throw new Error(
          `Circuit ${circuitId} references missing SubCircuit scope ${String(targetId)}`,
        );
      }
      subcircuitRefs.add(targetId);
    }

    for (const targetId of subcircuitRefs) {
      dependents.get(targetId)!.push(circuitId);
    }

    inDegreeMap.set(circuitId, subcircuitRefs.size);
  }

  const topologicalOrder = khansAlgorithm(inDegreeMap, dependents);
  if (!topologicalOrder) {
    throw new Error("A cyclic dependency was detected among the subcircuits!");
  }
  return topologicalOrder;
}

export async function importCanonical(
  json: CanonicalProjectInput,
  targetScope: Scope | null | undefined,
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
    results.errors.push(errorMessage(err));
    return results;
  }

  const hostCircuitId =
    topologicalOrder.find((id) => json.circuits[String(id)].verilogMetadata.isMainCircuit) ??
    topologicalOrder[topologicalOrder.length - 1];

  targetScope.initialize();

  if (targetScope.id !== hostCircuitId) {
    targetScope.id = hostCircuitId;
    scopeList[String(hostCircuitId)] = targetScope;
  }

  const keepScopeId = String(targetScope.id);
  for (const sid of Object.keys(scopeList)) {
    if (sid !== keepScopeId) {
      delete scopeList[sid];
    }
  }
  {
    const store = SimulatorStore();
    store.circuit_list.splice(0, store.circuit_list.length);
    store.circuit_list.push({
      id: targetScope.id,
      name: targetScope.name,
    });
    if (store.activeCircuit) {
      store.activeCircuit.id = targetScope.id;
      store.activeCircuit.name = targetScope.name;
    }
  }

  const scopeMap = new Map<number, Scope>();

  for (const canonicalId of topologicalOrder) {
    const circuitData = json.circuits[String(canonicalId)];

    let currentScope: Scope;
    if (canonicalId === hostCircuitId) {
      currentScope = targetScope;
    } else {
      const newScope = newCircuit(
        circuitData.projectMetadata.name,
        String(canonicalId),
        circuitData.verilogMetadata.isVerilogCircuit,
        circuitData.verilogMetadata.isMainCircuit,
      );
      if (!newScope) {
        results.errors.push(`[${canonicalId}] Failed to create scope — name may be empty`);
        continue;
      }
      currentScope = newScope;
    }

    scopeMap.set(canonicalId, currentScope);

    const importErrors = await importSingleScope(circuitData, currentScope, scopeMap);
    if (importErrors.length === 0) {
      results.imported++;
    }
    for (const err of importErrors) {
      results.errors.push(`[${canonicalId}] ${err}`);
    }
  }

  results.success = results.errors.length === 0;

  {
    const store = SimulatorStore();
    const hostIdx = store.circuit_list.findIndex(
      (c: { id: string | number; name?: string }) => String(c.id) === String(targetScope.id),
    );
    if (hostIdx !== -1) {
      store.circuit_list[hostIdx].name = targetScope.name;
    }
  }

  if (results.success) {
    resetup();
    renderCanvas(targetScope);
    switchCircuit(String(targetScope.id));
    updateSimulationSet(true);
    updateSubcircuitSet(true);
    forceResetNodesSet(true);
    updateCanvasSet(true);
    gridUpdateSet(true);
    update(targetScope, true);
    scheduleUpdate(1);
  }

  return results;
}

declare let globalScope: Scope;

/** Exports the current project, removes layout in memory, and imports it again through ELK. */
export async function elkRoundTrip(): Promise<ImportResult> {
  const targetScope = globalScope;
  const exported = await canonicaliseProject(Object.values(scopeList));
  const circuits: CanonicalProjectInput["circuits"] = {};

  for (const [id, circuit] of Object.entries(exported.circuits)) {
    const { layout: _layout, ...withoutLayout } = circuit;
    circuits[id] = withoutLayout;
  }

  return importCanonical({ ...exported, circuits }, targetScope);
}

declare global {
  interface Window {
    importCanonical?: typeof importCanonical;
    elkRoundTrip?: typeof elkRoundTrip;
  }
}

window.importCanonical = importCanonical;
window.elkRoundTrip = elkRoundTrip;
