import ts from "typescript";
import {
  calleeTail,
  condenseSource,
  endLineOf,
  nearestEnclosingFunction,
  pathTail,
  propertyPath,
  startLineOf,
  unwrap,
} from "./ast-util.js";
import type { ParsedFunction, PolicyExpression, PolicyKind } from "./types.js";

/**
 * Policy-expression extraction — the parser half of `duplicated_policy`.
 *
 * A "policy expression" is a decision the product makes about its own
 * rules: who may do a thing, whether a thing is valid, what a thing
 * costs, which state a thing may move to next. The collector's job is to
 * find those expressions and render each one into a **normalised form**
 * that two independent implementations of the same rule will agree on.
 *
 * ## What normalisation keeps and drops
 *
 * Kept, because they carry the rule:
 *   - comparison and logical operators (`===`, `!==`, `>=`, `&&`, `||`, `!`)
 *   - the **tail** of every property path (`ctx.session.user.role` → `.role`)
 *   - string and numeric literal values verbatim (`"admin"`, `100`)
 *   - callee names (`isAdmin`, `hasPermission`)
 *   - membership tests (`.includes`, `.has`) and their arguments
 *
 * Dropped, because they are naming and layout:
 *   - local identifier names, replaced by positional `$0`, `$1`, …
 *   - the root object of a property path (`user` vs `member` vs `actor`)
 *   - whitespace, parentheses, `as` casts, non-null assertions
 *
 * Dropping the path root is the load-bearing decision. `user.role ===
 * "admin"` in a route and `member.role === "admin"` in a service are the
 * same policy under two local names; treating them as different would
 * miss the exact case this detector exists for. Keeping the *tail* is
 * what stops it collapsing into "any two comparisons match" — `.role ===
 * "admin"` and `.status === "admin"` stay distinct.
 *
 * ## What is deliberately not extracted
 *
 * Trivial null / undefined checks (`if (!user) return`), bare truthiness
 * on a single identifier, and single-operand expressions with no literal
 * and no domain-bearing path. These are the boilerplate that makes a
 * generic clone detector useless, and none of them is a business rule.
 */

/** Minimum normalised-token count before an expression is a candidate. */
const MIN_POLICY_TOKENS = 3;

/**
 * Cap on how many policy expressions one file contributes. A generated
 * validator or a giant switch table can produce hundreds; past this point
 * the file is a data table, not a set of hand-written rules, and the
 * cross-file index would be dominated by one file's noise.
 */
const MAX_POLICY_PER_FILE = 60;

/** Membership-test methods whose argument is part of the rule. */
const MEMBERSHIP_METHODS: ReadonlySet<string> = new Set([
  "includes",
  "has",
  "contains",
  "indexOf",
  "some",
  "every",
  "startsWith",
  "endsWith",
]);

/**
 * Collect policy expressions rooted at `node`.
 *
 * Called from the main parse walk for every node; returns immediately for
 * the overwhelming majority of node kinds.
 */
export function collectPolicyExpression(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
  out: PolicyExpression[],
): void {
  if (out.length >= MAX_POLICY_PER_FILE) return;

  if (ts.isIfStatement(node)) {
    const kind: PolicyKind = isGuardShape(node) ? "guard_clause" : "conditional";
    push(node.expression, node, kind, sourceFile, functions, out);
    return;
  }

  if (ts.isSwitchStatement(node)) {
    collectSwitch(node, sourceFile, functions, out);
    return;
  }

  if (ts.isReturnStatement(node) && node.expression) {
    const expr = unwrap(node.expression);
    if (isBooleanShaped(expr)) {
      push(expr, node, "boolean_predicate", sourceFile, functions, out);
    }
    return;
  }

  // `const canEdit = user.role === "admin" || user.id === doc.ownerId;`
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const expr = unwrap(node.initializer);
    if (isBooleanShaped(expr)) {
      push(expr, node, "boolean_predicate", sourceFile, functions, out);
    }
    return;
  }

  // `throw new ForbiddenError(...)` guarded by a ternary, and the
  // `cond ? a : b` calculation form — both are decisions.
  if (ts.isConditionalExpression(node) && isBooleanShaped(unwrap(node.condition))) {
    push(node.condition, node, "conditional", sourceFile, functions, out);
  }
}

