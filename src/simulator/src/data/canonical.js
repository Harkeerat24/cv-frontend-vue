import { circuitElementList } from '../metadata'

class UnionFind {
    constructor(size) {
        this.parent = Array.from({ length: size }, (_, i) => i)
        this.rank = new Array(size).fill(0)
    }

    find(x) {
        if (this.parent[x] !== x) {
            this.parent[x] = this.find(this.parent[x])
        }
        return this.parent[x]
    }

    union(a, b) {
        let rootA = this.find(a)
        let rootB = this.find(b)
        if (rootA === rootB) return

        if (this.rank[rootA] < this.rank[rootB]) {
            ;[rootA, rootB] = [rootB, rootA]
        }
        this.parent[rootB] = rootA

        if (this.rank[rootA] === this.rank[rootB]) {
            this.rank[rootA]++
        }
    }

    getGroups() {
        const groups = new Map()
        for (let i = 0; i < this.parent.length; i++) {
            const root = this.find(i)
            if (!groups.has(root)) groups.set(root, [])
            groups.get(root).push(i)
        }
        return groups
    }
}

function buildNodeIndexMap(allNodes) {
    const map = new Map()
    for (let i = 0; i < allNodes.length; i++) {
        map.set(allNodes[i], i)
    }
    return map
}

function extractNets(scope, nodeIndexMap) {
    const { allNodes } = scope
    const uf = new UnionFind(allNodes.length)

    for (let i = 0; i < allNodes.length; i++) {
        const node = allNodes[i]
        for (let c = 0; c < node.connections.length; c++) {
            const neighbourIdx = nodeIndexMap.get(node.connections[c])
            if (neighbourIdx !== undefined) {
                uf.union(i, neighbourIdx)
            }
        }
    }

    const groupCount = uf.getGroups().size
    return { uf, groupCount }
}

function extractComponents(scope, uf, nodeIndexMap) {
    const components = []

    for (let t = 0; t < circuitElementList.length; t++) {
        const typeName = circuitElementList[t]
        const instances = scope[typeName]
        if (!instances || instances.length === 0) continue

        for (let c = 0; c < instances.length; c++) {
            const comp = instances[c]

            const portDefs = comp.customSave().nodes
            if (!portDefs || Object.keys(portDefs).length === 0) continue

            const portNetRoots = {}
            const portNames = Object.keys(portDefs)

            for (let p = 0; p < portNames.length; p++) {
                const portName = portNames[p]
                const savedVal = portDefs[portName]

                if (Array.isArray(savedVal)) {
                    const nodeArray = comp[portName]
                    for (let i = 0; i < nodeArray.length; i++) {
                        const idx = nodeIndexMap.get(nodeArray[i])
                        if (idx === undefined) {
                            console.warn(`[canonical] node missing — ${typeName}.${portName}[${i}]`)
                            continue
                        }
                        portNetRoots[`${portName}_${i}`] = uf.find(idx)
                    }
                } else {
                    const idx = nodeIndexMap.get(comp[portName])
                    if (idx === undefined) {
                        console.warn(`[canonical] node missing — ${typeName}.${portName}`)
                        continue
                    }
                    portNetRoots[portName] = uf.find(idx)
                }
            }

            const properties = {}
            if (comp.direction !== undefined) {
                properties.direction = comp.direction
            }
            if (comp.propagationDelay !== undefined && comp.propagationDelay !== 0) {
                properties.propagationDelay = comp.propagationDelay
            }

            const defaultState =
                (typeName === 'Input' || typeName === 'ConstantVal') && comp.state !== undefined
                    ? comp.state
                    : undefined
            components.push({
                type: comp.objectType,
                label: comp.label || '',
                bitWidth: comp.bitWidth,
                properties,
                _connections: portNetRoots,
                _state: defaultState,
                _labelDirection: comp.labelDirection,
                _x: comp.x,
                _y: comp.y,
                _instance: comp,
            })
        }
    }

    return components
}

// Sort components by type, then label, then connections for deterministic ID assignment and JSON output.
function sortComponents(components) {
    components.sort((a, b) => {
        if (a.type < b.type) return -1
        if (a.type > b.type) return 1

        if (a.label < b.label) return -1
        if (a.label > b.label) return 1

        const fpA = JSON.stringify(
            Object.fromEntries(Object.keys(a._connections).sort().map(k => [k, a._connections[k]]))
        )
        const fpB = JSON.stringify(
            Object.fromEntries(Object.keys(b._connections).sort().map(k => [k, b._connections[k]]))
        )
        if (fpA < fpB) return -1
        if (fpA > fpB) return 1

        return 0
    })
}

