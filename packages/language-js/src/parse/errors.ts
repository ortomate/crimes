import ts from "typescript";
import {
  calleeLabel,
  calleeName,
  calleeTail,
  condenseSource,
  endLineOf,
  isFunctionLike,
  nearestEnclosingFunction,
  pathTail,
  propertyPath,
  startLineOf,
  unwrap,
} from "./ast-util.js";
import type {
  ErrorHandler,
  ErrorHandlerBody,
  ErrorHandlerKind,
  ParsedFunction,
} from "./types.js";

/**
 * Error-handling extraction — the parser half of `swallowed_error`.
 *
 * The collector describes *what a handler does with a failure*; it never
 * decides whether that is acceptable. The detector applies policy. This
 * split matters because "acceptable" depends on the surrounding repo —
 * a project with a `Result<T, E>` convention swallows nothing when it
 * returns `{ ok: false }`, and a parser that hard-coded "returning a
 * value is bad" would be wrong there.
 *
 * Three shapes are captured:
 *
 *  - `catch_clause` — `try { … } catch (e) { … }`
 *  - `promise_catch` — `p.catch(handler)`, including `.then(ok, err)`
 *  - `fire_and_forget` — a promise whose rejection path is explicitly
 *    discarded: `void p.catch(() => {})`, `p.catch(noop)`
 *
 * For each, the *protected operation* is recorded verbatim (condensed) so
 * a finding can say what was at risk, not merely that a catch was empty.
 */

/** Cap per file — a big adapter can legitimately hold many handlers. */
const MAX_HANDLERS_PER_FILE = 60;

/**
 * Callee tails that mean "this failure was recorded somewhere a human
 * will see". Deliberately library-agnostic: `logger.error`, `log.warn`,
 * `Sentry.captureException`, `telemetry.recordException`, and a bare
 * `console.error` all count.
 */
const REPORTING_METHODS: ReadonlySet<string> = new Set([
  "log",
  "info",
  "warn",
  "warning",
  "error",
  "debug",
  "trace",
  "fatal",
  "critical",
  "exception",
  "captureexception",
  "captureerror",
  "capturemessage",
  "recordexception",
  "reporterror",
  "report",
  "notify",
  "track",
  "addbreadcrumb",
  "setstatus",
  "emiterror",
]);

/**
 * Property names whose read means the handler is *inspecting* the error
 * rather than discarding it. `e.code === "ENOENT"` is a deliberate,
 * narrow recovery; `return null` is not.
 */
const DISCRIMINATOR_PROPERTIES: ReadonlySet<string> = new Set([
  "code",
  "status",
  "statuscode",
  "name",
  "type",
  "kind",
  "errno",
  "response",
  "cause",
]);

/**
 * Names that mean "the author explicitly wanted this failure ignored".
 * A handler that calls one of these is doing something on purpose.
 */
const INTENTIONAL_NOOP_NAMES: ReadonlySet<string> = new Set([
  "noop",
  "ignore",
  "swallow",
  "silence",
  "voidfn",
]);

export function collectErrorHandler(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
  out: ErrorHandler[],
): void {
  if (out.length >= MAX_HANDLERS_PER_FILE) return;

  if (ts.isTryStatement(node)) {
    collectTry(node, sourceFile, functions, out);
    return;
  }

  if (ts.isCallExpression(node)) {
    collectPromiseHandler(node, sourceFile, functions, out);
  }
}

function collectTry(
  node: ts.TryStatement,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
  out: ErrorHandler[],
): void {
  const clause = node.catchClause;
  if (!clause) return;

  const binding =
    clause.variableDeclaration && ts.isIdentifier(clause.variableDeclaration.name)
      ? clause.variableDeclaration.name.text
      : undefined;

  const body = describeBlock(clause.block, binding, sourceFile);
  const protectedCalls = collectCallNames(node.tryBlock);

  push(out, {
    kind: "catch_clause",
    line: startLineOf(clause, sourceFile),
    endLine: endLineOf(clause, sourceFile),
    protectedOperation: describeProtectedBlock(node.tryBlock, sourceFile),
    protectedCalls,
    body,
    ...(binding !== undefined ? { errorBinding: binding } : {}),
    ...enclosingName(node, sourceFile, functions),
    ...(body.comment !== undefined ? { comment: body.comment } : {}),
  });
}

