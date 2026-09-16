import * as Model from "./model.js";
import * as Bindings from "./bindings.js";
import * as Ast from "./ast.js";
import * as Effect from "effect/Effect";
import type * as Oxc from "oxc-parser";
import * as SourceParser from "./sourceParser.js";

function complexity(node: Ast.FunctionNode): number {
  let count = 1;
  const visit = (current: Oxc.Node): void => {
    if (
      Ast.isFunction(current) ||
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
      const expression = Ast.unwrap(current);
      if (expression !== current) visit(expression);
      else if (current.type === "TSParameterProperty") visit(current.parameter);
      return;
    }
    for (const child of Ast.children(current)) visit(child);
  };
  for (const param of node.params) visit(param);
  if (node.body) visit(node.body);
  return count;
}

function expectsBranches(node: Ast.FunctionNode): boolean {
  const visit = (current: Oxc.Node): boolean => {
    if (
      Ast.isFunction(current) ||
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
    return Ast.children(current).some(visit);
  };
  return node.params.some(visit) || (node.body ? visit(node.body) : false);
}

function classify(
  node: Ast.FunctionNode,
  parent: Oxc.Node | undefined,
  resolve: ReturnType<typeof Bindings.resolveBindings>,
): Model.FunctionKind {
  if (parent?.type !== "CallExpression") return "function";
  const index = parent.arguments.findIndex((argument) => Ast.unwrap(argument) === node);
  const callee = Ast.unwrap(parent.callee);
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

function assignedName(node: Oxc.Node, parents: WeakMap<Oxc.Node, Oxc.Node>): string | undefined {
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
    const key = Ast.propertyName(parent.key);
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
    if (parent.left.type === "MemberExpression") return Ast.propertyName(parent.left.property);
  }
  if (parent.type === "ExportDefaultDeclaration") return "default";
  if (
    Ast.unwrap(parent) === node ||
    (parent.type === "CallExpression" &&
      parent.callee.type === "MemberExpression" &&
      parent.callee.property.type === "Identifier" &&
      parent.callee.property.name === "pipe")
  )
    return assignedName(parent, parents);
  if (
    parent.type === "MemberExpression" &&
    parent.object === node &&
    Ast.propertyName(parent.property) === "pipe"
  )
    return assignedName(parent, parents);
  return undefined;
}

function callbackName(node: Ast.FunctionNode, parent: Oxc.Node | undefined): string {
  if (parent?.type !== "CallExpression") return "callback";
  const callee = Ast.unwrap(parent.callee);
  const argument = parent.arguments.findIndex((arg) => Ast.unwrap(arg) === node) + 1;
  let label: string | undefined;
  let method: string | undefined;
  if (callee.type === "Identifier") label = method = callee.name;
  if (
    callee.type === "MemberExpression" &&
    (!callee.computed || callee.property.type === "Literal")
  ) {
    method = Ast.propertyName(callee.property);
    label = callee.object.type === "Identifier" ? `${callee.object.name}.${method}` : method;
  }
  if (!label) return `callback[arg${argument}]`;
  if (method && ["handle", "group", "fn", "catchTag"].includes(method)) {
    const tag = parent.arguments.find(
      (arg) => arg.type === "Literal" && typeof arg.value === "string" && arg.value.length <= 80,
    );
    if (tag?.type === "Literal") label += `(${JSON.stringify(tag.value)})`;
  }
  return `${label}[arg${argument}]`;
}

export function parseSource(
  file: string,
  source: string,
): Effect.Effect<Model.FunctionUnit[], Model.AnalysisError, SourceParser.SourceParser> {
  return Effect.gen(function* () {
    const parser = yield* SourceParser.SourceParser;
    const program = yield* parser.parse(file, source);
    return yield* Effect.try({
      try: () => {
        const parents = new WeakMap<Oxc.Node, Oxc.Node>();
        const functions: Ast.FunctionNode[] = [];
        const visit = (node: Oxc.Node): void => {
          if (Ast.isFunction(node) && node.body) functions.push(node);
          for (const child of Ast.children(node)) {
            parents.set(child, node);
            visit(child);
          }
        };
        visit(program);
        const resolve = Bindings.resolveBindings(program);
        const position = Ast.positionAt(source);
        const names = new WeakMap<Oxc.Node, string>();
        return functions.map((node) => {
          let parent = parents.get(node);
          while (parent && Ast.unwrap(parent) === node) parent = parents.get(parent);
          const kind = classify(node, parent, resolve);
          const start = position(node.start);
          let name = node.id?.name ?? assignedName(node, parents);
          if (kind !== "function" && parent) name ??= assignedName(parent, parents);
          if (!name) {
            let ancestor = parents.get(node);
            while (ancestor && !names.has(ancestor)) ancestor = parents.get(ancestor);
            const prefix = ancestor ? `${names.get(ancestor)}::` : "";
            name = `${prefix}${kind === "function" ? callbackName(node, parent) : kind}@${start.line}:${start.column}`;
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
            expressionBody: body.type !== "BlockStatement",
          };
        });
      },
      catch: (cause) =>
        new Model.AnalysisError({
          message: `Unable to parse ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });
  });
}
