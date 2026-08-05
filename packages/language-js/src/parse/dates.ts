import ts from "typescript";
import type {
  DateArithmetic,
  DateMethodCall,
  DateStringConcat,
  DateUse,
} from "./types.js";

// ----- DateUse: `Date.now()` and `new Date(...)` --------------------------

export function collectDateUse(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: DateUse[],
): void {
  if (ts.isCallExpression(node)) {
    const expr = node.expression;
    if (
      ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "Date" &&
      expr.name.text === "now"
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      out.push({ kind: "now", line: line + 1, usage: classifyUsage(node) });
    }
  }

  if (ts.isNewExpression(node)) {
    const expr = node.expression;
    if (ts.isIdentifier(expr) && expr.text === "Date") {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      const args = node.arguments;
      const use: DateUse = {
        kind: "new",
        line: line + 1,
        usage: classifyUsage(node),
      };
      classifyNewDateArg(args, use);
      out.push(use);
    }
  }
}

/**
 * Does this clock reading decide something, or is it just recorded?
 *
 * Field notes from choreograph.cc argued that `direct_date` "conflates
 * reading time with recording it", and that the genuinely risky case is
 * time used in a branch or comparison. That framing is right and this
 * is what implements it — but note the notes' own example did **not**
 * hold up. `JobDetail.tsx` was reported as "essentially all display
 * formatting"; it contains two poll timeouts of the form
 *
 *   if (Date.now() - startedAt >= VIDEO_POLL_TIMEOUT_MS) { … }
 *
 * which is exactly the risky shape. Opening the file is what settled
 * it. So this classification exists to make the *evidence* say which
 * uses are which, not to make the finding disappear.
 *
 * Walks up through the expression forms a clock reading passes through
 * on its way to a test — arithmetic (`now - start`), parentheses,
 * `.getTime()`, non-null assertions — and stops at anything that
 * consumes the value instead (a call argument, a property assignment, a
 * return, a template literal).
 *
 * **Unknown resolves to `compared`.** A wrong answer in that direction
 * costs a finding's severity staying where it already is; the other
 * direction silently downgrades a real one.
 */
function classifyUsage(node: ts.Node, followBinding = true): "compared" | "value" {
  let current: ts.Node = node;
  let parent = current.parent as ts.Node | undefined;

  while (parent) {
    // A relational or equality comparison is the answer.
    if (
      ts.isBinaryExpression(parent) &&
      isComparisonOperator(parent.operatorToken.kind)
    ) {
      return "compared";
    }
    // Condition position: if / while / do-while / for / ternary.
    if (
      (ts.isIfStatement(parent) ||
        ts.isWhileStatement(parent) ||
        ts.isDoStatement(parent)) &&
      parent.expression === current
    ) {
      return "compared";
    }
    if (ts.isConditionalExpression(parent) && parent.condition === current) {
      return "compared";
    }
    if (ts.isForStatement(parent) && parent.condition === current) return "compared";

    // Transparent wrappers — the value keeps flowing.
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isPrefixUnaryExpression(parent)
    ) {
      current = parent;
      parent = parent.parent;
      continue;
    }
    // Arithmetic keeps flowing: `Date.now() - startedAt` is still a
    // clock reading, and it is the left-hand side of most timeouts.
    if (
      ts.isBinaryExpression(parent) &&
      isArithmeticOperator(parent.operatorToken.kind)
    ) {
      current = parent;
      parent = parent.parent;
      continue;
    }
    // `.getTime()` / `.valueOf()` on a fresh Date is still the reading.
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === current &&
      (parent.name.text === "getTime" || parent.name.text === "valueOf")
    ) {
      current = parent;
      parent = parent.parent;
      continue;
    }
    if (ts.isCallExpression(parent) && parent.expression === current) {
      current = parent;
      parent = parent.parent;
      continue;
    }

    // A local binding: `const now = Date.now()`. Look for the name being
    // compared anywhere in the enclosing function. One hop only — this
    // is a syntax walk, not dataflow, and a second hop would be guessing.
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      // `followBinding` stops the one hop becoming a loop: the scan
      // below calls back into this function for each reference, and the
      // declaration's own name is one of them.
      if (!followBinding) return "value";
      return bindingIsCompared(parent.name.text, parent) ? "compared" : "value";
    }

    // Anything else consumes the value: a call argument, a property
    // assignment, a return, a template literal, JSX.
    return "value";
  }
  return "compared";
}

function isComparisonOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.LessThanToken ||
    kind === ts.SyntaxKind.LessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanToken ||
    kind === ts.SyntaxKind.GreaterThanEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
  );
}

function isArithmeticOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.MinusToken ||
    kind === ts.SyntaxKind.PlusToken ||
    kind === ts.SyntaxKind.AsteriskToken ||
    kind === ts.SyntaxKind.SlashToken ||
    kind === ts.SyntaxKind.PercentToken
  );
}

