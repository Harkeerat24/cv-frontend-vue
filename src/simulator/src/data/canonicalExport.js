/**
 * Canonical Data Format Converter for CircuitVerse
 *
 * Converts the internal CircuitVerse save format into a universal,
 * simulator-agnostic canonical JSON representation.
 *
 * The canonical format separates:
 *   - Logical netlist (components, ports, nets, interface)
 *   - Visual layout (positions, directions)
 *
 * This makes circuits portable to other simulators while retaining
 * enough info to reconstruct the visual layout in CircuitVerse.
 *
 * @module canonicalExport
 * @category data
 */

import { scopeList } from '../circuit'
import { simulationArea } from '../simulationArea'
import { moduleList, circuitElementList } from '../metadata'
import { update, updateSubcircuitSet } from '../engine'
import { getProjectName, getTabsOrder } from './save'
import { stripTags } from '../utils'

// Annotation types are visual-only (Text, Rectangle, Arrow, ImageAnnotation)
const ANNOTATION_TYPES = new Set(['Text', 'Rectangle', 'Arrow', 'ImageAnnotation'])

// Port name mappings for known component types
// Maps internal node names to human-readable port names
const PORT_ALIASES = {
    inp1: 'input',
    inp: 'input',
    output1: 'output',
    out: 'output',
    clockInp: 'clock',
    dInp: 'D',
    qOutput: 'Q',
    qInvOutput: 'Qbar',
    reset: 'reset',
    preset: 'preset',
    en: 'enable',
    bitWidth: undefined, // skip, it's a property not a port
}

/**
 * Generate a deterministic component ID based on type and index.
 * e.g. "DflipFlop_0", "Clock_0", "Input_1"
 */
function makeComponentId(type, index) {
    return `${type}_${index}`
}

/**
 * Extract port information from a component's node connections.
 * Returns an object mapping portName -> portId (componentId.portName).
 */
function extractPorts(component, componentId) {
    const ports = {}

    // Most CV components store their nodes as named properties
    // We discover them by checking node-like objects
    if (component.nodeList) {
        component.nodeList.forEach((nodeName) => {
            const node = component[nodeName]
            if (node && typeof node === 'object' && node.connections !== undefined) {
                const portName = nodeName
                ports[portName] = `${componentId}.${portName}`
            }
        })
    }

    return ports
}

/**
 * Extract properties relevant to the canonical format.
 * Filters out visual and internal-only properties.
 */
function extractProperties(saveObj, type) {
    const props = {}

    // Common properties that affect logic
    const logicProps = [
        'bitWidth', 'propagationDelay', 'numberOfInputs', 'numberOfOutputs',
        'inputSize', 'outputSize', 'controlSignalSize', 'rows', 'cols',
        'direction', 'state', 'value', 'constantVal',
        'constructorParamaters' // yes, it's misspelled in CV source
    ]

    for (const key of logicProps) {
        if (saveObj[key] !== undefined) {
            props[key] = saveObj[key]
        }
    }

    return Object.keys(props).length > 0 ? props : undefined
}

/**
 * Build the canonical representation of a single circuit scope.
 *
 * Structure:
 * {
 *   id: "circuit_<name>",
 *   originalId: <number>,
 *   name: "Main",
 *   netlist: {
 *     components: [...],
 *     nets: [...],
 *     interfacePorts: { inputs: [...], outputs: [...] }
 *   },
 *   visual: {
 *     layout: {...},
 *     components: { componentId: {x, y, direction, labelDirection} }
 *   }
 * }
 */
