import { circuitElementList } from '../metadata'
import modules from '../modules'
import { canonicaliseScope } from './canonical'
import { resetup } from '../setup'
import Node from '../node'

export function validateCanonicalJson(circuitData) {
    const errors = []
    const knownTypes = new Set(circuitElementList)

    if (!circuitData.netlist)
        errors.push('Missing netlist')
    if (!Array.isArray(circuitData.netlist?.components))
        errors.push('netlist.components must be an array')
    if (!Array.isArray(circuitData.netlist?.nets))
        errors.push('netlist.nets must be an array')
    if (!circuitData.interfacePorts)
        errors.push('Missing interfacePorts')

    if (Array.isArray(circuitData.netlist?.components)) {
        for (let i = 0; i < circuitData.netlist.components.length; i++) {
            const comp = circuitData.netlist.components[i]
            if (!comp?.id || typeof comp.id !== 'string')
                errors.push(`component[${i}] missing valid id`)
            if (!comp?.type || !knownTypes.has(comp.type))
                errors.push(`component[${i}] has unknown type: ${comp?.type}`)
            if (!comp?.connections || typeof comp.connections !== 'object')
                errors.push(`component[${i}] missing connections object`)
        }
    }

    if (errors.length > 0) return { valid: false, errors }
    return { valid: true, errors: [] }
}

function buildComponents(scope, components, layout) {
    const instanceMap = new Map()

    for (let i = 0; i < components.length; i++) {
        const { id, type, bitWidth, label, properties } = components[i]
        const pos = layout?.[id] || { x: 0, y: 0 }

        if (type === 'SubCircuit') {
            console.warn(`[importCanonical] SubCircuit "${id}" will be implemented later`)
            continue
        }

        const Constructor = modules[type]
        if (typeof Constructor !== 'function') {
            console.warn(`[importCanonical] No constructor for type "${type}" (id: ${id})`)
            continue
        }

        const direction = properties?.direction || 'RIGHT'

        const numInputs = Object.keys(components[i].connections || {})
            .filter(p => /^inp_\d+$/.test(p)).length

        let instance
        try {
            instance = numInputs > 0
                // Note: for components with inputs, bitWidth is passed as an option, not a positional argument
                ? new Constructor(pos.x, pos.y, scope, direction, numInputs, bitWidth)
                // Note: for zero-input components, bitWidth is passed in place of numInputs
                : new Constructor(pos.x, pos.y, scope, direction, bitWidth)
        } catch (err) {
            console.error(`[importCanonical] Failed to construct "${type}" (id: ${id}):`, err)
            continue
        }

        instance.label = label

        if (properties?.propagationDelay !== undefined) {
            instance.propagationDelay = properties.propagationDelay
        }

        if (pos.labelDirection !== undefined) {
            instance.labelDirection = pos.labelDirection
        }

        instanceMap.set(id, instance)
    }

    return instanceMap
}

function resolvePortNode(portRef, instanceMap) {
    const dotIdx = portRef.indexOf('.')
    if (dotIdx === -1) return null

    const compId   = portRef.substring(0, dotIdx)
    const portName = portRef.substring(dotIdx + 1)

    const instance = instanceMap.get(compId)
    if (!instance) {
        console.warn(`[importCanonical] resolvePortNode: no instance for "${compId}"`)
        return null
    }

    const lastUnderscoreIdx = portName.lastIndexOf('_')
    if (lastUnderscoreIdx > 0) {
        const base = portName.substring(0, lastUnderscoreIdx)
        const idx  = parseInt(portName.substring(lastUnderscoreIdx + 1), 10)

        if (!isNaN(idx) && idx >= 0 && Array.isArray(instance[base])) {
            const node = instance[base][idx]
            if (node) return node
            console.warn(`[importCanonical] Array port "${portRef}" index out of range`)
            return null
        }
    }

    const node = instance[portName]
    if (node) return node

    console.warn(`[importCanonical] Port not found: "${portName}" on "${compId}"`)
    return null
}

