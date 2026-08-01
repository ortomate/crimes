import ts from "typescript";
import {
  calleeLabel,
  calleeTail,
  endLineOf,
  hasRestParameter,
  isExported,
  isFunctionLike,
  parameterNames,
  propertyPath,
  soleReturnedExpression,
  startLineOf,
  unwrap,
} from "./ast-util.js";
import type { PassThroughFunction } from "./types.js";

/**
 * Pass-through-function extraction — the parser half of
 * `pass_through_abstraction`.
 *
 * A pass-through is a function whose entire body is one call to another
 * function, forwarding its arguments unchanged. In isolation that is
 * often correct: it is how a façade, a port, and a compatibility shim are
 * all spelled. The crime is not one wrapper — it is four of them in a
 * row, so that finding out what `updateUser` actually does means opening
 * five files and discovering that the answer was `db.users.update` all
 * along.
 *
 * The collector therefore records the *edge* (`wrapper → target`) and
 * everything the wrapper adds on top. The chain-building — and the
 * decision that a chain is long enough to matter — happens in `core`,
 * where the cross-file view exists.
 */

const MAX_PASSTHROUGH_PER_FILE = 60;

/**
 * Argument forwarding fidelity.
 *
 * - `identical` — same names, same order, same count. Nothing was
 *   decided here.
 * - `reordered` — same set of names, different order. Still no
 *   transformation, but a reader cannot skim past it.
 * - `partial` — a subset was forwarded, or an extra literal was added.
 *   Something *was* decided; the detector treats this as weaker evidence.
 */
export function collectPassThroughFunction(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: PassThroughFunction[],
): void {
  if (out.length >= MAX_PASSTHROUGH_PER_FILE) return;
  if (!isFunctionLike(node)) return;

  const name = declaredName(node);
  if (name === undefined) return;

  const returned = soleReturnedExpression(node);
  if (returned === undefined) return;

  // `async wrapper() { return await inner(); }` forwards just the same.
  const inner = unwrap(returned);
  const call = ts.isAwaitExpression(inner)
    ? asCall(unwrap(inner.expression))
    : asCall(inner);
  if (call === undefined) return;

  const target = calleeLabel(call);
  const targetTail = calleeTail(call);
  if (target === undefined || targetTail === undefined) return;
  // A self-call is recursion, not indirection.
  if (targetTail === name && !target.includes(".")) return;

  const forwarding = classifyForwarding(node, call);
  if (forwarding === undefined) return;

  const adds = describeAdditions(node, call, returned);

  out.push({
    name,
    line: startLineOf(node, sourceFile),
    endLine: endLineOf(node, sourceFile),
    exported: isExportedFunction(node),
    target,
    targetTail,
    forwarding,
    adds,
    ...(memberReceiver(call) !== undefined ? { viaMember: memberReceiver(call) } : {}),
    ...(targetTail === name ? { sameName: true } : {}),
  });
}

function asCall(expr: ts.Expression): ts.CallExpression | undefined {
  return ts.isCallExpression(expr) ? expr : undefined;
}

/**
 * Compare the wrapper's parameters with the call's arguments.
 *
 * Returns `undefined` when the call's arguments bear no relation to the
 * parameters — that is a function that happens to be one line long, not a
 * pass-through.
 */
function classifyForwarding(
  node: ts.SignatureDeclaration,
  call: ts.CallExpression,
): PassThroughFunction["forwarding"] | undefined {
  const params = parameterNames(node);

  // `(...args) => inner(...args)` — the purest form.
  if (hasRestParameter(node)) {
    const spreadsAll = call.arguments.every((a) => ts.isSpreadElement(a));
    if (spreadsAll && call.arguments.length > 0) return "identical";
  }

  // A zero-argument wrapper around a zero-argument call is a pass-through
  // only if it is genuinely delegating, which we cannot distinguish from
  // a constant factory. Require at least one parameter.
  if (params.length === 0) return undefined;

  const argNames: Array<string | undefined> = call.arguments.map((arg) => {
    const expr = unwrap(arg as ts.Expression);
    if (ts.isSpreadElement(expr)) {
      const inner = unwrap(expr.expression);
      return ts.isIdentifier(inner) ? inner.text : undefined;
    }
    return ts.isIdentifier(expr) ? expr.text : undefined;
  });

  const forwarded = argNames.filter(
    (n): n is string => n !== undefined && params.includes(n),
  );
  // Nothing from the signature reached the call: not a pass-through.
  if (forwarded.length === 0) return undefined;

  const named = params.filter((p): p is string => p !== undefined);
  const sameCount = argNames.length === params.length;
  const allForwarded = forwarded.length === named.length && named.length > 0;

  if (sameCount && allForwarded) {
    const inOrder = named.every((p, i) => argNames[i] === p);
    return inOrder ? "identical" : "reordered";
  }
  return "partial";
}

/**
 * Everything the wrapper contributes beyond forwarding. An empty list is
 * the finding; a non-empty one is the defence.
 *
 * Recognised contributions: a type assertion or narrowing cast, a
 * transformed argument, a default value, and the `await` that turns a
 * promise into a value (which is not nothing — it changes the caller's
 * error handling).
 */
function describeAdditions(
  node: ts.SignatureDeclaration,
  call: ts.CallExpression,
  returned: ts.Expression,
): string[] {
  const adds: string[] = [];

  if (ts.isAwaitExpression(returned)) adds.push("awaits the result");

  for (const param of node.parameters) {
    if (param.initializer) {
      adds.push("supplies a default parameter value");
      break;
    }
  }

  for (const arg of call.arguments) {
    const expr = arg as ts.Expression;
    if (ts.isSpreadElement(expr)) continue;
    const inner = unwrap(expr);
    if (ts.isIdentifier(inner)) continue;
    if (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner)) {
      adds.push("reshapes an argument");
      continue;
    }
    if (ts.isStringLiteral(inner) || ts.isNumericLiteral(inner)) {
      adds.push("binds a constant argument");
      continue;
    }
    adds.push("computes an argument");
  }

  // `as` / `satisfies` on the returned expression is a real narrowing.
  if (ts.isAsExpression(returned) || ts.isSatisfiesExpression(returned)) {
    adds.push("narrows the return type");
  }

  return [...new Set(adds)].sort();
}

/** Receiver of a member call: `this.repo.save(…)` → `this.repo`. */
function memberReceiver(call: ts.CallExpression): string | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  return propertyPath(call.expression.expression);
}

function declaredName(node: ts.SignatureDeclaration): string | undefined {
  const named = node as { name?: ts.Node };
  if (named.name && ts.isIdentifier(named.name)) return named.name.text;
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return undefined;
}

function isExportedFunction(node: ts.SignatureDeclaration): boolean {
  if (isExported(node)) return true;
  // `export const wrap = (x) => inner(x)` — modifier is on the statement.
  const declaration = node.parent;
  if (!declaration || !ts.isVariableDeclaration(declaration)) return false;
  const list = declaration.parent;
  if (!list || !ts.isVariableDeclarationList(list)) return false;
  const statement = list.parent;
  if (!statement || !ts.isVariableStatement(statement)) return false;
  return isExported(statement);
}
