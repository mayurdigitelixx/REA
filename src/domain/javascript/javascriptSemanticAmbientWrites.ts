import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  readExactJavaScriptLiteral,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronMemberPath,
} from "./javascriptElectronMemberWrites.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import {
  isUnshadowedGlobal,
  SEMANTIC_GLOBAL_OBJECT_NAMES as GLOBAL_OBJECT_NAMES,
  canonicalSemanticAmbientPath as canonicalAmbientPath,
  semanticAmbientPathMayHaveChanged,
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { isImportMetaUrl } from "./javascriptStaticAnalysisHelpers.js";
import {
  semanticBindingAtRead,
  semanticDefiniteEffectPrecedesReference,
  semanticEffectTiming,
  semanticEffectTimingAtStore,
  type SemanticBeforeStore,
} from "./javascriptSemanticMutationInitializers.js";
import { SEMANTIC_ALIAS_SELECTION_LIMIT } from "./javascriptSemanticResourceLimits.js";
import {
  semanticIterationSources,
  type SemanticIterationSource,
} from "./javascriptSemanticIterationSources.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";
import {
  semanticCopiedReferencePath,
  semanticReferenceIterationUnknown,
  semanticReferenceSourcesInactive,
} from "./javascriptSemanticReferenceSources.js";

// These static builtins do not give their namespace receiver to user code.
const NATIVE_NAMESPACE_METHODS = {
  Object: new Set([
    "assign",
    "create",
    "defineProperty",
    "defineProperties",
    "entries",
    "freeze",
    "fromEntries",
    "getOwnPropertyDescriptor",
    "getOwnPropertyDescriptors",
    "getOwnPropertyNames",
    "getOwnPropertySymbols",
    "getPrototypeOf",
    "groupBy",
    "hasOwn",
    "is",
    "isExtensible",
    "isFrozen",
    "isSealed",
    "keys",
    "preventExtensions",
    "seal",
    "setPrototypeOf",
    "values",
  ]),
  Reflect: new Set([
    "apply",
    "construct",
    "defineProperty",
    "deleteProperty",
    "get",
    "getOwnPropertyDescriptor",
    "getPrototypeOf",
    "has",
    "isExtensible",
    "ownKeys",
    "preventExtensions",
    "set",
    "setPrototypeOf",
  ]),
};

const globalObjectName = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): string | undefined =>
  GLOBAL_OBJECT_NAMES.find((name) => isUnshadowedGlobal(node, state, name));

type AmbientPath = readonly (string | null)[];

const retainedAmbientEffects = new WeakMap<
  JavaScriptSemanticAnalysisState,
  Map<t.Node | undefined, Set<string>>
>();

/** Retain canonical ambient effects once, whether discovered by syntax or receiver expansion. */
export const retainSemanticAmbientEffect = (
  state: JavaScriptSemanticAnalysisState,
  kind: "write" | "escape",
  path: AmbientPath,
  node: t.Node | undefined,
  storeTarget?: t.MemberExpression | t.OptionalMemberExpression,
): boolean => {
  const selected = kind === "escape" ? [...path, null] : path;
  const byNode = retainedAmbientEffects.get(state) ?? new Map();
  const keys = byNode.get(node) ?? new Set<string>();
  const key = JSON.stringify([
    kind,
    selected,
    storeTarget?.start,
    storeTarget?.end,
  ]);
  if (keys.has(key)) return false;
  keys.add(key);
  byNode.set(node, keys);
  retainedAmbientEffects.set(state, byNode);
  if (kind === "write") {
    state.ambientWrites.retain(selected);
    state.ambientWriteEffects.push({
      path: selected,
      node,
      ...(storeTarget === undefined ? {} : { storeTarget }),
    });
  } else {
    state.ambientEscapes.retain(selected);
    state.ambientEscapeEffects.push({ path: selected, node });
  }
  return true;
};

interface AmbientSetterCandidate {
  readonly effect: JavaScriptSemanticAnalysisState["ambientWriteEffects"][number];
  readonly prototype: AmbientPath;
  readonly unknownApplicability: boolean;
}

// Effects append during the semantic fixpoint. Index each effect once while
// retaining its actual site/target clock; applicability is queried afresh.
const ambientSetterIndexes = new WeakMap<
  JavaScriptSemanticAnalysisState,
  {
    writes: number;
    escapes: number;
    readonly keys: Map<string, AmbientSetterCandidate[]>;
    readonly any: AmbientSetterCandidate[];
  }
>();

const ambientSetterCandidates = (
  state: JavaScriptSemanticAnalysisState,
  key: string,
): readonly AmbientSetterCandidate[] => {
  const index = ambientSetterIndexes.get(state) ?? {
    writes: 0,
    escapes: 0,
    keys: new Map<string, AmbientSetterCandidate[]>(),
    any: [],
  };
  ambientSetterIndexes.set(state, index);
  const retain = (effect: AmbientSetterCandidate["effect"]) => {
    const path = effect.path.map((part) =>
      part === null || typeof part === "object" ? null : String(part),
    );
    // CommonJS/module identities share the effect transport, but do not name
    // the ambient global prototype namespace.
    if (path[0] !== "global" && path[0] !== null) return;
    let position = path.findIndex(
      (part, i) => i >= 2 && (part === "prototype" || part === null),
    );
    if (position < 0) {
      if (path.length > 3 || (path.length === 3 && path[2] !== null)) return;
      position = 2;
    }
    const prototype = path.slice(0, position);
    while (prototype.length < position) prototype.push(null);
    prototype.push("prototype");
    const selected = path[position + 1];
    if (
      selected !== undefined &&
      selected !== null &&
      selected !== "__proto__" &&
      path.length > position + 2
    )
      return;
    // Escaping an arbitrary ambient function does not itself prove a setter
    // exists on an unrelated unknown chain. Its possible prototype changes
    // still apply when the receiver owner resolves that same prototype.
    const candidate = {
      effect,
      prototype,
      unknownApplicability:
        path.includes("prototype") || path.length <= 1 || path[1] === null,
    };
    if (selected === undefined || selected === null || selected === "__proto__")
      index.any.push(candidate);
    else {
      const values = index.keys.get(selected) ?? [];
      values.push(candidate);
      index.keys.set(selected, values);
    }
  };
  while (index.writes < state.ambientWriteEffects.length)
    retain(state.ambientWriteEffects[index.writes++]!);
  while (index.escapes < state.ambientEscapeEffects.length)
    retain(state.ambientEscapeEffects[index.escapes++]!);
  return [...index.any, ...(index.keys.get(key) ?? [])];
};

