import ts from "typescript";
import type { DeclarationKind, InitializerKind, TypedDeclaration } from "./types.js";

/**
 * Walk every variable declaration, function parameter, and class
 * property in the source and surface the simple-identifier ones —
 * destructuring patterns and computed names are skipped so the
 * downstream naming detectors can assume `name` is a real identifier.
 *
 * Called once per top-level statement; recurses into nested function
 * bodies via the call site in `parse/index.ts`.
 */
export function collectTypedDeclaration(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: TypedDeclaration[],
): void {
  if (ts.isVariableStatement(node)) {
    const exported = hasExportModifier(node);
    const kind = variableKind(node.declarationList);
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      out.push({
        name: decl.name.text,
        declarationKind: kind,
        type: typeText(decl.type),
        initializerKind: initializerKindOf(decl.initializer),
        exported,
        line: lineOf(decl, sourceFile),
      });
    }
    return;
  }

  if (ts.isParameter(node)) {
    if (!ts.isIdentifier(node.name)) return;
    out.push({
      name: node.name.text,
      declarationKind: "param",
      type: typeText(node.type),
      initializerKind: initializerKindOf(node.initializer),
      exported: false,
      line: lineOf(node, sourceFile),
    });
    return;
  }

  if (ts.isPropertyDeclaration(node)) {
    if (!ts.isIdentifier(node.name)) return;
    out.push({
      name: node.name.text,
      declarationKind: "property",
      type: typeText(node.type),
      initializerKind: initializerKindOf(node.initializer),
      exported: false,
      line: lineOf(node, sourceFile),
    });
    return;
  }
}

function hasExportModifier(node: ts.VariableStatement): boolean {
  const modifiers = ts.getModifiers(node) ?? [];
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function variableKind(list: ts.VariableDeclarationList): DeclarationKind {
  if (list.flags & ts.NodeFlags.Const) return "const";
  if (list.flags & ts.NodeFlags.Let) return "let";
  return "var";
}

function typeText(annotation: ts.TypeNode | undefined): string | undefined {
  if (!annotation) return undefined;
  // Normalise whitespace so "User | null" and "User|null" produce the
  // same key — detectors that match on type text get a stable string.
  return annotation.getText().replace(/\s+/g, " ").trim();
}

function initializerKindOf(expr: ts.Expression | undefined): InitializerKind | undefined {
  if (!expr) return undefined;
  // Unwrap parens — `(true)` is still a boolean literal.
  let node: ts.Expression = expr;
  while (ts.isParenthesizedExpression(node)) node = node.expression;

  if (node.kind === ts.SyntaxKind.TrueKeyword) return "boolean_literal";
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "boolean_literal";

  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.ExclamationToken) return "negation";
  }

  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.LessThanToken ||
      op === ts.SyntaxKind.LessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanToken ||
      op === ts.SyntaxKind.GreaterThanEqualsToken ||
      op === ts.SyntaxKind.InKeyword ||
      op === ts.SyntaxKind.InstanceOfKeyword
    ) {
      return "comparison";
    }
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return "logical";
    }
  }

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return "string";
  }
  if (ts.isTemplateExpression(node)) return "string";
  if (ts.isNumericLiteral(node)) return "number";
  if (ts.isArrayLiteralExpression(node)) return "array";
  if (ts.isObjectLiteralExpression(node)) return "object";
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return "call";

  return "other";
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}