function assignComponentIds(components) {
    const countByType = {}
    for (let i = 0; i < components.length; i++) {
        const comp = components[i]
        if (!countByType[comp.type]) countByType[comp.type] = 0
        comp.id = `${comp.type}_${countByType[comp.type]++}`
    }
}

function assignNetIds(components) {
    const netIdMap = {}
    const netConnections = {}
    let netCounter = 0

    for (let i = 0; i < components.length; i++) {
        const comp = components[i]
        const portNames = Object.keys(comp._connections).sort()

        for (let j = 0; j < portNames.length; j++) {
            const groupRoot = comp._connections[portNames[j]]

            if (netIdMap[groupRoot] === undefined) {
                const netId = `net_${netCounter++}`
                netIdMap[groupRoot] = netId
                netConnections[netId] = []
            }

            const netId = netIdMap[groupRoot]
            netConnections[netId].push(`${comp.id}.${portNames[j]}`)
        }
    }

    for (let i = 0; i < components.length; i++) {
        const conn = components[i]._connections
        for (const port of Object.keys(conn)) {
            conn[port] = netIdMap[conn[port]]
        }
    }

    return { netIdMap, netConnections }
}

function buildWireLabelMap(allNodes, uf) {
    const labelByRoot = new Map()
    for (let i = 0; i < allNodes.length; i++) {
        const label = allNodes[i].label
        if (!label) continue
        const root = uf.find(i)
        if (!labelByRoot.has(root)) {
            labelByRoot.set(root, label)
        }
    }
    return labelByRoot
}

function deriveNetLabel(memberPortRefs, compMap, wireLabel) {
    if (wireLabel) return wireLabel

    for (let i = 0; i < memberPortRefs.length; i++) {
        const compId = memberPortRefs[i].split('.')[0]
        const comp = compMap.get(compId)
        if (comp && comp.label && (comp.type === 'Input' || comp.type === 'Output')) {
            return comp.label
        }
    }

    return undefined
}

function buildNetsArray(netIdMap, netConnections, allNodes, components, uf) {
    const compMap = new Map(components.map(c => [c.id, c]))
    const wireLabelByRoot = buildWireLabelMap(allNodes, uf)

    const nets = []
    const entries = Object.entries(netIdMap)
    for (let i = 0; i < entries.length; i++) {
        const groupRoot = Number(entries[i][0])
        const netId = entries[i][1]

        const label = deriveNetLabel(
            netConnections[netId] || [],
            compMap,
            wireLabelByRoot.get(groupRoot)
        )

        const netEntry = {
            id: netId,
            bitWidth: allNodes[groupRoot].bitWidth,
            connections: netConnections[netId] || [],
        }
        if (label) netEntry.label = label
        nets.push(netEntry)
    }

    nets.sort((a, b) => parseInt(a.id.slice(4)) - parseInt(b.id.slice(4)))

    const connectedNets = nets.filter(net => net.connections.length >= 2)

    for (let i = 0; i < connectedNets.length; i++) {
        connectedNets[i].connections.sort()
    }

    const renameMap = {}
    let counter = 0
    for (const net of connectedNets) {
        renameMap[net.id] = `net_${counter++}`
    }
    for (const net of connectedNets) {
        net.id = renameMap[net.id]
    }

    return { nets: connectedNets, renameMap }
}

function buildInstanceToIdMap(components) {
    const map = new Map()
    for (const comp of components) if (comp._instance) map.set(comp._instance, comp.id)
    return map
}