/**
 * `p.catch(handler)` and `p.then(onFulfilled, onRejected)`.
 *
 * `fire_and_forget` is distinguished from `promise_catch` by whether the
 * result is used: a `.catch()` whose value feeds an assignment or a
 * `return` is part of the data flow, while one sitting alone as an
 * expression statement (or behind `void`) discards the outcome entirely.
 */
function collectPromiseHandler(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
  out: ErrorHandler[],
): void {
  const tail = calleeTail(node);
  if (tail === undefined) return;

  let handler: ts.Expression | undefined;
  if (tail === "catch") {
    handler = node.arguments[0];
  } else if (tail === "then" && node.arguments.length >= 2) {
    handler = node.arguments[1];
  } else {
    return;
  }
  if (!handler) return;

  // The receiver of `.catch` is the protected operation.
  const receiver = ts.isPropertyAccessExpression(node.expression)
    ? node.expression.expression
    : undefined;
  if (!receiver) return;

  const resolved = unwrap(handler);
  const binding = handlerBinding(resolved);
  const body = describeHandlerExpression(resolved, binding, sourceFile);
  const kind: ErrorHandlerKind = isDiscardedExpression(node)
    ? "fire_and_forget"
    : "promise_catch";

  push(out, {
    kind,
    line: startLineOf(node, sourceFile),
    endLine: endLineOf(node, sourceFile),
    protectedOperation: condenseSource(receiver, sourceFile),
    protectedCalls: collectCallNames(receiver),
    body,
    ...(binding !== undefined ? { errorBinding: binding } : {}),
    ...enclosingName(node, sourceFile, functions),
    ...(body.comment !== undefined ? { comment: body.comment } : {}),
  });
}

function push(out: ErrorHandler[], handler: ErrorHandler): void {
  if (out.length >= MAX_HANDLERS_PER_FILE) return;
  out.push(handler);
}

function enclosingName(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
): { enclosing?: string } {
  const fn = nearestEnclosingFunction(node, sourceFile, functions);
  return fn?.name !== undefined ? { enclosing: fn.name } : {};
}

function handlerBinding(handler: ts.Expression): string | undefined {
  if (!isFunctionLike(handler)) return undefined;
  const first = handler.parameters[0];
  if (!first) return undefined;
  return ts.isIdentifier(first.name) ? first.name.text : undefined;
}

/**
 * Is this call's value thrown away? True when it is the whole of an
 * expression statement, or wrapped in `void`.
 */
function isDiscardedExpression(node: ts.CallExpression): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isExpressionStatement(parent)) return true;
  // `void p.catch(…)` — the explicit "I am discarding this" spelling.
  if (ts.isVoidExpression(parent)) return true;
  return false;
}

function describeHandlerExpression(
  handler: ts.Expression,
  binding: string | undefined,
  sourceFile: ts.SourceFile,
): ErrorHandlerBody {
  // `.catch(noop)` / `.catch(logger.error)` — a bare reference.
  if (!isFunctionLike(handler)) {
    const path = propertyPath(handler);
    const tail = path ? pathTail(path).toLowerCase() : undefined;
    const intentionalNoop = tail !== undefined && INTENTIONAL_NOOP_NAMES.has(tail);
    const reports = tail !== undefined && REPORTING_METHODS.has(tail);
    return {
      empty: intentionalNoop,
      commentOnly: false,
      rethrows: false,
      reportsError: reports,
      reportsWithoutError: false,
      typedResult: false,
      discriminates: false,
      statements: intentionalNoop || reports ? 1 : 0,
      ...(intentionalNoop ? { intentionalNoop: true } : {}),
    };
  }

  const body = (handler as { body?: ts.Node }).body;
  if (body && ts.isBlock(body)) {
    return describeBlock(body, binding, sourceFile);
  }
  if (body) {
    // Concise arrow: `(e) => null`, `() => []`, `(e) => log(e)`.
    return describeConciseBody(body as ts.Expression, binding, sourceFile);
  }
  return emptyBody();
}

function describeConciseBody(
  expr: ts.Expression,
  binding: string | undefined,
  sourceFile: ts.SourceFile,
): ErrorHandlerBody {
  const result = emptyBody();
  result.statements = 1;

  const target = unwrap(expr);
  const fallback = blandValue(target);
  if (fallback !== undefined) {
    result.fallback = fallback;
    return result;
  }
  if (isTypedResultShape(target)) {
    result.typedResult = true;
    return result;
  }
  if (ts.isCallExpression(target)) {
    scoreCall(target, binding, result);
    return result;
  }
  void sourceFile;
  return result;
}

