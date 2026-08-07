import ts from "typescript";

export function pickScriptKind(ext: string): ts.ScriptKind {
  switch (ext) {
    case ".ts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".mjs":
    case ".cjs":
    case ".js":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/**
 * Count the lines in a source file.
 *
 * A trailing newline terminates the last line rather than starting a
 * new one, so a 10-line file written with a final `\n` is 10 lines.
 * Blank lines count — they are lines.
 *
 * Called `countNonEmptyLines` until `0.22.0`, which was a lie of
 * exactly the kind `name_behavior_mismatch` charges: it never skipped a
 * blank line. Renamed rather than changed, and the two halves of that
 * decision are worth separating.
 *
 * **The name was the defect; the behaviour was not.** `large_file` does
 * not call this — it reads `UniversalFile.lineCount`, whose `countLines`
 * is honestly named and must stay in step with this one. Counting
 * blank lines was measured as a deliberate keep in `0.22.0`; see
 * `docs/dogfooding/2026-08-03-remediation.md` § "Deliberately not
 * changed".
 *
 * **Nothing in production reads the field this feeds.**
 * `ParsedFile.lineCount` is set here, asserted in `parse.test.ts`, and
 * consumed by no detector — the ~30 other references are test fixtures
 * satisfying the type. Kept because a parsed file having a line count
 * is a reasonable thing for the pack's contract to say; recorded
 * because the next person to reach for it should know it is currently
 * unread rather than assume it is load-bearing.
 */
export function countSourceLines(source: string): number {
  const lines = source.split(/\r?\n/);
  let total = lines.length;
  if (total > 0 && lines[total - 1] === "") total -= 1;
  return total;
}

export function propKey(prop: ts.PropertyAssignment): string | undefined {
  const n = prop.name;
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text;
  if (ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  return undefined;
}

export function propStringValue(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

export function extractDefaultExport(node: ts.Node): string | undefined {
  // `export default function Foo() {}` / `export default class Foo {}`
  if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
    hasDefaultModifier(node) &&
    node.name
  ) {
    return node.name.text;
  }

  // `export default Foo` / `export default someExpression`
  if (ts.isExportAssignment(node) && !node.isExportEquals) {
    const expr = node.expression;
    if (ts.isIdentifier(expr)) return expr.text;
    // `export default class Foo {}` parses as an ExportAssignment in some shapes.
    if (ts.isClassExpression(expr) && expr.name) return expr.name.text;
    if (ts.isFunctionExpression(expr) && expr.name) return expr.name.text;
    return undefined;
  }

  // `export { Foo as default }`
  if (
    ts.isExportDeclaration(node) &&
    node.exportClause &&
    ts.isNamedExports(node.exportClause)
  ) {
    for (const spec of node.exportClause.elements) {
      if (spec.name.text === "default" && spec.propertyName) {
        return spec.propertyName.text;
      }
    }
  }

  return undefined;
}

function hasDefaultModifier(node: ts.FunctionDeclaration | ts.ClassDeclaration): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!modifiers) return false;
  return modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}
