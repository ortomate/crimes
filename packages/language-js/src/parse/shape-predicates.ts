import ts from "typescript";
import { TEST_CALLEES } from "./constants.js";

/**
 * If `node` is an argument to a call whose callee identifier (or property
 * accessor tail, e.g. `vi.describe`) is in the test-framework set, return
 * that callee name. Otherwise `undefined`.
 */
export function testCalleeOfParent(node: ts.Node): string | undefined {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return undefined;
  // Confirm the function is one of the call's arguments, not its callee.
  let isArgument = false;
  for (const arg of parent.arguments) {
    if (arg === node) {
      isArgument = true;
      break;
    }
  }
  if (!isArgument) return undefined;
  const callee = parent.expression;
  if (ts.isIdentifier(callee) && TEST_CALLEES.has(callee.text)) {
    return callee.text;
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.name) &&
    TEST_CALLEES.has(callee.name.text)
  ) {
    return callee.name.text;
  }
  return undefined;
}

/**
 * True when the node carries an `export` modifier — either directly (for
 * `FunctionDeclaration` / `ClassDeclaration`) or via the enclosing
 * `VariableStatement` (for arrow / function expressions assigned to
 * exported `const`s).
 */
export function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) {
    // Walk up to the nearest declaration with modifiers (typically the
    // `VariableStatement` two levels up for `export const X = ...`).
    let p: ts.Node | undefined = node.parent;
    while (p) {
      if (ts.canHaveModifiers(p)) {
        const m = ts.getModifiers(p);
        if (m?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)) {
          return true;
        }
        return false;
      }
      p = p.parent;
    }
    return false;
  }
  const m = ts.getModifiers(node);
  return m?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * True when the node itself is `export default function …` /
 * `export default class …` (a declaration with both modifiers).
 */
export function hasDefaultModifierOnDeclaration(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const m = ts.getModifiers(node);
  return m?.some((mod) => mod.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

/**
 * True when the function is the value of an `export default` —
 * either `export default function Foo() {}` (declaration with both
 * modifiers) or `export default <expr>` (ExportAssignment over a
 * function/class/arrow). The latter is common with framework files like
 * `pages/api/foo.ts` (`export default function handler() {}` or
 * `export default async function handler() {}`).
 */
export function isDefaultExportFunction(node: ts.Node): boolean {
  if (hasDefaultModifierOnDeclaration(node)) return true;
  const parent = node.parent;
  if (parent && ts.isExportAssignment(parent) && !parent.isExportEquals) {
    return true;
  }
  return false;
}

/**
 * Cheap PascalCase check: first character is uppercase ASCII, no
 * leading underscores, doesn't match an HTTP verb (those are
 * already-handled route handler names, not components).
 */
export function isPascalCase(name: string): boolean {
  if (name.length === 0) return false;
  const first = name.charCodeAt(0);
  if (first < 65 || first > 90) return false; // 'A'..'Z'
  // Exclude all-caps acronym-only names (`API`, `URL`) — they aren't
  // components in practice. Allow PascalCase with internal caps.
  if (name === name.toUpperCase()) return false;
  return true;
}

/**
 * Walk the function's body looking for any JSX node. Returns `true` on
 * the first hit. Conservative and short-circuiting — a function with one
 * JSX return is enough to flip the shape, and we don't need to count.
 */
export function bodyContainsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}