function describeBlock(
  block: ts.Block,
  binding: string | undefined,
  sourceFile: ts.SourceFile,
): ErrorHandlerBody {
  const result = emptyBody();
  const statements = block.statements.filter((s) => !ts.isEmptyStatement(s));
  result.statements = statements.length;

  const comment = leadingComment(block, sourceFile);
  if (comment !== undefined) result.comment = comment;

  if (statements.length === 0) {
    result.empty = true;
    if (comment !== undefined) {
      result.empty = false;
      result.commentOnly = true;
    }
    return result;
  }

  for (const statement of statements) {
    inspectStatement(statement, binding, result);
  }
  return result;
}

function inspectStatement(
  statement: ts.Statement,
  binding: string | undefined,
  result: ErrorHandlerBody,
): void {
  if (ts.isThrowStatement(statement)) {
    result.rethrows = true;
    return;
  }

  if (ts.isIfStatement(statement)) {
    if (referencesDiscriminator(statement.expression, binding)) {
      result.discriminates = true;
    }
    // A guard that rethrows in one branch still propagates.
    forEachStatement(statement.thenStatement, (s) => inspectStatement(s, binding, result));
    if (statement.elseStatement) {
      forEachStatement(statement.elseStatement, (s) => inspectStatement(s, binding, result));
    }
    return;
  }

  if (ts.isSwitchStatement(statement)) {
    if (referencesDiscriminator(statement.expression, binding)) {
      result.discriminates = true;
    }
    for (const clause of statement.caseBlock.clauses) {
      for (const s of clause.statements) inspectStatement(s, binding, result);
    }
    return;
  }

  if (ts.isReturnStatement(statement)) {
    const expr = statement.expression ? unwrap(statement.expression) : undefined;
    if (expr === undefined) {
      result.fallback = "undefined (bare return)";
      return;
    }
    if (isRejectedPromise(expr)) {
      result.rethrows = true;
      return;
    }
    if (isTypedResultShape(expr)) {
      result.typedResult = true;
      return;
    }
    const bland = blandValue(expr);
    if (bland !== undefined) result.fallback = bland;
    return;
  }

  if (ts.isExpressionStatement(statement)) {
    const expr = unwrap(statement.expression);
    if (ts.isCallExpression(expr)) scoreCall(expr, binding, result);
    if (ts.isAwaitExpression(expr)) {
      const inner = unwrap(expr.expression);
      if (ts.isCallExpression(inner)) scoreCall(inner, binding, result);
    }
    return;
  }

  if (ts.isVariableStatement(statement)) {
    for (const decl of statement.declarationList.declarations) {
      if (!decl.initializer) continue;
      const init = unwrap(decl.initializer);
      if (ts.isCallExpression(init)) scoreCall(init, binding, result);
    }
  }
}

function forEachStatement(node: ts.Statement, fn: (s: ts.Statement) => void): void {
  if (ts.isBlock(node)) {
    for (const s of node.statements) fn(s);
    return;
  }
  fn(node);
}

/**
 * Classify a call inside a handler: is it reporting the failure, and did
 * the error itself make it into the report?
 *
 * A `logger.error("failed to save")` that never passes `e` loses the
 * stack trace, the cause chain, and the error code. It reads as handled
 * and debugs like an empty catch, so it is tracked separately rather than
 * counted as observability.
 */
function scoreCall(
  call: ts.CallExpression,
  binding: string | undefined,
  result: ErrorHandlerBody,
): void {
  const tail = calleeTail(call)?.toLowerCase();
  if (tail === undefined) return;

  if (INTENTIONAL_NOOP_NAMES.has(tail)) {
    result.intentionalNoop = true;
    return;
  }
  if (!REPORTING_METHODS.has(tail)) return;

  if (binding !== undefined && argumentsReference(call, binding)) {
    result.reportsError = true;
  } else if (binding === undefined) {
    // No binding to pass (`catch {}` with optional catch binding). The
    // call is still observability; it just cannot carry the error.
    result.reportsWithoutError = true;
  } else {
    result.reportsWithoutError = true;
  }
}

/** Does any argument mention the error binding, at any depth? */
function argumentsReference(call: ts.CallExpression, binding: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === binding) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const arg of call.arguments) visit(arg);
  return found;
}

