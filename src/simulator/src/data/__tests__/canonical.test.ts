/**
 * canonical.test.ts
 *
 * Comprehensive determinism tests for canonical.ts.
 *
 * HOW canonical.ts reads array ports:
 *   When customSave().nodes[portName] is an Array, canonical.ts reads the actual
 *   node array from comp[portName] directly (the component object itself), NOT from
 *   the customSave() return value. So for array-port components, we must attach the
 *   array as a direct property on the component object.
 *
 * Coverage:
 *  1.  Label independence
 *  2.  Direction independence (all DIRECTION_BEARING types)
 *  3.  Idempotency
 *  4.  Insertion-order independence
 *  5.  BitWidth sensitivity
 *  6.  Net topology sensitivity
 *  7.  Component count sensitivity
 *  8.  propagationDelay sensitivity
 *  9.  constructorParameters sensitivity
 * 10.  Structural state: ConstantVal value IS in hash
 * 11.  Transient state exclusion: Input/Dlatch/flip-flop state NOT in hash
 * 12.  Project-level hash semantics
 * 13.  circuitId keying
 * 14.  WL fingerprinting convergence
 * 15.  Net ID determinism
 * 16.  Component ID determinism
 * 17.  verilogMetadata passthrough
 * 18.  All 61 component types: valid SHA-256 hash + idempotency
 * 19.  Cross-type distinctness spot checks
 * 20.  naturalCompare stability (10-output Splitter)
 */

import { canonicaliseProject } from "../canonical";

const testScopeIds: Record<string, number> = {
  "my-scope-id": 12345,
  c1: 101,
  c2: 102,
  "net-test": 201,
  dangling: 202,
  cid: 301,
  mixed: 302,
  s: 401,
  v: 402,
  b: 403,
  empty: 501,
  a: 502,
  chain: 503,
  test: 504,
  combinational: 505,
  selection: 506,
  sequential: 507,
  memory: 508,
  display: 509,
};

