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
      out.push({ kind: "now", line: line + 1 });
    }
  }

  if (ts.isNewExpression(node)) {
    const expr = node.expression;
    if (ts.isIdentifier(expr) && expr.text === "Date") {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      const args = node.arguments;
      const use: DateUse = { kind: "new", line: line + 1 };
      classifyNewDateArg(args, use);
      out.push(use);
    }
  }
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
