import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import * as t from "@babel/types";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { inspectCall } from "./javascriptStaticAnalysisCalls.js";
import { createJavaScriptAnalysisAccumulator } from "./javascriptStaticAnalysisState.js";
import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { createJavaScriptRpcScan } from "./javascriptRpcEndpoints.js";
import { createSemanticExpressionShapeResolver } from "./javascriptSemanticExpressionShapes.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";

it("does not classify a local Map lookup as a network endpoint", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    const records = new Map([["/accounts", { name: "Alice" }]]);
    console.log(records.get("/accounts"));
    fetch("/network");
  `);
  expect(analysis.endpoints).toMatchObject([
    { kind: "network", value: "/network", mechanism: "call:fetch" },
  ]);
  expect(analysis.endpoints[0]?.interpretation).toBeUndefined();
});

it.each([
  'const records = new Map(); const alias = records; alias.get("/accounts"); records.delete("/accounts"); alias.get("/accounts")',
  'new Map().get("/accounts")',
  'new Map().delete("https://example.test/accounts")',
  'const records = new Map(); const alias = records; alias.get("/accounts")',
  'const records = new globalThis.Map(); records?.["get"]("/accounts")',
  'function inspect() { const records = new Map(); return records.get("/accounts"); }',
  'const inspect = () => { const records = new Map(); const alias = records; return alias.delete("/accounts"); }',
  'const browser = window; browser.open("about:blank"); new Map().get("/accounts")',
  'const browser = window as Window; (browser.open as any)(method, "context"); new Map().get("/accounts")',
  'const records = new Map(); const browser = window; browser.open("about:blank"); records.get("/accounts")',
  'const box = {}; box.value = { name: "Alice" }; inspect(box); new Map().get("/accounts")',
  'patch(() => ({ name: "Alice" })); new Map().get("/accounts")',
  'const box = {}; box.prototype = Map.prototype; new Map().get("/accounts")',
  'let box = {}; box.p = (box = { set p(value) { value.get = fetch; } }, Map.prototype); new Map().get("/accounts")',
  'const holder = { box: {} }; holder.box.p = (holder.box = { set p(value) { value.get = fetch; } }, Map.prototype); new Map().get("/accounts")',
  'const old = {}; const holder = { box: old }; const alias = holder.box; alias.p = (holder.box = { set p(value) { value.get = fetch; } }, Map.prototype); new Map().get("/accounts")',
  'const box = []; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = []; first.__proto__ = {}; Object.defineProperty(first.__proto__, "p", { set(value) { value.get = fetch; } }); const box = []; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = []; Object.setPrototypeOf(first, {}); Object.defineProperty(Object.getPrototypeOf(first), "p", { set(value) { value.get = fetch; } }); const box = []; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = []; Reflect.setPrototypeOf(first, {}); Object.defineProperty(Reflect.getPrototypeOf(first), "p", { set(value) { value.get = fetch; } }); const box = []; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = []; const set = Object.setPrototypeOf; set(first, {}); Object.defineProperty(Object.getPrototypeOf(first), "p", { set(value) { value.get = fetch; } }); const box = []; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = []; Object.setPrototypeOf(first, {}); Object.freeze(first); Object.defineProperty(Object.getPrototypeOf(first), "p", { set(value) { value.get = fetch; } }); const box = []; box.p = Map.prototype; new Map().get("/accounts")',
  'Object.defineProperty({}, "p", { value: 1 }); Object.defineProperty = function () { this.prototype.get = fetch; }; new Map().get("/accounts")',
  'const first = { ["__proto__"]: 1 }; Object.defineProperty(first.__proto__, "p", { set(value) { value.get = fetch; } }); const box = {}; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = []; first.__proto__ = {}; const proto = first.__proto__; Object.defineProperty(proto, "p", { set(value) { value.get = fetch; } }); const box = []; box.p = Map.prototype; new Map().get("/accounts")',
  'const box = {}; box.__proto__ = {}; new Map().get("/accounts")',
  'function expose() { const holder = { child: {} }; holder.child.prototype = Map.prototype; } new Map().get("/accounts")',
  'const box = flag ? {} : {}; box.prototype = Map.prototype; new Map().get("/accounts")',
  'const box = {}; const alias = box; alias.prototype = Map.prototype; inspect({}); new Map().get("/accounts")',
  'const box = {}; box.make = () => Map.prototype; new Map().get("/accounts")',
  'let box = {}; const first = box; box = {}; box.p = Map.prototype; patch(first); new Map().get("/accounts")',
  'const box = {}; box.a = {}; box.a.p = Map.prototype; box.safe = {}; patch(box.safe); new Map().get("/accounts")',
  'const records = new Map(); records.get = fetch; new Map().get("/accounts")',
  'const holder = { get prototype() { return Map.prototype; } }; new Map().get("/accounts")',
  'const holder = { get selected() { return {}; }, get other() { return Map.prototype; } }; holder.selected.get = fetch; new Map().get("/accounts")',
  'function Map() {} new Map().constructor.prototype.get = fetch; globalThis.Map.prototype; new globalThis.Map().get("/accounts")',
  'const factory = { make() { return {}; } }; factory.make = () => ({}); patch(factory.make()); new Map().get("/accounts")',
])("omits a proven Map operation: %s", (source) => {
  expect(analyzeJavaScriptStaticSource(source).endpoints).toEqual([]);
});

it.each([
  'const box = {}; box.p = (box.__proto__ = { set p(value) { value.get = fetch; } }, Map.prototype); new Map().get("/accounts")',
  'const box = {}; box.p = (Object.defineProperty(box, "p", { set(value) { value.get = fetch; } }), Map.prototype); new Map().get("/accounts")',
  'const old = {}; const holder = { box: old }; holder.box.p = (holder.box = {}, old.__proto__ = { set p(value) { value.get = fetch; } }, Map.prototype); new Map().get("/accounts")',
  'const box = {}; box.__proto__ = { child: { set p(value) { value.get = fetch; } } }; box.child.p = Map.prototype; new Map().get("/accounts")',
  'const box = {}; box.__proto__ = { set p(value) { value.get = fetch; } }; box.p = Map.prototype; new Map().get("/accounts")',
  'const box = {}; Object.setPrototypeOf(box, { set p(value) { value.get = fetch; } }); box.p = Map.prototype; new Map().get("/accounts")',
  'const box = {}; const alias = box; alias.__proto__ = { set p(value) { value.get = fetch; } }; box.p = Map.prototype; new Map().get("/accounts")',
  'const box = { child: {} }; box.child.__proto__ = { set p(value) { value.get = fetch; } }; box.child.p = Map.prototype; new Map().get("/accounts")',
  'const box = {}; Object.defineProperty(box, "p", { set(value) { value.get = fetch; } }); box.p = Map.prototype; new Map().get("/accounts")',
  'const box = { set p(value) { patch(value); } }; box.p = Map.prototype; new Map().get("/accounts")',
  'const box = { set p(value) { value.get = fetch; } }; box.p = Map.prototype; new Map().get("/accounts")',
  'const box = { __proto__: { set p(value) { patch(value); } } }; box.p = Map.prototype; new Map().get("/accounts")',
  'const box = { __proto__: external }; box.p = Map.prototype; new Map().get("/accounts")',
  'Object.defineProperty(Object.prototype,"p",{set:custom}); const box={}; box.p=Map.prototype; new Map().get("/accounts")',
  'const holder={get proto(){return Object.prototype}}; Object.defineProperty(holder.proto,"p",{set(value){value.get=fetch}}); const box={}; box.p=Map.prototype; new Map().get("/accounts")',
  'const box = { __proto__: {} }; box.__proto__.__proto__ = { set p(value) { value.get = fetch; } }; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = { ["__proto__"]: 1 }; Object.defineProperty(Object.getPrototypeOf(first), "p", { set(value) { value.get = fetch; } }); const box = {}; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = { ["__proto__"]: 1 }; Object.defineProperty(Reflect.getPrototypeOf(first), "p", { set(value) { value.get = fetch; } }); const box = {}; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = { ...values }; Object.defineProperty(Object.getPrototypeOf(first), "p", { set(value) { value.get = fetch; } }); const box = {}; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = { __proto__: -1 }; Object.defineProperty(Object.getPrototypeOf(first), "p", { set(value) { value.get = fetch; } }); const box = {}; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = []; Object.defineProperty(first, "__proto__", { value: {}, writable: true }); first.__proto__ = {}; Object.defineProperty(Object.getPrototypeOf(first), "p", { set(value) { value.get = fetch; } }); const box = []; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = { __proto__: 1 }; Object.defineProperty(Object.getPrototypeOf(first), "p", { set(value) { value.get = fetch; } }); const box = {}; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = []; const proto = first.__proto__; first.__proto__ = {}; Object.defineProperty(proto, "p", { set(value) { value.get = fetch; } }); const box = []; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = []; Object.setPrototypeOf(first, {}); Object.setPrototypeOf(first, Array.prototype); Object.defineProperty(Object.getPrototypeOf(first), "p", { set(value) { value.get = fetch; } }); const box = []; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = []; Object.freeze(first); Reflect.setPrototypeOf(first, {}); Object.defineProperty(Object.getPrototypeOf(first), "p", { set(value) { value.get = fetch; } }); const box = []; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = []; Object.setPrototypeOf(first, {}); restore(first); Object.defineProperty(Object.getPrototypeOf(first), "p", { set(value) { value.get = fetch; } }); const box = []; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = []; first.__proto__.__proto__ = { set p(value) { value.get = fetch; } }; const box = []; box.p = Map.prototype; new Map().get("/accounts")',
  'let box = []; const old = box; box = []; old.__proto__.__proto__ = { set p(value) { value.get = fetch; } }; box.p = Map.prototype; new Map().get("/accounts")',
  'const first = {}; Object.defineProperty(first.__proto__, "p", { set(value) { value.get = fetch; } }); const box = {}; box.p = Map.prototype; new Map().get("/accounts")',
  'const box = []; box.__proto__.__proto__ = { set p(value) { value.get = fetch; } }; box.p = Map.prototype; new Map().get("/accounts")',
  'const box = []; const alias = box; alias.__proto__.__proto__ = { set p(value) { value.get = fetch; } }; box.p = Map.prototype; new Map().get("/accounts")',
  'const holder = { box: [] }; holder.box.__proto__.__proto__ = { set p(value) { value.get = fetch; } }; holder.box.p = Map.prototype; new Map().get("/accounts")',
  'const box = []; patch(box.__proto__.__proto__); box.p = Map.prototype; new Map().get("/accounts")',
  'Array.prototype.__proto__ = { set p(value) { value.get = fetch; } }; const box = []; box.p = Map.prototype; new Map().get("/accounts")',
  'Object.prototype.__proto__ = { set p(value) { value.get = fetch; } }; const box = {}; box.p = Map.prototype; new Map().get("/accounts")',
  'Array.prototype.__proto__.__proto__ = { set p(value) { value.get = fetch; } }; const box = []; box.p = Map.prototype; new Map().get("/accounts")',
  'patch(Array.prototype.__proto__); const box = []; box.p = Map.prototype; new Map().get("/accounts")',
  'class Holder { get ns() { return Object; } } const holder = new Holder(); holder.ns.defineProperty = function () { this.prototype.get = fetch; }; Object.defineProperty({}, "p", {}); new Map().get("/accounts")',
  'Object.defineProperty = function () { this.prototype.get = fetch; }; Object.defineProperty({}, "p", {}); new Map().get("/accounts")',
  'Object.foo = function () { this.prototype.get = fetch; }; Object.foo(); new Map().get("/accounts")',
  'client.get("/accounts")',
  'const records = new Map(); const browser = window; browser.open(window); records.get("/accounts")',
  'const records = new Map(); function invoke() { window.open(); } window.open = patch; invoke(); records.get("/accounts")',
  'Object.getPrototypeOf = () => Map.prototype; Object.getPrototypeOf({}).get = fetch; new Map().get("/accounts")',
  'Reflect.getPrototypeOf = () => Map.prototype; Reflect.getPrototypeOf({}).get = fetch; new Map().get("/accounts")',
  'const records = new Map(); records.get = request; records.get("/accounts")',
  'let records = new Map(); records = client; records.get("/accounts")',
  'function inspect(Map) { new Map().get("/accounts"); }',
  'Map.prototype.get = request; const records = new Map(); records.get("/accounts")',
  'const records = new Map(); records.__proto__ = { get: fetch }; records.get("/accounts")',
  'const records = new Map(); const alias = records; alias.__proto__ = { get: fetch }; records.get("/accounts")',
  'const records = new Map(); records["__proto__"] = { delete: fetch }; records.delete("/accounts")',
  'function inspect() { records.get("/accounts"); const records = new Map(); }',
  'const alias = records; const records = new Map(); alias.get("/accounts")',
  'function inspect() { const alias = records; const records = new Map(); alias.get("/accounts"); }',
  'function inspect() { const records = new Map(); records.get = fetch; records.get("/accounts"); }',
  'patch(Map.prototype); const records = new Map(); records.get("/accounts")',
  'const prototype = Map.prototype; patch(prototype); new Map().get("/accounts")',
  'patch(Map); new Map().get("/accounts")',
  'new Patch(Map.prototype); new Map().get("/accounts")',
  'Map.prototype.patch = function () { this.get = fetch; }; Map.prototype.patch(); new Map().get("/accounts")',
  'Map.patch(); new Map().get("/accounts")',
  'globalThis.patch = function () { this.Map.prototype.get = fetch; }; globalThis.patch(); new Map().get("/accounts")',
  'window.open = function () { this.Map.prototype.get = fetch; }; window.open(); new Map().get("/accounts")',
  'function invoke() { window.open(); } window.open = patch; invoke(); new Map().get("/accounts")',
  'patch`prototype ${Map.prototype}`; new Map().get("/accounts")',
  'const box = { prototype: Map.prototype }; patch(box); new Map().get("/accounts")',
  'patch((() => Map.prototype)()); new Map().get("/accounts")',
  'const prototype = (() => Map.prototype)(); prototype.get = fetch; new Map().get("/accounts")',
  'const box = {}; box.prototype = Map.prototype; box.prototype.get = fetch; new Map().get("/accounts")',
  'const box = {}; box.p = (anything(), Map.prototype); patch(box); new Map().get("/accounts")',
  'window.prototype = Map.prototype; new Map().get("/accounts")',
  'const box = { set prototype(value) { patch(value); } }; box.prototype = Map.prototype; new Map().get("/accounts")',
  'const box = new ExternalBox(); box.prototype = Map.prototype; new Map().get("/accounts")',
  'function expose(box) { box.prototype = Map.prototype; } new Map().get("/accounts")',
  'function expose(box = {}) { box.prototype = Map.prototype; } new Map().get("/accounts")',
  'function expose(external, flag) { const box = flag ? {} : external; box.prototype = Map.prototype; } new Map().get("/accounts")',
  'function expose(external) { const holder = { child: external }; holder.child.prototype = Map.prototype; } new Map().get("/accounts")',
  'function expose(key) { const holder = { child: {} }; holder[key].prototype = Map.prototype; } new Map().get("/accounts")',
  'function expose(key) { const holder = [{}]; holder[key].prototype = Map.prototype; } new Map().get("/accounts")',
  'const box = flag ? {} : external(); box.prototype = Map.prototype; new Map().get("/accounts")',
  'function expose(external, flag) { const make = flag ? () => ({}) : external; const box = make(); box.prototype = Map.prototype; } new Map().get("/accounts")',
  'import external from "./external.mjs"; const box = flag ? {} : external; box.prototype = Map.prototype; new Map().get("/accounts")',
  'let box; if (flag) box = {}; box.prototype = Map.prototype; new Map().get("/accounts")',
  'const factory = { make() { return Map.prototype; } }; factory.make().get = fetch; new Map().get("/accounts")',
  'new Map().__proto__.get = fetch; new Map().get("/accounts")',
  'new Map().constructor.prototype.get = fetch; new Map().get("/accounts")',
  'Object.getPrototypeOf(new Map()).constructor.prototype.get = fetch; new Map().get("/accounts")',
  'const holder = { get prototype() { return Map.prototype; } }; holder.prototype.get = fetch; new Map().get("/accounts")',
  'const holder = { get ["prototype"]() { return { nested: Map.prototype }; } }; holder.prototype.nested.get = fetch; new Map().get("/accounts")',
  'const holder = { get prototype() { return Map.prototype; } }; patch(holder); new Map().get("/accounts")',
  'function store() { box.child.prototype = Map.prototype; } const box = {}; const inner = {}; box.child = inner; store(); patch(inner); new Map().get("/accounts")',
  'function store() { box.child.next.prototype = Map.prototype; } const box = {}; const middle = {}; const inner = {}; middle.next = inner; box.child = middle; store(); patch(inner); new Map().get("/accounts")',
  'const records = new Map(); Object.getPrototypeOf(records).get = fetch; new Map().get("/accounts")',
  'const getPrototype = Reflect.getPrototypeOf; getPrototype(new Map()).get = fetch; new Map().get("/accounts")',
  'patch(() => Map.prototype); new Map().get("/accounts")',
  'const factory = { make() { return {}; } }; factory.make = () => Map.prototype; patch(factory.make()); new Map().get("/accounts")',
  'function make() { return { prototype: Map.prototype }; } patch(make()); new Map().get("/accounts")',
  'const factory = { prototype() { return Map.prototype; } }; patch(factory.prototype()); new Map().get("/accounts")',
  'patch([Map.prototype]); new Map().get("/accounts")',
  'Object.setPrototypeOf(Map.prototype, custom); new Map().get("/accounts")',
])("keeps unresolved lookup semantics as a candidate: %s", (source) => {
  expect(analyzeJavaScriptStaticSource(source).endpoints).toMatchObject([
    { kind: "network", value: "/accounts", interpretation: "candidate" },
  ]);
});

it.each([
  "records.delete = fetch;",
  "patch(records);",
  "Map.prototype.delete = fetch;",
  "const alias = records; alias.__proto__ = { delete: fetch };",
])("retains genuine changes between Map operations: %s", (mutation) => {
  const analysis = analyzeJavaScriptStaticSource(
    `const records = new Map(); records.get('/before'); ${mutation} records.delete('/after');`,
  );
  expect(analysis.endpoints).toContainEqual(
    expect.objectContaining({ value: "/after", interpretation: "candidate" }),
  );
});

it.each(["get", "delete"])(
  "does not assume an unchanged constructor adder for Map.%s",
  (method) => {
    const analysis = analyzeJavaScriptStaticSource(`
    Map.prototype.set = function() { this.${method} = fetch; return this; };
    new Map([['x', 1]]).${method}('/accounts');
  `);
    expect(analysis.endpoints).toContainEqual(
      expect.objectContaining({
        value: "/accounts",
        interpretation: "candidate",
      }),
    );
  },
);

it.each([
  "box.prototype = Map.prototype;",
  'const alias = box; const prototype = Map.prototype; alias["prototype"] = prototype;',
  "({ value: box.prototype } = { value: Map.prototype });",
  "({ value: box.prototype = Map.prototype } = {});",
  "for (box.prototype of [Map.prototype]) {}",
])(
  "retains prototype identities stored after container initialization: %s",
  (store) => {
    const source = `const box = {}; ${store}
    function patch(b) { b.prototype.get = fetch; }
    patch(box); new Map().get("/accounts");`;
    expect(analyzeJavaScriptStaticSource(source).endpoints).toMatchObject([
      { kind: "network", value: "/accounts", interpretation: "candidate" },
    ]);
  },
);

it.each([
  ['new Headers().get("content-type")', 0],
  ['new URLSearchParams().delete("q")', 0],
  ['new Map().get("/accounts")', 0],
  ['new Map().delete("/accounts")', 0],
  ['client.get("/accounts")', 0],
  ['const client = createClient(); client.get("/accounts")', 0],
  ['const records = new Map(); records.get("/accounts")', 1],
] as const)(
  "requests mutation facts only for unresolved local receivers: %s",
  (source, pending) => {
    const file = parseJavaScriptSource(source);
    if (file === null) throw new Error("Expected parsed source");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(file.program),
    );
    completeSemanticSteps(index.indexAmbientWritesSteps());
    const accumulator = createJavaScriptAnalysisAccumulator(source.length);
    const context = {
      source,
      accumulator,
      vitePreloadDependencyTable: null,
      openReceiverFacts: index.receivers.openReceivers,
      rpcScan: createJavaScriptRpcScan(
        source,
        index.receivers.rpcClientRoots,
        index,
      ),
      expressionShapes: createSemanticExpressionShapeResolver(index.bindings),
    };
    traverseJavaScriptAst(file.program, {
      enter(node) {
        if (
          t.isCallExpression(node) ||
          t.isOptionalCallExpression(node) ||
          t.isNewExpression(node)
        )
          inspectCall(source, node, context, index.bindings);
      },
    });
    expect(accumulator.pendingNetworkCalls).toHaveLength(pending);
  },
);

it.each([
  [
    'const box = {}; [box.p, box.__proto__] = [Map.prototype, { set p(value) { value.get = fetch; } }]; new Map().get("/accounts")',
    0,
  ],
  [
    'const box = {}; ({a: box.p, b: box.__proto__} = {a: Map.prototype, b: { set p(value) { value.get = fetch; } }}); new Map().get("/accounts")',
    0,
  ],
  [
    'const box = {}; [box.__proto__, box.p] = [{ set p(value) { value.get = fetch; } }, Map.prototype]; new Map().get("/accounts")',
    1,
  ],
  [
    'const box = {}; ({a: box.__proto__, b: box.p} = {a: { set p(value) { value.get = fetch; } }, b: Map.prototype}); new Map().get("/accounts")',
    1,
  ],
  [
    'const box = {}; [{a: box.__proto__}, box.p] = [{a: { set p(value) { value.get = fetch; } }}, Map.prototype]; new Map().get("/accounts")',
    1,
  ],
] as const)(
  "orders pattern stores like the runtime: %s",
  (source, expected) => {
    const calls: unknown[] = [];
    runInNewContext(source, { fetch: (url: unknown) => calls.push(url) });
    expect(calls).toEqual(expected === 0 ? [] : ["/accounts"]);
    const endpoints = analyzeJavaScriptStaticSource(source).endpoints;
    if (expected === 0) expect(endpoints).toEqual([]);
    else
      expect(endpoints).toContainEqual(
        expect.objectContaining({
          value: "/accounts",
          interpretation: "candidate",
        }),
      );
  },
);

it.each([
  'Object.defineProperty(Object.prototype, "hook", { set(fn) { this.open = fn; } }); globalThis.hook = function() { this.Map.prototype.get = fetch; }; globalThis.open();',
  'Object.defineProperty(Object.prototype, "hook", { set(fn) { this.open = fn; } }); const root = globalThis; root.hook = function() { this.Map.prototype.get = fetch; }; root.open();',
  'Object.defineProperty(Object.prototype, "hook", { set(fn) { this.open = fn; } }); ({ value: globalThis.hook } = { value: function() { this.Map.prototype.get = fetch; } }); globalThis.open();',
])("retains cross-key receiver effects from inherited setters: %s", (setup) => {
  const source = `${setup} new Map().get("/accounts");`;
  const observed: unknown[] = [];
  runInNewContext(source, { fetch: (value: unknown) => observed.push(value) });
  expect(observed).toEqual(["/accounts"]);
  expect(analyzeJavaScriptStaticSource(source).endpoints).toContainEqual(
    expect.objectContaining({
      kind: "network",
      value: "/accounts",
      interpretation: "candidate",
    }),
  );
});

it.each([
  [
    'const box = {}; box.p = Map.prototype; Object.defineProperty(Object.prototype, "p", { set(v) { v.get = fetch; } });',
    false,
  ],
  [
    'const box = {}; Object.defineProperty(Object.prototype, "p", { set(v) { v.get = fetch; } }); box.p = Map.prototype;',
    true,
  ],
  [
    'const box = {}; box.p = (Object.defineProperty(Object.prototype, "p", { set(v) { v.get = fetch; } }), Map.prototype);',
    true,
  ],
  [
    'const box = {}; [box.p, box.other] = [Map.prototype, Object.defineProperty(Object.prototype, "p", { set(v) { v.get = fetch; } })];',
    true,
  ],
  [
    'const box = {}; [box.other, box.p] = [Object.defineProperty(Object.prototype, "p", { set(v) { v.get = fetch; } }), Map.prototype];',
    true,
  ],
  [
    "const box = {}; [box.p, Object.prototype.p] = [Map.prototype, undefined];",
    false,
  ],
] as const)(
  "selects ambient setters at the store clock: %s",
  (setup, invoked) => {
    const source = `${setup} new Map().get("/accounts");`;
    const calls: unknown[] = [];
    runInNewContext(source, { fetch: (value: unknown) => calls.push(value) });
    expect(calls).toEqual(invoked ? ["/accounts"] : []);
    const endpoints = analyzeJavaScriptStaticSource(source).endpoints;
    if (invoked)
      expect(endpoints).toContainEqual(
        expect.objectContaining({
          value: "/accounts",
          interpretation: "candidate",
        }),
      );
    else expect(endpoints).toEqual([]);
  },
);

it.each([
  'Object.defineProperty = function(target) { target.get = fetch; }; Object.defineProperty(Map.prototype, "p", {});',
  'Reflect.defineProperty = function(target) { target.get = fetch; return true; }; Reflect.defineProperty(Map.prototype, "p", {});',
  'const proxy = new Proxy(Map.prototype, { defineProperty(target) { target.get = fetch; return true; } }); Object.defineProperty(proxy, "p", { value: 1 });',
  'Object.defineProperty(Object.prototype, "p", { get set() { Map.prototype.get = fetch; return function() {}; } });',
])("retains descriptor target traps and getter effects: %s", (setup) => {
  const source = `${setup} new Map().get("/accounts");`;
  const calls: unknown[] = [];
  runInNewContext(source, { fetch: (value: unknown) => calls.push(value) });
  expect(calls).toEqual(["/accounts"]);
  expect(analyzeJavaScriptStaticSource(source).endpoints).toContainEqual(
    expect.objectContaining({
      value: "/accounts",
      interpretation: "candidate",
    }),
  );
});

const installInheritedSetter =
  'Object.defineProperty(Object.prototype,"p",{set(value){value.get=fetch}})';
it.each([
  [`[box.p,box[(${installInheritedSetter},"q")]]=[Map.prototype,0]`, false],
  [`[box[(${installInheritedSetter},"q")],box.p]=[0,Map.prototype]`, true],
  [
    `({first:box.p,[(${installInheritedSetter},"later")]:box.q}={first:Map.prototype,later:0})`,
    false,
  ],
  [
    `[box.p,box.q=(${installInheritedSetter},0)]=[Map.prototype,undefined]`,
    false,
  ],
  [
    `[box.q=(${installInheritedSetter},0),box.p]=[undefined,Map.prototype]`,
    true,
  ],
  [
    `[box.p,{value:box[(${installInheritedSetter},"q")]}]=[Map.prototype,{value:0}]`,
    false,
  ],
  [
    `[box.p,{value:box.q}=(${installInheritedSetter},{value:0})]=[Map.prototype,undefined]`,
    false,
  ],
  [
    `[{value:box.p}=(${installInheritedSetter},{value:Map.prototype})]=[undefined]`,
    true,
  ],
  [`[box.p=(${installInheritedSetter},Map.prototype)]=[undefined]`, true],
  [`box[(${installInheritedSetter},"p")]=Map.prototype`, true],
  [`box.p=(${installInheritedSetter},Map.prototype)`, true],
])(
  "orders inherited setters at each target completion: %s",
  (assignment, invoked) => {
    const source = `const box={};${assignment};new Map().get("/accounts");`;
    const calls: unknown[] = [];
    runInNewContext(source, { fetch: (value: unknown) => calls.push(value) });
    expect(calls).toEqual(invoked ? ["/accounts"] : []);
    const endpoints = analyzeJavaScriptStaticSource(source).endpoints;
    if (invoked)
      expect(endpoints).toContainEqual(
        expect.objectContaining({
          value: "/accounts",
          interpretation: "candidate",
        }),
      );
    else expect(endpoints).toEqual([]);
  },
);

it.each([
  [
    'const box={};Object.defineProperty(Array.prototype,"p",{set(value){value.get=fetch}});',
    false,
  ],
  [
    'const box={};Object.defineProperty(Function.prototype,"p",{set(value){value.get=fetch}});',
    false,
  ],
  [
    'const box={};Object.defineProperty(Object.prototype,"p",{set(value){value.get=fetch}});',
    true,
  ],
  [
    'const box=[];Object.defineProperty(Array.prototype,"p",{set(value){value.get=fetch}});',
    true,
  ],
  [
    'const box=function(){};Object.defineProperty(Function.prototype,"p",{set(value){value.get=fetch}});',
    true,
  ],
  ["const box={__proto__:{set p(value){value.get=fetch}}};", true],
  [
    'const box={};Object.setPrototypeOf(box,Array.prototype);Object.defineProperty(Array.prototype,"p",{set(value){value.get=fetch}});',
    true,
  ],
  [
    'const box={};Object.setPrototypeOf(box,Function.prototype);Object.defineProperty(Function.prototype,"p",{set(value){value.get=fetch}});',
    true,
  ],
  [
    'const box={};const alias=box;Reflect.setPrototypeOf(alias,Array.prototype);Object.defineProperty(Array.prototype,"p",{set(value){value.get=fetch}});',
    true,
  ],
  [
    'const box=Object.create(null);Object.defineProperty(Object.prototype,"p",{set(value){value.get=fetch}});',
    false,
  ],
  [
    'const box={__proto__:null};Object.defineProperty(Object.prototype,"p",{set(value){value.get=fetch}});',
    false,
  ],
  [
    'const box={["__proto__"]:Array.prototype};Object.defineProperty(Array.prototype,"p",{set(value){value.get=fetch}});',
    false,
  ],
  [
    'const box=Object.create(null);box.__proto__=Array.prototype;Object.defineProperty(Array.prototype,"p",{set(value){value.get=fetch}});',
    false,
  ],
  [
    'const box={};Object.setPrototypeOf(box,null);Object.defineProperty(Object.prototype,"p",{set(value){value.get=fetch}});',
    false,
  ],
  [
    'const box=flag?{}:[];Object.defineProperty(Array.prototype,"p",{set(value){value.get=fetch}});',
    true,
  ],
  [
    'const box={["__proto__"]:null};box.__proto__=Array.prototype;Object.defineProperty(Array.prototype,"p",{set(value){value.get=fetch}});',
    false,
  ],
  [
    'const box=Object.create(null);Object.setPrototypeOf(box,Array.prototype);box.__proto__=Function.prototype;Object.defineProperty(Function.prototype,"p",{set(value){value.get=fetch}});',
    true,
  ],
  [
    'let proto=Array.prototype;const box=Object.create(proto,(proto=null,{}));Object.defineProperty(Array.prototype,"p",{set(value){value.get=fetch}});',
    true,
  ],
  [
    'let proto=null;const box=Object.create(proto,(proto=Array.prototype,{}));Object.defineProperty(Array.prototype,"p",{set(value){value.get=fetch}});',
    false,
  ],
])(
  "limits inherited setters to applicable receiver prototypes: %s",
  (setup, invoked) => {
    const source = `${setup}box.p=Map.prototype;new Map().get("/accounts");`;
    const calls: unknown[] = [];
    runInNewContext(source, {
      flag: false,
      fetch: (value: unknown) => calls.push(value),
    });
    expect(calls).toEqual(invoked ? ["/accounts"] : []);
    const endpoints = analyzeJavaScriptStaticSource(source).endpoints;
    if (invoked)
      expect(endpoints).toContainEqual(
        expect.objectContaining({
          value: "/accounts",
          interpretation: "candidate",
        }),
      );
    else expect(endpoints).toEqual([]);
  },
);

it.each([
  'Object.defineProperty(Array.prototype,"p",{set(value){value.get=fetch}});Object.create=()=>[];const box=Object.create(null);box.p=Map.prototype;',
  'Object.setPrototypeOf=function(target){Object.defineProperty(target,"p",{set(value){value.get=fetch}});return target};const box={};Object.setPrototypeOf(box,null);box.p=Map.prototype;',
  'const box=new Proxy({},{setPrototypeOf(target){Object.defineProperty(target,"p",{set(value){value.get=fetch}});return true}});Object.setPrototypeOf(box,null);box.p=Map.prototype;',
  'function make(){return []}const box=make();Object.defineProperty(Array.prototype,"p",{set(value){value.get=fetch}});box.p=Map.prototype;',
])("retains unknown or replaced prototype operations: %s", (setup) => {
  const source = `${setup}new Map().get("/accounts");`;
  const calls: unknown[] = [];
  runInNewContext(source, { fetch: (value: unknown) => calls.push(value) });
  expect(calls).toEqual(["/accounts"]);
  expect(analyzeJavaScriptStaticSource(source).endpoints).toContainEqual(
    expect.objectContaining({
      value: "/accounts",
      interpretation: "candidate",
    }),
  );
});

it.each([
  ["const box={p:0};box.p=Map.prototype;", false],
  ["const box={p(){}};box.p=Map.prototype;", false],
  ["const box={get p(){return 0}};box.p=Map.prototype;", false],
  ["const box={set p(value){value.get=fetch}};box.p=Map.prototype;", true],
  ["const box={};box.hook=0;box.p=Map.prototype;", true],
  ["const box={hook:0};box.hook=0;box.p=Map.prototype;", false],
  [
    "const box={set hook(value){this.__proto__={set p(value){value.get=fetch}}}};box.hook=0;box.p=Map.prototype;",
    true,
  ],
  [
    "let box={};const old=box;box.hook=(box={p:0},0);old.p=Map.prototype;",
    true,
  ],
  ["let box={};box.hook=(box={p:0},0);box.p=Map.prototype;", false],
])(
  "preserves own descriptor shadowing and captured setter receivers: %s",
  (stores, invoked) => {
    const setter = stores.includes("hook")
      ? 'Object.defineProperty(Object.prototype,"hook",{set(){this.__proto__={set p(value){value.get=fetch}}}});'
      : 'Object.defineProperty(Object.prototype,"p",{set(value){value.get=fetch}});';
    const source = `${setter}${stores}new Map().get("/accounts");`;
    const calls: unknown[] = [];
    runInNewContext(source, { fetch: (value: unknown) => calls.push(value) });
    expect(calls).toEqual(invoked ? ["/accounts"] : []);
    const endpoints = analyzeJavaScriptStaticSource(source).endpoints;
    if (invoked)
      expect(endpoints).toContainEqual(
        expect.objectContaining({
          value: "/accounts",
          interpretation: "candidate",
        }),
      );
    else expect(endpoints).toEqual([]);
  },
);

it.each([
  ["delete this.q;return 0", true],
  ["return 0", false],
])(
  "checks source getter effects before proving a spread own slot: %s",
  (body, invoked) => {
    const source = `Object.defineProperty(Object.prototype,"q",{set(value){value.get=fetch}});const box={...{get p(){${body}},q:0}};box.q=Map.prototype;new Map().get("/accounts");`;
    const calls: unknown[] = [];
    runInNewContext(source, { fetch: (value: unknown) => calls.push(value) });
    expect(calls).toEqual(invoked ? ["/accounts"] : []);
    const endpoints = analyzeJavaScriptStaticSource(source).endpoints;
    if (invoked)
      expect(endpoints).toContainEqual(
        expect.objectContaining({
          value: "/accounts",
          interpretation: "candidate",
        }),
      );
    else expect(endpoints).toEqual([]);
  },
);

it.each([
  [
    "const v={valueOf(){Map.prototype.get=fetch;return 0}};const a=new Uint8Array(1);a[0]=v;",
    true,
  ],
  [
    "const v={[Symbol.toPrimitive](){Map.prototype.get=fetch;return 0n}};const a=new BigInt64Array(1);const alias=a;alias[0]=v;",
    true,
  ],
  [
    "const v={valueOf(){Map.prototype.get=fetch;return 0}};let a=new Uint8Array(1);a[0]=(a=[],v);",
    true,
  ],
  ["const v={valueOf(){return 0}};const a=new Uint8Array(1);a[0]=v;", false],
  ["const a=new Uint8Array(1);a[0]=0;", false],
  [
    'Object.defineProperty(Map.prototype,"hook",{set(value){this.get=fetch}});const box=new Map();box.hook=0;',
    true,
    "box",
  ],
  [
    'Object.defineProperty(Set.prototype,"hook",{set(value){Map.prototype.get=fetch}});const box=new Set();box.hook=0;',
    true,
  ],
  [
    'Object.defineProperty(Map.prototype,"hook",{set(value){this.get=fetch}});const box={__proto__:Map.prototype,hook:0};box.hook=0;',
    false,
  ],
  [
    'Object.defineProperty(Map.prototype,"hook",{set(value){this.get=fetch}});const box={};box.hook=0;',
    false,
  ],
])(
  "owns typed-store conversion and resolved prototype setter effects: %s",
  (setup, invoked, receiver?: string) => {
    const source = `${setup}${receiver ?? "new Map()"}.get("/accounts");`;
    const calls: unknown[] = [];
    runInNewContext(source, { fetch: (value: unknown) => calls.push(value) });
    expect(calls).toEqual(invoked ? ["/accounts"] : []);
    const endpoints = analyzeJavaScriptStaticSource(source).endpoints;
    if (invoked)
      expect(endpoints).toContainEqual(
        expect.objectContaining({
          value: "/accounts",
          interpretation: "candidate",
        }),
      );
    else expect(endpoints).toEqual([]);
  },
);

it.each([
  'const box=new Map();box.hook=0;Object.defineProperty(Map.prototype,"hook",{set(value){this.get=fetch}});box.get("/accounts");',
])(
  "keeps a captured store before later prototype setters intact: %s",
  (source) => {
    const calls: unknown[] = [];
    runInNewContext(source, { fetch: (value: unknown) => calls.push(value) });
    expect(calls).toEqual([]);
    expect(analyzeJavaScriptStaticSource(source).endpoints).toEqual([]);
  },
);

it("retains conversion from a possible integer-indexed receiver", () => {
  const source =
    'const a=flag?new Uint8Array(1):[];const v={valueOf(){Map.prototype.get=fetch;return 0}};a[0]=v;new Map().get("/accounts");';
  const calls: unknown[] = [];
  runInNewContext(source, {
    flag: true,
    fetch: (value: unknown) => calls.push(value),
  });
  expect(calls).toEqual(["/accounts"]);
  expect(analyzeJavaScriptStaticSource(source).endpoints).toContainEqual(
    expect.objectContaining({
      value: "/accounts",
      interpretation: "candidate",
    }),
  );
});