function stringToNumber(str: string): number {
  if (str in testScopeIds) {
    return testScopeIds[str];
  }
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

// ─── Types ───────────────────────────────────────────────────────────────────

type WireNode = {
  label?: string;
  bitWidth: number;
  connections: WireNode[];
  deleted?: boolean;
  type: number;
  x: number;
  y: number;
  [key: string]: unknown;
};

// ─── Node factory ─────────────────────────────────────────────────────────────

/** type 0 = component input port, type 1 = component output, type 2 = wire junction */
function node(type: number, bitWidth = 1): WireNode {
  return { label: undefined, bitWidth, connections: [], type, x: 0, y: 0 };
}

function connect(a: WireNode, b: WireNode) {
  a.connections.push(b);
  b.connections.push(a);
}

// ─── Scope builder ────────────────────────────────────────────────────────────

/**
 * Build a minimal scope from a list of component descriptors.
 *
 * Each descriptor is a plain object with:
 *   _type        – objectType string
 *   _nodes       – { portName: WireNode | WireNode[] }
 *                  for ARRAY ports the same array must also live as comp[portName]
 *   _params      – constructorParamaters[]
 *   _values      – values map
 *   _stateField  – e.g. 'state', 'slaveState'
 *   _stateValue  – value of that field on the component object
 *   …any other fields copied verbatim
 */
function makeScope(id: string, comps: Array<Record<string, unknown>>): Record<string, unknown> {
  const allNodes: WireNode[] = [];
  const byType: Record<string, unknown[]> = {};

  for (const c of comps) {
    const type = c._type as string;
    const portNodes = (c._nodes ?? {}) as Record<string, WireNode | WireNode[]>;
    const stateField = c._stateField as string | undefined;
    const stateValue = c._stateValue;

    // Collect all WireNodes referenced by this component into allNodes
    for (const val of Object.values(portNodes)) {
      if (Array.isArray(val)) {
        for (const n of val) {
          if (!allNodes.includes(n)) allNodes.push(n);
        }
      } else if (val && !allNodes.includes(val)) {
        allNodes.push(val);
      }
    }

    // Attach customSave — array ports return the array as a sentinel value
    (c as any).customSave = () => ({
      nodes: portNodes,
      constructorParamaters: (c._params as unknown[]) ?? [],
      values: (c._values as Record<string, unknown>) ?? {},
    });
    (c as any).objectType = type;

    // For every port, the node or array MUST live directly on the component object
    // because canonical.ts reads comp[portName] (not the customSave return value)
    for (const [portName, val] of Object.entries(portNodes)) {
      (c as any)[portName] = val;
    }

    // State field
    if (stateField !== undefined) {
      (c as any)[stateField] = stateValue;
    }

    if (!byType[type]) byType[type] = [];
    byType[type].push(c);
  }

  return {
    id: stringToNumber(id),
    name: "Test",
    timeStamp: null,
    allNodes,
    ...byType,
  };
}

// ─── Component descriptor helpers ────────────────────────────────────────────

/** Two-port: one output node connected to one input node */
function twoPort(
  type: string,
  extra: Record<string, unknown> = {},
  params: unknown[] = ["RIGHT", 1],
  values: Record<string, unknown> = {},
): Record<string, unknown> {
  const out = node(1);
  const inp = node(0);
  connect(out, inp);
  return {
    _type: type,
    objectType: type,
    direction: "RIGHT",
    label: "",
    bitWidth: 1,
    propagationDelay: 0,
    labelDirection: undefined,
    x: 0,
    y: 0,
    _nodes: { output1: out, inp1: inp },
    _params: params,
    _values: values,
    ...extra,
  };
}

/** Source: only an output node */
function sourceComp(
  type: string,
  extra: Record<string, unknown> = {},
  params: unknown[] = ["RIGHT", 1],
  values: Record<string, unknown> = {},
): Record<string, unknown> {
  const out = node(1);
  return {
    _type: type,
    objectType: type,
    direction: "RIGHT",
    label: "",
    bitWidth: 1,
    propagationDelay: 0,
    labelDirection: undefined,
    x: 0,
    y: 0,
    _nodes: { output1: out },
    _params: params,
    _values: values,
    ...extra,
  };
}

/** Sink: only an input node */
function sinkComp(
  type: string,
  extra: Record<string, unknown> = {},
  params: unknown[] = ["RIGHT", 1],
  values: Record<string, unknown> = {},
): Record<string, unknown> {
  const inp = node(0);
  return {
    _type: type,
    objectType: type,
    direction: "RIGHT",
    label: "",
    bitWidth: 1,
    propagationDelay: 0,
    labelDirection: undefined,
    x: 0,
    y: 0,
    _nodes: { inp1: inp },
    _params: params,
    _values: values,
    ...extra,
  };
}

/**
 * Multi-input gate helper — uses an inp[] array (attached directly to comp).
 * The output is a scalar output1 node.
 */
function multiInputComp(
  type: string,
  inputCount: number,
  extra: Record<string, unknown> = {},
  params: unknown[] = ["RIGHT", inputCount, 1],
): Record<string, unknown> {
  const out = node(1);
  const inpNodes: WireNode[] = [];
  for (let i = 0; i < inputCount; i++) inpNodes.push(node(0));
  return {
    _type: type,
    objectType: type,
    direction: "RIGHT",
    label: "",
    bitWidth: 1,
    propagationDelay: 0,
    labelDirection: undefined,
    x: 0,
    y: 0,
    // scalar port + array port
    _nodes: { output1: out, inp: inpNodes },
    // direct property so canonical.ts can read comp['inp']
    inp: inpNodes,
    _params: params,
    _values: {},
    ...extra,
  };
}

/** Convenience: run canonicaliseProject and return the project hash */
async function hash(comps: Array<Record<string, unknown>>, id = "test"): Promise<string> {
  const s = makeScope(id, comps);
  return (await canonicaliseProject(s as any)).canonicalHash;
}

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 1 – Label independence
// ═════════════════════════════════════════════════════════════════════════════

describe("Label independence", () => {
  it('same hash for NotGate with labels "foo" vs "bar"', async () => {
    const a = [{ ...twoPort("NotGate"), label: "foo" }];
    const b = [{ ...twoPort("NotGate"), label: "bar" }];
    expect(await hash(a)).toBe(await hash(b));
  });

  it('same hash for Input with labels "CLK" vs "RST"', async () => {
    const mk = (lbl: string) => ({
      ...sourceComp("Input", { label: lbl }, ["RIGHT", 1], { state: 0 }),
      _stateField: "state",
      _stateValue: 0,
    });
    expect(await hash([mk("CLK")])).toBe(await hash([mk("RST")]));
  });

  it("same hash for Output with different labels", async () => {
    const a = [{ ...sinkComp("Output"), label: "Q" }];
    const b = [{ ...sinkComp("Output"), label: "Z" }];
    expect(await hash(a)).toBe(await hash(b));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 2 – Direction independence (all DIRECTION_BEARING types)
// ═════════════════════════════════════════════════════════════════════════════

describe("Direction independence", () => {
  const directionTypes = [
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
  ] as const;

  for (const type of directionTypes) {
    it(`${type}: LEFT vs RIGHT gives same hash`, async () => {
      const mk = (dir: string) => ({
        ...twoPort(type),
        direction: dir,
        _params: [dir, 1],
      });
      expect(await hash([mk("LEFT")])).toBe(await hash([mk("RIGHT")]));
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 3 – Idempotency
// ═════════════════════════════════════════════════════════════════════════════

describe("Idempotency", () => {
  it("NotGate produces the same hash on two calls", async () => {
    const comps = [twoPort("NotGate")];
    expect(await hash(comps)).toBe(await hash(comps));
  });

  it("empty circuit produces the same hash on two calls", async () => {
    const s = makeScope("empty", []);
    const h1 = (await canonicaliseProject(s as any)).canonicalHash;
    const h2 = (await canonicaliseProject(s as any)).canonicalHash;
    expect(h1).toBe(h2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 4 – Insertion-order independence
// ═════════════════════════════════════════════════════════════════════════════

describe("Insertion-order independence", () => {
  it("AndGate then NotGate == NotGate then AndGate", async () => {
    const ng = twoPort("NotGate");
    const ag = multiInputComp("AndGate", 2, {}, ["RIGHT", 2, 1]);
    expect(await hash([ng, ag])).toBe(await hash([ag, ng]));
  });

  it("three different gates in any permutation give same hash", async () => {
    const a = multiInputComp("AndGate", 2, {}, ["RIGHT", 2, 1]);
    const o = multiInputComp("OrGate", 2, {}, ["RIGHT", 2, 1]);
    const x = multiInputComp("XorGate", 2, {}, ["RIGHT", 2, 1]);
    const h1 = await hash([a, o, x]);
    const h2 = await hash([o, x, a]);
    const h3 = await hash([x, a, o]);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 5 – Structural sensitivity
// ═════════════════════════════════════════════════════════════════════════════

describe("BitWidth sensitivity", () => {
  it("bitWidth 1 vs 4 produces different hashes", async () => {
    const a = [{ ...twoPort("NotGate", {}, ["RIGHT", 1]), bitWidth: 1 }];
    const b = [{ ...twoPort("NotGate", {}, ["RIGHT", 4]), bitWidth: 4 }];
    expect(await hash(a)).not.toBe(await hash(b));
  });
});

describe("Net topology sensitivity", () => {
  it("two gates chained together vs two isolated gates produce different hashes", async () => {
    // Circuit A: NotGate_output → AndGate_input: one shared net with 2 endpoints
    const outA = node(1);
    const inpA = node(0);
    connect(outA, inpA);
    const inpA2 = node(0); // second input of AndGate, not connected
    const ngA: Record<string, unknown> = {
      _type: "NotGate",
      objectType: "NotGate",
      direction: "RIGHT",
      label: "",
      bitWidth: 1,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: { output1: outA },
      _params: ["RIGHT", 1],
      _values: {},
    };
    const agA: Record<string, unknown> = {
      _type: "AndGate",
      objectType: "AndGate",
      direction: "RIGHT",
      label: "",
      bitWidth: 1,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 20,
      y: 0,
      _nodes: { inp1: inpA, inp2: inpA2 },
      _params: ["RIGHT", 2, 1],
      _values: {},
    };

    // Circuit B: two isolated gates — no wire between them
    const outB = node(1);
    const inpB = node(0);
    const inpB2 = node(0);
    const ngB: Record<string, unknown> = {
      _type: "NotGate",
      objectType: "NotGate",
      direction: "RIGHT",
      label: "",
      bitWidth: 1,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: { output1: outB },
      _params: ["RIGHT", 1],
      _values: {},
    };
    const agB: Record<string, unknown> = {
      _type: "AndGate",
      objectType: "AndGate",
      direction: "RIGHT",
      label: "",
      bitWidth: 1,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 20,
      y: 0,
      _nodes: { inp1: inpB, inp2: inpB2 },
      _params: ["RIGHT", 2, 1],
      _values: {},
    };

    const hA = (await canonicaliseProject(makeScope("a", [ngA, agA]) as any)).canonicalHash;
    const hB = (await canonicaliseProject(makeScope("b", [ngB, agB]) as any)).canonicalHash;
    expect(hA).not.toBe(hB);
  });
});

describe("Component count sensitivity", () => {
  it("one NotGate vs two NotGates produce different hashes", async () => {
    expect(await hash([twoPort("NotGate")])).not.toBe(
      await hash([twoPort("NotGate"), twoPort("NotGate")]),
    );
  });
});

describe("propagationDelay sensitivity", () => {
  it("delay 0 vs delay 100 produces different hashes", async () => {
    const a = [{ ...twoPort("NotGate"), propagationDelay: 0 }];
    const b = [{ ...twoPort("NotGate"), propagationDelay: 100 }];
    expect(await hash(a)).not.toBe(await hash(b));
  });
});

describe("constructorParameters sensitivity", () => {
  it("2-input AndGate vs 4-input AndGate produces different hashes", async () => {
    const a = [multiInputComp("AndGate", 2, {}, ["RIGHT", 2, 1])];
    const b = [multiInputComp("AndGate", 4, {}, ["RIGHT", 4, 1])];
    expect(await hash(a)).not.toBe(await hash(b));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 6 – Structural state inclusion / exclusion
// ═════════════════════════════════════════════════════════════════════════════

describe("ConstantVal – state IS structural", () => {
  const mk = (val: string) => ({
    ...sourceComp("ConstantVal", {}, ["RIGHT", 4, val]),
    bitWidth: 4,
    _stateField: "state",
    _stateValue: val,
  });
  it("different constant values → different hashes", async () => {
    expect(await hash([mk("0101")])).not.toBe(await hash([mk("1010")]));
  });
  it("same constant value → same hash", async () => {
    expect(await hash([mk("0101")])).toBe(await hash([mk("0101")]));
  });
});

describe("Input state – EXCLUDED from hash", () => {
  const mk = (val: number) => ({
    ...sourceComp("Input", {}, ["RIGHT", 1], { state: val }),
    _stateField: "state",
    _stateValue: val,
  });
  it("state 0 vs state 1 → same hash", async () => {
    expect(await hash([mk(0)])).toBe(await hash([mk(1)]));
  });
});

describe("DflipFlop slaveState – EXCLUDED from hash", () => {
  const mk = (val: number) => ({
    ...twoPort("DflipFlop", {}, ["RIGHT", 1]),
    _stateField: "slaveState",
    _stateValue: val,
    _values: { slaveState: val },
  });
  it("slaveState 0 vs 1 → same hash", async () => {
    expect(await hash([mk(0)])).toBe(await hash([mk(1)]));
  });
});

describe("TflipFlop slaveState – EXCLUDED from hash", () => {
  const mk = (val: number) => ({
    ...twoPort("TflipFlop", {}, ["RIGHT", 1]),
    _stateField: "slaveState",
    _stateValue: val,
    _values: { slaveState: val },
  });
  it("slaveState 0 vs 1 → same hash", async () => {
    expect(await hash([mk(0)])).toBe(await hash([mk(1)]));
  });
});

describe("SRflipFlop state – EXCLUDED from hash", () => {
  const mk = (val: number) => ({
    ...twoPort("SRflipFlop", {}, ["RIGHT", 1]),
    _stateField: "state",
    _stateValue: val,
    _values: { state: val },
  });
  it("state 0 vs 1 → same hash", async () => {
    expect(await hash([mk(0)])).toBe(await hash([mk(1)]));
  });
});

describe("JKflipFlop state – EXCLUDED from hash", () => {
  const mk = (val: number) => ({
    ...twoPort("JKflipFlop", {}, ["RIGHT", 1]),
    _stateField: "state",
    _stateValue: val,
    _values: { state: val },
  });
  it("state 0 vs 1 → same hash", async () => {
    expect(await hash([mk(0)])).toBe(await hash([mk(1)]));
  });
});

describe("Dlatch state – EXCLUDED from hash", () => {
  const mk = (val: number) => ({
    ...twoPort("Dlatch", {}, ["RIGHT", 1]),
    _stateField: "state",
    _stateValue: val,
    _values: { state: val },
  });
  it("state 0 vs 1 → same hash", async () => {
    expect(await hash([mk(0)])).toBe(await hash([mk(1)]));
  });
});

describe("Counter value – EXCLUDED from hash", () => {
  const mk = (val: number) => ({
    ...twoPort("Counter", {}, ["RIGHT", 1]),
    _stateField: "value",
    _stateValue: val,
    _values: { value: val },
  });
  it("value 0 vs 7 → same hash", async () => {
    expect(await hash([mk(0)])).toBe(await hash([mk(7)]));
  });
});

describe("Stepper state – EXCLUDED from hash", () => {
  const mk = (val: number) => ({
    ...sourceComp("Stepper", {}, ["RIGHT", 1]),
    _stateField: "state",
    _stateValue: val,
    _values: { state: val },
  });
  it("state 0 vs 3 → same hash", async () => {
    expect(await hash([mk(0)])).toBe(await hash([mk(3)]));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 7 – Project-level hash
// ═════════════════════════════════════════════════════════════════════════════

describe("Project-level hash", () => {
  it("two-circuit project produces a valid 64-char hex hash", async () => {
    const s1 = makeScope("c1", [twoPort("NotGate")]);
    const s2 = makeScope("c2", [twoPort("NotGate")]);
    const r = await canonicaliseProject([s1, s2] as any);
    expect(r.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("project hash changes when any circuit changes", async () => {
    const ng = [twoPort("NotGate")];
    const ag = [multiInputComp("AndGate", 2, {}, ["RIGHT", 2, 1])];
    const r1 = await canonicaliseProject([makeScope("c1", ng), makeScope("c2", ng)] as any);
    const r2 = await canonicaliseProject([makeScope("c1", ag), makeScope("c2", ng)] as any);
    expect(r1.canonicalHash).not.toBe(r2.canonicalHash);
  });

  it("project hash is order-independent across circuits", async () => {
    const c1 = makeScope("c1", [twoPort("NotGate")]);
    const c2 = makeScope("c2", [multiInputComp("AndGate", 2, {}, ["RIGHT", 2, 1])]);
    const r1 = await canonicaliseProject([c1, c2] as any);
    const r2 = await canonicaliseProject([c2, c1] as any);
    expect(r1.canonicalHash).toBe(r2.canonicalHash);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 8 – circuitId keying
// ═════════════════════════════════════════════════════════════════════════════

describe("Circuit ID keying", () => {
  it("uses scope.id as the circuits map key", async () => {
    const s = makeScope("my-scope-id", [twoPort("NotGate")]);
    const r = await canonicaliseProject(s as any);
    expect(r.circuits[stringToNumber("my-scope-id")]).toBeDefined();
  });

  it("each circuit in a project has its own canonical hash", async () => {
    const c1 = makeScope("c1", [twoPort("NotGate")]);
    const c2 = makeScope("c2", [multiInputComp("AndGate", 2, {}, ["RIGHT", 2, 1])]);
    const r = await canonicaliseProject([c1, c2] as any);
    expect(r.circuits[stringToNumber("c1")].canonicalHash).not.toBe(
      r.circuits[stringToNumber("c2")].canonicalHash,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 9 – WL fingerprinting
// ═════════════════════════════════════════════════════════════════════════════

describe("WL fingerprinting", () => {
  it("chain of 25 gates produces no WL warnings", async () => {
    const warnMsgs: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => {
      warnMsgs.push(m);
      orig(m);
    };

    const allNodes: WireNode[] = [];
    const byType: Record<string, unknown[]> = { NotGate: [], AndGate: [] };
    let prevOut: WireNode | null = null;

    for (let i = 0; i < 25; i++) {
      const t = i % 6 === 0 ? "NotGate" : "AndGate";
      const out = node(1);
      const inp = node(0);
      if (prevOut) connect(prevOut, inp);
      allNodes.push(out, inp);
      const c: Record<string, unknown> = {
        objectType: t,
        direction: "RIGHT",
        label: "",
        bitWidth: 1,
        propagationDelay: 0,
        labelDirection: undefined,
        x: i * 20,
        y: 0,
        inp: [inp],
        output1: out,
      };
      c.customSave = () => ({
        nodes: { inp: (c as any).inp, output1: (c as any).output1 },
        constructorParamaters: ["RIGHT", 2, 1],
        values: {},
      });
      byType[t].push(c);
      prevOut = out;
    }

    const s = { id: stringToNumber("chain"), name: "Test", timeStamp: null, allNodes, ...byType };
    await canonicaliseProject(s as any);
    console.warn = orig;
    expect(warnMsgs.filter((m) => m.includes("WL")).length).toBe(0);
  });

  it("topologically distinct structures give distinct hashes", async () => {
    // Three-gate chain (different connectivity from one gate)
    const outA = node(1);
    const inpB = node(0);
    connect(outA, inpB);
    const outB = node(1);
    const inpC = node(0);
    connect(outB, inpC);
    const outC = node(1);
    const chain = [
      {
        _type: "NotGate",
        objectType: "NotGate",
        direction: "RIGHT",
        label: "",
        bitWidth: 1,
        propagationDelay: 0,
        labelDirection: undefined,
        x: 0,
        y: 0,
        _nodes: { output1: outA, inp1: inpB },
        _params: ["RIGHT", 1],
        _values: {},
      },
      {
        _type: "NotGate",
        objectType: "NotGate",
        direction: "RIGHT",
        label: "",
        bitWidth: 1,
        propagationDelay: 0,
        labelDirection: undefined,
        x: 20,
        y: 0,
        _nodes: { output1: outB, inp1: inpC },
        _params: ["RIGHT", 1],
        _values: {},
      },
      {
        _type: "NotGate",
        objectType: "NotGate",
        direction: "RIGHT",
        label: "",
        bitWidth: 1,
        propagationDelay: 0,
        labelDirection: undefined,
        x: 40,
        y: 0,
        _nodes: { output1: outC },
        _params: ["RIGHT", 1],
        _values: {},
      },
    ];
    const single = [twoPort("NotGate")];
    expect(await hash(chain)).not.toBe(await hash(single));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 10 – Net ID determinism
// ═════════════════════════════════════════════════════════════════════════════

describe("Net ID determinism", () => {
  it("net IDs follow net_0, net_1, … and are contiguous", async () => {
    const outN = node(1);
    const inpA = node(0);
    const inpB = node(0);
    connect(outN, inpA);
    connect(outN, inpB);
    const comp: Record<string, unknown> = {
      _type: "NotGate",
      objectType: "NotGate",
      direction: "RIGHT",
      label: "",
      bitWidth: 1,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: { output1: outN, inp1: inpA, inp2: inpB },
      _params: ["RIGHT", 1],
      _values: {},
    };
    const s = makeScope("net-test", [comp]);
    const r = await canonicaliseProject(s as any);
    const nets = r.circuits[stringToNumber("net-test")].netlist.nets;
    for (const net of nets) expect(net.id).toMatch(/^net_\d+$/);
    const indices = nets
      .map((n: any) => parseInt(n.id.slice(4), 10))
      .sort((a: number, b: number) => a - b);
    for (let i = 0; i < indices.length; i++) expect(indices[i]).toBe(i);
  });

  it("dangling ports (< 2 connections) produce no nets", async () => {
    const out = node(1);
    const comp: Record<string, unknown> = {
      _type: "NotGate",
      objectType: "NotGate",
      direction: "RIGHT",
      label: "",
      bitWidth: 1,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: { output1: out },
      _params: ["RIGHT", 1],
      _values: {},
    };
    const r = await canonicaliseProject(makeScope("dangling", [comp]) as any);
    expect(r.circuits[stringToNumber("dangling")].netlist.nets).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 11 – Component ID determinism
// ═════════════════════════════════════════════════════════════════════════════

describe("Component ID determinism", () => {
  it("three NotGates get IDs NotGate_0, NotGate_1, NotGate_2", async () => {
    const s = makeScope("cid", [twoPort("NotGate"), twoPort("NotGate"), twoPort("NotGate")]);
    const r = await canonicaliseProject(s as any);
    const comps = r.circuits[stringToNumber("cid")].netlist.components;
    const ids = comps
      .filter((c: any) => c.type === "NotGate")
      .map((c: any) => c.id)
      .sort();
    expect(ids).toEqual(["NotGate_0", "NotGate_1", "NotGate_2"]);
  });

  it("different types get independent ID counters", async () => {
    const s = makeScope("mixed", [
      twoPort("NotGate"),
      multiInputComp("AndGate", 2, {}, ["RIGHT", 2, 1]),
      twoPort("NotGate"),
    ]);
    const r = await canonicaliseProject(s as any);
    const ids = r.circuits[stringToNumber("mixed")].netlist.components.map((c: any) => c.id);
    expect(ids).toContain("NotGate_0");
    expect(ids).toContain("NotGate_1");
    expect(ids).toContain("AndGate_0");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 12 – verilogMetadata passthrough
// ═════════════════════════════════════════════════════════════════════════════

describe("verilogMetadata passthrough", () => {
  it("non-verilog scope gets default verilogMetadata", async () => {
    const r = await canonicaliseProject(makeScope("s", [twoPort("NotGate")]) as any);
    const vm = r.circuits[stringToNumber("s")].verilogMetadata;
    expect(vm.isVerilogCircuit).toBe(false);
    expect(vm.isMainCircuit).toBe(false);
  });

  it("verilog scope metadata is preserved", async () => {
    const s = {
      ...makeScope("v", [twoPort("NotGate")]),
      verilogMetadata: {
        isVerilogCircuit: true,
        isMainCircuit: true,
        code: "module top(); endmodule",
        subCircuitScopeIds: ["sc1"],
      },
    };
    const r = await canonicaliseProject(s as any);
    const vm = r.circuits[stringToNumber("v")].verilogMetadata;
    expect(vm.isVerilogCircuit).toBe(true);
    expect(vm.code).toBe("module top(); endmodule");
    expect(vm.subCircuitScopeIds).toEqual(["sc1"]);
  });

  it("verilog flag does NOT change the canonical netlist hash", async () => {
    const base = makeScope("b", [twoPort("NotGate")]);
    const verilog = {
      ...makeScope("v", [twoPort("NotGate")]),
      verilogMetadata: {
        isVerilogCircuit: true,
        isMainCircuit: true,
        code: "module x();endmodule",
        subCircuitScopeIds: [],
      },
    };
    const hBase = (await canonicaliseProject(base as any)).circuits[stringToNumber("b")]
      .canonicalHash;
    const hVeri = (await canonicaliseProject(verilog as any)).circuits[stringToNumber("v")]
      .canonicalHash;
    expect(hBase).toBe(hVeri);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 13 – All 61 component types: valid hash + idempotency
// ═════════════════════════════════════════════════════════════════════════════

describe("All 61 component types – valid hash & idempotency", () => {
  // ── Convenience aliases ──────────────────────────────────────────────────

  const src = (
    type: string,
    params: unknown[] = ["RIGHT", 1],
    vals: Record<string, unknown> = {},
  ) => sourceComp(type, {}, params, vals);
  const snk = (
    type: string,
    params: unknown[] = ["RIGHT", 1],
    vals: Record<string, unknown> = {},
  ) => sinkComp(type, {}, params, vals);
  const tp = (type: string, params: unknown[] = ["RIGHT", 1], vals: Record<string, unknown> = {}) =>
    twoPort(type, {}, params, vals);
  const mi = (type: string, n: number, params?: unknown[]) =>
    multiInputComp(type, n, {}, params ?? ["RIGHT", n, 1]);

  // ── Component catalogue (one descriptor per type) ────────────────────────

  const catalogue: Array<{ name: string; comp: Record<string, unknown> }> = [
    // ── Inputs ───────────────────────────────────────────────────────────
    {
      name: "Input",
      comp: { ...src("Input", ["RIGHT", 1], { state: 0 }), _stateField: "state", _stateValue: 0 },
    },
    { name: "Button", comp: src("Button", ["RIGHT", 1]) },
    { name: "Power", comp: src("Power", ["RIGHT", 1]) },
    { name: "Ground", comp: src("Ground", ["RIGHT", 1]) },
    {
      name: "ConstantVal",
      comp: {
        ...src("ConstantVal", ["RIGHT", 4, "0000"]),
        bitWidth: 4,
        _stateField: "state",
        _stateValue: "0000",
      },
    },
    {
      name: "Stepper",
      comp: { ...src("Stepper", ["RIGHT", 1]), _stateField: "state", _stateValue: 0 },
    },
    { name: "Random", comp: src("Random", ["RIGHT", 1, 2]) },
    {
      name: "Counter",
      comp: {
        ...tp("Counter", ["RIGHT", 1]),
        _stateField: "value",
        _stateValue: 0,
        _values: { value: 0 },
      },
    },

    // ── Outputs ──────────────────────────────────────────────────────────
    { name: "Output", comp: snk("Output", ["RIGHT", 1]) },
    { name: "DigitalLed", comp: snk("DigitalLed", ["RIGHT", 1]) },
    { name: "VariableLed", comp: snk("VariableLed", ["RIGHT", 1]) },
    { name: "HexDisplay", comp: snk("HexDisplay", ["RIGHT", 1]) },
    { name: "SevenSegDisplay", comp: snk("SevenSegDisplay", []) },
    { name: "SixteenSegDisplay", comp: snk("SixteenSegDisplay", []) },
    { name: "TTY", comp: snk("TTY", []) },
    {
      name: "RGBLed",
      comp: (() => {
        const r = node(0);
        const g = node(0);
        const b = node(0);
        const inpArr = [r, g, b];
        return {
          _type: "RGBLed",
          objectType: "RGBLed",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp: inpArr },
          inp: inpArr, // direct property for canonical.ts
          _params: [],
          _values: {},
        };
      })(),
    },
    {
      name: "SquareRGBLed",
      comp: (() => {
        const inp = node(0);
        const r = node(0);
        const g = node(0);
        const b = node(0);
        return {
          _type: "SquareRGBLed",
          objectType: "SquareRGBLed",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: inp, inp2: r, inp3: g, inp4: b },
          _params: ["RIGHT", 1],
          _values: {},
        };
      })(),
    },
    {
      name: "RGBLedMatrix",
      comp: (() => {
        const inp = node(0);
        return {
          _type: "RGBLedMatrix",
          objectType: "RGBLedMatrix",
          direction: "RIGHT",
          label: "",
          bitWidth: 8,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: inp },
          _params: [8, 8],
          _values: {},
        };
      })(),
    },

    // ── Gates ─────────────────────────────────────────────────────────────
    { name: "NotGate", comp: tp("NotGate", ["RIGHT", 1]) },
    { name: "AndGate", comp: mi("AndGate", 2, ["RIGHT", 2, 1]) },
    { name: "OrGate", comp: mi("OrGate", 2, ["RIGHT", 2, 1]) },
    { name: "NandGate", comp: mi("NandGate", 2, ["RIGHT", 2, 1]) },
    { name: "NorGate", comp: mi("NorGate", 2, ["RIGHT", 2, 1]) },
    { name: "XorGate", comp: mi("XorGate", 2, ["RIGHT", 2, 1]) },
    { name: "XnorGate", comp: mi("XnorGate", 2, ["RIGHT", 2, 1]) },
    { name: "Buffer", comp: tp("Buffer", ["RIGHT", 1]) },
    { name: "ForceGate", comp: tp("ForceGate", ["RIGHT", 1]) },

    // ── Decoders & Plexers ────────────────────────────────────────────────
    {
      name: "Multiplexer",
      comp: (() => {
        const out = node(1);
        const s = node(0);
        const i0 = node(0);
        const i1 = node(0);
        const inpArr = [i0, i1];
        return {
          _type: "Multiplexer",
          objectType: "Multiplexer",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { output1: out, controlSignalInput: s, inp: inpArr },
          inp: inpArr,
          _params: ["RIGHT", 1, 1],
          _values: {},
        };
      })(),
    },
    {
      name: "Demultiplexer",
      comp: (() => {
        const inp = node(0);
        const s = node(0);
        const o0 = node(1);
        const o1 = node(1);
        const outArr = [o0, o1];
        return {
          _type: "Demultiplexer",
          objectType: "Demultiplexer",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: inp, controlSignalInput: s, output: outArr },
          output: outArr,
          _params: ["RIGHT", 1, 1],
          _values: {},
        };
      })(),
    },
    {
      name: "BitSelector",
      comp: (() => {
        const inp = node(0, 4);
        const sel = node(0);
        const out = node(1);
        return {
          _type: "BitSelector",
          objectType: "BitSelector",
          direction: "RIGHT",
          label: "",
          bitWidth: 4,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: inp, bitSelectorInp: sel, output1: out },
          _params: ["RIGHT", 4, 0],
          _values: {},
        };
      })(),
    },
    {
      name: "Splitter",
      comp: (() => {
        const inp = node(0, 4);
        const outsArr = [node(1), node(1), node(1), node(1)];
        return {
          _type: "Splitter",
          objectType: "Splitter",
          direction: "RIGHT",
          label: "",
          bitWidth: 4,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: inp, outputs: outsArr },
          outputs: outsArr,
          _params: ["RIGHT", 4, 4],
          _values: {},
        };
      })(),
    },
    { name: "MSB", comp: tp("MSB", ["RIGHT", 4]) },
    { name: "LSB", comp: tp("LSB", ["RIGHT", 4]) },
    {
      name: "PriorityEncoder",
      comp: mi("PriorityEncoder", 4, ["RIGHT", 4]),
    },
    {
      name: "Decoder",
      comp: (() => {
        const inp = node(0, 2);
        const outArr = [node(1), node(1), node(1), node(1)];
        return {
          _type: "Decoder",
          objectType: "Decoder",
          direction: "RIGHT",
          label: "",
          bitWidth: 2,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: inp, output: outArr },
          output: outArr,
          _params: ["RIGHT", 2],
          _values: {},
        };
      })(),
    },

    // ── Sequential ────────────────────────────────────────────────────────
    {
      name: "DflipFlop",
      comp: {
        ...tp("DflipFlop", ["RIGHT", 1]),
        _stateField: "slaveState",
        _stateValue: 0,
        _values: { slaveState: 0 },
      },
    },
    {
      name: "Dlatch",
      comp: {
        ...tp("Dlatch", ["RIGHT", 1]),
        _stateField: "state",
        _stateValue: 0,
        _values: { state: 0 },
      },
    },
    {
      name: "TflipFlop",
      comp: {
        ...tp("TflipFlop", ["RIGHT", 1]),
        _stateField: "slaveState",
        _stateValue: 0,
        _values: { slaveState: 0 },
      },
    },
    {
      name: "JKflipFlop",
      comp: {
        ...tp("JKflipFlop", ["RIGHT", 1]),
        _stateField: "state",
        _stateValue: 0,
        _values: { state: 0 },
      },
    },
    {
      name: "SRflipFlop",
      comp: {
        ...tp("SRflipFlop", ["RIGHT", 1]),
        _stateField: "state",
        _stateValue: 0,
        _values: { state: 0 },
      },
    },
    { name: "Clock", comp: src("Clock", ["RIGHT", 1]) },
    {
      name: "Keyboard",
      comp: (() => {
        const out = node(1);
        return {
          _type: "Keyboard",
          objectType: "Keyboard",
          direction: "RIGHT",
          label: "",
          bitWidth: 7,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { output1: out },
          _params: [],
          _values: {},
        };
      })(),
    },
    {
      name: "Rom",
      comp: (() => {
        const addr = node(0);
        const out = node(1);
        return {
          _type: "Rom",
          objectType: "Rom",
          direction: "RIGHT",
          label: "",
          bitWidth: 8,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { address: addr, output: out },
          _params: [8, 8],
          _values: {},
        };
      })(),
    },
    {
      name: "RAM",
      comp: (() => {
        const addr = node(0);
        const din = node(0);
        const we = node(0);
        const out = node(1);
        return {
          _type: "RAM",
          objectType: "RAM",
          direction: "RIGHT",
          label: "",
          bitWidth: 8,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { address: addr, dataInput: din, writeEnable: we, output: out },
          _params: ["RIGHT", 8, 8],
          _values: {},
        };
      })(),
    },
    {
      name: "verilogRAM",
      comp: (() => {
        const addr = node(0);
        const din = node(0);
        const we = node(0);
        const out = node(1);
        return {
          _type: "verilogRAM",
          objectType: "verilogRAM",
          direction: "RIGHT",
          label: "",
          bitWidth: 8,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { address: addr, dataInput: din, writeEnable: we, output: out },
          _params: ["RIGHT", 8, 8],
          _values: {},
        };
      })(),
    },
    {
      name: "EEPROM",
      comp: (() => {
        const addr = node(0);
        const din = node(0);
        const we = node(0);
        const out = node(1);
        return {
          _type: "EEPROM",
          objectType: "EEPROM",
          direction: "RIGHT",
          label: "",
          bitWidth: 8,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { address: addr, dataInput: din, writeEnable: we, output: out },
          _params: ["RIGHT", 8, 8],
          _values: {},
        };
      })(),
    },

    // ── Arithmetic ────────────────────────────────────────────────────────
    {
      name: "Adder",
      comp: (() => {
        const a = node(0);
        const b = node(0);
        const cin = node(0);
        const s = node(1);
        const cout = node(1);
        return {
          _type: "Adder",
          objectType: "Adder",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: a, inp2: b, carryIn: cin, sum: s, carryOut: cout },
          _params: ["RIGHT", 1],
          _values: {},
        };
      })(),
    },
    {
      name: "ALU",
      comp: (() => {
        const a = node(0);
        const b = node(0);
        const op = node(0, 3);
        const out = node(1);
        const cout = node(1);
        const zero = node(1);
        return {
          _type: "ALU",
          objectType: "ALU",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: {
            inp1: a,
            inp2: b,
            controlSignalInput: op,
            output: out,
            carryOut: cout,
            zeroSignal: zero,
          },
          _params: ["RIGHT", 1],
          _values: {},
        };
      })(),
    },
    { name: "TwoComplement", comp: tp("TwoComplement", ["RIGHT", 1]) },
    {
      name: "ControlledInverter",
      comp: (() => {
        const inp = node(0);
        const ctrl = node(0);
        const out = node(1);
        return {
          _type: "ControlledInverter",
          objectType: "ControlledInverter",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: inp, controlSignalInput: ctrl, output1: out },
          _params: ["RIGHT", 1],
          _values: {},
        };
      })(),
    },
    {
      name: "TriState",
      comp: (() => {
        const inp = node(0);
        const en = node(0);
        const out = node(1);
        return {
          _type: "TriState",
          objectType: "TriState",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: inp, state: en, output1: out },
          _params: ["RIGHT", 1],
          _values: {},
        };
      })(),
    },

    // ── Verilog arithmetic ─────────────────────────────────────────────────
    {
      name: "verilogMultiplier",
      comp: (() => {
        const a = node(0);
        const b = node(0);
        const out = node(1);
        return {
          _type: "verilogMultiplier",
          objectType: "verilogMultiplier",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: a, inp2: b, output1: out },
          _params: ["RIGHT", 1],
          _values: {},
        };
      })(),
    },
    {
      name: "verilogDivider",
      comp: (() => {
        const a = node(0);
        const b = node(0);
        const q = node(1);
        const r = node(1);
        return {
          _type: "verilogDivider",
          objectType: "verilogDivider",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: a, inp2: b, output1: q, output2: r },
          _params: ["RIGHT", 1],
          _values: {},
        };
      })(),
    },
    {
      name: "verilogPower",
      comp: (() => {
        const a = node(0);
        const b = node(0);
        const out = node(1);
        return {
          _type: "verilogPower",
          objectType: "verilogPower",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: a, inp2: b, output1: out },
          _params: ["RIGHT", 1],
          _values: {},
        };
      })(),
    },
    {
      name: "verilogShiftLeft",
      comp: (() => {
        const a = node(0);
        const b = node(0);
        const out = node(1);
        return {
          _type: "verilogShiftLeft",
          objectType: "verilogShiftLeft",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: a, inp2: b, output1: out },
          _params: ["RIGHT", 1],
          _values: {},
        };
      })(),
    },
    {
      name: "verilogShiftRight",
      comp: (() => {
        const a = node(0);
        const b = node(0);
        const out = node(1);
        return {
          _type: "verilogShiftRight",
          objectType: "verilogShiftRight",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: a, inp2: b, output1: out },
          _params: ["RIGHT", 1],
          _values: {},
        };
      })(),
    },

    // ── Misc ──────────────────────────────────────────────────────────────
    {
      name: "Flag",
      comp: (() => {
        const inp = node(0);
        const out = node(1);
        return {
          _type: "Flag",
          objectType: "Flag",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: inp, output1: out },
          _params: ["RIGHT", 1],
          _values: {},
        };
      })(),
    },
    {
      name: "Tunnel",
      comp: tp("Tunnel", ["RIGHT", 1], { tunnelName: "T1" }),
    },
    {
      name: "SubCircuit",
      // SubCircuit is in the list but customSave returns empty nodes → skipped
      // by buildComponentDrafts. We still verify a valid hash is produced.
      comp: (() => {
        const inp = node(0);
        return {
          _type: "SubCircuit",
          objectType: "SubCircuit",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: inp },
          _params: [],
          _values: {},
        };
      })(),
    },

    // ── Testbench ──────────────────────────────────────────────────────────
    { name: "TB_Input", comp: src("TB_Input", ["RIGHT", 1]) },
    { name: "TB_Output", comp: snk("TB_Output", ["RIGHT", 1]) },
  ];

  // ── Verify catalogue completeness ──────────────────────────────────────────

  it("catalogue covers all 61 circuitElementList entries", () => {
    const circuitElementList = [
      "Input",
      "Output",
      "NotGate",
      "OrGate",
      "AndGate",
      "NorGate",
      "NandGate",
      "XorGate",
      "XnorGate",
      "SevenSegDisplay",
      "SixteenSegDisplay",
      "HexDisplay",
      "Multiplexer",
      "BitSelector",
      "Splitter",
      "Power",
      "Ground",
      "ConstantVal",
      "ControlledInverter",
      "TriState",
      "Adder",
      "verilogMultiplier",
      "verilogDivider",
      "verilogPower",
      "verilogShiftLeft",
      "TwoComplement",
      "verilogShiftRight",
      "Rom",
      "RAM",
      "verilogRAM",
      "EEPROM",
      "TflipFlop",
      "JKflipFlop",
      "SRflipFlop",
      "DflipFlop",
      "TTY",
      "Keyboard",
      "Clock",
      "DigitalLed",
      "Stepper",
      "VariableLed",
      "RGBLed",
      "SquareRGBLed",
      "RGBLedMatrix",
      "Button",
      "Demultiplexer",
      "Buffer",
      "SubCircuit",
      "Flag",
      "MSB",
      "LSB",
      "PriorityEncoder",
      "Tunnel",
      "ALU",
      "Decoder",
      "Random",
      "Counter",
      "Dlatch",
      "TB_Input",
      "TB_Output",
      "ForceGate",
    ];
    expect(circuitElementList).toHaveLength(61);
    const names = catalogue.map((e) => e.name);
    for (const type of circuitElementList) {
      expect(names, `Missing type: ${type}`).toContain(type);
    }
  });

  // ── Per-type tests ───────────────────────────────────────────────────────

  for (const { name, comp } of catalogue) {
    describe(name, () => {
      it("produces a valid 64-char hex SHA-256 hash", async () => {
        const h = await hash([comp], `scope-${name}`);
        expect(h).toMatch(/^[0-9a-f]{64}$/);
      });

      it("is idempotent (same hash on two calls)", async () => {
        const h1 = await hash([comp], `scope-${name}`);
        const h2 = await hash([comp], `scope-${name}`);
        expect(h1).toBe(h2);
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 14 – Cross-type distinctness spot-checks
// ═════════════════════════════════════════════════════════════════════════════

describe("Cross-type hash distinctness", () => {
  const cases: Array<[string, () => Record<string, unknown>, () => Record<string, unknown>]> = [
    [
      "AndGate vs OrGate",
      () => multiInputComp("AndGate", 2, {}, ["RIGHT", 2, 1]),
      () => multiInputComp("OrGate", 2, {}, ["RIGHT", 2, 1]),
    ],
    [
      "NandGate vs NorGate",
      () => multiInputComp("NandGate", 2, {}, ["RIGHT", 2, 1]),
      () => multiInputComp("NorGate", 2, {}, ["RIGHT", 2, 1]),
    ],
    [
      "XorGate vs XnorGate",
      () => multiInputComp("XorGate", 2, {}, ["RIGHT", 2, 1]),
      () => multiInputComp("XnorGate", 2, {}, ["RIGHT", 2, 1]),
    ],
    [
      "Input vs Output",
      () => sourceComp("Input", {}, ["RIGHT", 1], { state: 0 }),
      () => sinkComp("Output", {}, ["RIGHT", 1]),
    ],
    [
      "DflipFlop vs TflipFlop",
      () => twoPort("DflipFlop", {}, ["RIGHT", 1]),
      () => twoPort("TflipFlop", {}, ["RIGHT", 1]),
    ],
    [
      "verilogShiftLeft vs verilogShiftRight",
      () => {
        const a = node(0);
        const b = node(0);
        const out = node(1);
        return {
          _type: "verilogShiftLeft",
          objectType: "verilogShiftLeft",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: a, inp2: b, output1: out },
          _params: ["RIGHT", 1],
          _values: {},
        };
      },
      () => {
        const a = node(0);
        const b = node(0);
        const out = node(1);
        return {
          _type: "verilogShiftRight",
          objectType: "verilogShiftRight",
          direction: "RIGHT",
          label: "",
          bitWidth: 1,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { inp1: a, inp2: b, output1: out },
          _params: ["RIGHT", 1],
          _values: {},
        };
      },
    ],
    [
      "Power vs Ground",
      () => sourceComp("Power", {}, ["RIGHT", 1]),
      () => sourceComp("Ground", {}, ["RIGHT", 1]),
    ],
    [
      "RAM vs EEPROM",
      () => {
        const addr = node(0);
        const din = node(0);
        const we = node(0);
        const out = node(1);
        return {
          _type: "RAM",
          objectType: "RAM",
          direction: "RIGHT",
          label: "",
          bitWidth: 8,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { address: addr, dataInput: din, writeEnable: we, output: out },
          _params: ["RIGHT", 8, 8],
          _values: {},
        };
      },
      () => {
        const addr = node(0);
        const din = node(0);
        const we = node(0);
        const out = node(1);
        return {
          _type: "EEPROM",
          objectType: "EEPROM",
          direction: "RIGHT",
          label: "",
          bitWidth: 8,
          propagationDelay: 0,
          labelDirection: undefined,
          x: 0,
          y: 0,
          _nodes: { address: addr, dataInput: din, writeEnable: we, output: out },
          _params: ["RIGHT", 8, 8],
          _values: {},
        };
      },
    ],
  ];

  for (const [label, mkA, mkB] of cases) {
    it(`${label} → different hashes`, async () => {
      expect(await hash([mkA()])).not.toBe(await hash([mkB()]));
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 15 – naturalCompare stability (10-output Splitter)
// ═════════════════════════════════════════════════════════════════════════════

describe("naturalCompare port ordering", () => {
  it("10-output Splitter produces a valid hash (inp_9 < inp_10 numeric order)", async () => {
    const inp = node(0, 10);
    const outsArr: WireNode[] = [];
    for (let i = 0; i < 10; i++) outsArr.push(node(1));
    const comp: Record<string, unknown> = {
      _type: "Splitter",
      objectType: "Splitter",
      direction: "RIGHT",
      label: "",
      bitWidth: 10,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: { inp1: inp, outputs: outsArr },
      outputs: outsArr,
      _params: ["RIGHT", 10, 10],
      _values: {},
    };
    const h = await hash([comp], "splitter-10");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same Splitter produces the same hash twice (stable sort)", async () => {
    const mk = () => {
      const inp = node(0, 4);
      const outsArr: WireNode[] = [node(1), node(1), node(1), node(1)];
      return {
        _type: "Splitter",
        objectType: "Splitter",
        direction: "RIGHT",
        label: "",
        bitWidth: 4,
        propagationDelay: 0,
        labelDirection: undefined,
        x: 0,
        y: 0,
        _nodes: { inp1: inp, outputs: outsArr },
        outputs: outsArr,
        _params: ["RIGHT", 4, 4],
        _values: {},
      };
    };
    expect(await hash([mk()], "sp1")).toBe(await hash([mk()], "sp1"));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 16 – MultiCircuits
// ══════════

describe("Large multi-circuit wired project", () => {
  function pickPort(comp: any, port: string, index = 0) {
    const value = comp._nodes[port];
    return Array.isArray(value) ? value[index] : value;
  }

  function wire(a: any, aPort: string, b: any, bPort: string, aIndex = 0, bIndex = 0) {
    connect(pickPort(a, aPort, aIndex), pickPort(b, bPort, bIndex));
  }

  function mkControlledInverter(bitWidth = 8, extra: Record<string, unknown> = {}) {
    const inp = node(0, bitWidth);
    const ctrl = node(0, 1);
    const out = node(1, bitWidth);
    return {
      _type: "ControlledInverter",
      objectType: "ControlledInverter",
      direction: "RIGHT",
      label: "",
      bitWidth,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: { inp1: inp, controlSignalInput: ctrl, output1: out },
      _params: ["RIGHT", bitWidth],
      _values: {},
      ...extra,
    };
  }

  function mkAdder(bitWidth = 8, extra: Record<string, unknown> = {}) {
    const a = node(0, bitWidth);
    const b = node(0, bitWidth);
    const cin = node(0, 1);
    const sum = node(1, bitWidth);
    const cout = node(1, 1);
    return {
      _type: "Adder",
      objectType: "Adder",
      direction: "RIGHT",
      label: "",
      bitWidth,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: { inp1: a, inp2: b, carryIn: cin, sum, carryOut: cout },
      _params: ["RIGHT", bitWidth],
      _values: {},
      ...extra,
    };
  }

  function mkALU(bitWidth = 8, extra: Record<string, unknown> = {}) {
    const a = node(0, bitWidth);
    const b = node(0, bitWidth);
    const op = node(0, 3);
    const out = node(1, bitWidth);
    const cout = node(1, 1);
    const zero = node(1, 1);
    return {
      _type: "ALU",
      objectType: "ALU",
      direction: "RIGHT",
      label: "",
      bitWidth,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: {
        inp1: a,
        inp2: b,
        controlSignalInput: op,
        output: out,
        carryOut: cout,
        zeroSignal: zero,
      },
      _params: ["RIGHT", bitWidth],
      _values: {},
      ...extra,
    };
  }

  function mkMultiplexer(inputCount = 4, bitWidth = 8, extra: Record<string, unknown> = {}) {
    const out = node(1, bitWidth);
    const ctrl = node(0, 1);
    const inp = Array.from({ length: inputCount }, () => node(0, bitWidth));
    return {
      _type: "Multiplexer",
      objectType: "Multiplexer",
      direction: "RIGHT",
      label: "",
      bitWidth,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: { output1: out, controlSignalInput: ctrl, inp },
      inp,
      _params: ["RIGHT", bitWidth, inputCount],
      _values: {},
      ...extra,
    };
  }

  function mkDemultiplexer(outputCount = 2, bitWidth = 8, extra: Record<string, unknown> = {}) {
    const inp = node(0, bitWidth);
    const ctrl = node(0, 1);
    const output = Array.from({ length: outputCount }, () => node(1, bitWidth));
    return {
      _type: "Demultiplexer",
      objectType: "Demultiplexer",
      direction: "RIGHT",
      label: "",
      bitWidth,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: { inp1: inp, controlSignalInput: ctrl, output },
      output,
      _params: ["RIGHT", bitWidth, outputCount],
      _values: {},
      ...extra,
    };
  }

  function mkDecoder(outputCount = 4, bitWidth = 4, extra: Record<string, unknown> = {}) {
    const inp = node(0, bitWidth);
    const output = Array.from({ length: outputCount }, () => node(1, 1));
    return {
      _type: "Decoder",
      objectType: "Decoder",
      direction: "RIGHT",
      label: "",
      bitWidth,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: { inp1: inp, output },
      output,
      _params: ["RIGHT", bitWidth],
      _values: {},
      ...extra,
    };
  }

  function mkSplitter(bitWidth = 8, outputCount = 8, extra: Record<string, unknown> = {}) {
    const inp = node(0, bitWidth);
    const outputs = Array.from({ length: outputCount }, () => node(1, 1));
    return {
      _type: "Splitter",
      objectType: "Splitter",
      direction: "RIGHT",
      label: "",
      bitWidth,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: { inp1: inp, outputs },
      outputs,
      _params: ["RIGHT", bitWidth, outputCount],
      _values: {},
      ...extra,
    };
  }

  function mkRGBLed(extra: Record<string, unknown> = {}) {
    const inp = [node(0, 1), node(0, 1), node(0, 1)];
    return {
      _type: "RGBLed",
      objectType: "RGBLed",
      direction: "RIGHT",
      label: "",
      bitWidth: 1,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: { inp },
      inp,
      _params: [],
      _values: {},
      ...extra,
    };
  }

  function mkSquareRGBLed(extra: Record<string, unknown> = {}) {
    const inp1 = node(0, 1);
    const inp2 = node(0, 1);
    const inp3 = node(0, 1);
    const inp4 = node(0, 1);
    return {
      _type: "SquareRGBLed",
      objectType: "SquareRGBLed",
      direction: "RIGHT",
      label: "",
      bitWidth: 1,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: { inp1, inp2, inp3, inp4 },
      _params: ["RIGHT", 1],
      _values: {},
      ...extra,
    };
  }

  function mkRGBLedMatrix(extra: Record<string, unknown> = {}) {
    const inp1 = node(0, 8);
    return {
      _type: "RGBLedMatrix",
      objectType: "RGBLedMatrix",
      direction: "RIGHT",
      label: "",
      bitWidth: 8,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: { inp1 },
      _params: [8, 8],
      _values: {},
      ...extra,
    };
  }

  function mkCounter(bitWidth = 8, value = 0, extra: Record<string, unknown> = {}) {
    const inp = node(0, 1);
    const out = node(1, bitWidth);
    return {
      _type: "Counter",
      objectType: "Counter",
      direction: "RIGHT",
      label: "",
      bitWidth,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: { inp1: inp, output1: out },
      _params: ["RIGHT", bitWidth],
      _values: { value },
      _stateField: "value",
      _stateValue: value,
      ...extra,
    };
  }

  function mkMemory(
    type: "RAM" | "EEPROM" | "verilogRAM",
    bitWidth = 8,
    extra: Record<string, unknown> = {},
  ) {
    const address = node(0, bitWidth);
    const dataInput = node(0, bitWidth);
    const writeEnable = node(0, 1);
    const output = node(1, bitWidth);
    return {
      _type: type,
      objectType: type,
      direction: "RIGHT",
      label: "",
      bitWidth,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 0,
      y: 0,
      _nodes: { address, dataInput, writeEnable, output },
      _params: ["RIGHT", bitWidth, bitWidth],
      _values: {},
      ...extra,
    };
  }

  function buildCombinationalScope() {
    const a = sourceComp("Input", { label: "A", x: 0, y: 0 }, ["RIGHT", 8], { state: 0 }) as any;
    const b = sourceComp("Input", { label: "B", x: 0, y: 20 }, ["RIGHT", 8], { state: 0 }) as any;
    const sel = sourceComp("Input", { label: "SEL", x: 0, y: 40 }, ["RIGHT", 1], {
      state: 0,
    }) as any;
    const cin = sourceComp("Input", { label: "CIN", x: 0, y: 60 }, ["RIGHT", 1], {
      state: 0,
    }) as any;
    const power = sourceComp("Power", { label: "PWR" }, ["RIGHT", 1]) as any;
    const ground = sourceComp("Ground", { label: "GND" }, ["RIGHT", 1]) as any;
    const constant = sourceComp("ConstantVal", { label: "MASK" }, ["RIGHT", 8, "00001111"], {
      state: "00001111",
    }) as any;
    constant._stateField = "state";
    constant._stateValue = "00001111";

    const split = mkSplitter(8, 8, { x: 120, y: 0 }) as any;
    const cinv = mkControlledInverter(8, { x: 180, y: 0 }) as any;
    const adder = mkAdder(8, { x: 240, y: 0 }) as any;
    const alu = mkALU(8, { x: 300, y: 0 }) as any;
    const mux = mkMultiplexer(4, 8, { x: 360, y: 0 }) as any;
    const msb = twoPort("MSB", { x: 420, y: 0 }, ["RIGHT", 8]) as any;
    const lsb = twoPort("LSB", { x: 420, y: 20 }, ["RIGHT", 8]) as any;
    const twos = twoPort("TwoComplement", { x: 180, y: 40 }, ["RIGHT", 8]) as any;
    const buffer = twoPort("Buffer", { x: 180, y: 60 }, ["RIGHT", 8]) as any;
    const force = twoPort("ForceGate", { x: 180, y: 80 }, ["RIGHT", 8]) as any;

    const out = sinkComp("Output", { label: "RESULT", x: 480, y: 0 }, ["RIGHT", 8]) as any;
    const carryLed = sinkComp("DigitalLed", { label: "CARRY", x: 480, y: 20 }, ["RIGHT", 1]) as any;
    const zeroLed = sinkComp("DigitalLed", { label: "ZERO", x: 480, y: 40 }, ["RIGHT", 1]) as any;
    const hex = sinkComp("HexDisplay", { label: "HEX", x: 480, y: 60 }, ["RIGHT", 8]) as any;

    wire(a, "output1", split, "inp1");
    wire(a, "output1", cinv, "inp1");
    wire(a, "output1", adder, "inp1");
    wire(b, "output1", adder, "inp2");
    wire(b, "output1", twos, "inp1");
    wire(b, "output1", buffer, "inp1");
    wire(sel, "output1", cinv, "controlSignalInput");
    wire(sel, "output1", mux, "controlSignalInput");
    wire(sel, "output1", alu, "controlSignalInput");
    wire(cin, "output1", adder, "carryIn");
    wire(power, "output1", adder, "carryIn");
    wire(ground, "output1", force, "inp1");
    wire(constant, "output1", mux, "inp", 2);
    wire(split, "outputs", msb, "inp1", 7);
    wire(split, "outputs", lsb, "inp1", 0);
    wire(split, "outputs", mux, "inp", 3, 1);
    wire(cinv, "output1", mux, "inp", 1);
    wire(twos, "output1", mux, "inp", 0);
    wire(buffer, "output1", alu, "inp1");
    wire(force, "output1", alu, "inp2");
    wire(adder, "sum", alu, "inp1");
    wire(mux, "output1", alu, "inp2");
    wire(alu, "output", out, "inp1");
    wire(alu, "carryOut", carryLed, "inp1");
    wire(alu, "zeroSignal", zeroLed, "inp1");
    wire(mux, "output1", hex, "inp1");

    return makeScope("combinational", [
      a,
      b,
      sel,
      cin,
      power,
      ground,
      constant,
      split,
      cinv,
      adder,
      alu,
      mux,
      msb,
      lsb,
      twos,
      buffer,
      force,
      out,
      carryLed,
      zeroLed,
      hex,
    ]);
  }

  function buildSelectionScope() {
    const data = sourceComp("Input", { label: "DATA", x: 0, y: 0 }, ["RIGHT", 4], {
      state: 0,
    }) as any;
    const sel = sourceComp("Input", { label: "SEL", x: 0, y: 20 }, ["RIGHT", 1], {
      state: 0,
    }) as any;

    const decoder = mkDecoder(4, 4, { x: 120, y: 0 }) as any;
    const encoder = multiInputComp("PriorityEncoder", 4, { x: 240, y: 0 }, ["RIGHT", 4]) as any;
    const demux = mkDemultiplexer(2, 4, { x: 120, y: 40 }) as any;
    const mux = mkMultiplexer(4, 4, { x: 240, y: 40 }) as any;
    const bitSel = {
      _type: "BitSelector",
      objectType: "BitSelector",
      direction: "RIGHT",
      label: "",
      bitWidth: 4,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 120,
      y: 80,
      _nodes: {
        inp1: node(0, 4),
        bitSelectorInp: node(0, 1),
        output1: node(1, 1),
      },
      _params: ["RIGHT", 4, 0],
      _values: {},
    } as any;
    const tunnel = twoPort("Tunnel", { x: 300, y: 80, tunnelName: "BUS_A" }, ["RIGHT", 4]) as any;
    const flag = twoPort("Flag", { x: 360, y: 80 }, ["RIGHT", 4]) as any;

    const out = sinkComp("Output", { label: "ENC", x: 360, y: 0 }, ["RIGHT", 1]) as any;
    const out2 = sinkComp("Output", { label: "MUX", x: 360, y: 40 }, ["RIGHT", 4]) as any;
    const led0 = sinkComp("DigitalLed", { x: 360, y: 120 }, ["RIGHT", 1]) as any;
    const led1 = sinkComp("DigitalLed", { x: 390, y: 120 }, ["RIGHT", 1]) as any;
    const led2 = sinkComp("DigitalLed", { x: 420, y: 120 }, ["RIGHT", 1]) as any;
    const led3 = sinkComp("DigitalLed", { x: 450, y: 120 }, ["RIGHT", 1]) as any;

    wire(data, "output1", decoder, "inp1");
    wire(data, "output1", demux, "inp1");
    wire(data, "output1", mux, "inp", 0);
    wire(data, "output1", bitSel, "inp1");
    wire(sel, "output1", demux, "controlSignalInput");
    wire(sel, "output1", mux, "controlSignalInput");
    wire(sel, "output1", bitSel, "bitSelectorInp");

    wire(decoder, "output", encoder, "inp", 0);
    wire(decoder, "output", encoder, "inp", 1);
    wire(decoder, "output", encoder, "inp", 2);
    wire(decoder, "output", encoder, "inp", 3);

    wire(decoder, "output", led0, "inp1", 0, 0);
    wire(decoder, "output", led1, "inp1", 1, 0);
    wire(decoder, "output", led2, "inp1", 2, 0);
    wire(decoder, "output", led3, "inp1", 3, 0);

    wire(demux, "output", mux, "inp", 0, 1);
    wire(demux, "output", mux, "inp", 1, 2);
    wire(demux, "output", led0, "inp1", 0, 0);
    wire(demux, "output", led1, "inp1", 1, 0);

    wire(bitSel, "output1", tunnel, "inp1");
    wire(tunnel, "output1", flag, "inp1");
    wire(flag, "output1", out, "inp1");

    wire(encoder, "output1", out, "inp1");
    wire(mux, "output1", out2, "inp1");

    return makeScope("selection", [
      data,
      sel,
      decoder,
      encoder,
      demux,
      mux,
      bitSel,
      tunnel,
      flag,
      out,
      out2,
      led0,
      led1,
      led2,
      led3,
    ]);
  }

  function buildSequentialScope() {
    const clk = sourceComp("Clock", { label: "CLK", x: 0, y: 0 }, ["RIGHT", 1]) as any;
    const btn = sourceComp("Button", { label: "BTN", x: 0, y: 20 }, ["RIGHT", 1]) as any;
    const stepper = sourceComp("Stepper", { label: "STEP", x: 0, y: 40 }, ["RIGHT", 1], {
      state: 2,
    }) as any;
    stepper._stateField = "state";
    stepper._stateValue = 2;

    const dff = {
      ...twoPort("DflipFlop", { x: 120, y: 0 }, ["RIGHT", 1]),
      _stateField: "slaveState",
      _stateValue: 0,
      _values: { slaveState: 0 },
    } as any;
    const tff = {
      ...twoPort("TflipFlop", { x: 180, y: 0 }, ["RIGHT", 1]),
      _stateField: "slaveState",
      _stateValue: 1,
      _values: { slaveState: 1 },
    } as any;
    const dlatch = {
      ...twoPort("Dlatch", { x: 240, y: 0 }, ["RIGHT", 1]),
      _stateField: "state",
      _stateValue: 0,
      _values: { state: 0 },
    } as any;
    const jk = {
      ...twoPort("JKflipFlop", { x: 300, y: 0 }, ["RIGHT", 1]),
      _stateField: "state",
      _stateValue: 1,
      _values: { state: 1 },
    } as any;
    const sr = {
      ...twoPort("SRflipFlop", { x: 360, y: 0 }, ["RIGHT", 1]),
      _stateField: "state",
      _stateValue: 0,
      _values: { state: 0 },
    } as any;
    const counter = mkCounter(8, 7, { x: 180, y: 40 }) as any;

    const out = sinkComp("Output", { label: "SEQ", x: 420, y: 0 }, ["RIGHT", 1]) as any;
    const led = sinkComp("DigitalLed", { label: "STEP_OUT", x: 420, y: 20 }, ["RIGHT", 1]) as any;
    const hex = sinkComp("HexDisplay", { label: "COUNT", x: 420, y: 40 }, ["RIGHT", 8]) as any;

    wire(clk, "output1", dff, "inp1");
    wire(dff, "output1", tff, "inp1");
    wire(tff, "output1", dlatch, "inp1");
    wire(dlatch, "output1", jk, "inp1");
    wire(jk, "output1", sr, "inp1");
    wire(sr, "output1", out, "inp1");

    wire(btn, "output1", dff, "inp1");
    wire(stepper, "output1", led, "inp1");

    wire(clk, "output1", counter, "inp1");
    wire(counter, "output1", hex, "inp1");

    return makeScope("sequential", [
      clk,
      btn,
      stepper,
      dff,
      tff,
      dlatch,
      jk,
      sr,
      counter,
      out,
      led,
      hex,
    ]);
  }

  function buildMemoryScope() {
    const clk = sourceComp("Clock", { label: "CLK", x: 0, y: 0 }, ["RIGHT", 1]) as any;
    const data = sourceComp("Input", { label: "DATA", x: 0, y: 20 }, ["RIGHT", 8], {
      state: 0,
    }) as any;
    const we = sourceComp("Input", { label: "WE", x: 0, y: 40 }, ["RIGHT", 1], { state: 1 }) as any;

    const counter = mkCounter(8, 13, { x: 120, y: 0 }) as any;
    const decoder = mkDecoder(4, 8, { x: 240, y: 0 }) as any;

    const ram = mkMemory("RAM", 8, { x: 120, y: 40 }) as any;
    const eeprom = mkMemory("EEPROM", 8, { x: 120, y: 80 }) as any;
    const vram = mkMemory("verilogRAM", 8, { x: 120, y: 120 }) as any;

    const led0 = sinkComp("DigitalLed", { x: 300, y: 0 }, ["RIGHT", 1]) as any;
    const led1 = sinkComp("DigitalLed", { x: 330, y: 0 }, ["RIGHT", 1]) as any;
    const led2 = sinkComp("DigitalLed", { x: 360, y: 0 }, ["RIGHT", 1]) as any;
    const led3 = sinkComp("DigitalLed", { x: 390, y: 0 }, ["RIGHT", 1]) as any;

    const hex = sinkComp("HexDisplay", { label: "RAM", x: 300, y: 40 }, ["RIGHT", 8]) as any;
    const tty = sinkComp("TTY", { label: "EEPROM", x: 300, y: 60 }, []) as any;
    const vLed = sinkComp("VariableLed", { label: "VRAM", x: 300, y: 80 }, ["RIGHT", 1]) as any;

    wire(clk, "output1", counter, "inp1");
    wire(counter, "output1", decoder, "inp1");
    wire(counter, "output1", ram, "address");
    wire(counter, "output1", eeprom, "address");
    wire(counter, "output1", vram, "address");

    wire(data, "output1", ram, "dataInput");
    wire(data, "output1", eeprom, "dataInput");
    wire(data, "output1", vram, "dataInput");

    wire(we, "output1", ram, "writeEnable");
    wire(we, "output1", eeprom, "writeEnable");
    wire(we, "output1", vram, "writeEnable");

    wire(decoder, "output", led0, "inp1", 0, 0);
    wire(decoder, "output", led1, "inp1", 1, 0);
    wire(decoder, "output", led2, "inp1", 2, 0);
    wire(decoder, "output", led3, "inp1", 3, 0);

    wire(ram, "output", hex, "inp1");
    wire(eeprom, "output", tty, "inp1");
    wire(vram, "output", vLed, "inp1");

    return makeScope("memory", [
      clk,
      data,
      we,
      counter,
      decoder,
      ram,
      eeprom,
      vram,
      led0,
      led1,
      led2,
      led3,
      hex,
      tty,
      vLed,
    ]);
  }

  function buildDisplayScope() {
    const bus = sourceComp("Input", { label: "BUS", x: 0, y: 0 }, ["RIGHT", 8], {
      state: 0,
    }) as any;
    const split = mkSplitter(8, 8, { x: 120, y: 0 }) as any;

    const rgb = mkRGBLed({ x: 240, y: 0 }) as any;
    const square = mkSquareRGBLed({ x: 240, y: 40 }) as any;
    const matrix = mkRGBLedMatrix({ x: 240, y: 80 }) as any;
    const seven = sinkComp("SevenSegDisplay", { x: 240, y: 120 }, []) as any;
    const sixteen = sinkComp("SixteenSegDisplay", { x: 240, y: 160 }, []) as any;
    const hex = sinkComp("HexDisplay", { x: 240, y: 200 }, ["RIGHT", 8]) as any;
    const tty = sinkComp("TTY", { x: 240, y: 240 }, []) as any;
    const led = sinkComp("DigitalLed", { x: 240, y: 280 }, ["RIGHT", 1]) as any;

    const tunnel = twoPort("Tunnel", { x: 360, y: 80, tunnelName: "DISPLAY_BUS" }, [
      "RIGHT",
      8,
    ]) as any;
    const flag = twoPort("Flag", { x: 420, y: 80 }, ["RIGHT", 8]) as any;

    wire(bus, "output1", split, "inp1");
    wire(split, "outputs", rgb, "inp", 0, 0);
    wire(split, "outputs", rgb, "inp", 1, 1);
    wire(split, "outputs", rgb, "inp", 2, 2);

    wire(split, "outputs", square, "inp1", 3, 0);
    wire(split, "outputs", square, "inp2", 4, 0);
    wire(split, "outputs", square, "inp3", 5, 0);
    wire(split, "outputs", square, "inp4", 6, 0);

    wire(split, "outputs", matrix, "inp1", 7, 0);
    wire(split, "outputs", seven, "inp1", 0, 0);
    wire(split, "outputs", sixteen, "inp1", 1, 0);
    wire(split, "outputs", hex, "inp1", 2, 0);
    wire(split, "outputs", tty, "inp1", 3, 0);
    wire(split, "outputs", led, "inp1", 4, 0);

    wire(split, "outputs", tunnel, "inp1", 5, 0);
    wire(tunnel, "output1", flag, "inp1");
    wire(flag, "output1", led, "inp1");

    return makeScope("display", [
      bus,
      split,
      rgb,
      square,
      matrix,
      seven,
      sixteen,
      hex,
      tty,
      led,
      tunnel,
      flag,
    ]);
  }

  function buildProject() {
    return [
      buildCombinationalScope(),
      buildSelectionScope(),
      buildSequentialScope(),
      buildMemoryScope(),
      buildDisplayScope(),
    ];
  }

  function buildProjectWithOneChangedWire() {
    const project = buildProject();

    const selection = project.find((s: any) => s.id === "selection") as any;
    const circuit = selection as any;

    // Rebuild only the selection scope with one altered connection:
    // route demux output[1] into a different mux input to change topology.
    const data = sourceComp("Input", { label: "DATA", x: 0, y: 0 }, ["RIGHT", 4], {
      state: 0,
    }) as any;
    const sel = sourceComp("Input", { label: "SEL", x: 0, y: 20 }, ["RIGHT", 1], {
      state: 0,
    }) as any;
    const decoder = mkDecoder(4, 4, { x: 120, y: 0 }) as any;
    const encoder = multiInputComp("PriorityEncoder", 4, { x: 240, y: 0 }, ["RIGHT", 4]) as any;
    const demux = mkDemultiplexer(2, 4, { x: 120, y: 40 }) as any;
    const mux = mkMultiplexer(4, 4, { x: 240, y: 40 }) as any;
    const bitSel = {
      _type: "BitSelector",
      objectType: "BitSelector",
      direction: "RIGHT",
      label: "",
      bitWidth: 4,
      propagationDelay: 0,
      labelDirection: undefined,
      x: 120,
      y: 80,
      _nodes: {
        inp1: node(0, 4),
        bitSelectorInp: node(0, 1),
        output1: node(1, 1),
      },
      _params: ["RIGHT", 4, 0],
      _values: {},
    } as any;
    const tunnel = twoPort("Tunnel", { x: 300, y: 80, tunnelName: "BUS_A" }, ["RIGHT", 4]) as any;
    const flag = twoPort("Flag", { x: 360, y: 80 }, ["RIGHT", 4]) as any;

    const out = sinkComp("Output", { label: "ENC", x: 360, y: 0 }, ["RIGHT", 1]) as any;
    const out2 = sinkComp("Output", { label: "MUX", x: 360, y: 40 }, ["RIGHT", 4]) as any;
    const led0 = sinkComp("DigitalLed", { x: 360, y: 120 }, ["RIGHT", 1]) as any;
    const led1 = sinkComp("DigitalLed", { x: 390, y: 120 }, ["RIGHT", 1]) as any;
    const led2 = sinkComp("DigitalLed", { x: 420, y: 120 }, ["RIGHT", 1]) as any;
    const led3 = sinkComp("DigitalLed", { x: 450, y: 120 }, ["RIGHT", 1]) as any;

    wire(data, "output1", decoder, "inp1");
    wire(data, "output1", demux, "inp1");
    wire(data, "output1", mux, "inp", 0);
    wire(data, "output1", bitSel, "inp1");
    wire(sel, "output1", demux, "controlSignalInput");
    wire(sel, "output1", mux, "controlSignalInput");
    wire(sel, "output1", bitSel, "bitSelectorInp");

    wire(decoder, "output", encoder, "inp", 0);
    wire(decoder, "output", encoder, "inp", 1);
    wire(decoder, "output", encoder, "inp", 2);
    wire(decoder, "output", encoder, "inp", 3);

    wire(decoder, "output", led0, "inp1", 0, 0);
    wire(decoder, "output", led1, "inp1", 1, 0);
    wire(decoder, "output", led2, "inp1", 2, 0);
    wire(decoder, "output", led3, "inp1", 3, 0);

    // changed topology here:
    wire(demux, "output", mux, "inp", 1, 3);
    wire(demux, "output", mux, "inp", 0, 1);
    wire(demux, "output", led0, "inp1", 0, 0);
    wire(demux, "output", led1, "inp1", 1, 0);

    wire(bitSel, "output1", tunnel, "inp1");
    wire(tunnel, "output1", flag, "inp1");
    wire(flag, "output1", out, "inp1");

    wire(encoder, "output1", out, "inp1");
    wire(mux, "output1", out2, "inp1");

    const rebuiltSelection = makeScope("selection", [
      data,
      sel,
      decoder,
      encoder,
      demux,
      mux,
      bitSel,
      tunnel,
      flag,
      out,
      out2,
      led0,
      led1,
      led2,
      led3,
    ]);

    project[1] = rebuiltSelection;
    return project;
  }

  it("hashes a large wired multi-circuit project deterministically", async () => {
    const projectA = buildProject();
    const projectB = buildProject();

    const r1 = await canonicaliseProject(projectA as any);
    const r2 = await canonicaliseProject(projectB as any);

    expect(r1.canonicalHash).toBe(r2.canonicalHash);

    expect(r1.circuits[stringToNumber("combinational")]).toBeDefined();
    expect(r1.circuits[stringToNumber("selection")]).toBeDefined();
    expect(r1.circuits[stringToNumber("sequential")]).toBeDefined();
    expect(r1.circuits[stringToNumber("memory")]).toBeDefined();
    expect(r1.circuits[stringToNumber("display")]).toBeDefined();

    for (const [id, circuit] of Object.entries(r1.circuits)) {
      expect(circuit.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
      expect(circuit.netlist.components.length).toBeGreaterThan(0);
      expect(circuit.netlist.nets.length).toBeGreaterThan(0);
      expect(circuit.projectMetadata.id).toBe(Number(id));
    }

    expect(r1.circuits[stringToNumber("combinational")].canonicalHash).toBe(
      r2.circuits[stringToNumber("combinational")].canonicalHash,
    );
    expect(r1.circuits[stringToNumber("selection")].canonicalHash).toBe(
      r2.circuits[stringToNumber("selection")].canonicalHash,
    );
    expect(r1.circuits[stringToNumber("sequential")].canonicalHash).toBe(
      r2.circuits[stringToNumber("sequential")].canonicalHash,
    );
    expect(r1.circuits[stringToNumber("memory")].canonicalHash).toBe(
      r2.circuits[stringToNumber("memory")].canonicalHash,
    );
    expect(r1.circuits[stringToNumber("display")].canonicalHash).toBe(
      r2.circuits[stringToNumber("display")].canonicalHash,
    );

    const hashes = Object.values(r1.circuits).map((c) => c.canonicalHash);
    expect(new Set(hashes).size).toBeGreaterThan(1);
  });

  it("changes the project hash when one wire topology changes", async () => {
    const base = await canonicaliseProject(buildProject() as any);
    const changed = await canonicaliseProject(buildProjectWithOneChangedWire() as any);

    expect(base.canonicalHash).not.toBe(changed.canonicalHash);
  });

  describe("SubCircuit specific behavior", () => {
    it("deduplicates subcircuitRefs to avoid indegree double-counting", async () => {
      // Scope 'T' is the target scope (id = 101)
      const T = makeScope("c1", []); // id = 101
      
      // Scope 'D' has two SubCircuits referencing target scope T (id = 101)
      const sub1 = {
        _type: "SubCircuit",
        objectType: "SubCircuit",
        direction: "RIGHT",
        label: "",
        bitWidth: 1,
        propagationDelay: 0,
        labelDirection: undefined,
        x: 0,
        y: 0,
        _nodes: { inp1: node(0) },
        _params: [101],
        _values: {},
      };
      const sub2 = {
        _type: "SubCircuit",
        objectType: "SubCircuit",
        direction: "RIGHT",
        label: "",
        bitWidth: 1,
        propagationDelay: 0,
        labelDirection: undefined,
        x: 10,
        y: 10,
        _nodes: { inp1: node(0) },
        _params: [101],
        _values: {},
      };
      
      const D = makeScope("c2", [sub1, sub2]); // id = 102
      
      // Canonicalise project containing T and D.
      // If deduplication is working, the topological order will be computed successfully (T then D).
      const project = await canonicaliseProject([T, D] as any);
      expect(project.circuits[101]).toBeDefined();
      expect(project.circuits[102]).toBeDefined();
    });

    it("disambiguates SubCircuits referencing different scopes in WL fingerprinting", async () => {
      const subA = {
        _type: "SubCircuit",
        objectType: "SubCircuit",
        direction: "RIGHT",
        label: "",
        bitWidth: 1,
        propagationDelay: 0,
        labelDirection: undefined,
        x: 0,
        y: 0,
        _nodes: { inp1: node(0) },
        _params: [101],
        _values: {},
      };

      const subB = {
        _type: "SubCircuit",
        objectType: "SubCircuit",
        direction: "RIGHT",
        label: "",
        bitWidth: 1,
        propagationDelay: 0,
        labelDirection: undefined,
        x: 0,
        y: 0,
        _nodes: { inp1: node(0) },
        _params: [102],
        _values: {},
      };

      const scopeA = makeScope("s1", [subA]);
      const scopeB = makeScope("s2", [subB]);

      const resA = await canonicaliseProject(scopeA as any);
      const resB = await canonicaliseProject(scopeB as any);

      const hashA = resA.circuits[stringToNumber("s1")].canonicalHash;
      const hashB = resB.circuits[stringToNumber("s2")].canonicalHash;

      expect(hashA).not.toBe(hashB);
    });

    it("ensures two SubCircuits referencing different scopes in the same circuit get different fingerprints and sort deterministically", async () => {
      const sub102 = {
        _type: "SubCircuit",
        objectType: "SubCircuit",
        direction: "RIGHT",
        label: "",
        bitWidth: 1,
        propagationDelay: 0,
        labelDirection: undefined,
        x: 0,
        y: 0,
        _nodes: { inp1: node(0) },
        _params: [102],
        _values: {},
      };

      const sub101 = {
        _type: "SubCircuit",
        objectType: "SubCircuit",
        direction: "RIGHT",
        label: "",
        bitWidth: 1,
        propagationDelay: 0,
        labelDirection: undefined,
        x: 0,
        y: 0,
        _nodes: { inp1: node(0) },
        _params: [101],
        _values: {},
      };

      const scope = makeScope("cid", [sub102, sub101]);
      const res = await canonicaliseProject(scope as any);
      const circuit = res.circuits[stringToNumber("cid")];
      
      const comps = circuit.netlist.components;
      expect(comps.length).toBe(2);
      expect(comps[0].type).toBe("SubCircuit");
      expect(comps[1].type).toBe("SubCircuit");
      
      // Because of sorting, sub101 (params [101]) should sort before sub102 (params [102])
      const p0 = (comps[0].properties?.constructorParamaters as unknown[])?.[0];
      const p1 = (comps[1].properties?.constructorParamaters as unknown[])?.[0];
      expect(p0).toBe(101);
      expect(p1).toBe(102);
    });
  });
});

