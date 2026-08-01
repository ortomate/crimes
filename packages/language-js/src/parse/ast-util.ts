import ts from "typescript";
import type { EnclosingFunction, ParsedFunction } from "./types.js";

/**
 * AST helpers shared by the 0.16.0 collectors.
 *
 * `sync-io.ts` grew the first copy of `isFunctionLike` /
 * `buildEnclosingChain`; six more collectors needed the same two
 * functions. Rather than seven copies drifting apart, they live here and
 * `sync-io.ts` keeps its own (its chain shape predates this module and is
 * part of a shipped schema, so it is left alone deliberately).
 */

export function isFunctionLike(node: ts.Node): node is ts.SignatureDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** 1-based start line of a node. */
export function startLineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** 1-based end line of a node. */
export function endLineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

/**
 * Nearest enclosing function-like ancestor, resolved against the
 * already-collected {@link ParsedFunction} list so callers get the
 * parser's own name/shape classification rather than re-deriving it.
 *
 * Returns `undefined` at module top level.
 */
export function nearestEnclosingFunction(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
): EnclosingFunction | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (isFunctionLike(cur)) {
      const startLine = startLineOf(cur, sourceFile);
      const endLine = endLineOf(cur, sourceFile);
      const match = functions.find(
        (f) => f.startLine === startLine && f.endLine === endLine,
      );
      if (match) {
        const entry: EnclosingFunction = {
          shape: match.shape,
          startLine: match.startLine,
          endLine: match.endLine,
        };
        if (match.name !== undefined) entry.name = match.name;
        return entry;
      }
    }
    cur = cur.parent;
  }
  return undefined;
}

/**
 * Every function-like ancestor, innermost first. Same resolution rule as
 * {@link nearestEnclosingFunction}.
 */
export function enclosingFunctionChain(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
): EnclosingFunction[] {
  const chain: EnclosingFunction[] = [];
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (isFunctionLike(cur)) {
      const startLine = startLineOf(cur, sourceFile);
      const endLine = endLineOf(cur, sourceFile);
      const match = functions.find(
        (f) => f.startLine === startLine && f.endLine === endLine,
      );
      if (match) {
        const entry: EnclosingFunction = {
          shape: match.shape,
          startLine: match.startLine,
          endLine: match.endLine,
        };
        if (match.name !== undefined) entry.name = match.name;
        chain.push(entry);
      }
    }
    cur = cur.parent;
  }
  return chain;
}

/**
 * Dotted text of a property-access chain, or `undefined` when the
 * expression isn't a plain chain of identifiers.
 *
 * `ctx.session.user.role` → `"ctx.session.user.role"`. A computed access
 * (`a[b]`) or a call in the middle (`a.b().c`) yields `undefined` — a
 * partially-known path would be quoted into evidence as if it were
 * complete.
 */
export function propertyPath(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return "this";
  // `import.meta` is a MetaProperty, not a property access — without this
  // branch every `import.meta.env.X` read is invisible.
  if (ts.isMetaProperty(expr)) {
    return `${ts.tokenToString(expr.keywordToken) ?? "import"}.${expr.name.text}`;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const head = propertyPath(expr.expression);
    if (head === undefined) return undefined;
    return `${head}.${expr.name.text}`;
  }
  // `a?.b` reads the same as `a.b` for policy purposes.
  if (ts.isNonNullExpression(expr)) return propertyPath(expr.expression);
  if (ts.isParenthesizedExpression(expr)) return propertyPath(expr.expression);
  return undefined;
}

/**
 * Callee name of a call expression, as written: `save`, `db.users.create`,
 * `this.repo.save`. `undefined` for computed or otherwise dynamic callees,
 * **including any callee whose receiver is itself a call** —
 * `p.then(…).catch` has no static path.
 *
 * When you only need the method being invoked, use {@link calleeTail},
 * which answers for chains too.
 */
export function calleeName(call: ts.CallExpression): string | undefined {
  return propertyPath(call.expression);
}

/**
 * The method being invoked, independent of how complicated the receiver
 * is. `p.then(f).catch(g)` → `"catch"`; `save(x)` → `"save"`;
 * `handlers[k]()` → `undefined`.
 *
 * This exists because nearly every interesting call in this codebase is
 * part of a chain — `.catch()`, `.map()`, `expect(x).toBe(y)`,
 * `z.object({}).partial()` — and {@link calleeName} correctly refuses to
 * name those. Detectors that key off the method name need the tail; only
 * detectors that quote the full path into evidence need the path.
 */
