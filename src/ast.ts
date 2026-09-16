import type * as Oxc from "oxc-parser";
import type * as Model from "./model.js";

export type FunctionNode = Oxc.Function | Oxc.ArrowFunctionExpression;

export function isFunction(node: Oxc.Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

export function children(node: Oxc.Node): Oxc.Node[] {
  // Only visit AST children; positions, comments and parent pointers are metadata.
  return Object.entries(node).flatMap(([key, value]) => {
    if (["parent", "loc", "range", "comments", "tokens"].includes(key)) return [];
    return (Array.isArray(value) ? value : [value]).filter(
      (child): child is Oxc.Node => child !== null && typeof child === "object" && "type" in child,
    );
  });
}

export function unwrap(node: Oxc.Node): Oxc.Node {
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

export function propertyName(node: Oxc.Node): string | undefined {
  if (node.type === "Identifier" || node.type === "PrivateIdentifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  return undefined;
}

/** Parser adapters and Istanbul both use UTF-16 columns. */
export function positionAt(source: string): (offset: number) => Model.Position {
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