/** Ambient prototype changes can turn a property store into an opaque setter call. */
export const semanticStoreMayReachAmbientSetter = (
  state: JavaScriptSemanticAnalysisState,
  key: string | null,
  store: SemanticBeforeStore,
): boolean => {
  if (key === null) return true;
  const candidates = ambientSetterCandidates(state, key);
  // Preserve the cheap absence gate before resolving captured receiver chains.
  if (candidates.length === 0) return false;
  const facts = state.ambientStorePrototypeFacts?.(store);
  if (key === "__proto__" && facts?.directNullPrototype === true) return false;
  return candidates.some(({ effect, prototype, unknownApplicability }) => {
    const applicable =
      ((facts === undefined || facts.unknownAncestors) &&
        unknownApplicability) ||
      facts?.prototypePaths.some(
        (path) =>
          prototype.length === path.length &&
          prototype.every((part, i) => part === null || part === path[i]),
      );
    if (!applicable) return false;
    const overlaps = (path: readonly (string | null)[], descendants: boolean) =>
      (descendants || effect.path.length <= path.length) &&
      effect.path.every((part, i) =>
        i >= path.length ? descendants : part === null || part === path[i],
      );
    return (
      (overlaps([...prototype, key], false) ||
        overlaps([...prototype, "__proto__"], true)) &&
      semanticEffectTimingAtStore(store, effect, state) !== "after"
    );
  });
};

/** Parsed receiver facts stay separate from mutation-dependent safety. */
export const semanticIntrinsicReceiverIsSafe = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const fact = state.intrinsicReceiverCalls.get(node);
  return (
    fact !== undefined &&
    !semanticAmbientPathMayHaveChanged(state, fact.readAt, fact.path)
  );
};

/** A native descriptor write does not expose its ordinary builtin target to user code. */
export const semanticNativeMutationTargetIsSafe = (
  node: t.Node,
  target: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const fact = state.intrinsicReceiverCalls.get(node);
  if (
    fact?.path.length !== 3 ||
    !["Object", "Reflect"].includes(fact.path[1] ?? "") ||
    !["defineProperty", "setPrototypeOf"].includes(fact.path[2] ?? "") ||
    !semanticIntrinsicReceiverIsSafe(node, state) ||
    (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) ||
    node.arguments[0] !== target
  )
    return false;
  if (
    fact.path[2] === "setPrototypeOf" &&
    state.ordinaryLocalIdentityAt?.(target) === true
  )
    return true;
  const identities = createAmbientPathResolver(state, false)(target).paths;
  const identity = identities[0];
  return (
    identities.length === 1 &&
    identity?.length === 3 &&
    identity[0] === "global" &&
    ["Object", "Array", "Function", "Map"].includes(identity[1] ?? "") &&
    identity[2] === "prototype" &&
    !semanticAmbientPathMayHaveChanged(state, target, identity)
  );
};

/** Undefined means a cyclic or conflicting projection can select any depth. */
type AmbientProjection = AmbientPath | undefined;

const joinAmbientProjection = (
  left: AmbientProjection,
  right: AmbientProjection,
): AmbientProjection =>
  left === undefined || right === undefined || left.length !== right.length
    ? undefined
    : left.map((key, index) => (key === right[index] ? key : null));

type AmbientIdentityUnknownReason =
  | "unresolved-value"
  | "widened-projection"
  | "unresolved-call"
  | "mixed-identities";
interface AmbientResolution {
  readonly paths: readonly AmbientPath[];
  readonly ownership: "local" | "ambient" | "unknown";
  readonly unknownReasons: readonly AmbientIdentityUnknownReason[];
  readonly nullPrototype: boolean;
  readonly directNullPrototype: boolean;
  readonly localPrototypes: readonly t.Node[];
}

interface AmbientPrototypeReplacement {
  readonly node: t.Node;
  readonly value: t.Node;
  readonly definiteOwner: boolean;
}

interface AmbientReferenceFacts {
  readonly stores: WeakMap<
    t.Node,
    Map<SemanticIterationSource, AmbientProjection>
  >;
  readonly prototypeTarget: (node: t.Node) => t.Node | undefined;
  readonly prototypeReplacements: WeakMap<
    t.Node,
    AmbientPrototypeReplacement[]
  >;
  readonly prototypeMutation: (node: t.Node) => boolean;
  readonly prototypeReady: (
    root: t.Node,
    mutation: t.Node,
    read: t.Node,
    native: boolean,
    store?: SemanticBeforeStore,
  ) => boolean;
  readonly freshObject: (node: t.Node) => boolean;
}

/**
 * Follow local object identities without equating shallow copies with their
 * sources. Writes select aliases at their capture; uncertain execution order
 * retains possible initializers. Intrinsic reads stay strict.
 */