function wireComponents(instanceMap, nets, intermediateNodesByNet = null) {
    const graphRoutedNetIds = new Set(
        Object.entries(intermediateNodesByNet || {})
            .filter(([, routing]) => (
                routing &&
                !Array.isArray(routing) &&
                Array.isArray(routing.nodes) &&
                routing.nodes.length > 0
            ))
            .map(([netId]) => netId)
    )

    for (const net of nets) {
        if (graphRoutedNetIds.has(net.id)) continue

        const portNodes = net.connections
            .map(ref => resolvePortNode(ref, instanceMap))
            .filter(node => node !== null)

        if (portNodes.length < 2) {
            if (portNodes.length === 1)
                console.warn(`[importCanonical] net "${net.id}": only 1 node resolved, skipping`)
            continue
        }

        for (let i = 1; i < portNodes.length; i++) {
            try {
                portNodes[i - 1].connect(portNodes[i])
            } catch (err) {
                console.error(`[importCanonical] Wire failed on net "${net.id}": ${net.connections[i - 1]} and ${net.connections[i]}`, err)
            }
        }
    }
}

function restoreDefaultState(instanceMap, components) {
    for (const compData of components) {
        if (compData.type !== 'Input' && compData.type !== 'ConstantVal') continue
        if (compData.defaultState === undefined) continue

        const instance = instanceMap.get(compData.id)
        if (!instance) continue

        instance.state = compData.defaultState
    }
}

function restoreNetLabels(instanceMap, nets) {
    for (const net of nets) {
        if (!net?.label) continue

        const labeledNode = (net.connections || [])
            .map(ref => resolvePortNode(ref, instanceMap))
            .find(node => node !== null)

        if (labeledNode) {
            labeledNode.label = net.label
        }
    }
}

function restoreIntermediateNodes(scope, intermediateNodes, instanceMap, nets = []) {
    if (!intermediateNodes || Object.keys(intermediateNodes).length === 0) return

    const netBitWidthMap = new Map((nets || []).map(net => [net.id, net.bitWidth]))

    for (const [netId, routing] of Object.entries(intermediateNodes)) {
        const { nodes: junctionPoints, edges, portConnections } = routing
        if (!junctionPoints || junctionPoints.length === 0) continue

        const netBitWidth = netBitWidthMap.get(netId)

        const junctionNodes = []
        for (const point of junctionPoints) {
            try {
                const node = netBitWidth !== undefined
                    ? new Node(point.x, point.y, 2, scope.root, netBitWidth)
                    : new Node(point.x, point.y, 2, scope.root)
                junctionNodes.push(node)
            } catch (err) {
                console.error(`[importCanonical] Failed to create junction at (${point.x},${point.y}) for ${netId}:`, err)
                junctionNodes.push(null)
            }
        }

        // junction to junction
        for (const [fromId, toId] of edges) {
            const fromNode = junctionNodes[fromId]
            const toNode = junctionNodes[toId]
            if (fromNode && toNode) {
                try {
                    fromNode.connect(toNode)
                } catch (err) {
                    console.error(`[importCanonical] junction-to-junction connection failed for net "${netId}" (${fromId} -> ${toId}):`, err)
                }
            }
        }

        // component ports to junction
        for (const { portRef, nodeId } of portConnections) {
            const junctionNode = junctionNodes[nodeId]
            if (!junctionNode) continue

            const portNode = resolvePortNode(portRef, instanceMap)
            if (!portNode) {
                console.warn(`[importCanonical] portConnection: cannot resolve "${portRef}"`)
                continue
            }

            try {
                portNode.connect(junctionNode)
            } catch (err) {
                console.error(`[importCanonical] port-to-junction connection failed for net "${netId}" (port "${portRef}" -> node ${nodeId}):`, err)
            }
        }

    }
}

function restoreScopeMetadata(scope, circuitData) {
    if (circuitData.projectMetadata?.name) {
        scope.name = circuitData.projectMetadata.name
    }

    if (circuitData.visual?.canvas) {
        const { scale, ox, oy } = circuitData.visual.canvas
        scope.scale = scale ?? 1
        scope.ox = ox ?? 0
        scope.oy = oy ?? 0
    }

    if (circuitData.layout?.subcircuitSymbol) {
        const sym = circuitData.layout.subcircuitSymbol
        scope.layout = {
            width: sym.width ?? 100,
            height: sym.height ?? 100,
            titleX: sym.titleX ?? 50,
            titleY: sym.titleY ?? 13,
            titleEnabled: sym.titleEnabled ?? true,
        }
    }
}

