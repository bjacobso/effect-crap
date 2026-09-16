import type * as Oxc from "oxc-parser";
import * as Ast from "./ast.js";

type Binding = "effect" | "namespace" | "gen" | "fn" | "fnUntraced" | "local";
interface Scope {
  parent?: Scope;
  functionScope: boolean;
  bindings: Map<string, Binding>;
}

function bindPattern(node: Oxc.Node, scope: Scope): void {
  switch (node.type) {
    case "Identifier":
      scope.bindings.set(node.name, "local");
      break;
    case "AssignmentPattern":
      bindPattern(node.left, scope);
      break;
    case "RestElement":
      bindPattern(node.argument, scope);
      break;
    case "TSParameterProperty":
      bindPattern(node.parameter, scope);
      break;
    case "ObjectPattern":
      for (const property of node.properties)
        bindPattern(property.type === "RestElement" ? property.argument : property.value, scope);
      break;
    case "ArrayPattern":
      for (const element of node.elements) if (element) bindPattern(element, scope);
      break;
  }
}

function importBinding(source: string, imported: string): Binding {
  if (source === "effect" && imported === "Effect") return "effect";
  if (
    source === "effect/Effect" &&
    (imported === "gen" || imported === "fn" || imported === "fnUntraced")
  )
    return imported;
  return "local";
}

/** Two passes allow later declarations (including hoisted var) to shadow imports. */
export function resolveBindings(program: Oxc.Node): (node: Oxc.Node) => Binding | undefined {
  const scopes = new WeakMap<Oxc.Node, Scope>();
  const root: Scope = { bindings: new Map(), functionScope: true };
  const visit = (node: Oxc.Node, outer: Scope): void => {
    if (
      node.type === "TSEnumDeclaration" ||
      node.type === "TSModuleDeclaration" ||
      node.type === "TSImportEqualsDeclaration"
    ) {
      if (node.id.type === "Identifier") bindPattern(node.id, outer);
    }
    if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id)
      bindPattern(node.id, outer);
    const createsScope =
      Ast.isFunction(node) ||
      [
        "BlockStatement",
        "CatchClause",
        "ForStatement",
        "ForOfStatement",
        "ForInStatement",
        "SwitchStatement",
        "ClassExpression",
        "ClassDeclaration",
        "StaticBlock",
        "TSModuleBlock",
      ].includes(node.type);
    const scope = createsScope
      ? {
          parent: outer,
          bindings: new Map<string, Binding>(),
          functionScope: Ast.isFunction(node) || node.type === "StaticBlock",
        }
      : outer;
    scopes.set(node, scope);

    if (Ast.isFunction(node)) {
      if (node.id) bindPattern(node.id, scope);
      for (const param of node.params) bindPattern(param, scope);
    }
    if ((node.type === "ClassDeclaration" || node.type === "ClassExpression") && node.id)
      bindPattern(node.id, scope);
    if (node.type === "CatchClause" && node.param) bindPattern(node.param, scope);
    if (node.type === "VariableDeclaration") {
      let target = scope;
      if (node.kind === "var")
        while (!target.functionScope && target.parent) target = target.parent;
      for (const declaration of node.declarations) bindPattern(declaration.id, target);
    }
    if (node.type === "ImportDeclaration" && node.importKind !== "type") {
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") continue;
        let binding: Binding = "local";
        if (specifier.type === "ImportNamespaceSpecifier") {
          binding =
            node.source.value === "effect"
              ? "namespace"
              : node.source.value === "effect/Effect"
                ? "effect"
                : "local";
        } else if (specifier.type === "ImportSpecifier") {
          binding = importBinding(node.source.value, Ast.propertyName(specifier.imported) ?? "");
        }
        scope.bindings.set(specifier.local.name, binding);
      }
    }
    for (const child of Ast.children(node)) visit(child, scope);
  };
  visit(program, root);

  const resolve = (input: Oxc.Node): Binding | undefined => {
    const node = Ast.unwrap(input);
    if (node.type === "Identifier") {
      let scope = scopes.get(node);
      while (scope) {
        if (scope.bindings.has(node.name)) return scope.bindings.get(node.name);
        scope = scope.parent;
      }
    }
    if (node.type === "MemberExpression") {
      if (node.computed && node.property.type !== "Literal") return undefined;
      const name = Ast.propertyName(node.property);
      const object = resolve(node.object);
      if (object === "namespace" && name === "Effect") return "effect";
      if (object === "effect" && (name === "gen" || name === "fn" || name === "fnUntraced"))
        return name;
    }
    return undefined;
  };
  return resolve;
}