/** Is `name` read inside a comparison anywhere in the enclosing function? */
function bindingIsCompared(name: string, from: ts.Node): boolean {
  const scope = enclosingFunctionOrSource(from);
  if (!scope) return true;
  let found = false;
  const declarationName = ts.isVariableDeclaration(from) ? from.name : undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    // Skip the binding site itself — it is a reference to the name by
    // definition, and following it would just re-ask this question.
    if (n === declarationName) return;
    if (ts.isIdentifier(n) && n.text === name && classifyUsage(n, false) === "compared") {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(scope, visit);
  return found;
}

function enclosingFunctionOrSource(node: ts.Node): ts.Node | undefined {
  let current = node.parent as ts.Node | undefined;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isSourceFile(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function classifyNewDateArg(
  args: ts.NodeArray<ts.Expression> | undefined,
  use: DateUse,
): void {
  if (!args || args.length === 0) {
    use.argKind = "none";
    return;
  }
  // Multi-arg form: new Date(y, m, d, ...). Not a parse-safety concern.
  // Tag as "expression" so detectors can ignore it cleanly.
  if (args.length > 1) {
    use.argKind = "expression";
    return;
  }
  const arg = args[0]!;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    use.argKind = "string-literal";
    use.argValue = arg.text;
    return;
  }
  if (ts.isNumericLiteral(arg)) {
    use.argKind = "number";
    use.argValue = arg.text;
    return;
  }
  use.argKind = "expression";
}

// ----- DateMethodCall: `d.getHours()` / `d.toLocaleDateString()` etc. -----

const UTC_METHODS = new Set([
  "getUTCFullYear",
  "getUTCMonth",
  "getUTCDate",
  "getUTCDay",
  "getUTCHours",
  "getUTCMinutes",
  "getUTCSeconds",
  "getUTCMilliseconds",
  "setUTCFullYear",
  "setUTCMonth",
  "setUTCDate",
  "setUTCHours",
  "setUTCMinutes",
  "setUTCSeconds",
  "setUTCMilliseconds",
  "toUTCString",
  "toISOString",
]);

const LOCAL_METHODS = new Set([
  "getFullYear",
  "getMonth",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getSeconds",
  "getMilliseconds",
  "setFullYear",
  "setMonth",
  "setDate",
  "setHours",
  "setMinutes",
  "setSeconds",
  "setMilliseconds",
  "toDateString",
  "toTimeString",
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
]);

export function collectDateMethodCall(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: DateMethodCall[],
): void {
  if (!ts.isCallExpression(node)) return;
  if (!ts.isPropertyAccessExpression(node.expression)) return;
  // Only collect when the receiver is a simple identifier — chained
  // calls (`a.b.getHours()`) and `this.x.getHours()` are rarer and add
  // noise without aiding the 0.8.0 detectors.
  if (!ts.isIdentifier(node.expression.expression)) return;
  const method = node.expression.name.text;
  const family: "utc" | "local" | undefined = UTC_METHODS.has(method)
    ? "utc"
    : LOCAL_METHODS.has(method)
      ? "local"
      : undefined;
  if (!family) return;
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  out.push({
    receiver: node.expression.expression.text,
    method,
    family,
    line: line + 1,
    argCount: node.arguments?.length ?? 0,
  });
}

// ----- DateArithmetic: `x + 86400000` (DST-naive day math) ---------------

interface DayConstant {
  value: number;
  unit: DateArithmetic["unit"];
}

const DAY_CONSTANTS: DayConstant[] = [
  { value: 86400000, unit: "day" },
  { value: 604800000, unit: "week" },
  { value: 2419200000, unit: "month_approx" }, // 28 days
  { value: 2592000000, unit: "month_approx" }, // 30 days
  { value: 31536000000, unit: "year_approx" },
];

const DAY_CONSTANT_BY_VALUE = new Map<number, DateArithmetic["unit"]>(
  DAY_CONSTANTS.map((c) => [c.value, c.unit]),
);

export function collectDateArithmetic(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: DateArithmetic[],
): void {
  if (!ts.isBinaryExpression(node)) return;
  const op = node.operatorToken.kind;
  if (op !== ts.SyntaxKind.PlusToken && op !== ts.SyntaxKind.MinusToken) return;
  const operand = foldNumericLiteral(node.left) ?? foldNumericLiteral(node.right);
  if (operand === undefined) return;
  const unit = DAY_CONSTANT_BY_VALUE.get(operand);
  if (!unit) return;
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  out.push({
    kind: op === ts.SyntaxKind.PlusToken ? "add" : "subtract",
    line: line + 1,
    operand,
    unit,
  });
}

// ----- DateStringConcat: `"…" + d.method()` ------------------------------

export function collectDateStringConcat(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: DateStringConcat[],
): void {
  if (!ts.isBinaryExpression(node)) return;
  if (node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return;
  const left = node.left;
  const right = node.right;
  const leftIsStr = isStringLiteralLike(left);
  const rightIsStr = isStringLiteralLike(right);
  if (!leftIsStr && !rightIsStr) return;
  const dateSide = leftIsStr ? right : left;
  const method = dateMethodCallName(dateSide);
  if (!method) return;
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  out.push({ line: line + 1, method });
}

function isStringLiteralLike(node: ts.Expression): boolean {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function dateMethodCallName(node: ts.Expression): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const method = node.expression.name.text;
  if (UTC_METHODS.has(method) || LOCAL_METHODS.has(method)) return method;
  return undefined;
}

/**
 * Best-effort static fold of a numeric expression. Handles:
 *
 * - bare numeric literals (`86400000`)
 * - parenthesised expressions (recurses)
 * - multiplications of all-numeric operands (`24 * 60 * 60 * 1000`)
 *
 * Anything else (identifiers, calls, mixed expressions) returns
 * `undefined`. The detector decides whether the value matches a known
 * day constant — we don't try to be clever about partial folds.
 */
function foldNumericLiteral(node: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isParenthesizedExpression(node)) {
    return foldNumericLiteral(node.expression);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AsteriskToken
  ) {
    const left = foldNumericLiteral(node.left);
    const right = foldNumericLiteral(node.right);
    if (left === undefined || right === undefined) return undefined;
    return left * right;
  }
  return undefined;
}
