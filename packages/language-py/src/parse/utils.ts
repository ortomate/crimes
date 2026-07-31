import type { Node } from "web-tree-sitter";

/** tree-sitter rows are 0-based; every crimes line number is 1-based. */
export function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

export function endLineOf(node: Node): number {
  return node.endPosition.row + 1;
}

/**
 * Collapse a node's source text to a single line. Decorator and base-class
 * text goes straight into `Finding.evidence`, and a multi-line decorator
 * would break the one-evidence-string-per-line contract the reporter
 * assumes.
 */
export function flatText(node: Node | null | undefined): string {
  if (!node) return "";
  return node.text.replace(/\s+/g, " ").trim();
}

export function fieldText(node: Node, field: string): string {
  return flatText(node.childForFieldName(field));
}

/**
 * Dotted callee text for a `call` node's `function` field.
 *
 * `open(...)`              → `"open"`
 * `requests.get(...)`      → `"requests.get"`
 * `datetime.datetime.now()`→ `"datetime.datetime.now"`
 *
 * Subscripts and calls in the receiver chain (`registry["x"].run()`)
 * yield the raw flattened text — detectors match on suffixes, so an
 * unusual receiver simply fails to match rather than mis-matching.
 */
export function calleeText(callNode: Node): string {
  return fieldText(callNode, "function");
}

/** Trailing segment of a dotted path: `a.b.c` → `"c"`. */
export function lastSegment(dotted: string): string {
  const idx = dotted.lastIndexOf(".");
  return idx === -1 ? dotted : dotted.slice(idx + 1);
}

/**
 * Walk every node in the tree depth-first, calling `visit` on each.
 *
 * Iterative rather than recursive: a deeply nested Python file (long
 * `if/elif` chains parse into right-leaning trees) can exceed the call
 * stack, and a stack overflow inside a scan would take out the whole
 * run rather than degrading one file.
 */
export function walk(root: Node, visit: (node: Node) => void): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    // Push in reverse so children are visited left-to-right.
    for (let i = node.namedChildCount - 1; i >= 0; i -= 1) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
}

/**
 * Compound statements that open a new indentation level. Used to measure
 * nesting depth — the Python analogue of the JS deep-nesting signal.
 */
const NESTING_TYPES = new Set([
  "if_statement",
  "elif_clause",
  "else_clause",
  "for_statement",
  "while_statement",
  "try_statement",
  "except_clause",
  "finally_clause",
  "with_statement",
  "match_statement",
  "case_clause",
]);

/**
 * Deepest chain of nested compound statements within a function body.
 *
 * `elif` is deliberately *not* counted as deeper than its `if`: Python
 * parses `elif` as a nested clause, but a flat `if/elif/elif` chain reads
 * as one level to a human and should not be scored as three.
 */
export function maxNestingDepth(body: Node): number {
  let deepest = 0;
  const stack: Array<{ node: Node; depth: number }> = [{ node: body, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > deepest) deepest = depth;
    for (let i = 0; i < node.namedChildCount; i += 1) {
      const child = node.namedChild(i);
      if (!child) continue;
      // Don't descend into nested function/class definitions — their
      // nesting is their own, and `large_function.py` measures each
      // separately.
      if (
        child.type === "function_definition" ||
        child.type === "class_definition" ||
        child.type === "decorated_definition"
      ) {
        continue;
      }
      const opensLevel =
        NESTING_TYPES.has(child.type) && child.type !== "elif_clause";
      stack.push({ node: child, depth: opensLevel ? depth + 1 : depth });
    }
  }
  return deepest;
}