function extractIntermediateNodes(scope, nodeIndexMap, uf, netIdMap, renameMap, instanceToId, components) {
    const allNodes = scope.allNodes

    const portRefByNodeIndex = new Map()

    for (const comp of components) {
        const instance = comp._instance

        if (!instance || !instance.customSave) continue

        const canonicalId = instanceToId.get(instance)
        if (!canonicalId) continue

        const portDefs = instance.customSave().nodes

        for (const portName of Object.keys(portDefs)) {
            const savedVal = portDefs[portName]

            if (Array.isArray(savedVal)) {
                // Array port: resolve each element separately
                const nodeArray = instance[portName]

                for (let pi = 0; pi < nodeArray.length; pi++) {
                    const idx = nodeIndexMap.get(nodeArray[pi])
                    if (idx !== undefined) {
                        portRefByNodeIndex.set(idx, `${canonicalId}.${portName}_${pi}`)
                    }
                }
            } else {
                const idx = nodeIndexMap.get(instance[portName])
                if (idx !== undefined) {
                    portRefByNodeIndex.set(idx, `${canonicalId}.${portName}`)
                }
            }
        }
    }

    const intermediatesByNet = new Map()

    for (let i = 0; i < allNodes.length; i++) {
        const node = allNodes[i]
        if (node.deleted || node.type !== 2) continue
        if (node.connections.length === 0) continue

        const root = uf.find(i)
        const originalNetId = netIdMap[root]
        const finalNetId = renameMap[originalNetId]
        if (finalNetId === undefined) continue

        if (!intermediatesByNet.has(finalNetId)) intermediatesByNet.set(finalNetId, [])
        intermediatesByNet.get(finalNetId).push({ node, idx: i })
    }

    const result = {}

    for (const [finalNetId, intermediates] of intermediatesByNet) {
        intermediates.sort((a, b) =>
            a.node.x !== b.node.x ? a.node.x - b.node.x : a.node.y - b.node.y
        )

        const nodeToLocalId = new Map()
        const nodes = []

        for (let i = 0; i < intermediates.length; i++) {
            nodeToLocalId.set(intermediates[i].idx, i)
            nodes.push({ id: i, x: intermediates[i].node.x, y: intermediates[i].node.y })
        }

        // Internal wire edges (junction to junction)
        const edgeSet = new Set()
        const edges = []

        for (const { node, idx } of intermediates) {
            const fromLocalId = nodeToLocalId.get(idx)

            for (const neighbour of node.connections) {
                const neighbourIdx = nodeIndexMap.get(neighbour)
                if (neighbourIdx === undefined || neighbour.deleted) continue

                if (!nodeToLocalId.has(neighbourIdx)) continue // Component port : skip

                const toLocalId = nodeToLocalId.get(neighbourIdx)
                const edgeKey = `${Math.min(fromLocalId, toLocalId)}-${Math.max(fromLocalId, toLocalId)}`

                if (!edgeSet.has(edgeKey)) {
                    edgeSet.add(edgeKey)
                    edges.push([Math.min(fromLocalId, toLocalId), Math.max(fromLocalId, toLocalId)])
                }
            }
        }

        edges.sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1])

        // External port connections (junction to component port)
        const portConnSeen = new Set()
        const portConnections = []

        for (const { node: junctionNode, idx: junctionIdx } of intermediates) {
            const localId = nodeToLocalId.get(junctionIdx)

            for (const neighbour of junctionNode.connections) {
                const neighbourIdx = nodeIndexMap.get(neighbour)
                if (neighbourIdx === undefined || neighbour.deleted) continue
                if (neighbour.type === 2) continue

                const portRef = portRefByNodeIndex.get(neighbourIdx)
                if (!portRef) continue

                const dedupeKey = `${portRef}|${localId}`

                if (!portConnSeen.has(dedupeKey)) {
                    portConnSeen.add(dedupeKey)
                    portConnections.push({ portRef, nodeId: localId })
                }
            }
        }

        portConnections.sort((a, b) => a.portRef.localeCompare(b.portRef))

        result[finalNetId] = { nodes, edges, portConnections }
    }

    const sorted = {}

    Object.keys(result)
        .sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)))
        .forEach(k => {
            sorted[k] = result[k]
        })

    return sorted
}

function extractLayout(scope, components, nodeIndexMap, uf, netIdMap, renameMap) {
    const layout = {}

    const instanceToId = buildInstanceToIdMap(components)

    const intermediateNodes = extractIntermediateNodes(
        scope, nodeIndexMap, uf, netIdMap, renameMap, instanceToId, components
    )
    if (Object.keys(intermediateNodes).length > 0) {
        layout.intermediateNodes = intermediateNodes
    }

    for (let i = 0; i < components.length; i++) {
        const comp = components[i]
        layout[comp.id] = {
            x: comp._x,
            y: comp._y,
            labelDirection: comp._labelDirection,
        }
        delete comp._x
        delete comp._y
        delete comp._labelDirection
        delete comp._instance
    }

    if (scope.layout && typeof scope.layout === 'object') {
        layout.subcircuitSymbol = {
            width: scope.layout.width ?? 100,
            height: scope.layout.height ?? 100,
            titleX: scope.layout.titleX ?? 50,
            titleY: scope.layout.titleY ?? 13,
            titleEnabled: scope.layout.titleEnabled ?? true,
        }
    }

    return layout
}

function extractVisual(scope) {
    return {
        canvas: {
            scale: scope.scale ?? 1,
            ox: scope.ox ?? 0,
            oy: scope.oy ?? 0
        },
    }
}