/** `e instanceof X`, `e.code === …`, `isFooError(e)`. */
function referencesDiscriminator(
  expr: ts.Expression,
  binding: string | undefined,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
      found = true;
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const rootOk =
        binding === undefined || propertyPath(node)?.startsWith(`${binding}.`) === true;
      if (rootOk && DISCRIMINATOR_PROPERTIES.has(node.name.text.toLowerCase())) {
        found = true;
        return;
      }
    }
    if (ts.isCallExpression(node)) {
      const tail = calleeTail(node);
      if (tail !== undefined && /^is[A-Z]/.test(tail)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return found;
}

/**
 * A value that carries no information about the failure: `null`,
 * `undefined`, `false`, `0`, `""`, `[]`, `{}`.
 *
 * Returns the rendered value for evidence, or `undefined` when the
 * expression carries something more substantial.
 */
function blandValue(expr: ts.Expression): string | undefined {
  if (expr.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (ts.isIdentifier(expr) && expr.text === "undefined") return "undefined";
  if (ts.isNumericLiteral(expr) && expr.text === "0") return "0";
  if (
    (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) &&
    expr.text === ""
  ) {
    return '""';
  }
  if (ts.isArrayLiteralExpression(expr) && expr.elements.length === 0) return "[]";
  if (ts.isObjectLiteralExpression(expr) && expr.properties.length === 0) return "{}";
  return undefined;
}

/**
 * `{ ok: false, error: e }` / `{ success: false, … }` / `Err(e)` — the
 * result-type convention. A handler that converts a throw into a typed,
 * discriminable value has not swallowed anything.
 */
function isTypedResultShape(expr: ts.Expression): boolean {
  if (ts.isObjectLiteralExpression(expr)) {
    const keys = new Set<string>();
    for (const prop of expr.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        keys.add(prop.name.text.toLowerCase());
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        keys.add(prop.name.text.toLowerCase());
      }
    }
    const hasDiscriminant =
      keys.has("ok") || keys.has("success") || keys.has("status") || keys.has("type");
    const carriesError = keys.has("error") || keys.has("err") || keys.has("reason") || keys.has("cause");
    // Both halves required: `{ ok: false }` alone is a bland fallback
    // wearing a discriminant, and `{ error: e }` alone cannot be matched
    // against a success shape.
    return hasDiscriminant && carriesError;
  }
  if (ts.isCallExpression(expr)) {
    const tail = calleeTail(expr);
    if (tail === undefined) return false;
    return /^(Err|Error|failure|Failure|err)$/.test(tail) && expr.arguments.length > 0;
  }
  return false;
}

/** `Promise.reject(...)` — propagation by another name. */
function isRejectedPromise(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false;
  return calleeName(expr) === "Promise.reject";
}

/**
 * Comment text inside an otherwise-empty block. Read from the raw source
 * between the braces rather than via `getFullText` on a child, because an
 * empty block has no children to hang trivia off.
 */
function leadingComment(block: ts.Block, sourceFile: ts.SourceFile): string | undefined {
  const text = sourceFile.text.slice(block.getStart(sourceFile) + 1, block.getEnd() - 1);
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const allComments = lines.every(
    (l) => l.startsWith("//") || l.startsWith("/*") || l.startsWith("*") || l.endsWith("*/"),
  );
  if (!allComments) return undefined;
  const condensed = lines
    .map((l) => l.replace(/^\/\*+|^\/\/+|^\*+|\*+\/$/g, "").trim())
    .filter((l) => l.length > 0)
    .join(" ");
  return condensed.length > 120 ? `${condensed.slice(0, 119)}…` : condensed;
}

/** Condensed rendering of what the `try` block was protecting. */
function describeProtectedBlock(block: ts.Block, sourceFile: ts.SourceFile): string {
  const first = block.statements[0];
  if (!first) return "(empty try block)";
  const rendered = condenseSource(first, sourceFile, 100);
  return block.statements.length > 1
    ? `${rendered} (+${block.statements.length - 1} more statement(s))`
    : rendered;
}

/**
 * Callee names invoked anywhere inside the protected region, deduplicated
 * and capped. The detector matches these against its boundary catalogue
 * to decide how consequential a swallowed failure is.
 */
function collectCallNames(node: ts.Node): string[] {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (names.size >= 24) return;
    if (ts.isCallExpression(n)) {
      const callee = calleeLabel(n);
      if (callee !== undefined) names.add(callee);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return [...names];
}

function emptyBody(): ErrorHandlerBody {
  return {
    empty: false,
    commentOnly: false,
    rethrows: false,
    reportsError: false,
    reportsWithoutError: false,
    typedResult: false,
    discriminates: false,
    statements: 0,
  };
}
