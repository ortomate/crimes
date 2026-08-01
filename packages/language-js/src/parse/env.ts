import ts from "typescript";
import {
  calleeName,
  condenseSource,
  nearestEnclosingFunction,
  pathTail,
  propertyPath,
  startLineOf,
  stringLiteralText,
  unwrap,
} from "./ast-util.js";
import type { EnvRead, EnvReadVia, ParsedFile, ParsedFunction } from "./types.js";

/**
 * Environment-variable read extraction — the parser half of
 * `config_drift`.
 *
 * The interesting property of an env read is never the read itself; it is
 * how the *same name* is treated in two places. `TIMEOUT` parsed as an
 * integer in one module and compared as a string in another is a bug
 * waiting for a deploy. So each read records everything needed for a
 * later comparison: the parser applied, the default supplied, whether the
 * value is treated as required, and any unit implied by the name.
 *
 * **Values are never recorded.** Only names, locations, and the *shape*
 * of the handling. A default that is a string literal is rendered
 * (`"3000"`) because a default is a documented constant, not a secret;
 * anything else is rendered as its expression kind. There is no code path
 * in this collector that can put a secret into a finding.
 */

const MAX_ENV_READS_PER_FILE = 120;

/** Suffixes that pin a unit onto a numeric setting. */
const UNIT_SUFFIXES: ReadonlyArray<{ re: RegExp; unit: string }> = [
  { re: /_(MS|MILLIS|MILLISECONDS)$/i, unit: "milliseconds" },
  { re: /_(S|SEC|SECS|SECONDS)$/i, unit: "seconds" },
  { re: /_(M|MIN|MINS|MINUTES)$/i, unit: "minutes" },
  { re: /_(H|HR|HRS|HOURS)$/i, unit: "hours" },
  { re: /_(D|DAYS)$/i, unit: "days" },
  { re: /_(BYTES|KB|MB|GB)$/i, unit: "bytes" },
  { re: /_(PERCENT|PCT)$/i, unit: "percent" },
];

/** Prefixes that expose a value to browser bundles. */
const PUBLIC_PREFIXES: readonly string[] = [
  "NEXT_PUBLIC_",
  "VITE_",
  "PUBLIC_",
  "REACT_APP_",
  "GATSBY_",
  "NUXT_PUBLIC_",
  "EXPO_PUBLIC_",
  "STORYBOOK_",
];

export function collectEnvRead(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
  out: EnvRead[],
): void {
  if (out.length >= MAX_ENV_READS_PER_FILE) return;

  // `const { PORT, HOST } = process.env`
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const via = envAccessRoot(unwrap(node.initializer));
    if (via !== undefined && ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        const name = bindingSourceName(element);
        if (name === undefined) continue;
        push(out, {
          name,
          via: "destructured",
          line: startLineOf(element, sourceFile),
          required: false,
          ...(element.initializer
            ? { defaultValue: renderDefault(unwrap(element.initializer), sourceFile) }
            : {}),
          ...unitOf(name),
          ...publicOf(name),
          ...enclosingName(node, sourceFile, functions),
        });
      }
      return;
    }
  }

  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) {
    return;
  }

  const access = resolveEnvAccess(node);
  if (access === undefined) return;

  const context = describeContext(node, sourceFile);
  push(out, {
    name: access.name,
    via: access.via,
    line: startLineOf(node, sourceFile),
    required: context.required,
    ...(context.parser !== undefined ? { parser: context.parser } : {}),
    ...(context.defaultValue !== undefined
      ? { defaultValue: context.defaultValue }
      : {}),
    ...unitOf(access.name),
    ...publicOf(access.name),
    ...enclosingName(node, sourceFile, functions),
  });
}

interface EnvAccess {
  name: string;
  via: EnvReadVia;
}

/**
 * Resolve `process.env.X` / `process.env["X"]` / `import.meta.env.X`.
 *
 * A computed access with a non-literal key (`process.env[name]`) is
 * recorded with the sentinel name `*` and `via: "dynamic"`: the detector
 * uses it to know a file reads configuration it cannot enumerate, which
 * is itself worth saying, but never treats it as a named variable.
 */
function resolveEnvAccess(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): EnvAccess | undefined {
  const receiverPath = propertyPath(node.expression);
  const via = receiverPath !== undefined ? viaFor(receiverPath) : undefined;
  if (via === undefined) return undefined;

  if (ts.isPropertyAccessExpression(node)) {
    return { name: node.name.text, via };
  }
  const key = stringLiteralText(unwrap(node.argumentExpression));
  if (key !== undefined) return { name: key, via };
  return { name: "*", via: "dynamic" };
}

function viaFor(path: string): EnvReadVia | undefined {
  if (path === "process.env") return "process.env";
  if (path === "import.meta.env") return "import.meta.env";
  // `Deno.env` reads go through `Deno.env.get("X")`, handled as a call
  // elsewhere; the bare path is not an access on its own.
  return undefined;
}

/** Is this expression the env object itself (for destructuring)? */
function envAccessRoot(expr: ts.Expression): EnvReadVia | undefined {
  const path = propertyPath(expr);
  return path !== undefined ? viaFor(path) : undefined;
}

interface ReadContext {
  parser?: EnvRead["parser"];
  defaultValue?: string;
  required: boolean;
}

/**
 * Walk *outward* from the access to learn how the value is treated.
 *
 * Only a bounded number of enclosing nodes are inspected — the handling
 * of an env read is always immediately around it, and an unbounded walk
 * would attribute an unrelated `Number(...)` further up the tree.
 */
