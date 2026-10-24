import { jsonTextCodeUnits } from "../jsonSerialization.js";
import type { JsonValue } from "../jsonValue.js";
import { same, type JsonObject } from "./environmentStateRules.js";
import { storedKinds } from "./environmentStateWriteApply.js";
import type { explainUpdate } from "./environmentStateWriteExplain.js";
import type {
  FieldRule,
  StateWritePlan,
  WriteBody,
} from "./environmentStateWriteRules.js";
import { integerOf, slugOf } from "./environmentStateWriteValues.js";

/** Whether a rule changes its field on calls that do not send it: serving applies it to every call that could. */
export const unsentChange = (rule: FieldRule): boolean =>
  rule.rule === "increment" ||
  rule.rule === "slug" ||
  rule.rule === "stamp" ||
  rule.rule === "derived" ||
  rule.rule === "set";

/** Whether serving gives a rule's field a new value on every call, so no call may have kept it. */
export const regenerates = (rule: FieldRule): boolean =>
  rule.rule === "unique" ||
  rule.rule === "renewed" ||
  rule.rule === "nested-clock";

/** The fields a call showed as they were before it. */
export const keptFields = (before: JsonObject, after: JsonObject): string[] =>
  Object.keys(after).filter(
    (field) =>
      Object.hasOwn(before, field) && same(before[field], after[field]),
  );

/** Whether a plan's rules give a recorded call another value than it showed, or one of them regenerates a field the call kept. */
export const disagreesWithCall = (
  rules: readonly FieldRule[],
  call: {
    readonly written: JsonObject;
    readonly after: JsonObject;
    readonly kept: readonly string[];
  },
): boolean =>
  rules.some(
    (rule) =>
      (unsentChange(rule) &&
        Object.hasOwn(call.after, rule.field) &&
        !same(call.written[rule.field], call.after[rule.field])) ||
      (regenerates(rule) && call.kept.includes(rule.field)),
  );

/** The fields a call found already at the value a set rule gives them: the action sets them rather than toggling them. */
export const steadyFields = (
  rules: readonly FieldRule[],
  before: JsonObject,
  after: JsonObject,
): string[] =>
  rules.flatMap((rule) =>
    rule.rule === "set" &&
    same(before[rule.field], rule.value) &&
    same(after[rule.field], rule.value)
      ? [rule.field]
      : [],
  );

/** A call's scalar members by name, as much of it as later rules are checked against. */
export const scalars = (object: JsonObject): Map<string, JsonValue> =>
  new Map(
    Object.entries(object).filter(
      ([, value]) => value === null || typeof value !== "object",
    ),
  );

/** The scalar values a modelled update call showed and sent, and the fields it kept, which later rules must reproduce. */
export interface UpdateCall {
  readonly shown: ReadonlyMap<string, JsonValue>;
  readonly sent: ReadonlyMap<string, JsonValue>;
  readonly kept: readonly string[];
}

/** Whether a rule a later call showed gives an earlier call a value other than the one it showed for a field it did not send. */
export const contradictsEarlierCalls = (
  draft: {
    readonly plan: { readonly rules: readonly FieldRule[] };
    readonly updates: readonly UpdateCall[];
  },
  rules: readonly FieldRule[],
): boolean => {
  const ruled = new Set(draft.plan.rules.map((rule) => rule.field));
  return rules.some(
    (rule) =>
      (unsentChange(rule) || regenerates(rule) || rule.rule === "clock") &&
      !ruled.has(rule.field) &&
      draft.updates.some(({ shown, sent, kept }) => {
        if (regenerates(rule)) return kept.includes(rule.field);
        // An unruled field an earlier call showed is one it left as it was.
        const value = shown.get(rule.field);
        if (value === undefined) return false;
        if (rule.rule === "increment") return integerOf(value) !== undefined;
        if (rule.rule === "set") return !same(value, rule.value);
        // Serving stamps a clock on every call, so a field an earlier call kept contradicts it.
        if (rule.rule === "clock") return true;
        if (rule.rule === "stamp") return !same(value, rule.value);
        if (rule.rule === "derived")
          return sent.has(rule.member) && !same(value, rule.value);
        const from = rule.rule === "slug" ? sent.get(rule.from) : undefined;
        return typeof from === "string" && slugOf(from) !== value;
      }),
  );
};