/**
 * A switch is normalised as a unit: discriminant tail plus every case
 * label in source order plus whether a default exists. Two copies of the
 * same state-transition table match even when the bodies differ, which is
 * the interesting case — a table restated with one extra state is exactly
 * the near-clone worth reporting.
 */
function collectSwitch(
  node: ts.SwitchStatement,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
  out: PolicyExpression[],
): void {
  const discriminantPath = propertyPath(unwrap(node.expression));
  const labels: string[] = [];
  let hasDefault = false;

  for (const clause of node.caseBlock.clauses) {
    if (ts.isDefaultClause(clause)) {
      hasDefault = true;
      continue;
    }
    const expr = unwrap(clause.expression);
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      labels.push(expr.text);
      continue;
    }
    if (ts.isNumericLiteral(expr)) {
      labels.push(expr.text);
      continue;
    }
    // A non-literal case label (`case STATUS.ACTIVE:`) is still a label —
    // record its path tail so the shape stays comparable.
    const path = propertyPath(expr);
    labels.push(path ? `#${pathTail(path)}` : "#expr");
  }

  // A two-case switch is a glorified if; the clone signal is too weak.
  if (labels.length < 3) return;

  const tail = discriminantPath ? pathTail(discriminantPath) : "$";
  const normalized = `switch .${tail} { ${[...labels].sort().join(" | ")}${hasDefault ? " | default" : ""} }`;

  out.push({
    kind: "switch_case",
    normalized,
    readable: `switch (${discriminantPath ?? "…"}) over ${labels.length} case(s)`,
    line: startLineOf(node, sourceFile),
    endLine: endLineOf(node, sourceFile),
    paths: discriminantPath ? [discriminantPath] : [],
    literals: [...labels].sort(),
    calls: [],
    operators: ["switch"],
    tokens: labels.length + 1,
    ...enclosingName(node, sourceFile, functions),
  });
}

/**
 * Property tails that describe a data structure rather than the domain.
 * A comparison whose only paths are these is arithmetic about a
 * collection, never a business rule — `items.length > 0` is not a policy
 * in any codebase.
 */
const STRUCTURAL_TAILS: ReadonlySet<string> = new Set([
  "length",
  "size",
  "count",
  "index",
  "offset",
  "position",
  "depth",
  "width",
  "height",
  "line",
  "column",
  "byteLength",
]);

function push(
  expr: ts.Expression,
  anchor: ts.Node,
  kind: PolicyKind,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
  out: PolicyExpression[],
): void {
  const target = unwrap(expr);
  if (isTrivialCheck(target)) return;

  const norm = normalise(target, sourceFile);
  if (isStructuralComparison(norm)) return;
  if (norm.tokens < MIN_POLICY_TOKENS) return;
  // A rule with neither a literal value nor a named property is a shape,
  // not a policy: `$0 && $1` matches half the repo.
  if (norm.literals.length === 0 && norm.paths.length === 0 && norm.calls.length === 0) {
    return;
  }

  out.push({
    kind,
    normalized: norm.normalized,
    readable: condenseSource(target, sourceFile),
    line: startLineOf(anchor, sourceFile),
    endLine: endLineOf(anchor, sourceFile),
    paths: unique(norm.paths),
    literals: unique(norm.literals),
    calls: unique(norm.calls),
    operators: norm.operators,
    tokens: norm.tokens,
    ...enclosingName(anchor, sourceFile, functions),
  });
}

function enclosingName(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
): { enclosing?: string } {
  const fn = nearestEnclosingFunction(node, sourceFile, functions);
  return fn?.name !== undefined ? { enclosing: fn.name } : {};
}

