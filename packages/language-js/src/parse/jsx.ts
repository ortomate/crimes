import ts from "typescript";
import { propStringValue } from "./utils.js";
import type { JsxAttributeValue, JsxElementInfo, JsxNode } from "./types.js";

/**
 * Collect a JSX root — a `JsxElement` / `JsxSelfClosingElement` / `JsxFragment`
 * that is not itself nested inside another JSX node. We rely on the parent
 * pointers set up by `createSourceFile(..., true, ...)` to short-circuit
 * nested elements; nested nodes are walked as children when their root is
 * processed, not as new roots.
 */
export function collectJsxRoot(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  source: string,
  out: JsxElementInfo[],
): void {
  if (
    !ts.isJsxElement(node) &&
    !ts.isJsxSelfClosingElement(node) &&
    !ts.isJsxFragment(node)
  ) {
    return;
  }
  if (isInsideJsx(node)) return;

  if (ts.isJsxFragment(node)) {
    for (const child of node.children) {
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
        out.push(buildJsxElementInfo(child, sourceFile, source));
      }
    }
    return;
  }
  out.push(buildJsxElementInfo(node, sourceFile, source));
}

function isInsideJsx(node: ts.Node): boolean {
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p)) {
      return true;
    }
    p = p.parent;
  }
  return false;
}

function buildJsxElementInfo(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  sourceFile: ts.SourceFile,
  source: string,
): JsxElementInfo {
  if (ts.isJsxSelfClosingElement(node)) {
    const name = jsxTagText(node.tagName) ?? "<unknown>";
    const { line: startLine } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    const { line: endLine } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    return {
      name,
      lines: [startLine + 1, endLine + 1],
      attributes: buildAttributes(node.attributes, source),
      children: [],
      selfClosing: true,
    };
  }

  const opening = node.openingElement;
  const name = jsxTagText(opening.tagName) ?? "<unknown>";
  const { line: startLine } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  const { line: endLine } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  const children: JsxNode[] = [];
  for (const child of node.children) {
    if (ts.isJsxText(child)) {
      const text = child.text.replace(/\s+/g, " ").trim();
      if (text.length === 0) continue;
      children.push({ kind: "text", value: text });
      continue;
    }
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      children.push({
        kind: "element",
        element: buildJsxElementInfo(child, sourceFile, source),
      });
      continue;
    }
    if (ts.isJsxFragment(child)) {
      for (const grand of child.children) {
        if (ts.isJsxElement(grand) || ts.isJsxSelfClosingElement(grand)) {
          children.push({
            kind: "element",
            element: buildJsxElementInfo(grand, sourceFile, source),
          });
        }
      }
    }
    // JsxExpression and other shapes are intentionally dropped from the
    // child list — we only carry statically representable values.
  }
  return {
    name,
    lines: [startLine + 1, endLine + 1],
    attributes: buildAttributes(opening.attributes, source),
    children,
    selfClosing: false,
  };
}

function buildAttributes(
  attrs: ts.JsxAttributes,
  source: string,
): Map<string, JsxAttributeValue> {
  const out = new Map<string, JsxAttributeValue>();
  for (const attr of attrs.properties) {
    if (ts.isJsxSpreadAttribute(attr)) {
      const exprSrc = source.slice(attr.expression.getStart(), attr.expression.getEnd());
      out.set(`...${exprSrc}`, { kind: "spread", source: exprSrc });
      continue;
    }
    if (!ts.isJsxAttribute(attr)) continue;
    const name = jsxAttrName(attr.name);
    if (!name) continue;
    const init = attr.initializer;
    if (init === undefined) {
      out.set(name, { kind: "boolean", value: true });
      continue;
    }
    if (ts.isStringLiteral(init)) {
      out.set(name, { kind: "string", value: init.text });
      continue;
    }
    if (ts.isJsxExpression(init)) {
      if (init.expression === undefined) continue;
      const expr = init.expression;
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
        out.set(name, { kind: "string", value: expr.text });
        continue;
      }
      const exprSrc = source.slice(expr.getStart(), expr.getEnd());
      out.set(name, { kind: "expression", source: exprSrc });
    }
  }
  return out;
}

function jsxAttrName(name: ts.JsxAttributeName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  // JsxNamespacedName ("xmlns:foo") — keep the joined form so detectors can
  // pattern-match on the full attribute text.
  if (ts.isJsxNamespacedName(name)) {
    return `${name.namespace.text}:${name.name.text}`;
  }
  return undefined;
}

export function jsxTagName(tag: ts.JsxTagNameExpression): string | undefined {
  if (ts.isIdentifier(tag)) return tag.text;
  // PropertyAccessExpression (e.g. `Foo.Bar`) — keep the tail.
  if (ts.isPropertyAccessExpression(tag)) return tag.name.text;
  return undefined;
}

export function jsxTextContent(node: ts.JsxElement): string | undefined {
  const chunks: string[] = [];
  for (const child of node.children) {
    if (ts.isJsxText(child)) {
      chunks.push(child.text);
    } else if (
      ts.isJsxExpression(child) &&
      child.expression &&
      propStringValue(child.expression) !== undefined
    ) {
      chunks.push(propStringValue(child.expression)!);
    } else {
      // Mixed content (other JSX, computed expressions). Don't risk a false reading.
      return undefined;
    }
  }
  const joined = chunks.join("").trim();
  return joined.length > 0 ? joined : undefined;
}

function jsxTagText(tag: ts.JsxTagNameExpression): string | undefined {
  if (ts.isIdentifier(tag)) return tag.text;
  if (ts.isPropertyAccessExpression(tag)) {
    const head = jsxTagText(tag.expression);
    const tail = tag.name.text;
    return head ? `${head}.${tail}` : tail;
  }
  if (ts.isJsxNamespacedName(tag)) {
    return `${tag.namespace.text}:${tag.name.text}`;
  }
  return undefined;
}
