import { describe, test, expect, beforeAll, vi } from 'vitest';
import { setup } from '../src/setup';
import load from '../src/data/load';
import { runAll } from '../src/testbench';
import { canonicaliseProject } from '../src/data/canonical';
import { importCanonical } from '../src/data/importCanonical';
import { scopeList } from '../src/circuit';
import { errorDetectedSet } from '../src/engine';

import gatesCircuitData from './circuits/gates-circuitdata.json';
import gatesTestData from './testData/gates-testdata.json';

import rippleCircuitData from './circuits/rippleCarryAdder-circuitdata.json';
import rippleTestData from './testData/ripple-carry-adder.json';

import aluCircuitData from './circuits/alu-circuitdata.json';
import aluTestData from './testData/alu-testdata.json';

import subCircuitCircuitData from './circuits/subCircuit-circuitdata.json';
import subCircuitTestData from './testData/subCircuit-testdata.json';

import decodersPlexersCircuitData from './circuits/Decoders-plexers-circuitdata.json';
import decodersPlexersTestData from './testData/decoders-plexers.json';

import sequentialCircuitData from './circuits/sequential-circuitdata.json';
import sequentialTestData from './testData/sequential-testdata.json';

import miscCircuitData from './circuits/misc-circuitdata.json';
import miscTestData from './testData/misc-testdata.json';

import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { createRouter, createWebHistory } from 'vue-router';
import i18n from '#/locales/i18n';
import { routes } from '#/router';
import vuetify from '#/plugins/vuetify';
import simulator from '#/pages/simulator.vue';

vi.mock('codemirror', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        fromTextArea: vi.fn(() => ({ setValue: () => { } })),
    };
});

vi.mock('codemirror-editor-vue3', () => ({
    defineSimpleMode: vi.fn(),
}));