function describeContext(node: ts.Node, sourceFile: ts.SourceFile): ReadContext {
  const context: ReadContext = { required: false };
  let cur: ts.Node | undefined = node;
  let child: ts.Node = node;

  for (let depth = 0; depth < 6; depth++) {
    cur = cur?.parent;
    if (!cur) break;

    if (ts.isNonNullExpression(cur)) {
      context.required = true;
      child = cur;
      continue;
    }

    if (ts.isBinaryExpression(cur)) {
      const op = cur.operatorToken.kind;
      if (
        (op === ts.SyntaxKind.QuestionQuestionToken ||
          op === ts.SyntaxKind.BarBarToken) &&
        cur.left === child
      ) {
        context.defaultValue ??= renderDefault(unwrap(cur.right), sourceFile);
        child = cur;
        continue;
      }
      // `process.env.FLAG === "true"` — a string comparison used as a
      // boolean parse.
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken
      ) {
        context.parser ??= "boolean";
        child = cur;
        continue;
      }
      child = cur;
      continue;
    }

    if (
      ts.isPrefixUnaryExpression(cur) &&
      cur.operator === ts.SyntaxKind.PlusToken
    ) {
      // Unary `+process.env.PORT` is a numeric coercion.
      context.parser ??= "number";
      child = cur;
      continue;
    }

    if (ts.isCallExpression(cur)) {
      const parser = parserFor(cur);
      if (parser !== undefined) context.parser ??= parser;
      if (isRequiredAssertionCall(cur)) context.required = true;
      child = cur;
      continue;
    }

    if (ts.isIfStatement(cur) || ts.isThrowStatement(cur)) {
      // `if (!process.env.X) throw new Error(...)`
      if (ts.isThrowStatement(cur)) context.required = true;
      break;
    }

    child = cur;
  }

  return context;
}

function parserFor(call: ts.CallExpression): EnvRead["parser"] | undefined {
  const callee = calleeName(call);
  if (callee === undefined) return undefined;
  switch (callee) {
    case "Number":
      return "number";
    case "parseInt":
      return "int";
    case "parseFloat":
      return "float";
    case "Boolean":
      return "boolean";
    case "JSON.parse":
      return "json";
    case "String":
      return "string";
    default:
      break;
  }
  const tail = pathTail(callee).toLowerCase();
  if (tail === "tonumber" || tail === "asnumber") return "number";
  if (tail === "toboolean" || tail === "asboolean") return "boolean";
  return undefined;
}

/**
 * Calls that mean "this value must be present": a schema `.parse(...)`,
 * an assertion helper, or an explicit `required(...)`.
 */
function isRequiredAssertionCall(call: ts.CallExpression): boolean {
  const callee = calleeName(call);
  if (callee === undefined) return false;
  const tail = pathTail(callee).toLowerCase();
  return (
    tail === "parse" ||
    tail === "parseasync" ||
    tail === "required" ||
    tail === "assert" ||
    tail === "invariant" ||
    tail === "demand" ||
    tail === "requireenv" ||
    tail === "mustget"
  );
}

/**
 * Render a default expression for evidence.
 *
 * String and numeric literals are rendered verbatim: a default is a
 * committed constant, visible to anyone reading the file, and the whole
 * point of the finding is that two files disagree about it. Anything
 * else — an identifier, a call, a template with substitutions — is
 * rendered as a shape, never as a value, because the collector cannot
 * know what it resolves to.
 */
function renderDefault(expr: ts.Expression, sourceFile: ts.SourceFile): string {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return JSON.stringify(expr.text);
  }
  if (ts.isNumericLiteral(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (expr.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isIdentifier(expr) && expr.text === "undefined") return "undefined";
  if (ts.isArrayLiteralExpression(expr)) return "[…]";
  if (ts.isObjectLiteralExpression(expr)) return "{…}";
  // A computed default: render the expression *source* (which is
  // committed code, not a value) inside angle brackets so a reader can
  // tell at a glance that the default is dynamic.
  return `<${condenseSource(expr, sourceFile, 32)}>`;
}

function unitOf(name: string): { unit?: string } {
  for (const { re, unit } of UNIT_SUFFIXES) {
    if (re.test(name)) return { unit };
  }
  return {};
}

function publicOf(name: string): { publicPrefix?: string } {
  for (const prefix of PUBLIC_PREFIXES) {
    if (name.startsWith(prefix)) return { publicPrefix: prefix };
  }
  return {};
}

function bindingSourceName(element: ts.BindingElement): string | undefined {
  // `const { PORT: port } = process.env` — the *source* key is what
  // identifies the variable, not the local alias.
  if (element.propertyName) {
    if (ts.isIdentifier(element.propertyName)) return element.propertyName.text;
    return stringLiteralText(element.propertyName);
  }
  return ts.isIdentifier(element.name) ? element.name.text : undefined;
}

function enclosingName(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
): { enclosing?: string } {
  const fn = nearestEnclosingFunction(node, sourceFile, functions);
  return fn?.name !== undefined ? { enclosing: fn.name } : {};
}

function push(out: EnvRead[], read: EnvRead): void {
  if (out.length >= MAX_ENV_READS_PER_FILE) return;
  out.push(read);
}

/**
 * Does this parsed file look like a central configuration module — the
 * one place a repo funnels environment access through?
 *
 * Signal: it reads several distinct variables and exports something. The
 * detector uses this to decide whether a direct read *elsewhere* is
 * bypassing an established boundary, so the bar is deliberately about
 * concentration rather than filename.
 */
export function looksLikeConfigModule(parsed: ParsedFile, file: string): boolean {
  const reads = parsed.envReads ?? [];
  if (reads.length < 3) return false;
  const distinct = new Set(reads.map((r) => r.name));
  if (distinct.size < 3) return false;
  return /(^|\/)(config|env|environment|settings)(\.[cm]?[jt]sx?|\/)/i.test(file);
}