function refreshCanvas(scope, hasRestoredViewport = false) {
    try {
        if (!hasRestoredViewport && typeof scope.centerFocus === 'function') {
            scope.centerFocus(true)
        }
        if (typeof resetup === 'function') resetup()
        if (typeof renderCanvas === 'function') renderCanvas()
    } catch (err) {
        console.warn('[importCanonical] Canvas refresh failed:', err)
    }
}

// Export → import → export should produce the same canonical hash when the circuit is unchanged.
async function verifyRoundTrip(scope, expectedHash) {
    const reExported = await canonicaliseScope(scope)
    const actualHash = reExported.circuits?.[String(scope.id)]?.canonicalHash

    const match = actualHash === expectedHash

    if (match) {
        console.log(
            '[importCanonical] Round-trip check\n' +
            '  scopeId: ' + String(scope?.id) + '\n' +
            '  present hash: ' + expectedHash + '\n' +
            '  now exporting...\n' +
            '  exported hash: ' + actualHash + '\n' +
            '  result: PASS'
        )
    } else {
        console.warn(
            '[importCanonical] Round-trip check\n' +
            '  scopeId: ' + String(scope?.id) + '\n' +
            '  present hash: ' + expectedHash + '\n' +
            '  now exporting...\n' +
            '  exported hash: ' + actualHash + '\n' +
            '  result: FAIL\n' +
            '  Import did not reproduce the original netlist exactly.'
        )
    }

    return { match, actualHash, expectedHash }
}

export async function importCanonical(json, targetScope) {
    const results = {
        success: false, // True if at least one circuit imported successfully
        imported: 0, // Count of successfully imported circuits
        errors: []
    }

    if (!json.circuits || typeof json.circuits !== 'object') {
        results.errors.push('Missing circuits object in JSON')
        return results
    }

    const circuits = Object.entries(json.circuits)
        .map(([scopeId, circuitData]) => ({ scopeId, circuitData }))

    if (circuits.length === 0) {
        results.errors.push('No circuits found in JSON')
        return results
    }

    for (const { scopeId, circuitData } of circuits) {
        const validation = validateCanonicalJson(circuitData)
        if (!validation.valid) {
            console.error(`[importCanonical] Validation failed for "${scopeId}":`)
            results.errors.push(...validation.errors)
            continue
        }

        if (!targetScope) {
            results.errors.push(`No scope provided for circuit "${scopeId}"`)
            continue
        }

        const scope  = targetScope
        const layout = circuitData.layout || {}
        const { components, nets } = circuitData.netlist

        const instanceMap = buildComponents(scope, components, layout)

        if (components.length > 0 && instanceMap.size === 0) {
            results.errors.push(`[${scopeId}] no components could be constructed`)
            continue
        }

        wireComponents(instanceMap, nets, layout.intermediateNodes)
        restoreDefaultState(instanceMap, components)
        restoreNetLabels(instanceMap, nets)

        if (layout.intermediateNodes) {
            restoreIntermediateNodes(scope, layout.intermediateNodes, instanceMap, nets)
        }

        restoreScopeMetadata(scope, circuitData)

        refreshCanvas(scope, Boolean(circuitData.visual?.canvas))

        if (circuitData.canonicalHash) {
            const verification = await verifyRoundTrip(scope, circuitData.canonicalHash)
            if (!verification.match) {
                console.warn(`[importCanonical] Round-trip mismatch for "${scopeId}"`)
            }
        }

        if (instanceMap.size > 0 || components.length === 0) {
            results.imported++
        }
    }

    results.success = results.imported > 0
    return results
}

// For testing in the browser console directly
if (typeof window !== 'undefined') {
    window.importCanonical      = importCanonical
    window.validateCanonicalJson = validateCanonicalJson
}