function convertScope(scope) {
    const circuit = {
        id: `circuit_${(scope.name || 'main').toLowerCase().replace(/\s+/g, '_')}`,
        originalId: scope.id,
        name: scope.name || 'Main',
        netlist: {
            components: [],
            nets: [],
            interfacePorts: {
                inputs: [],
                outputs: [],
            },
        },
        visual: {
            layout: {},
            components: {},
        },
    }

    // Track component type counts for deterministic naming
    const typeCounters = {}

    // Track all nodes -> which component port they belong to
    // nodeIndex -> [{ componentId, portName }]
    const nodeToPort = {}

    // Collect all allNodes for net reconstruction
    const allNodes = scope.allNodes || []

    // Process each module type
    for (const moduleType of circuitElementList) {
        const elements = scope[moduleType]
        if (!elements || elements.length === 0) continue

        if (!typeCounters[moduleType]) typeCounters[moduleType] = 0

        for (const element of elements) {
            const index = typeCounters[moduleType]++
            const componentId = makeComponentId(moduleType, index)

            // Build component entry
            const component = {
                id: componentId,
                type: moduleType,
                label: element.label || '',
            }

            // Add logical properties
            const props = extractProperties(element, moduleType)
            if (props) {
                component.properties = props
            }

            // Build ports from node connections
            const ports = {}
            if (element.nodeList) {
                for (const nodeName of element.nodeList) {
                    const node = element[nodeName]
                    if (node) {
                        const portId = `${componentId}.${nodeName}`
                        ports[nodeName] = portId

                        // Map all node indices to this port
                        if (node.connections) {
                            const nodeIdx = allNodes.indexOf(node)
                            if (nodeIdx >= 0) {
                                if (!nodeToPort[nodeIdx]) nodeToPort[nodeIdx] = []
                                nodeToPort[nodeIdx].push({
                                    componentId,
                                    portName: nodeName,
                                    portId,
                                    bitWidth: node.bitWidth || 1,
                                })
                            }
                        }
                    }
                }
            }

            if (Object.keys(ports).length > 0) {
                component.ports = ports
            }

            // State for stateful components (Inputs with set values, flip-flops, etc.)
            if (moduleType === 'Input' || moduleType === 'TB_Input') {
                component.state = { state: element.state !== undefined ? element.state : 0 }
            }

            circuit.netlist.components.push(component)

            // Visual data
            circuit.visual.components[componentId] = {
                x: element.x,
                y: element.y,
                direction: element.direction || 'RIGHT',
                labelDirection: element.labelDirection || 'LEFT',
            }

            // Interface ports (for subcircuit usage)
            if (moduleType === 'Input' || moduleType === 'TB_Input') {
                circuit.netlist.interfacePorts.inputs.push({
                    componentId,
                    label: element.label || '',
                    bitWidth: element.bitWidth || 1,
                    order: circuit.netlist.interfacePorts.inputs.length,
                })
            } else if (moduleType === 'Output' || moduleType === 'TB_Output') {
                circuit.netlist.interfacePorts.outputs.push({
                    componentId,
                    label: element.label || '',
                    bitWidth: element.bitWidth || 1,
                    order: circuit.netlist.interfacePorts.outputs.length,
                })
            }
        }
    }

    // Build nets by tracing connected nodes
    // Two ports are on the same net if their underlying nodes are connected
    const visited = new Set()
    let netIndex = 0

    function traceNet(startNodeIdx) {
        const netNodes = new Set()
        const queue = [startNodeIdx]

        while (queue.length > 0) {
            const idx = queue.shift()
            if (visited.has(idx) || netNodes.has(idx)) continue
            netNodes.add(idx)
            visited.add(idx)

            const node = allNodes[idx]
            if (!node) continue

            // Follow connections to other nodes
            if (node.connections) {
                for (const conn of node.connections) {
                    const connIdx = allNodes.indexOf(conn)
                    if (connIdx >= 0 && !netNodes.has(connIdx)) {
                        queue.push(connIdx)
                    }
                }
            }
        }

        return netNodes
    }

    // For each node that has a component port attached, trace its full net
    for (let i = 0; i < allNodes.length; i++) {
        if (visited.has(i)) continue
        if (!nodeToPort[i]) continue // Skip nodes with no component attachment

        const netNodeIndices = traceNet(i)

        // Collect all component ports on this net
        const connections = []
        let bitWidth = 1
        let label = ''

        for (const nodeIdx of netNodeIndices) {
            if (nodeToPort[nodeIdx]) {
                for (const port of nodeToPort[nodeIdx]) {
                    connections.push(port.portId)
                    bitWidth = port.bitWidth || bitWidth
                    if (!label && port.portName) {
                        label = port.portName
                    }
                }
            }
        }

        if (connections.length >= 2) {
            circuit.netlist.nets.push({
                id: `net_${netIndex++}`,
                bitWidth,
                connections,
                label,
            })
        }
    }

    // Visual layout info
    if (scope.layout) {
        circuit.visual.layout = {
            width: scope.layout.width || 100,
            height: scope.layout.height || 100,
            titleX: scope.layout.title_x || 50,
            titleY: scope.layout.title_y || 13,
            titleEnabled: scope.layout.titleEnabled !== false,
        }
    }

    return circuit
}

/**
 * Generate the full canonical JSON for the entire project.
 *
 * @returns {string} JSON string in canonical format
 */
export function generateCanonicalData() {
    const projectName = getProjectName() || 'Untitled'

    const canonical = {
        formatVersion: '1.0',
        generator: 'CircuitVerse Canonical Converter v1.0',
        generatedAt: new Date().toISOString(),
        project: {
            name: stripTags(projectName),
            projectId: window.projectId || '',
            clockEnabled: simulationArea.clockEnabled,
            timePeriod: simulationArea.timePeriod,
            focusedCircuitId: String(globalScope.id),
            tabOrder: getTabsOrder(),
        },
        circuits: [],
    }

    // Process dependency order (same as regular save)
    const dependencyList = {}
    const completed = {}

    for (const id in scopeList) {
        dependencyList[id] = scopeList[id].getDependencies()
    }

    function processScope(id) {
        if (completed[id]) return
        for (const dep of dependencyList[id]) {
            processScope(dep)
        }
        completed[id] = true
        updateSubcircuitSet(true)
        update(scopeList[id], true)
        canonical.circuits.push(convertScope(scopeList[id]))
    }

    for (const id in scopeList) {
        processScope(id)
    }

    return JSON.stringify(canonical, null, 2)
}
