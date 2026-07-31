import ts from "typescript";
import type { FetchSite, StringUnionType } from "./types.js";

/**
 * Surfaces that only exist to be matched against another language.
 *
 * Both were added in 0.15.0 for the cross-language pack. Neither is
 * consumed by any single-language detector, which is deliberate: a
 * `fetch("/api/users")` is unremarkable on its own and only becomes
 * evidence when a Python route disagrees with it.
 */

/**
 * Callee names that mean "this is an HTTP request to a path".
 * `fetch` covers the platform API; `axios.get` / `http.post` /
 * `client.get` cover the common wrappers.
 */
const REQUEST_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "request",
]);
const REQUEST_RECEIVERS = /(^|\.)(axios|http|client|api|request)$/i;

/**
 * Collect a `fetch()`-shaped call whose URL is a statically-known
 * string.
 *
 * Only literal URLs are captured. A URL assembled at runtime
 * (`fetch(\`\${base}/users\`)` with substitutions) cannot be quoted
 * verbatim into `Finding.evidence`, and a partially-known path would
 * line up against the wrong route — the same rule the Python route
 * extractor applies from the other side.
 */
export function collectFetchSite(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: FetchSite[],
): void {
  if (!ts.isCallExpression(node)) return;

  let method = "get";
  let matched = false;

  if (ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
    matched = true;
  } else if (ts.isPropertyAccessExpression(node.expression)) {
    const name = node.expression.name.text;
    const receiver = node.expression.expression.getText(sourceFile);
    if (REQUEST_METHODS.has(name.toLowerCase()) && REQUEST_RECEIVERS.test(receiver)) {
      matched = true;
      method = name.toLowerCase();
    }
  }
  if (!matched) return;

  const first = node.arguments[0];
  if (!first) return;
  const url = literalText(first);
  if (url === undefined) return;
  // Only same-origin paths participate. An absolute URL to a third
  // party is not this repo's route.
  if (!url.startsWith("/")) return;

  // `fetch(url, { method: "POST" })` — the verb lives in the options
  // object, not the callee.
  const second = node.arguments[1];
  if (second && ts.isObjectLiteralExpression(second)) {
    for (const prop of second.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = prop.name.getText(sourceFile).replace(/['"]/g, "");
      if (key !== "method") continue;
      const verb = literalText(prop.initializer);
      if (verb) method = verb.toLowerCase();
    }
  }

  out.push({
    url,
    method,
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
  });
}

/**
 * Collect a type alias whose right-hand side is a union of string
 * literals — `type Plan = "free" | "pro" | "enterprise"`.
 *
 * This is the TS half of `cross_language_type_drift`: a closed set
 * declared in one language and restated in another is a place where the
 * two can silently disagree.
 *
 * A single-member "union" (`type Plan = "free"`) is captured too, since
 * a set of one that has drifted from a set of three is exactly the
 * interesting case.
 */
export function collectStringUnionType(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: StringUnionType[],
): void {
  if (!ts.isTypeAliasDeclaration(node)) return;

  const members = stringLiteralMembers(node.type);
  if (members === undefined || members.length === 0) return;

  out.push({
    name: node.name.text,
    members,
    exported:
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true,
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
  });
}

/**
 * String-literal members of a type node, or `undefined` when the type
 * is not a closed set of string literals. A union containing anything
 * non-literal (`"free" | string`) is not a closed set and yields
 * `undefined` rather than a partial list — a partial list would invent
 * a disagreement that isn't there.
 */
function stringLiteralMembers(typeNode: ts.TypeNode): string[] | undefined {
  if (ts.isLiteralTypeNode(typeNode)) {
    const literal = typeNode.literal;
    return ts.isStringLiteral(literal) ? [literal.text] : undefined;
  }
  if (!ts.isUnionTypeNode(typeNode)) return undefined;

  const members: string[] = [];
  for (const member of typeNode.types) {
    if (!ts.isLiteralTypeNode(member)) return undefined;
    const literal = member.literal;
    if (!ts.isStringLiteral(literal)) return undefined;
    members.push(literal.text);
  }
  return members;
}

/** Statically-known text of a string-ish expression, if there is one. */
function literalText(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}
