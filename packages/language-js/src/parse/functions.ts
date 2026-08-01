import ts from "typescript";
import { classifyShape } from "./shapes.js";
import type { FunctionKind, ParsedFunction } from "./types.js";

export function collectFunction(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: ParsedFunction[],
  absolutePath: string,
): void {
  if (ts.isFunctionDeclaration(node)) {
    pushFunction(node, sourceFile, out, "function", node.name?.text, absolutePath);
  } else if (ts.isMethodDeclaration(node)) {
    pushFunction(node, sourceFile, out, "method", methodName(node), absolutePath);
  } else if (ts.isConstructorDeclaration(node)) {
    pushFunction(node, sourceFile, out, "constructor", "constructor", absolutePath);
  } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const kind: FunctionKind = ts.isArrowFunction(node) ? "arrow" : "function_expression";
    pushFunction(node, sourceFile, out, kind, inferAssignedName(node), absolutePath);
  } else if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    pushFunction(node, sourceFile, out, "method", methodName(node), absolutePath);
  }
}

function pushFunction(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: ParsedFunction[],
  kind: FunctionKind,
  name: string | undefined,
  absolutePath: string,
): void {
  const { line: startLine } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  const { line: endLine } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  const { shape, shapeEvidence } = classifyShape({
    node,
    kind,
    name,
    absolutePath,
  });
  const entry: ParsedFunction = {
    name,
    kind,
    startLine: startLine + 1,
    endLine: endLine + 1,
    shape,
  };
  if (shapeEvidence && shapeEvidence.length > 0) {
    entry.shapeEvidence = shapeEvidence;
  }
  out.push(entry);
}

function methodName(
  node: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
): string | undefined {
  const n = node.name;
  if (!n) return undefined;
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text;
  if (ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  return undefined;
}

function inferAssignedName(node: ts.Node): string | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (
    ts.isPropertyDeclaration(parent) &&
    (ts.isIdentifier(parent.name) || ts.isPrivateIdentifier(parent.name))
  ) {
    return parent.name.text;
  }
  return undefined;
}
