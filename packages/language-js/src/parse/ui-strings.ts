import ts from "typescript";
import { LABEL_KEYS, TITLE_HOOK_CALLEES, UI_LABEL_TAGS } from "./constants.js";
import { jsxTagName, jsxTextContent } from "./jsx.js";
import { propKey, propStringValue } from "./utils.js";
import type { UiStringLiteral } from "./types.js";

export function collectUiStringLiteral(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: UiStringLiteral[],
): void {
  // 1. `<title>X</title>` and named title-like elements
  if (ts.isJsxElement(node)) {
    const opening = node.openingElement;
    const tagName = jsxTagName(opening.tagName);
    if (tagName === "title" || tagName === "Title") {
      const inner = jsxTextContent(node);
      if (inner) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          opening.getStart(sourceFile),
        );
        out.push({
          value: inner,
          line: line + 1,
          context: "jsx_title",
          source: tagName,
        });
      }
    }

    // 2. `<Breadcrumb label="X" />` etc. — attribute on a UI-label-tag.
    if (tagName && UI_LABEL_TAGS.test(tagName)) {
      pushJsxLabelAttributes(opening.attributes, sourceFile, out, tagName);
    }
  }

  if (ts.isJsxSelfClosingElement(node)) {
    const tagName = jsxTagName(node.tagName);
    if (tagName && UI_LABEL_TAGS.test(tagName)) {
      pushJsxLabelAttributes(node.attributes, sourceFile, out, tagName);
    }
  }

  // 3. `document.title = "X"`
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.left) &&
    ts.isIdentifier(node.left.expression) &&
    node.left.expression.text === "document" &&
    node.left.name.text === "title"
  ) {
    const value = propStringValue(node.right);
    if (value !== undefined) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      out.push({
        value,
        line: line + 1,
        context: "document_title",
        source: "document.title",
      });
    }
  }

  // 4. `useTitle("X")` / `setTitle("X")` / similar title hooks.
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const callee = node.expression.text;
    if (TITLE_HOOK_CALLEES.has(callee) && node.arguments.length >= 1) {
      const first = node.arguments[0];
      const value = first ? propStringValue(first) : undefined;
      if (value !== undefined) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        out.push({
          value,
          line: line + 1,
          context: "use_title",
          source: callee,
        });
      }
    }
  }

  // 5. `export const metadata = { title: "X" }` (Next.js App Router).
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "metadata" &&
    node.initializer &&
    ts.isObjectLiteralExpression(node.initializer)
  ) {
    for (const prop of node.initializer.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = propKey(prop);
      if (key !== "title") continue;
      const value = propStringValue(prop.initializer);
      if (value === undefined) continue;
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        prop.getStart(sourceFile),
      );
      out.push({
        value,
        line: line + 1,
        context: "metadata_title",
        source: "metadata.title",
      });
    }
  }
}

function pushJsxLabelAttributes(
  attrs: ts.JsxAttributes,
  sourceFile: ts.SourceFile,
  out: UiStringLiteral[],
  tagName: string,
): void {
  for (const attr of attrs.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    if (!ts.isIdentifier(attr.name)) continue;
    const key = attr.name.text;
    if (!LABEL_KEYS.has(key)) continue;
    const init = attr.initializer;
    if (!init) continue;
    let value: string | undefined;
    if (ts.isStringLiteral(init)) {
      value = init.text;
    } else if (ts.isJsxExpression(init) && init.expression) {
      value = propStringValue(init.expression);
    }
    if (value === undefined) continue;
    const { line } = sourceFile.getLineAndCharacterOfPosition(attr.getStart(sourceFile));
    out.push({
      value,
      line: line + 1,
      context: "jsx_label",
      source: tagName,
    });
  }
}
