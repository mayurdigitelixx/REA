import * as t from "@babel/types";

/** Simple stores convert their RHS only when the captured target is integer-indexed. */
export const semanticIntegerIndexedStoreSource = (
  node: t.Node,
):
  | { readonly target: t.MemberExpression; readonly node: t.Node }
  | undefined =>
  t.isAssignmentExpression(node, { operator: "=" }) &&
  t.isMemberExpression(node.left)
    ? { target: node.left, node: node.right }
    : undefined;

/** Operands exposed to user-defined primitive conversion by language operations. */
export const semanticCoercionOperands = (
  node: t.Node,
  isObject: (operand: t.Node) => boolean = () => false,
  integerIndexedStore: (target: t.MemberExpression) => boolean = () => false,
): readonly t.Node[] => {
  if (t.isBinaryExpression(node)) {
    if (["===", "!=="].includes(node.operator)) return [];
    if (node.operator === "instanceof") return [node.left, node.right];
    if (
      ["==", "!="].includes(node.operator) &&
      ((t.isThisExpression(node.left) && t.isThisExpression(node.right)) ||
        (isObject(node.left) && isObject(node.right)))
    )
      return [];
    return node.operator === "in" ? [node.left] : [node.left, node.right];
  }
  if (t.isUnaryExpression(node) && ["+", "-", "~"].includes(node.operator))
    return [node.argument];
  if (t.isUpdateExpression(node)) return [node.argument];
  // Integer-indexed exotic stores convert the assigned value to Number or
  // BigInt even though ordinary simple assignment has no primitive conversion.
  const store = semanticIntegerIndexedStoreSource(node);
  if (store !== undefined && integerIndexedStore(store.target))
    return [store.node];
  if (
    t.isAssignmentExpression(node) &&
    !["=", "&&=", "||=", "??="].includes(node.operator)
  )
    return [node.left, node.right];
  if (
    (t.isMemberExpression(node) ||
      t.isOptionalMemberExpression(node) ||
      t.isObjectProperty(node) ||
      t.isObjectMethod(node) ||
      t.isClassProperty(node) ||
      t.isClassMethod(node) ||
      t.isClassAccessorProperty(node)) &&
    node.computed
  )
    return [
      t.isMemberExpression(node) || t.isOptionalMemberExpression(node)
        ? node.property
        : node.key,
    ];
  return [];
};
