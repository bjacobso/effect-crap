import { Effect } from "effect";
import { parseSync, type Node } from "oxc-parser";
import {
  children,
  isFunction,
  positionAt,
  propertyName,
  unwrap,
  type FunctionNode,
} from "./ast.js";
import { resolveBindings } from "./bindings.js";
import { AnalysisError, type FunctionKind, type FunctionUnit } from "./model.js";

function complexity(node: FunctionNode): number {
  let count = 1;
  const visit = (current: Node): void => {
    if (
      isFunction(current) ||
      current.type === "ClassDeclaration" ||
      current.type === "ClassExpression"
    )
      return;
    switch (current.type) {
      case "IfStatement":
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "WhileStatement":
      case "DoWhileStatement":
      case "CatchClause":
      case "ConditionalExpression":
      case "LogicalExpression":
      case "AssignmentPattern":
        count++;
        break;
      case "SwitchCase":
        if (current.test) count++;
        break;
      case "AssignmentExpression":
        if (["&&=", "||=", "??="].includes(current.operator)) count++;
        break;
      case "MemberExpression":
      case "CallExpression":
        if (current.optional) count++;
        break;
    }
    // Types don't contribute control flow. TS expression wrappers still do.
    if (current.type.startsWith("TS")) {
      const expression = unwrap(current);
      if (expression !== current) visit(expression);
      else if (current.type === "TSParameterProperty") visit(current.parameter);
      return;
    }
    for (const child of children(current)) visit(child);
  };
  for (const param of node.params) visit(param);
  if (node.body) visit(node.body);
  return count;
}

function expectsBranches(node: FunctionNode): boolean {
  const visit = (current: Node): boolean => {
    if (
      isFunction(current) ||
      current.type === "ClassDeclaration" ||
      current.type === "ClassExpression"
    )
      return false;
    if (
      [
        "IfStatement",
        "ConditionalExpression",
        "SwitchStatement",
        "LogicalExpression",
        "AssignmentPattern",
      ].includes(current.type)
    )
      return true;
    if (current.type === "AssignmentExpression" && ["&&=", "||=", "??="].includes(current.operator))
      return true;
    if (
      (current.type === "MemberExpression" || current.type === "CallExpression") &&
      current.optional
    )
      return true;
    return children(current).some(visit);
  };
  return node.params.some(visit) || (node.body ? visit(node.body) : false);
}

function classify(
  node: FunctionNode,
  parent: Node | undefined,
  resolve: ReturnType<typeof resolveBindings>,
): FunctionKind {
  if (parent?.type !== "CallExpression") return "function";
  const index = parent.arguments.findIndex((argument) => unwrap(argument) === node);
  const callee = unwrap(parent.callee);
  const binding = resolve(callee);
  if (binding === "gen" && node.generator && index === parent.arguments.length - 1)
    return "effect.gen";
  if ((binding === "fn" || binding === "fnUntraced") && index === 0) return `effect.${binding}`;
  if (
    callee.type === "CallExpression" &&
    resolve(callee.callee) === "fn" &&
    index === 0 &&
    callee.arguments.length === 1 &&
    callee.arguments[0]?.type === "Literal" &&
    typeof callee.arguments[0].value === "string"
  )
    return "effect.fn";
  return "function";
}

function assignedName(node: Node, parents: WeakMap<Node, Node>): string | undefined {
  const parent = parents.get(node);
  if (!parent) return undefined;
  if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier")
    return parent.id.name;
  if (
    (parent.type === "Property" ||
      parent.type === "MethodDefinition" ||
      parent.type === "PropertyDefinition") &&
    parent.value === node
  ) {
    const key = propertyName(parent.key);
    const container = parents.get(parent);
    const owner = container?.type === "ClassBody" ? parents.get(container) : container;
    const ownerName =
      owner &&
      (owner.type === "ClassDeclaration" || owner.type === "ClassExpression"
        ? owner.id?.name
        : assignedName(owner, parents));
    const accessor =
      "kind" in parent && (parent.kind === "get" || parent.kind === "set")
        ? `${parent.kind} ${key}`
        : key;
    return [ownerName, accessor].filter(Boolean).join(".") || undefined;
  }
  if (parent.type === "AssignmentExpression" && parent.right === node) {
    if (parent.left.type === "Identifier") return parent.left.name;
    if (parent.left.type === "MemberExpression") return propertyName(parent.left.property);
  }
  if (parent.type === "ExportDefaultDeclaration") return "default";
  if (
    unwrap(parent) === node ||
    (parent.type === "CallExpression" &&
      parent.callee.type === "MemberExpression" &&
      parent.callee.property.type === "Identifier" &&
      parent.callee.property.name === "pipe")
  )
    return assignedName(parent, parents);
  if (
    parent.type === "MemberExpression" &&
    parent.object === node &&
    propertyName(parent.property) === "pipe"
  )
    return assignedName(parent, parents);
  return undefined;
}

export function parseSource(
  file: string,
  source: string,
): Effect.Effect<FunctionUnit[], AnalysisError> {
  return Effect.try({
    try: () => {
      const parsed = parseSync(file, source, { showSemanticErrors: true });
      if (parsed.errors.length)
        throw new Error(parsed.errors.map((error) => error.message).join("; "));
      const parents = new WeakMap<Node, Node>();
      const functions: FunctionNode[] = [];
      const visit = (node: Node): void => {
        if (isFunction(node) && node.body) functions.push(node);
        for (const child of children(node)) {
          parents.set(child, node);
          visit(child);
        }
      };
      visit(parsed.program);
      const resolve = resolveBindings(parsed.program);
      const position = positionAt(source);
      const names = new WeakMap<Node, string>();
      return functions.map((node) => {
        let parent = parents.get(node);
        while (parent && unwrap(parent) === node) parent = parents.get(parent);
        const kind = classify(node, parent, resolve);
        const start = position(node.start);
        let name = node.id?.name ?? assignedName(node, parents);
        if (kind !== "function" && parent) name ??= assignedName(parent, parents);
        if (!name) {
          let ancestor = parents.get(node);
          while (ancestor && !names.has(ancestor)) ancestor = parents.get(ancestor);
          const prefix = ancestor ? `${names.get(ancestor)}::` : "";
          name = `${prefix}${kind === "function" ? "callback" : kind}@${start.line}:${start.column}`;
        }
        names.set(node, name);
        const body = node.body!;
        const expectsStatements =
          body.type !== "BlockStatement" ||
          body.body.some(
            (statement) =>
              ![
                "TSInterfaceDeclaration",
                "TSTypeAliasDeclaration",
                "FunctionDeclaration",
                "EmptyStatement",
              ].includes(statement.type),
          );
        return {
          name,
          kind,
          range: { start, end: position(node.end) },
          body: { start: position(body.start), end: position(body.end) },
          complexity: complexity(node),
          expectsStatements,
          expectsBranches: expectsBranches(node),
        };
      });
    },
    catch: (cause) =>
      new AnalysisError({
        message: `Unable to parse ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
}
