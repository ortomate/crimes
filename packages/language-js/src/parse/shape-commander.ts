import ts from "typescript";
import { COMMANDER_REGISTRAR_NAME_RE } from "./constants.js";

export function isCommanderRegistrarName(name: string): boolean {
  return COMMANDER_REGISTRAR_NAME_RE.test(name);
}

/**
 * True when `node`'s body contains an expression of the form
 * `<param>.command(...).…` — the Commander builder chain. Walks the
 * direct body statements rather than the whole tree so unrelated
 * `something.command(...)` calls elsewhere don't trip the heuristic.
 */
export function bodyContainsCommanderChain(node: ts.Node): boolean {
  let body: ts.Node | undefined;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  ) {
    body = node.body;
  } else if (ts.isArrowFunction(node)) {
    body = node.body;
  }
  if (!body) return false;

  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      if (ts.isExpressionStatement(stmt) && chainIncludesCommandCall(stmt.expression)) {
        return true;
      }
      if (
        ts.isReturnStatement(stmt) &&
        stmt.expression &&
        chainIncludesCommandCall(stmt.expression)
      ) {
        return true;
      }
    }
    return false;
  }
  // ConciseBody: an arrow's expression-bodied form.
  return chainIncludesCommandCall(body as ts.Expression);
}

/**
 * Walk a method-call chain (`a.b().c().d()`) and return true if any
 * step in the chain is a `.command(...)` call. We don't enforce that
 * the chain root is literally an identifier named `program` — repos
 * sometimes alias it (`cmd`, `cli`), and the `.command(...)` step plus
 * the registrar function name is conservative enough.
 */
function chainIncludesCommandCall(expr: ts.Expression): boolean {
  let cursor: ts.Expression = expr;
  while (ts.isCallExpression(cursor)) {
    const callee = cursor.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.name) &&
      callee.name.text === "command"
    ) {
      return true;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      cursor = callee.expression;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * True when the function is an argument to a `.action(...)` call that
 * sits on a Commander builder chain (i.e. the chain contains a
 * `.command(...)` step somewhere upstream). The receiver may be any
 * identifier — see {@link chainIncludesCommandCall}.
 */
export function isCommanderActionCallbackArg(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  let isArgument = false;
  for (const arg of parent.arguments) {
    if (arg === node) {
      isArgument = true;
      break;
    }
  }
  if (!isArgument) return false;
  const callee = parent.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.name) ||
    callee.name.text !== "action"
  ) {
    return false;
  }
  // The receiver of `.action(...)` should itself be a `.command(...)`
  // chain head — i.e. somewhere up the chain we hit a `.command(...)`
  // call.
  return chainIncludesCommandCall(callee.expression);
}
