import type { Node } from "web-tree-sitter";
import type { PyAssignment, PyInitializerKind } from "./types.js";
import { flatText, lineOf } from "./utils.js";

/**
 * Classify an assignment's right-hand side.
 *
 * `boolean_naming_drift.py` needs to answer "is this name bound to a
 * boolean?" without type inference. The classification is deliberately
 * conservative — anything it cannot place lands in `other`, and the
 * detector only fires on the kinds that are unambiguously boolean.
 */
export function classifyInitializer(right: Node | null): PyInitializerKind {
  if (!right) return "other";
  switch (right.type) {
    case "true":
    case "false":
      return "boolean_literal";
    case "not_operator":
      return "negation";
    case "boolean_operator":
      return "logical";
    case "comparison_operator":
      return classifyComparison(right);
    case "call":
      return "call";
    case "string":
    case "concatenated_string":
      return "string";
    case "integer":
    case "float":
      return "number";
    case "list":
    case "set":
    case "tuple":
    case "dictionary":
    case "list_comprehension":
    case "set_comprehension":
    case "dictionary_comprehension":
      return "collection";
    case "none":
      return "none";
    default:
      return "other";
  }
}

/**
 * `in` / `not in` and `is` / `is not` both parse as `comparison_operator`
 * but read very differently at a call site, so they get their own kinds.
 * Both still yield a boolean, which is what the naming detector cares
 * about — the split exists so evidence strings can say which.
 */
function classifyComparison(node: Node): PyInitializerKind {
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (!child || child.isNamed) continue;
    if (child.type === "in") return "membership";
    if (child.type === "is") return "identity";
  }
  return "comparison";
}

/** Right-hand-side kinds that are certainly a boolean value. */
export const BOOLEAN_INITIALIZER_KINDS: ReadonlySet<PyInitializerKind> = new Set([
  "boolean_literal",
  "negation",
  "comparison",
  "membership",
  "identity",
]);

/**
 * Extract an assignment, if the target is a simple name we can reason
 * about. Tuple unpacking (`a, b = f()`) and subscript targets
 * (`d["k"] = v`) are skipped — the naming detectors only look at plain
 * identifiers and `self.x` attributes.
 */
export function extractAssignment(
  node: Node,
  functionName: string | undefined,
): PyAssignment | undefined {
  const left = node.childForFieldName("left");
  if (!left) return undefined;

  let name: string;
  let attributeTarget = false;
  if (left.type === "identifier") {
    name = flatText(left);
  } else if (left.type === "attribute") {
    const object = left.childForFieldName("object");
    const objectText = flatText(object);
    // Only `self.x` / `cls.x` — an assignment to some other object's
    // attribute is that object's naming concern, not this file's.
    if (objectText !== "self" && objectText !== "cls") return undefined;
    name = flatText(left.childForFieldName("attribute"));
    attributeTarget = true;
  } else {
    return undefined;
  }
  if (name.length === 0) return undefined;

  const annotationNode = node.childForFieldName("type");
  const right = node.childForFieldName("right");

  const result: PyAssignment = {
    name,
    attributeTarget,
    initializerKind: classifyInitializer(right),
    line: lineOf(node),
  };
  if (annotationNode) result.annotation = flatText(annotationNode);
  if (functionName !== undefined) result.functionName = functionName;
  return result;
}
