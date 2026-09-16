import { visitorKeys, type ArrowFunctionExpression, type Function, type Node } from "oxc-parser";
import type { Position } from "./model.js";

export type FunctionNode = Function | ArrowFunctionExpression;

export function isFunction(node: Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

export function children(node: Node): Node[] {
  const record = node as unknown as Record<string, unknown>;
  return (visitorKeys[node.type] ?? []).flatMap((key) => {
    const value = record[key];
    return (Array.isArray(value) ? value : [value]).filter(
      (child): child is Node => child !== null && typeof child === "object" && "type" in child,
    );
  });
}

export function unwrap(node: Node): Node {
  switch (node.type) {
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TSTypeAssertion":
    case "TSInstantiationExpression":
    case "ChainExpression":
      return unwrap(node.expression);
    default:
      return node;
  }
}

export function propertyName(node: Node): string | undefined {
  if (node.type === "Identifier" || node.type === "PrivateIdentifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  return undefined;
}

/** Oxc's Node binding and Istanbul both use UTF-16 columns. */
export function positionAt(source: string): (offset: number) => Position {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\r" && source[i + 1] === "\n") i++;
    if (char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029")
      starts.push(i + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle]! <= offset) low = middle;
      else high = middle;
    }
    return { line: low + 1, column: offset - starts[low]! };
  };
}