export const createAmbientPathResolver = (
  state: JavaScriptSemanticAnalysisState,
  possibleWrites: boolean,
  facts?: AmbientReferenceFacts,
) => {
  const cached = new WeakMap<t.Node, AmbientResolution>();
  const returnedReferences = createSemanticReturnedReferences(state);
  return (
    node: t.Node,
    capture?: t.Node,
    escapedContents = false,
    projection: AmbientProjection = [],
    selection?: {
      readonly localIdentity?: (node: t.Node, path: AmbientProjection) => void;
      readonly prototypeReceiver?: boolean;
      readonly actualPrototype?: boolean;
      readonly beforeStore?: SemanticBeforeStore;
    },
  ): AmbientResolution => {
    const prior = possibleWrites ? undefined : cached.get(node);
    if (prior !== undefined) return prior;
    const result = new Map<string, AmbientPath>();
    let hasLocalIdentity = false;
    let nullPrototype = false;
    let traversedLocalPrototype = false;
    const localPrototypes = new Set<t.Node>();
    const unknownReasons = new Set<AmbientIdentityUnknownReason>();
    // The caller's write site selects initializers for the written target.
    // Reads reached through an initializer occur at their own position.
    const pending: {
      node: t.Node;
      suffix: AmbientProjection;
      readsAtSelf?: true;
      prototypeDepths?: readonly number[];
      prototypeReadAt?: t.Node;
    }[] = [
      {
        node,
        suffix: projection,
        ...(selection?.actualPrototype
          ? { prototypeDepths: [0], prototypeReadAt: capture ?? node }
          : {}),
      },
    ];
    // Join projections at their producing expression, rather than enumerating
    // alias histories. Each key can only widen to a wildcard, and conflicting
    // depths widen to unknown, so diamonds and cycles have finite state.
    const expanded = new WeakMap<t.Node, Map<string, AmbientProjection>>();
    let prototypeStates = 0;
    const retain = (path: AmbientPath) => {
      let canonical = canonicalAmbientPath(path);
      for (;;) {
        result.set(JSON.stringify(canonical), canonical);
        if (
          possibleWrites &&
          canonical[0] === "global" &&
          canonical[2] === "prototype" &&
          canonical[3] === "constructor"
        ) {
          canonical = ["global", canonical[1] ?? null, ...canonical.slice(4)];
          continue;
        }
        // An unknown key may select a global self reference as well as a
        // distinct property. Retain both possible object identities for writes.
        if (
          !possibleWrites ||
          canonical[0] !== "global" ||
          canonical[1] !== null
        )
          break;
        canonical = canonicalAmbientPath(["global", ...canonical.slice(2)]);
      }
    };
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      const queuedBefore = pending.length;
      const pathsBefore = result.size;
      let resolvedIdentity = false;
      try {
        const { root, members } = electronMemberPath(current.node);
        let suffix: AmbientProjection =
          current.suffix === undefined
            ? undefined
            : [...members, ...current.suffix];
        const prototypeDepths = (current.prototypeDepths ?? []).map(
          (depth) => depth + members.length,
        );
        const prototypeReadAt = members.includes("__proto__")
          ? current.node
          : current.prototypeReadAt;
        if (
          prototypeDepths.length > 0 &&
          ++prototypeStates > SEMANTIC_ALIAS_SELECTION_LIMIT
        ) {
          state.valueResourceLimits.add("alias-selections");
          retain(["global", null]);
          continue;
        }
        const selectionKey = JSON.stringify([
          prototypeDepths,
          prototypeReadAt?.start,
          prototypeReadAt?.end,
        ]);
        const bySelection =
          expanded.get(root) ?? new Map<string, AmbientProjection>();
        if (bySelection.has(selectionKey)) {
          const previous = bySelection.get(selectionKey);
          if (previous === undefined) {
            resolvedIdentity = true;
            continue;
          }
          if (suffix !== undefined && previous.length === suffix.length) {
            const joined: AmbientPath = previous.map((key, index) =>
              key === suffix?.[index] ? key : null,
            );
            if (joined.every((key, index) => key === previous[index])) {
              resolvedIdentity = true;
              continue;
            }
            suffix = joined;
          } else suffix = undefined;
          if (!possibleWrites) {
            const unresolved: AmbientResolution = {
              paths: [],
              ownership: "unknown",
              unknownReasons: ["widened-projection"],
              nullPrototype: false,
              directNullPrototype: false,
              localPrototypes: [],
            };
            cached.set(node, unresolved);
            return unresolved;
          }
        }
        bySelection.set(selectionKey, suffix);
        expanded.set(root, bySelection);
        if (suffix === undefined || suffix.includes(null))
          unknownReasons.add("widened-projection");
        // A widened projection is a possible write, never proof of an intrinsic.
        if (suffix === undefined && !possibleWrites) continue;
        const shiftPrototypeDepths = (path: AmbientProjection) =>
          path === undefined || suffix === undefined
            ? []
            : prototypeDepths
                .map((depth) => depth + path.length - suffix.length)
                .filter((depth) => depth >= 0);
        const continueWith = (
          node: t.Node,
          path: AmbientProjection = suffix,
          depths = shiftPrototypeDepths(path),
          readAt = prototypeReadAt,
        ) =>
          pending.push({
            node,
            suffix: path,
            ...(depths.length === 0 ? {} : { prototypeDepths: depths }),
            ...(readAt === undefined ? {} : { prototypeReadAt: readAt }),
            ...(current.readsAtSelf && { readsAtSelf: true }),
          });
        const continueReturned = (callee: t.Node, path: AmbientProjection) => {
          unknownReasons.add("unresolved-call");
          for (const source of returnedReferences(callee).references)
            continueWith(
              source.node,
              path === undefined
                ? undefined
                : [
                    ...source.projection.map((key) =>
                      key === null || typeof key === "object"
                        ? null
                        : String(key),
                    ),
                    ...path,
                  ],
            );
        };
        const ownProtoData =
          t.isObjectExpression(root) &&
          root.properties.some(
            (property) =>
              !t.isSpreadElement(property) &&
              semanticStaticPropertyKey(property.key, property.computed) ===
                "__proto__" &&
              !(
                t.isObjectProperty(property) &&
                !property.computed &&
                !property.shorthand
              ),
          );
        if (!t.isIdentifier(root) && facts?.freshObject(root)) {
          selection?.localIdentity?.(root, suffix);
          if (suffix?.length === 0) {
            if (!selection?.actualPrototype) hasLocalIdentity = true;
            resolvedIdentity = true;
          }
          for (const [source, path] of facts?.stores.get(root) ?? []) {
            const selected =
              suffix === undefined ||
              path === undefined ||
              path.every(
                (key, index) =>
                  index >= suffix.length ||
                  key === null ||
                  suffix[index] === null ||
                  key === suffix[index],
              );
            if (
              !selected ||
              (suffix !== undefined &&
                path !== undefined &&
                suffix.length < path.length &&
                !escapedContents)
            )
              continue;
            if (
              selection?.actualPrototype &&
              selection.beforeStore !== undefined &&
              semanticEffectTimingAtStore(
                selection.beforeStore,
                { node: source.mutation, assignedSources: [source] },
                state,
              ) === "after"
            )
              continue;
            if (
              selection?.actualPrototype &&
              path?.length === 1 &&
              path[0] === "__proto__" &&
              (ownProtoData ||
                (t.isNullLiteral(
                  state.nativeObjectCreationAt?.(root)?.prototype,
                ) &&
                  !(facts?.prototypeReplacements.get(root) ?? []).some(
                    (replacement) =>
                      source.target !== undefined &&
                      semanticEffectTimingAtStore(
                        { mutation: source.mutation, target: source.target },
                        { node: replacement.node },
                        state,
                      ) !== "after",
                  )))
            )
              continue;
            const remaining =
              suffix === undefined || path === undefined
                ? undefined
                : suffix.slice(path.length);
            pending.push({
              node: source.node,
              readsAtSelf: true,
              ...(prototypeReadAt === undefined ? {} : { prototypeReadAt }),
              prototypeDepths:
                suffix === undefined || path === undefined
                  ? []
                  : prototypeDepths
                      .map(
                        (depth) =>
                          depth + source.projection.length - path.length,
                      )
                      .filter((depth) => depth >= 0),
              suffix:
                remaining === undefined
                  ? undefined
                  : [
                      ...source.projection.map((key) =>
                        key === null || typeof key === "object"
                          ? null
                          : String(key),
                      ),
                      ...remaining,
                    ],
            });
          }
        }
        if (
          t.isMetaProperty(root) &&
          root.meta.name === "import" &&
          root.property.name === "meta"
        ) {
          retain(["import-meta", ...(suffix ?? [])]);
          resolvedIdentity = true;
          continue;
        }
        if (t.isIdentifier(root)) {
          // The wrapper module object is distinct from globalThis.module. Keep
          // its identity through the same alias/projection owner used for writes.
          if (isUnshadowedGlobal(root, state, "module")) {
            retain(["commonjs-module", ...(suffix ?? [])]);
            resolvedIdentity = true;
            continue;
          }
          if (globalObjectName(root, state) !== undefined) {
            retain(["global", ...(suffix ?? [])]);
            resolvedIdentity = true;
            continue;
          }
          if (isUnshadowedGlobal(root, state, root.name)) {
            retain(["global", root.name, ...(suffix ?? [])]);
            resolvedIdentity = true;
            continue;
          }
          const binding = resolveSemanticBindingState(state, root, root.name);
          if (binding === undefined) continue;
          const stable = possibleWrites
            ? undefined
            : semanticStableInitializer(binding, state);
          const readAt = current.readsAtSelf ? root : capture;
          const atRead =
            possibleWrites && readAt !== undefined
              ? semanticBindingAtRead(binding, readAt, state.parentsByNode)
              : undefined;
          const selected = atRead?.binding ?? binding;
          if (possibleWrites && atRead?.hasDefiniteInitializer === false)
            unknownReasons.add("unresolved-value");
          const initializers = possibleWrites
            ? [...selected.initializers, ...selected.referenceInitializers]
            : stable === undefined
              ? []
              : [stable];
          for (const initializer of initializers) {
            if (semanticReferenceSourcesInactive(initializer, state)) continue;
            // Pattern assignments share the source selection owner with member
            // effects: copying a container preserves its children, not itself.
            const path = semanticCopiedReferencePath(
              initializer,
              suffix ?? [null],
              escapedContents ? "escape" : "identity",
            );
            if (path === null) continue;
            pending.push({
              node: initializer.node,
              readsAtSelf: true,
              ...(prototypeReadAt === undefined ? {} : { prototypeReadAt }),
              prototypeDepths: shiftPrototypeDepths(
                suffix === undefined
                  ? undefined
                  : path.map((key) =>
                      key === null || typeof key === "object"
                        ? null
                        : String(key),
                    ),
              ),
              suffix:
                suffix === undefined ||
                semanticReferenceIterationUnknown(initializer, state)
                  ? undefined
                  : path.map((key) =>
                      key === null || typeof key === "object"
                        ? null
                        : String(key),
                    ),
            });
          }
          continue;
        }
        if (selection?.actualPrototype) {
          if (t.isNullLiteral(root) && suffix?.length === 0) {
            nullPrototype = true;
            resolvedIdentity = true;
            continue;
          }
          if (suffix?.length === 0 && facts?.freshObject(root)) {
            traversedLocalPrototype = true;
            localPrototypes.add(root);
            continueWith(root, ["__proto__"], [0]);
            continue;
          }
          if (
            suffix?.[0] === "__proto__" &&
            facts?.freshObject(root) &&
            !facts.prototypeReady(
              root,
              root,
              selection.beforeStore?.mutation ?? capture ?? current.node,
              true,
              selection.beforeStore,
            )
          ) {
            unknownReasons.add("unresolved-value");
            continue;
          }
        }
        const explicitPrototype = prototypeDepths.includes(0);
        const canSelectActualPrototype = explicitPrototype || !ownProtoData;
        let intrinsicReplacement = false;
        if (
          possibleWrites &&
          suffix?.[0] === "__proto__" &&
          canSelectActualPrototype
        ) {
          for (const replacement of facts?.prototypeReplacements.get(root) ??
            []) {
            if (
              !facts?.prototypeMutation(replacement.node) ||
              (selection?.beforeStore === undefined
                ? semanticEffectTiming(
                    prototypeReadAt ?? capture ?? current.node,
                    replacement.node,
                    state,
                  )
                : semanticEffectTimingAtStore(
                    selection.beforeStore,
                    { node: replacement.node },
                    state,
                  )) === "after"
            )
              continue;
            continueWith(replacement.value, suffix.slice(1));
            if (
              replacement.definiteOwner &&
              (facts.freshObject(replacement.value) ||
                t.isNullLiteral(replacement.value)) &&
              semanticDefiniteEffectPrecedesReference(
                replacement.node,
                prototypeReadAt ?? capture ?? current.node,
                state.parentsByNode,
              ) &&
              facts.prototypeReady(
                root,
                replacement.node,
                prototypeReadAt ?? capture ?? current.node,
                true,
              )
            )
              intrinsicReplacement = true;
          }
        }
        if (selection?.actualPrototype && intrinsicReplacement) continue;
        // Literal instances share native prototypes. A write to the instance's
        // own __proto__ slot changes only that instance; selecting or exposing
        // the prototype's contents can affect every instance of the builtin.
        if (
          possibleWrites &&
          suffix?.[0] === "__proto__" &&
          (escapedContents || selection?.prototypeReceiver || suffix.length > 1)
        ) {
          const declaredPrototype =
            selection?.actualPrototype && t.isObjectExpression(root)
              ? root.properties.find(
                  (property) =>
                    t.isObjectProperty(property) &&
                    !property.computed &&
                    !property.shorthand &&
                    semanticStaticPropertyKey(property.key, false) ===
                      "__proto__",
                )
              : undefined;
          const prototypeLiteral = t.isObjectProperty(declaredPrototype)
            ? readExactJavaScriptLiteral(declaredPrototype.value)
            : undefined;
          const explicitObjectPrototype =
            declaredPrototype !== undefined &&
            !(prototypeLiteral?.found && prototypeLiteral.value !== null);
          const builtin = explicitObjectPrototype
            ? undefined
            : t.isArrayExpression(root)
              ? "Array"
              : t.isObjectExpression(root) &&
                  root.properties.every((property) => {
                    if (t.isSpreadElement(property))
                      return prototypeDepths.includes(0);
                    const key = semanticStaticPropertyKey(
                      property.key,
                      property.computed,
                    );
                    const prototypeSetter =
                      t.isObjectProperty(property) &&
                      !property.computed &&
                      !property.shorthand &&
                      key === "__proto__";
                    if (prototypeSetter && t.isObjectProperty(property)) {
                      // Unknown values may be primitive: Annex B ignores them and
                      // leaves Object.prototype in place. Only a proven object or
                      // null can exclude that shared prototype.
                      const value = unwrapJavaScriptExpression(
                        property.value,
                      ).node;
                      return !(
                        t.isNullLiteral(value) ||
                        t.isObjectExpression(value) ||
                        t.isArrayExpression(value) ||
                        t.isFunction(value) ||
                        t.isClassExpression(value) ||
                        facts?.freshObject(value)
                      );
                    }
                    return (
                      prototypeDepths.includes(0) ||
                      (key !== null && key !== "__proto__")
                    );
                  })
                ? "Object"
                : t.isFunction(root) ||
                    (t.isClass(root) && root.superClass == null)
                  ? "Function"
                  : undefined;
          if (builtin !== undefined) {
            const replaced =
              intrinsicReplacement ||
              (!(explicitPrototype && ownProtoData) &&
                [...(facts?.stores.get(root) ?? [])].some(
                  ([source, path]) =>
                    path?.length === 1 &&
                    path[0] === "__proto__" &&
                    t.isAssignmentExpression(source.mutation, {
                      operator: "=",
                    }) &&
                    source.target !== undefined &&
                    facts?.freshObject(source.target.object) &&
                    (facts.freshObject(source.node) ||
                      t.isNullLiteral(source.node)) &&
                    semanticDefiniteEffectPrecedesReference(
                      source.mutation,
                      prototypeReadAt ?? capture ?? current.node,
                      state.parentsByNode,
                    ) &&
                    facts.prototypeReady(
                      root,
                      source.mutation,
                      prototypeReadAt ?? capture ?? current.node,
                      false,
                    ),
                ));
            if (!replaced)
              retain(["global", builtin, "prototype", ...suffix.slice(1)]);
            continue;
          }
        }
        if (
          possibleWrites &&
          t.isNewExpression(root) &&
          (suffix?.[0] === "__proto__" || suffix?.[0] === "constructor")
        ) {
          continueWith(
            root.callee,
            suffix[0] === "__proto__"
              ? ["prototype", ...suffix.slice(1)]
              : suffix.slice(1),
          );
          continue;
        }
        const creation = state.nativeObjectCreationAt?.(root);
        if (
          selection?.actualPrototype &&
          suffix?.[0] === "__proto__" &&
          creation !== undefined
        ) {
          pending.push({
            node: creation.prototype,
            suffix: suffix.slice(1),
            readsAtSelf: true,
            ...(prototypeReadAt === undefined ? {} : { prototypeReadAt }),
          });
          continue;
        }
        if (
          creation !== undefined &&
          suffix?.length === 0 &&
          facts?.freshObject(root)
        ) {
          resolvedIdentity = true;
          continue;
        }
        const prototypeTarget = possibleWrites
          ? facts?.prototypeTarget(root)
          : undefined;
        if (prototypeTarget !== undefined) {
          continueWith(
            prototypeTarget,
            suffix === undefined ? undefined : ["__proto__", ...suffix],
            suffix === undefined
              ? []
              : [0, ...prototypeDepths.map((depth) => depth + 1)],
            root,
          );
          continue;
        }
        if (
          possibleWrites &&
          (t.isCallExpression(root) ||
            t.isOptionalCallExpression(root) ||
            t.isNewExpression(root) ||
            t.isTaggedTemplateExpression(root) ||
            (escapedContents && (t.isFunction(root) || t.isClass(root))))
        ) {
          continueReturned(
            t.isFunction(root) || t.isClass(root)
              ? root
              : t.isTaggedTemplateExpression(root)
                ? root.tag
                : root.callee,
            suffix,
          );
          continue;
        }
        if (possibleWrites && t.isConditionalExpression(root)) {
          continueWith(root.consequent);
          continueWith(root.alternate);
          continue;
        }
        if (possibleWrites && t.isLogicalExpression(root)) {
          continueWith(root.left);
          continueWith(root.right);
          continue;
        }
        if (possibleWrites && t.isSequenceExpression(root)) {
          const value = root.expressions.at(-1);
          if (value !== undefined) continueWith(value);
          continue;
        }
        if (
          possibleWrites &&
          t.isAssignmentExpression(root) &&
          root.operator === "="
        ) {
          continueWith(root.right);
          continue;
        }
        const key = suffix?.[0];
        // Container escapes reuse the finite worklist, including alias cycles.
        if (escapedContents && suffix?.length === 0) {
          if (t.isObjectExpression(root)) {
            for (const property of root.properties)
              if (t.isSpreadElement(property))
                // A fresh copy exposes selected children, not its source container.
                continueWith(property.argument, [null]);
              else if (
                t.isObjectProperty(property) &&
                t.isExpression(property.value)
              )
                continueWith(property.value, []);
              else if (t.isObjectMethod(property) && property.kind === "get")
                continueReturned(property, []);
            continue;
          }
          if (t.isArrayExpression(root)) {
            for (const element of root.elements)
              if (t.isSpreadElement(element))
                continueWith(element.argument, []);
              else if (t.isExpression(element)) continueWith(element, []);
            continue;
          }
        }
        if (suffix !== undefined && key === undefined) continue;
        if (t.isObjectExpression(root)) {
          if (possibleWrites) {
            for (const property of root.properties) {
              if (t.isSpreadElement(property)) continueWith(property.argument);
              else if (
                (t.isObjectProperty(property) &&
                  t.isExpression(property.value)) ||
                (t.isObjectMethod(property) && property.kind === "get")
              ) {
                const ownKey = semanticStaticPropertyKey(
                  property.key,
                  property.computed,
                );
                if (
                  suffix === undefined ||
                  key === null ||
                  ownKey === null ||
                  ownKey === key
                )
                  if (t.isObjectMethod(property))
                    continueReturned(property, suffix?.slice(1));
                  else if (t.isExpression(property.value))
                    continueWith(property.value, suffix?.slice(1));
              }
            }
          } else if (
            suffix !== undefined &&
            key !== null &&
            root.properties.every(
              (property) =>
                t.isObjectProperty(property) &&
                semanticStaticPropertyKey(property.key, property.computed) !==
                  null,
            )
          ) {
            const property = root.properties.findLast(
              (property) =>
                t.isObjectProperty(property) &&
                semanticStaticPropertyKey(property.key, property.computed) ===
                  key,
            );
            if (t.isObjectProperty(property) && t.isExpression(property.value))
              continueWith(property.value, suffix.slice(1));
          }
        } else if (t.isArrayExpression(root)) {
          if (suffix === undefined) {
            for (const element of root.elements)
              if (t.isSpreadElement(element)) continueWith(element.argument);
              else if (t.isExpression(element)) continueWith(element);
          } else if (!root.elements.some(t.isSpreadElement)) {
            const index = Number(key);
            if (key === null && possibleWrites) {
              for (const element of root.elements)
                if (t.isExpression(element))
                  continueWith(element, suffix.slice(1));
            } else if (
              key !== null &&
              Number.isInteger(index) &&
              index >= 0 &&
              String(index) === key
            ) {
              const element = root.elements[index];
              if (t.isExpression(element))
                continueWith(element, suffix.slice(1));
            }
          }
        }
      } finally {
        if (
          !resolvedIdentity &&
          pending.length === queuedBefore &&
          result.size === pathsBefore
        )
          unknownReasons.add("unresolved-value");
      }
    }
    const paths = [...result.values()];
    if (paths.length > 0 && hasLocalIdentity)
      unknownReasons.add("mixed-identities");
    const resolution: AmbientResolution = {
      paths,
      ownership:
        unknownReasons.size > 0
          ? "unknown"
          : paths.length > 0
            ? "ambient"
            : hasLocalIdentity
              ? "local"
              : "unknown",
      unknownReasons: [...unknownReasons],
      nullPrototype,
      directNullPrototype:
        nullPrototype && !traversedLocalPrototype && paths.length === 0,
      localPrototypes: [...localPrototypes],
    };
    if (!possibleWrites) cached.set(node, resolution);
    return resolution;
  };
};