function buildInterfacePorts(components) {
    const inputs = []
    const outputs = []

    for (let i = 0; i < components.length; i++) {
        const comp = components[i]
        const entry = {
            componentId: comp.id,
            label: comp.label,
            bitWidth: comp.bitWidth,
            subcircuitExposed: true,
        }

        if (comp.type === 'Input') {
            inputs.push({ ...entry, order: inputs.length })
        } else if (comp.type === 'Output') {
            outputs.push({ ...entry, order: outputs.length })
        }
    }

    return { inputs, outputs }
}

function buildCanonicalComponents(components, validNetIds) {
    return components.map(comp => {
        const connections = {}
        for (const [port, netId] of Object.entries(comp._connections)) {
            if (validNetIds.has(netId)) {
                connections[port] = netId
            }
        }
        delete comp._connections

        const entry = {
            id: comp.id,
            type: comp.type,
            label: comp.label,
            bitWidth: comp.bitWidth,
            connections,
            properties: comp.properties,
        }

        if ((comp.type === 'Input' || comp.type === 'ConstantVal') && comp._state !== undefined) {
            entry.defaultState = comp._state
            delete comp._state
        }

        return entry
    })
}

async function sha256(text) {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
        const data = new TextEncoder().encode(text)
        const hashBuffer = await crypto.subtle.digest('SHA-256', data)
        const hashArray = Array.from(new Uint8Array(hashBuffer))
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
    }

    // djb2 fallback — fast, non-cryptographic, used only in test environments
    let hash = 5381
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) + hash + text.charCodeAt(i)) & 0xffffffff
    }
    return `djb2_${(hash >>> 0).toString(16)}`
}

async function canonicaliseSingleScope(scope) {
    const nodeIndexMap = buildNodeIndexMap(scope.allNodes)
    const { uf } = extractNets(scope, nodeIndexMap)

    const components = extractComponents(scope, uf, nodeIndexMap)

    sortComponents(components)
    assignComponentIds(components)

    const { netIdMap, netConnections } = assignNetIds(components)
    const { nets, renameMap } = buildNetsArray(netIdMap, netConnections, scope.allNodes, components, uf)

    for (let i = 0; i < components.length; i++) {
        const conn = components[i]._connections
        for (const port of Object.keys(conn)) conn[port] = renameMap[conn[port]]
    }

    const validNetIds = new Set(nets.map(n => n.id))

    const interfacePorts = buildInterfacePorts(components)
    const componentLayout = extractLayout(scope, components, nodeIndexMap, uf, netIdMap, renameMap)
    const visual = extractVisual(scope)

    const canonicalComponents = buildCanonicalComponents(components, validNetIds)

    const netlist = { components: canonicalComponents, nets }
    const netlistForHash = {
        components: netlist.components.map(({ defaultState, ...rest }) => rest),
        nets: netlist.nets,
    }
    const canonicalHash = await sha256(JSON.stringify({ netlist: netlistForHash, interfacePorts }))

    const verilogMeta = scope.verilogMetadata || {}
    const verilogMetadata = {
        isVerilogCircuit: verilogMeta.isVerilogCircuit ?? false,
        isMainCircuit: verilogMeta.isMainCircuit ?? false,
        code: verilogMeta.code ?? '// Write Some Verilog Code Here!',
        subCircuitScopeIds: verilogMeta.subCircuitScopeIds ?? [],
    }

    const projectMetadata = {
        id: scope.id,
        name: scope.name || 'Untitled',
        timeStamp: scope.timeStamp || null,
        restrictedElementsUsed: scope.restrictedCircuitElementsUsed || [],
    }

    console.log(`[canonical] canonicalHash: ${canonicalHash}`)

    return {
        canonicalHash,
        projectMetadata,
        netlist,
        interfacePorts,
        layout: componentLayout,
        visual,
        verilogMetadata,
    }
}

export async function canonicaliseScope(scopeOrScopes) {
    const scopes = Array.isArray(scopeOrScopes) ? scopeOrScopes : [scopeOrScopes]

    const circuits = {}
    const circuitHashes = []

    for (let i = 0; i < scopes.length; i++) {
        const scope = scopes[i]
        if (!scope || !scope.allNodes) {
            console.warn(`[canonical] Invalid scope at index ${i}`)
            continue
        }
        const circuit = await canonicaliseSingleScope(scope)
        const circuitId = scope.id || `circuit_${i}`
        circuits[circuitId] = circuit
        circuitHashes.push(circuit.canonicalHash)
    }

    const projectHash = await sha256(JSON.stringify([...circuitHashes].sort()))

    const result = {
        formatVersion: 'v1',
        canonicalHash: projectHash,
        circuits,
    }

    return result
}


// For testing in the browser console directly
if (typeof window !== 'undefined') {
    window.canonicaliseScope = canonicaliseScope
}
