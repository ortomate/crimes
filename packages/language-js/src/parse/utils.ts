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

export function countNonEmptyLines(source: string): number {
  const lines = source.split(/\r?\n/);
  // Trim trailing empty newline if present, so a 10-line file with a final
  // newline still reports 10 lines.
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