interface Normalised {
  normalized: string;
  paths: string[];
  literals: string[];
  calls: string[];
  operators: string[];
  tokens: number;
}

/**
 * Render an expression into its canonical policy form. Recursive descent
 * over the expression kinds that can carry a rule; anything unrecognised
 * becomes an opaque `$expr` token so the surrounding structure still
 * compares.
 */
function normalise(expr: ts.Expression, sourceFile: ts.SourceFile): Normalised {
  const state: Normalised = {
    normalized: "",
    paths: [],
    literals: [],
    calls: [],
    operators: [],
    tokens: 0,
  };
  const locals = new Map<string, string>();
  state.normalized = render(expr, sourceFile, state, locals);
  return state;
}

function render(
  raw: ts.Expression,
  sourceFile: ts.SourceFile,
  state: Normalised,
  locals: Map<string, string>,
): string {
  const expr = unwrap(raw);

  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.getText(sourceFile);
    state.operators.push(op);
    state.tokens += 1;
    const left = render(expr.left, sourceFile, state, locals);
    const right = render(expr.right, sourceFile, state, locals);
    // Commutative comparisons are ordered so `a === "x"` and `"x" === a`
    // normalise identically. Ordering is lexical, hence deterministic.
    if (COMMUTATIVE.has(op)) {
      const [a, b] = left <= right ? [left, right] : [right, left];
      return `(${a} ${op} ${b})`;
    }
    return `(${left} ${op} ${right})`;
  }

  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    state.operators.push("!");
    state.tokens += 1;
    return `!${render(expr.operand as ts.Expression, sourceFile, state, locals)}`;
  }

  if (ts.isConditionalExpression(expr)) {
    state.operators.push("?:");
    state.tokens += 1;
    const cond = render(expr.condition, sourceFile, state, locals);
    const whenTrue = render(expr.whenTrue, sourceFile, state, locals);
    const whenFalse = render(expr.whenFalse, sourceFile, state, locals);
    return `(${cond} ? ${whenTrue} : ${whenFalse})`;
  }

  if (ts.isCallExpression(expr)) {
    return renderCall(expr, sourceFile, state, locals);
  }

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    state.literals.push(expr.text);
    state.tokens += 1;
    return JSON.stringify(expr.text);
  }

  if (ts.isNumericLiteral(expr)) {
    state.literals.push(expr.text);
    state.tokens += 1;
    return expr.text;
  }

  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    state.tokens += 1;
    return "true";
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    state.tokens += 1;
    return "false";
  }
  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    state.tokens += 1;
    return "null";
  }

  if (ts.isArrayLiteralExpression(expr)) {
    const parts = expr.elements.map((e) =>
      render(e as ts.Expression, sourceFile, state, locals),
    );
    state.tokens += 1;
    // Array-literal order rarely encodes meaning in a membership test.
    return `[${[...parts].sort().join(",")}]`;
  }

  const path = propertyPath(expr);
  if (path !== undefined) {
    if (path.includes(".")) {
      state.paths.push(path);
      state.tokens += 1;
      return `.${pathTail(path)}`;
    }
    // Bare identifier: a local name with no semantic content. `undefined`
    // is a keyword-ish identifier in TS's grammar and does carry meaning.
    if (path === "undefined") {
      state.tokens += 1;
      return "undefined";
    }
    state.tokens += 1;
    return placeholder(path, locals);
  }

  state.tokens += 1;
  return "$expr";
}

function renderCall(
  expr: ts.CallExpression,
  sourceFile: ts.SourceFile,
  state: Normalised,
  locals: Map<string, string>,
): string {
  const tail = calleeTail(expr);
  const args = expr.arguments.map((a) => render(a, sourceFile, state, locals));
  state.tokens += 1;

  if (tail === undefined) return `$call(${args.join(",")})`;

  if (MEMBERSHIP_METHODS.has(tail)) {
    // `roles.includes("admin")` — the receiver is a local collection, the
    // method and the argument are the rule.
    state.calls.push(tail);
    return `.${tail}(${args.join(",")})`;
  }

  // A free function or a method on some object: the name is the rule.
  // `hasPermission(user, "billing.write")` and
  // `auth.hasPermission(actor, "billing.write")` normalise the same,
  // which is correct — one is a re-export of the other often enough.
  state.calls.push(tail);
  return `${tail}(${args.join(",")})`;
}