describe('Canonical Import/Export Round-Trip and Functional Verification', () => {
    let pinia;
    let router;

    beforeAll(async () => {
        pinia = createPinia();
        setActivePinia(pinia);

        router = createRouter({
            history: createWebHistory(),
            routes,
        });

        const elem = document.createElement('div');

        if (document.body) {
            document.body.appendChild(elem);
        }

        global.document.createRange = vi.fn(() => ({
            setEnd: vi.fn(),
            setStart: vi.fn(),
            getBoundingClientRect: vi.fn(() => ({
                x: 0,
                y: 0,
                width: 0,
                height: 0,
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
            })),
            getClientRects: vi.fn(() => ({
                item: vi.fn(() => null),
                length: 0,
                [Symbol.iterator]: vi.fn(() => []),
            })),
        }));

        global.globalScope = global.globalScope || {};

        mount(simulator, {
            global: {
                plugins: [pinia, router, i18n, vuetify],
            },
            attachTo: elem,
        });

        setup();
    });

    function diffObjects(obj1: any, obj2: any, path = "") {
        if (typeof obj1 !== typeof obj2) {
            console.warn(`[DIFF] Type mismatch at ${path}: ${typeof obj1} vs ${typeof obj2}`);
            return;
        }
        if (obj1 && typeof obj1 === 'object') {
            const keys1 = Object.keys(obj1).sort();
            const keys2 = Object.keys(obj2).sort();
            for (const k of keys1) {
                if (!(k in obj2)) {
                    console.warn(`[DIFF] Key ${k} missing in imported at ${path}`);
                } else {
                    diffObjects(obj1[k], obj2[k], path ? `${path}.${k}` : k);
                }
            }
            for (const k of keys2) {
                if (!(k in obj1)) {
                    console.warn(`[DIFF] Extra key ${k} in imported at ${path}`);
                }
            }
        } else {
            if (obj1 !== obj2) {
                console.warn(`[DIFF] Value mismatch at ${path}: ${JSON.stringify(obj1)} vs ${JSON.stringify(obj2)}`);
            }
        }
    }

    async function runRoundTripTest(circuitData: any, testBenches: Record<string, any>) {
        // 1. Load original project
        load(circuitData);
        errorDetectedSet(false);

        const findScope = (key: string) => {
            // Testbenches in CircuitVerse are designed to run on the main testing scope (usually "Main").
            // We should always run on "Main" if it exists, otherwise fall back to globalScope.
            const mainScope = Object.values(scopeList).find((s) => s.name === "Main");
            if (mainScope) return mainScope;
            return globalScope;
        };

        // 2. Execute baseline simulation testbenches
        const baselineResults: Record<string, any> = {};
        for (const [key, testBench] of Object.entries(testBenches)) {
            // runAll takes TestData, which is under the .testData property in some JSONs or direct
            const data = (testBench as any).testData || testBench;
            const scope = findScope(key);
            const res = runAll(data, scope);
            if (res.summary.passed !== res.summary.total) {
                console.warn(`[BASELINE FAIL] for ${key}: expected ${res.summary.total}, got ${res.summary.passed} on scope ${scope.name}`);
                data.groups.forEach((group: any) => {
                    group.outputs.forEach((output: any) => {
                        console.warn(`[BASELINE FAIL] Output "${output.label}": Expected [${output.values.join(",")}], Got [${output.results?.join(",")}]`);
                    });
                });
            }
            baselineResults[key] = res;
        }

        // 3. Export to canonical JSON representation
        const scopes = Object.values(scopeList);
        const canonicalProj = await canonicaliseProject(scopes as any);

        // 4. Import the canonical representation into target scope
        const importResult = await importCanonical(canonicalProj, globalScope);
        expect(importResult.success).toBe(true);
        expect(importResult.errors).toEqual([]);

        // Log the imported structure details
        console.warn(`=== IMPORTED STRUCTURE for ${globalScope.name} ===`);
        if (globalScope.name === "Main" && circuitData.scopes.some((s: any) => s.name === "4 bit Full adder")) {
            console.warn("EXPECTED NETS FOR RIPPLE CARRY ADDER MAIN:");
            console.warn(JSON.stringify(canonicalProj.circuits["93663071628"]?.netlist?.nets, null, 2));
        }
        for (const scope of Object.values(scopeList) as any[]) {
            console.warn(`  Scope: "${scope.name}" (ID: ${scope.id})`);
            scope.Input.forEach((inp: any) => {
                console.warn(`    Input "${inp.label}": bitWidth = ${inp.bitWidth} (type: ${typeof inp.bitWidth})`);
            });
            scope.Output.forEach((out: any) => {
                console.warn(`    Output "${out.label}": bitWidth = ${out.bitWidth} (type: ${typeof out.bitWidth})`);
            });
            scope.SubCircuit.forEach((sub: any) => {
                console.warn(`    SubCircuit referencing "${sub.id}":`);
                sub.inputNodes.forEach((node: any, idx: number) => {
                    console.warn(`      inputNode[${idx}] (layout_id: ${node.layout_id}): bitWidth = ${node.bitWidth} (type: ${typeof node.bitWidth})`);
                });
                sub.outputNodes.forEach((node: any, idx: number) => {
                    console.warn(`      outputNode[${idx}] (layout_id: ${node.layout_id}): bitWidth = ${node.bitWidth} (type: ${typeof node.bitWidth})`);
                });
            });
        }

        // 5. Execute imported simulation and assert functional behavior matches exactly
        for (const [key, testBench] of Object.entries(testBenches)) {
            const data = (testBench as any).testData || testBench;
            const importedResult = runAll(data, findScope(key));
            
            if (importedResult.summary.passed !== baselineResults[key].summary.passed) {
                console.warn(`[SIM FAIL] simulation result mismatch for ${key}: expected ${baselineResults[key].summary.passed}, got ${importedResult.summary.passed}`);
                data.groups.forEach((group: any) => {
                    group.outputs.forEach((output: any) => {
                        console.warn(`[SIM FAIL] Output "${output.label}": Expected [${output.values.join(",")}], Got [${output.results?.join(",")}]`);
                    });
                });
            }
            expect(importedResult.summary.passed).toBe(baselineResults[key].summary.passed);
            expect(importedResult.summary.total).toBe(baselineResults[key].summary.total);
            expect(importedResult.summary.passed).toBeGreaterThan(0);
        }

        // 6. Re-export and verify that the re-exported canonical project hash matches original
        const importedScopes = Object.values(scopeList);
        const reExportedProj = await canonicaliseProject(importedScopes as any);
        let hashMatch = true;
        if (reExportedProj.canonicalHash !== canonicalProj.canonicalHash) {
            console.warn(`[HASH FAIL] Hash mismatch! Expected: ${canonicalProj.canonicalHash}, Actual: ${reExportedProj.canonicalHash}`);
            diffObjects(canonicalProj, reExportedProj);
            
            // Detailed mismatched net connection logger
            for (const scopeId of Object.keys(canonicalProj.circuits)) {
                const expScope = canonicalProj.circuits[scopeId];
                const actScope = reExportedProj.circuits[scopeId];
                if (actScope && expScope.canonicalHash !== actScope.canonicalHash) {
                    console.warn(`Scope "${expScope.name}" (${scopeId}) net mismatch details:`);
                    expScope.netlist.nets.forEach((net1: any, idx: number) => {
                        const net2 = actScope.netlist.nets[idx];
                        if (net2 && net1.bitWidth !== net2.bitWidth) {
                            console.warn(`  Net ${idx}: Expected bitWidth ${net1.bitWidth}, Got ${net2.bitWidth}`);
                            console.warn(`    Expected nodes: ${JSON.stringify(net1.nodes)}`);
                            console.warn(`    Got nodes:      ${JSON.stringify(net2.nodes)}`);
                        }
                    });
                }
            }
            hashMatch = false;
        }

        expect(hashMatch).toBe(true);
    }

    test('Gates Project round-trip', async () => {
        await runRoundTripTest(gatesCircuitData, gatesTestData);
    });

    test('Ripple Carry Adder Project round-trip', async () => {
        await runRoundTripTest(rippleCircuitData, { ripple: rippleTestData });
    });

    test('ALU Project round-trip', async () => {
        await runRoundTripTest(aluCircuitData, { alu: aluTestData });
    });

    test('SubCircuit Project round-trip', async () => {
        await runRoundTripTest(subCircuitCircuitData, subCircuitTestData);
    });

    test('Decoders & Plexers Project round-trip', async () => {
        await runRoundTripTest(decodersPlexersCircuitData, decodersPlexersTestData);
    });

    test('Sequential Project round-trip', async () => {
        await runRoundTripTest(sequentialCircuitData, sequentialTestData);
    });

    test('Misc Project round-trip', async () => {
        await runRoundTripTest(miscCircuitData, miscTestData);
    });
});
