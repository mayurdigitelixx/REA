import * as t from "@babel/types";
import { describe, expect, it } from "vitest";

import {
  semanticBindingAtRead,
  semanticEffectTimingAtStore,
  semanticMutationInitializers,
  semanticTopLevelEffectFollowsCapture,
} from "./javascriptSemanticMutationInitializers.js";
import type { JavaScriptSemanticBindingState } from "./javascriptSemanticState.js";
import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { semanticProjectedSourceFactsAtRead } from "./javascriptSemanticProjectedSources.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

it.each([
  ["public value", false, false],
  ["private value", false, false],
  ["accessor value", false, false],
  ["public value", true, true],
  ["private value", true, true],
  ["accessor value", true, true],
  ["public key", false, true],
  ["accessor key", false, true],
] as const)(
  "orders %s reads with static=%s only when evaluated at class definition",
  (kind, isStatic, ordered) => {
    const initializer = t.numericLiteral(1);
    const read = t.identifier("child");
    const inKey = kind.endsWith("key");
    const key = inKey ? read : t.identifier("field");
    const value = inKey ? t.numericLiteral(0) : read;
    const field = kind.startsWith("private")
      ? t.classPrivateProperty(t.privateName(t.identifier("field")), value)
      : kind.startsWith("accessor")
        ? t.classAccessorProperty(key, value, null, null, inKey)
        : t.classProperty(key, value, null, null, inKey);
    field.static = isStatic;
    const program = t.program([
      t.variableDeclaration("let", [
        t.variableDeclarator(t.identifier("child"), initializer),
      ]),
      t.classDeclaration(t.identifier("Stop"), null, t.classBody([field])),
    ]);
    const parents = new WeakMap<t.Node, t.Node>();
    traverseJavaScriptAst(program, {
      enter: (node, parent) => {
        if (parent !== null) parents.set(node, parent);
      },
    });
    const binding: JavaScriptSemanticBindingState = {
      bindingId: "program:child",
      scopeId: "program",
      name: "child",
      kind: "variable",
      declarationKinds: new Set(["let"]),
      mutable: true,
      memberWrites: [],
      escapedPaths: [],
      definitions: [],
      initializers: [{ node: initializer, projection: [] }],
      referenceInitializers: [],
      directOrigins: [],
      runtimeImport: false,
    };
    expect(semanticBindingAtRead(binding, read, parents).status).toBe(
      ordered ? "ordered" : "unresolved",
    );
    expect(
      semanticTopLevelEffectFollowsCapture(initializer, read, parents),
    ).toBe(ordered);
  },
);

describe("parameter references copied into function body bindings", () => {
  it.each([
    ["var arg = []; mutate(arg);", false],
    ["mutate(arg); var arg = [];", true],
    ["if (flag) { var arg = []; } mutate(arg);", true],
  ])(
    "retains the entry reference only when still reachable: %s",
    (body, retained) => {
      const program = parseJavaScriptSource(
        `function result(arg = source) { ${body} }`,
      )?.program;
      const callable = program?.body[0];
      if (program === undefined || !t.isFunctionDeclaration(callable))
        throw new Error("Expected a parsed function declaration");
      const parameter = callable.params[0];
      if (!t.isAssignmentPattern(parameter) || !t.isIdentifier(parameter.left))
        throw new Error("Expected the source parameter binding");
      const parents = new WeakMap<t.Node, t.Node>();
      let replacement: t.Node | undefined;
      let mutation: t.Node | undefined;
      traverseJavaScriptAst(program, {
        enter: (node, parent) => {
          if (parent !== null) parents.set(node, parent);
          if (t.isVariableDeclarator(node) && node.init !== null)
            replacement = node.init;
          if (t.isCallExpression(node)) mutation = node;
        },
      });
      if (replacement === undefined || mutation === undefined)
        throw new Error("Expected a body initializer and subsequent effect");
      const entry = {
        node: parameter.left,
        projection: [],
        entryBody: callable.body,
      };
      const assigned = { node: replacement, projection: [] };
      const binding: JavaScriptSemanticBindingState = {
        bindingId: "body:arg",
        scopeId: "body",
        name: "arg",
        kind: "variable",
        declarationKinds: new Set(),
        mutable: true,
        memberWrites: [],
        escapedPaths: [],
        definitions: [],
        initializers: [entry, assigned],
        referenceInitializers: [],
        directOrigins: [],
        runtimeImport: false,
      };
      const origins = semanticMutationInitializers(binding, mutation, parents);
      expect(origins.initializers.includes(entry)).toBe(retained);
      expect(origins.initializers).toContain(assigned);
    },
  );
});