/**
 * Index source-local writes through ambient identities and stable aliases.
 * The shared invocation owner resolves intrinsic aliases, bind/call/apply and
 * literal argument spreads. Runtime reachability and arbitrary call effects
 * remain unevaluated; a visible possible write is sufficient.
 */
export function* indexJavaScriptAmbientWritesSteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  observeOpaqueInvocation?: (node: t.Node) => void,
  observeWriteSite?: (node: t.Node) => void,
): Generator<void> {
  const ambientReads = createAmbientPathResolver(state, false);
  const nativeReceiverCalls: {
    readonly node: t.Node;
    readonly receiver: t.Node;
  }[] = [];
  const storedSites = new WeakSet<t.Node>();
  const storedReferences: SemanticIterationSource[] = [];
  const writes: {
    node: t.Node;
    path: AmbientPath;
    storeTarget?: t.MemberExpression | t.OptionalMemberExpression;
  }[] = [];
  const targets: { node: t.Node; capture: t.Node }[] = [];
  const escapes: {
    node: t.Node;
    target: t.Node;
    browserReceiver: boolean;
    projection?: AmbientProjection;
  }[] = [];
  const stores = new WeakMap<
    t.Node,
    Map<SemanticIterationSource, AmbientProjection>
  >();
  const prototypeCalls: { node: t.Node; target: t.Node; value: t.Node }[] = [];
  const prototypeReplacements = new WeakMap<
    t.Node,
    AmbientPrototypeReplacement[]
  >();
  const exposures = new WeakMap<t.Node, t.Node[]>();
  const interop = createSemanticModuleInterop(state, {
    intrinsicPath: (node) => {
      const [path] = ambientReads(node).paths;
      return path?.[0] === "global" && path.every((key) => key !== null)
        ? ["intrinsic", ...(path.slice(1) as readonly string[])]
        : undefined;
    },
  });
  const prototypeMutation = (node: t.Node): boolean => {
    if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
      return false;
    const invocation = interop.intrinsicInvocation(node);
    return (
      invocation?.kind === "known" &&
      invocation.path.length === 3 &&
      ["Object", "Reflect"].includes(invocation.path[1] ?? "") &&
      invocation.path[2] === "setPrototypeOf"
    );
  };
  const prototypeReady = (
    root: t.Node,
    mutation: t.Node,
    read: t.Node,
    native: boolean,
    store?: SemanticBeforeStore,
  ): boolean => {
    if (
      state.opaqueEffects.byScope.size > 0 ||
      state.opaqueEffects.globalSites.length > 0
    )
      return false;
    if (
      !native &&
      ["Object", ...(t.isArrayExpression(root) ? ["Array"] : [])].some(
        (owner) =>
          semanticAmbientPathMayHaveChanged(state, mutation, [
            "global",
            owner,
            "prototype",
            "__proto__",
          ]),
      )
    )
      return false;
    return !(exposures.get(root) ?? []).some((site) => {
      if (prototypeMutation(site)) return false;
      let kind: "unknown" | "extensibility" = "unknown";
      if (t.isCallExpression(site) || t.isOptionalCallExpression(site)) {
        const call = interop.intrinsicInvocation(site);
        if (
          call?.kind === "known" &&
          call.path.length === 3 &&
          ["Object", "Reflect"].includes(call.path[1] ?? "")
        ) {
          if (
            ["getPrototypeOf", "isExtensible", "isFrozen", "isSealed"].includes(
              call.path[2] ?? "",
            )
          )
            return false;
          if (
            ["freeze", "seal", "preventExtensions"].includes(call.path[2] ?? "")
          )
            kind = "extensibility";
        }
      }
      return (
        (store === undefined
          ? semanticEffectTiming(read, site, state)
          : semanticEffectTimingAtStore(store, { node: site }, state)) !==
          "after" &&
        (kind === "unknown" ||
          semanticEffectTiming(mutation, site, state) !== "after")
      );
    });
  };
  state.nativeObjectCreationAt = (node) => {
    if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
      return undefined;
    const invocation = interop.intrinsicInvocation(node);
    if (
      invocation?.kind !== "known" ||
      invocation.path.length !== 3 ||
      invocation.path[1] !== "Object" ||
      invocation.path[2] !== "create" ||
      semanticAmbientPathMayHaveChanged(state, node.callee, [
        "global",
        "Object",
        "create",
      ])
    )
      return undefined;
    const prototype = invocation.arguments?.[0];
    let descriptors: t.Node | undefined = invocation.arguments?.[1];
    // Sequence operands still execute, but the final value owns the descriptors.
    while (t.isSequenceExpression(descriptors))
      descriptors = descriptors.expressions.at(-1);
    if (descriptors !== undefined)
      descriptors = unwrapJavaScriptExpression(descriptors).node;
    return t.isExpression(prototype)
      ? {
          prototype,
          ownPropertiesEmpty:
            invocation.arguments?.length === 1 ||
            (t.isObjectExpression(descriptors) &&
              descriptors.properties.length === 0),
        }
      : undefined;
  };
  const freshObject = (node: t.Node) =>
    interop.isFreshObject(node) ||
    state.nativeObjectCreationAt?.(node) !== undefined;
  const ambientWrites = createAmbientPathResolver(state, true, {
    stores,
    prototypeReplacements,
    prototypeMutation,
    prototypeReady,
    freshObject,
    prototypeTarget: (node) => {
      if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
        return undefined;
      const invocation = interop.intrinsicInvocation(node);
      if (
        invocation?.kind !== "known" ||
        invocation.path.length !== 3 ||
        !["Object", "Reflect"].includes(invocation.path[1] ?? "") ||
        invocation.path[2] !== "getPrototypeOf"
      )
        return undefined;
      const target = invocation.arguments?.[0];
      return t.isNode(target) && !t.isSpreadElement(target)
        ? target
        : undefined;
    },
  });
  state.ordinaryLocalIdentityAt = (node) =>
    ambientWrites(node, node).ownership === "local";
  yield* collectJavaScriptIdentityWritesSteps(
    program,
    (root, kind, writeSite) => {
      if (kind === "opaque-call") return [];
      observeWriteSite?.(writeSite);
      // Reassigning a local alias changes the binding, not the referenced object.
      if (kind === "binding")
        return t.isIdentifier(root) &&
          isUnshadowedGlobal(root, state, root.name)
          ? [["global", root.name]]
          : [];
      if (!storedSites.has(writeSite)) {
        storedSites.add(writeSite);
        for (const source of semanticIterationSources(
          writeSite,
          state.parentsByNode.get(writeSite) ?? null,
        )) {
          if (source.kind === "reference-store") storedReferences.push(source);
        }
      }
      // Resolve identities after the traversal has collected every local store.
      const id = targets.push({ node: root, capture: writeSite }) - 1;
      return [["pending-target", String(id)]];
    },
    interop.intrinsicInvocation,
    interop.staticString,
    interop.isFreshObject,
    (node, path, storeTarget) => {
      writes.push({
        node,
        path,
        ...(storeTarget === undefined ? {} : { storeTarget }),
      });
      const target =
        path[0] === "pending-target" ? targets[Number(path[1])] : undefined;
      if (target !== undefined)
        for (const identity of ambientReads(target.node).paths)
          if (identity[0] === "global")
            interop.retainWrite(node, [
              "intrinsic",
              ...identity.slice(1),
              ...path.slice(2),
            ]);
    },
    (node, invocation) => {
      observeOpaqueInvocation?.(node);
      if (
        invocation?.kind === "known" &&
        invocation.path.length === 3 &&
        ["Object", "Reflect"].includes(invocation.path[1] ?? "") &&
        invocation.path[2] === "setPrototypeOf"
      ) {
        const [target, value] = invocation.arguments ?? [];
        if (t.isExpression(target) && t.isExpression(value))
          prototypeCalls.push({ node, target, value });
      }
      // Escaping objects can change contents without replacing their identity.
      const retainEscape = (target: t.Node, browserReceiver = false) => {
        escapes.push({ target, node, browserReceiver });
      };
      for (const argument of t.isTaggedTemplateExpression(node)
        ? node.quasi.expressions
        : node.arguments)
        if (t.isNode(argument))
          retainEscape(
            t.isSpreadElement(argument) ? argument.argument : argument,
          );
      const callee = unwrapJavaScriptExpression(
        t.isTaggedTemplateExpression(node) ? node.tag : node.callee,
      ).node;
      const browserMethod =
        invocation?.kind === "known" &&
        invocation.path.length === 2 &&
        ["open", "fetch"].includes(invocation.path[1] ?? "")
          ? invocation.path[1]
          : undefined;
      const member =
        t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
          ? callee
          : undefined;
      const receiver = member?.object;
      const [namespace] =
        receiver === undefined ? [] : ambientReads(receiver).paths;
      const method =
        member === undefined
          ? null
          : semanticStaticPropertyKey(member.property, member.computed);
      const nativeNamespace =
        namespace?.length === 2 &&
        namespace[0] === "global" &&
        (namespace[1] === "Object" || namespace[1] === "Reflect")
          ? namespace[1]
          : undefined;
      const nativeReceiver =
        invocation?.kind === "known" &&
        nativeNamespace !== undefined &&
        method !== null &&
        NATIVE_NAMESPACE_METHODS[nativeNamespace].has(String(method));
      if (nativeReceiver && receiver !== undefined) {
        state.intrinsicReceiverCalls.set(node, {
          path: ["global", nativeNamespace!, String(method)],
          readAt: callee,
        });
        nativeReceiverCalls.push({ node, receiver });
      }
      if (
        !t.isNewExpression(node) &&
        (t.isMemberExpression(callee) ||
          t.isOptionalMemberExpression(callee)) &&
        !nativeReceiver
      ) {
        if (browserMethod !== undefined) {
          state.intrinsicReceiverCalls.set(node, {
            path: ["global", browserMethod],
            readAt: callee,
          });
          nativeReceiverCalls.push({ node, receiver: callee.object });
        }
        retainEscape(callee.object, browserMethod !== undefined);
      }
    },
  );
  const pendingStores = new Set(storedReferences);
  const dependents = new WeakMap<t.Node, Set<SemanticIterationSource>>();
  while (pendingStores.size > 0) {
    const source = pendingStores.values().next().value;
    if (source === undefined) break;
    pendingStores.delete(source);
    if (source.target === undefined) continue;
    const identities = new Map<t.Node, AmbientProjection>();
    ambientWrites(source.target, source.target.object, false, [], {
      localIdentity: (node, path) => {
        const users =
          dependents.get(node) ?? new Set<SemanticIterationSource>();
        users.add(source);
        dependents.set(node, users);
        identities.set(
          node,
          identities.has(node)
            ? joinAmbientProjection(identities.get(node), path)
            : path,
        );
      },
    });
    // Publish only completed queries; each source/root projection can only widen.
    for (const [node, path] of identities) {
      const entries =
        stores.get(node) ??
        new Map<SemanticIterationSource, AmbientProjection>();
      const previous = entries.get(source);
      const joined = entries.has(source)
        ? joinAmbientProjection(previous, path)
        : path;
      if (
        entries.has(source) &&
        (previous === undefined ||
          (joined !== undefined &&
            previous.every((key, index) => key === joined[index])))
      )
        continue;
      entries.set(source, joined);
      stores.set(node, entries);
      for (const dependent of dependents.get(node) ?? [])
        pendingStores.add(dependent);
    }
    yield;
  }
  if (
    prototypeCalls.length > 0 ||
    storedReferences.some(
      (source) =>
        source.target !== undefined &&
        semanticStaticPropertyKey(
          source.target.property,
          source.target.computed,
        ) === "__proto__",
    )
  ) {
    for (const exposure of escapes)
      ambientWrites(
        exposure.target,
        exposure.node,
        true,
        exposure.projection ?? [],
        {
          localIdentity: (root, path) => {
            if (path?.length !== 0) return;
            const sites = exposures.get(root) ?? [];
            sites.push(exposure.node);
            exposures.set(root, sites);
          },
        },
      );
    for (const call of prototypeCalls) {
      const roots = new Set<t.Node>();
      const ambient = ambientWrites(call.target, call.target, false, [], {
        localIdentity: (root, path) => {
          if (path?.length === 0) roots.add(root);
        },
      });
      const definiteOwner = roots.size === 1 && ambient.ownership === "local";
      for (const root of roots) {
        const values = prototypeReplacements.get(root) ?? [];
        values.push({ node: call.node, value: call.value, definiteOwner });
        prototypeReplacements.set(root, values);
      }
    }
  }
  for (const source of storedReferences) {
    if (source.target === undefined) continue;
    const receiver = ambientWrites(source.target.object, source.target.object);
    if (receiver.ownership !== "local") {
      state.escapingReferenceStores.add(source.target);
      escapes.push({
        node: source.mutation,
        target: source.node,
        browserReceiver: false,
        projection: source.projection.map((key) =>
          key === null || typeof key === "object" ? null : String(key),
        ),
      });
    }
  }
  for (const { node, path, storeTarget } of writes) {
    const target =
      path[0] === "pending-target" ? targets[Number(path[1])] : undefined;
    const paths =
      target === undefined
        ? [path]
        : ambientWrites(target.node, target.capture, false, [], {
            prototypeReceiver: true,
          }).paths.map((identity) => [...identity, ...path.slice(2)]);
    for (const resolved of paths) {
      retainSemanticAmbientEffect(state, "write", resolved, node, storeTarget);
    }
  }
  for (const { node, target, browserReceiver, projection } of escapes) {
    if (semanticNativeMutationTargetIsSafe(node, target, state)) continue;
    const resolved = ambientWrites(target, node, true, projection);
    if (
      browserReceiver &&
      resolved.ownership === "ambient" &&
      resolved.paths.length > 0 &&
      resolved.paths.every((path) => path.length === 1 && path[0] === "global")
    )
      state.retainedGlobalCallReceivers.add(target);
    for (const path of resolved.paths)
      // Only proven browser APIs keep their global receiver from user code.
      if (!(browserReceiver && path.length === 1 && path[0] === "global")) {
        retainSemanticAmbientEffect(state, "escape", path, node);
      }
  }
  state.inheritedMemberIdentityMayHaveChangedAt = (root, read) =>
    (prototypeReplacements.get(root) ?? []).some(
      (replacement) =>
        prototypeMutation(replacement.node) &&
        semanticEffectTiming(read, replacement.node, state) !== "after",
    ) ||
    [...(stores.get(root) ?? [])].some(
      ([source, path]) =>
        path?.length === 1 &&
        path[0] === "__proto__" &&
        semanticEffectTiming(read, source.mutation, state) !== "after",
    );
  state.ambientStorePrototypeFacts = (store) => {
    const resolved = ambientWrites(
      store.target.object,
      store.target.object,
      false,
      ["__proto__"],
      { actualPrototype: true, prototypeReceiver: true, beforeStore: store },
    );
    if (resolved.unknownReasons.length > 0) return undefined;
    const prototypePaths: AmbientPath[] = [];
    let unknownAncestors = false;
    for (const path of resolved.paths) {
      const owner = path[1];
      if (path.length !== 3 || path[0] !== "global" || path[2] !== "prototype")
        return undefined;
      prototypePaths.push(path);
      if (owner !== "Object" && owner !== "Array" && owner !== "Function")
        unknownAncestors = true;
      if (owner !== "Object") {
        if (
          [...state.ambientWriteEffects, ...state.ambientEscapeEffects].some(
            (effect) =>
              effect.path.length >= 4 &&
              effect.path[0] === "global" &&
              effect.path[1] === owner &&
              effect.path[2] === "prototype" &&
              (effect.path[3] === null || effect.path[3] === "__proto__") &&
              semanticEffectTimingAtStore(store, effect, state) !== "after",
          )
        )
          return undefined;
        if (!unknownAncestors)
          prototypePaths.push(["global", "Object", "prototype"]);
      }
    }
    return resolved.paths.length > 0 || resolved.nullPrototype
      ? {
          prototypePaths,
          unknownAncestors,
          directNullPrototype: resolved.directNullPrototype,
          localPrototypes: resolved.localPrototypes,
        }
      : undefined;
  };
  // A setter can rewrite any property of its receiver, not just the assigned
  // key. Publish that exposure before deciding whether a recognized native
  // method still keeps its receiver away from user code.
  for (const source of storedReferences) {
    const target = source.target;
    if (
      target === undefined ||
      !semanticStoreMayReachAmbientSetter(
        state,
        semanticStaticPropertyKey(target.property, target.computed),
        { mutation: source.mutation, target },
      )
    )
      continue;
    for (const identity of ambientWrites(target.object, source.mutation, false)
      .paths)
      retainSemanticAmbientEffect(state, "escape", identity, source.mutation);
  }
  for (const { node, receiver } of nativeReceiverCalls) {
    if (semanticIntrinsicReceiverIsSafe(node, state)) continue;
    for (const identity of ambientWrites(receiver, node, true).paths)
      retainSemanticAmbientEffect(state, "escape", identity, node);
  }
}

/**
 * Recognize an ambient property path, optionally through a global object, without a visible
 * source-local overwrite. This is a syntax-local identity fact, not proof that
 * the runtime's globals have never been patched by other code.
 */
export const isUnmodifiedGlobalReference = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
  name: string | readonly [string, ...string[]],
): boolean => {
  const path: readonly [string, ...string[]] =
    typeof name === "string" ? [name] : name;
  if (state.ambientWrites.covers(["global", ...path])) return false;
  const { root, members } = electronMemberPath(callee);
  const matches = (expected: readonly string[]) =>
    members.length === expected.length &&
    members.every((key, index) => key === expected[index]);
  if (isUnshadowedGlobal(root, state, path[0]) && matches(path.slice(1)))
    return true;
  const namespace = globalObjectName(root, state);
  return (
    namespace !== undefined &&
    matches(path) &&
    !state.ambientWrites.covers(["global", namespace])
  );
};

/** A module URL base is known only while its property has no visible write. */
export const isUnmodifiedImportMetaUrl = (
  node: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  isImportMetaUrl(node) && !state.ambientWrites.covers(["import-meta", "url"]);
