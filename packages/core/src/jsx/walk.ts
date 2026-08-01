/**
 * JSX query layer.
 *
 * Frontend detectors (`design_token_escape`, `accessible_interaction_risk`,
 * `duplicate_component_shape`, `responsive_fragility`, `copy_ia_drift`)
 * read from this module rather than walking the TS AST themselves. The
 * actual JSX tree is built once by `@crimes/language-js` during its
 * single AST pass and attached to `ParsedFile.jsxElements`; the helpers
 * here just expose ergonomic queries over that tree.
 */

import type {
  JsxAttributeValue,
  JsxElementInfo,
  JsxNode,
  ParsedFile,
} from "@crimes/language-js";

export type {
  JsxAttributeValue,
  JsxElementInfo,
  JsxNode,
} from "@crimes/language-js";

/**
 * Return the top-level JSX trees in a parsed file. `source` is accepted
 * for forward compatibility with detectors that may want to slice raw
 * source text alongside the structured tree.
 */
export function walkJsx(args: { source: string; ast: ParsedFile }): JsxElementInfo[] {
  // The `source` parameter is intentionally unused today — the parser
  // already captures every statically representable JSX value into
  // `ast.jsxElements`. Detectors that need raw expression text read it
  // from `JsxAttributeValue.source` instead.
  void args.source;
  return args.ast.jsxElements ?? [];
}

/**
 * Recursively flatten a JSX tree and return every descendant element
 * (including the roots) for which `predicate` returns true. Element-order
 * traversal: an element is visited before its children, matching the way
 * detectors emit line-ordered evidence.
 */
export function findJsxElements(
  elements: JsxElementInfo[],
  predicate: (el: JsxElementInfo) => boolean,
): JsxElementInfo[] {
  const out: JsxElementInfo[] = [];
  const visit = (el: JsxElementInfo): void => {
    if (predicate(el)) out.push(el);
    for (const child of el.children) {
      if (child.kind === "element") visit(child.element);
    }
  };
  for (const root of elements) visit(root);
  return out;
}