const COMMUTATIVE: ReadonlySet<string> = new Set(["===", "!==", "==", "!=", "&&", "||"]);

function placeholder(name: string, locals: Map<string, string>): string {
  let existing = locals.get(name);
  if (existing === undefined) {
    existing = `$${locals.size}`;
    locals.set(name, existing);
  }
  return existing;
}

/**
 * `if (cond) return …` / `if (cond) throw …` — the guard shape. Also
 * matches a block whose only statement is a return or throw.
 */
function isGuardShape(node: ts.IfStatement): boolean {
  if (node.elseStatement !== undefined) return false;
  const then = node.thenStatement;
  const inner = ts.isBlock(then)
    ? then.statements.length === 1
      ? then.statements[0]
      : undefined
    : then;
  if (!inner) return false;
  return ts.isReturnStatement(inner) || ts.isThrowStatement(inner);
}

/**
 * Does this expression look like it evaluates to a boolean rule? Used to
 * decide whether a `return` or a `const` initialiser is a predicate.
 */
function isBooleanShaped(expr: ts.Expression): boolean {
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    return (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.LessThanToken ||
      op === ts.SyntaxKind.LessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanToken ||
      op === ts.SyntaxKind.GreaterThanEqualsToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.InKeyword ||
      op === ts.SyntaxKind.InstanceOfKeyword
    );
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    return expr.operator === ts.SyntaxKind.ExclamationToken;
  }
  return false;
}

/**
 * Trivial checks that are never a business rule: presence tests on a
 * single value, and comparisons against `null` / `undefined` alone.
 *
 * This is the guard that keeps `duplicated_policy` from degenerating into
 * "you wrote `if (!x) return` in 40 files", which is true and useless.
 */
function isTrivialCheck(expr: ts.Expression): boolean {
  // `!x`, `!x.y`
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return propertyPath(unwrap(expr.operand as ts.Expression)) !== undefined;
  }
  // bare `x` / `x.y`
  if (propertyPath(expr) !== undefined) return true;

  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    const isEquality =
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken;
    if (!isEquality) return false;
    const left = unwrap(expr.left);
    const right = unwrap(expr.right);
    return isNullish(left) || isNullish(right);
  }
  return false;
}

/**
 * Is this expression arithmetic about a data structure rather than a
 * rule about the domain?
 *
 * True when every property path it reads is a structural tail
 * (`.length`, `.size`, `.index`) and every literal is a small integer.
 * That covers emptiness checks, bounds checks, and index guards — the
 * three predicates that appear in every file of every codebase and mean
 * nothing about the product.
 *
 * A comparison mixing a structural tail with a domain path
 * (`cart.items.length > user.plan.seatLimit`) is *not* structural: it
 * reads a business limit, and it stays.
 */
function isStructuralComparison(norm: Normalised): boolean {
  if (norm.paths.length === 0 && norm.calls.length === 0) {
    // No named data at all — `$0 > 0`. Nothing to compare across files.
    return true;
  }
  const allStructural =
    norm.paths.length > 0 &&
    norm.paths.every((path) => STRUCTURAL_TAILS.has(pathTail(path)));
  if (!allStructural) return false;

  // Every literal must be a plain small integer for this to be bounds
  // arithmetic. A structural tail compared against a string is something
  // else and is left alone.
  return norm.literals.every((literal) => /^-?\d{1,3}$/.test(literal));
}

function isNullish(expr: ts.Expression): boolean {
  if (expr.kind === ts.SyntaxKind.NullKeyword) return true;
  return ts.isIdentifier(expr) && expr.text === "undefined";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