/** A plan's body with the members and fixed values a later call's body adds, and the JSON types it stored those members as when the observation shows none. */
export const refinedBody = (
  body: WriteBody,
  later: WriteBody,
  values: { readonly observed: JsonObject; readonly stored: JsonObject },
): WriteBody => {
  const fixed = new Set(body.fixed.map((entry) => entry.member));
  const accepted = later.accepted.filter(
    (member) => !body.accepted.includes(member),
  );
  return {
    ...body,
    // A later call may be the first to show the body repeating the path's id.
    identity: body.identity ?? later.identity,
    accepted: [...body.accepted, ...accepted],
    fixed: [
      ...body.fixed,
      ...later.fixed.filter((entry) => !fixed.has(entry.member)),
    ],
    // Serving reads member types from the observation, which may not show a member a later call stored.
    kinds: [
      ...body.kinds,
      ...storedKinds(accepted, values.observed, values.stored),
    ],
  };
};

/** Whether a later call explains a member or field otherwise than the plan: echoed by one and stored as something else by the other, or ruled differently. */
export const conflictsWithPlan = (
  plan: Pick<StateWritePlan, "body" | "rules">,
  explained: ReturnType<typeof explainUpdate>,
): boolean => {
  const body = plan.body!;
  const fixed = new Map(body.fixed.map((entry) => [entry.member, entry.sent]));
  const rules = new Map(plan.rules.map((rule) => [rule.field, rule]));
  const { identity } = explained.body;
  // Serving checks a call's identity member before its fixed values, so a member both cannot take every recorded call.
  return (
    explained.body.accepted.some((member) => fixed.has(member)) ||
    explained.body.fixed.some(
      (entry) =>
        body.accepted.includes(entry.member) ||
        entry.member === body.identity ||
        (fixed.has(entry.member) && !same(fixed.get(entry.member), entry.sent)),
    ) ||
    (identity !== null && fixed.has(identity)) ||
    explained.rules.some((rule) => {
      const held = rules.get(rule.field);
      return held !== undefined && !same(held, rule);
    })
  );
};

/** A modelled update's result: a later read that also shows an unmodelled change checks only the members it sent. */
export const appliedUpdate = (
  plan: Pick<StateWritePlan, "body" | "rules">,
  at: {
    readonly targets: string[];
    readonly target: {
      readonly type: string;
      readonly collection: string;
      readonly id: string;
    };
  },
  before: JsonObject,
  call: { readonly written: JsonObject; readonly body: JsonObject },
) => {
  const { written, body } = call;
  const sent = Object.keys(body).filter(
    (member) => member !== plan.body?.identity,
  );
  const derived = Object.keys(written).filter(
    (field) =>
      !Object.hasOwn(before, field) || !same(written[field], before[field]),
  );
  const changed = {
    fields: [...new Set([...sent, ...derived])],
    accumulated: plan.rules.flatMap((rule) =>
      rule.rule === "increment" ? [rule.field] : [],
    ),
  };
  return {
    kind: "applied" as const,
    targets: at.targets,
    entity: at.target,
    fields: sent,
    changed,
  };
};

/** Keep what a modelled update call showed, which later calls' rules must reproduce, and the fields it found already set. */
export const rememberCall = (
  retain: (bytes: number) => void,
  draft: {
    readonly plan: { readonly rules: readonly FieldRule[] };
    readonly updates: UpdateCall[];
    readonly steady: Set<string>;
    readonly unstamped: Set<string>;
  },
  call: {
    readonly before: JsonObject;
    readonly after: JsonObject;
    readonly sent: JsonObject;
    readonly kept: readonly string[];
  },
  /** Clocks the call left as they were in its own second, which show neither a stamp nor a kept value. */
  sameSecond: readonly string[],
): void => {
  const unstamped = new Set(sameSecond);
  for (const field of unstamped) draft.unstamped.add(field);
  const kept = call.kept.filter((field) => !unstamped.has(field));
  const shown = scalars(call.after);
  for (const field of unstamped) shown.delete(field);
  const facts = { shown, sent: scalars(call.sent), kept };
  retain(64 + jsonTextCodeUnits([...facts.shown, ...facts.sent, kept]) * 2);
  draft.updates.push(facts);
  for (const field of steadyFields(draft.plan.rules, call.before, call.after))
    draft.steady.add(field);
};
