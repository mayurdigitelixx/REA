import { buildBinary, type PlistValue } from "plist";

/** Translate Foundation XML UID references to the binary writer's UID objects. */
export const buildBinaryKeyedArchive = (value: PlistValue): Uint8Array => {
  const convert = (node: PlistValue): PlistValue => {
    if (Array.isArray(node)) return node.map(convert);
    if (
      node === null ||
      typeof node !== "object" ||
      node instanceof Date ||
      node instanceof Uint8Array
    )
      return node;
    if (Object.keys(node).length === 1 && typeof node["CF$UID"] === "number")
      return { UID: node["CF$UID"] };
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => [key, convert(child)]),
    );
  };
  return buildBinary(convert(value));
};