export function calleeTail(
  call: ts.CallExpression | ts.NewExpression,
): string | undefined {
  const expr = call.expression;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) {
    return propertyPath(expr.expression);
  }
  return undefined;
}

/**
 * Display name for a call's callee: the full static path when there is
 * one, otherwise `…<tail>` so evidence still names the method rather
 * than going blank.
 */
export function calleeLabel(call: ts.CallExpression): string | undefined {
  const path = calleeName(call);
  if (path !== undefined) return path;
  const tail = calleeTail(call);
  return tail !== undefined ? `…${tail}` : undefined;
}

/**
 * Receiver of a member call, when the receiver has a static path.
 * `db.orders.findMany(…)` → `"db.orders"`.
 */
export function receiverPath(call: ts.CallExpression): string | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  return propertyPath(call.expression.expression);
}

/**
 * Resolve a bare identifier to the initializer it was bound to, searching
 * the nearest enclosing function or source file for a
 * `const/let/var <name> = <init>`.
 *
 * Scope-lite, and deliberately so: it does not track reassignment,
 * shadowing across nested blocks, or imports. It exists for one
 * extremely common shape —
 *
 *     const orders = await db.orders.findMany();
 *     await Promise.all(orders.map(…));
 *
 * — where refusing to look one statement up would blind every collector
 * to where the collection came from. Callers must treat the result as a
 * hint that raises confidence, never as proof.
 */
export function resolveLocalBinding(
  name: string,
  from: ts.Node,
): ts.Expression | undefined {
  let scope: ts.Node | undefined = from;
  while (scope) {
    if (isFunctionLike(scope) || ts.isSourceFile(scope) || ts.isBlock(scope)) {
      const found = findDeclarationIn(scope, name);
      if (found) return found;
    }
    scope = scope.parent;
  }
  return undefined;
}

function findDeclarationIn(scope: ts.Node, name: string): ts.Expression | undefined {
  let result: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (result) return;
    // Don't descend into nested functions: their `const orders` is a
    // different binding.
    if (node !== scope && isFunctionLike(node)) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      result = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return result;
}

/** Last segment of a dotted path — `ctx.user.role` → `role`. */
export function pathTail(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Statically-known text of a string-ish expression, if there is one. */
export function stringLiteralText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

/**
 * Source text with runs of whitespace collapsed and a hard length cap.
 *
 * Every collector that puts a fragment of user source into a parsed
 * surface goes through here: evidence strings are rendered into a
 * terminal and a 400-character minified line would destroy the report.
 */
export function condenseSource(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  maxLength = 120,
): string {
  const raw = node.getText(sourceFile).replace(/\s+/g, " ").trim();
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength - 1)}…`;
}

/**
 * Unwrap parentheses, non-null assertions, and `as`/`satisfies` casts to
 * reach the expression that actually carries meaning.
 */
export function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    return cur;
  }
}

/** Does this node carry an `export` modifier? */
export function isExported(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
}

/**
 * Statement list of a function body, or `undefined` for a
 * concise-body arrow (`x => x + 1`). Callers that treat a concise body as
 * "one return statement" handle it explicitly rather than getting an
 * empty list here.
 */
export function bodyStatements(
  node: ts.SignatureDeclaration,
): ts.NodeArray<ts.Statement> | undefined {
  const body = (node as { body?: ts.Node }).body;
  if (body && ts.isBlock(body)) return body.statements;
  return undefined;
}

/**
 * The single expression a function returns, when its whole body is one
 * return. Covers both `x => expr` and `function () { return expr; }`.
 * `undefined` for anything more involved — a multi-statement body is not
 * a pass-through and not a pure predicate.
 */
export function soleReturnedExpression(
  node: ts.SignatureDeclaration,
): ts.Expression | undefined {
  const body = (node as { body?: ts.Node }).body;
  if (!body) return undefined;
  if (!ts.isBlock(body)) {
    // Concise arrow body: the body *is* the returned expression.
    return body as ts.Expression;
  }
  const statements = body.statements.filter((s) => !ts.isEmptyStatement(s));
  if (statements.length !== 1) return undefined;
  const only = statements[0]!;
  if (ts.isReturnStatement(only)) return only.expression;
  if (ts.isExpressionStatement(only)) return only.expression;
  return undefined;
}

/** Parameter names in order; `undefined` entries for destructuring patterns. */
export function parameterNames(node: ts.SignatureDeclaration): Array<string | undefined> {
  return node.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : undefined));
}

/** Is this a rest parameter (`...args`)? */
export function hasRestParameter(node: ts.SignatureDeclaration): boolean {
  return node.parameters.some((p) => p.dotDotDotToken !== undefined);
}