it.each([false, true])(
  "selects local setter effects before a target store (installed first: %s)",
  (first) => {
    const effect =
      'Object.defineProperty(proto,"p",{set(value){value.get=fetch}})';
    const assignment = first
      ? `[box[(${effect},"q")],box.p]=[0,Map.prototype]`
      : `[box.p,box[(${effect},"q")]]=[Map.prototype,0]`;
    const source = `const proto={};const box={__proto__:proto};${assignment};`;
    const parsed = parseJavaScriptSource(source);
    if (parsed === null) throw new Error("Expected a local setter fixture");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(parsed.program),
    );
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
    let mutation: t.AssignmentExpression | undefined;
    let target: t.MemberExpression | undefined;
    let descriptor: t.CallExpression | undefined;
    traverseJavaScriptAst(parsed.program, {
      enter(node) {
        if (t.isAssignmentExpression(node) && t.isArrayPattern(node.left))
          mutation = node;
        if (
          t.isMemberExpression(node) &&
          t.isIdentifier(node.object, { name: "box" }) &&
          t.isIdentifier(node.property, { name: "p" })
        )
          target = node;
        if (
          t.isCallExpression(node) &&
          t.isMemberExpression(node.callee) &&
          t.isIdentifier(node.callee.property, { name: "defineProperty" })
        )
          descriptor = node;
      },
    });
    const binding = [...index.bindings.bindingsById.values()].find(
      ({ name }) => name === "proto",
    );
    const reference = descriptor?.arguments[0];
    if (
      mutation === undefined ||
      target === undefined ||
      binding === undefined ||
      !t.isIdentifier(reference)
    )
      throw new Error("Expected captured target and local prototype");
    const facts = semanticProjectedSourceFactsAtRead(
      binding,
      reference,
      ["p"],
      index.bindings,
      true,
      mutation,
      [],
      { beforeStore: { mutation, target } },
    );
    // The descriptor call may expose its local target. Its effect is relevant
    // only when that call precedes this leaf's completed store.
    expect(facts === undefined).toBe(first);
  },
);

it("preserves target identity and unknown positions across cached store queries", () => {
  const parsed = parseJavaScriptSource(
    "const box={};[box.a,box.b,box.c]=[1,2,3];[box.c,box.b,box.a]=[4,5,6];",
  );
  if (parsed === null) throw new Error("Expected ordered pattern fixtures");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  const mutations = parsed.program.body.flatMap((statement) =>
    t.isExpressionStatement(statement) &&
    t.isAssignmentExpression(statement.expression)
      ? [statement.expression]
      : [],
  );
  for (const mutation of mutations) {
    if (!t.isArrayPattern(mutation.left))
      throw new Error("Expected array targets");
    const [before, target, after] = mutation.left.elements;
    if (
      !t.isMemberExpression(before) ||
      !t.isMemberExpression(target) ||
      !t.isMemberExpression(after)
    )
      throw new Error("Expected member target identities");
    const store = { mutation, target };
    const timing = (storeTarget: t.MemberExpression) =>
      semanticEffectTimingAtStore(
        store,
        { node: mutation, storeTarget },
        index.bindings,
      );
    expect(timing(before)).toBe("before");
    expect(timing(target)).toBe("after");
    expect(timing(after)).toBe("after");
    // A structurally equal member from another occurrence supplies no proof.
    expect(timing(t.cloneNode(before))).toBe("unknown");
    expect(
      semanticEffectTimingAtStore(store, { node: mutation }, index.bindings),
    ).toBe("unknown");
  }
});
