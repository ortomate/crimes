import type { Node } from "web-tree-sitter";
import type { PyImport } from "./types.js";
import { flatText, lineOf } from "./utils.js";

/**
 * Extract every `import` / `from … import …` statement.
 *
 * `from __future__ import annotations` is skipped — it is a compiler
 * directive, not a dependency, and counting it would give every modern
 * Python file a spurious import edge.
 */
export function extractImport(node: Node): PyImport | undefined {
  if (node.type === "import_statement") return fromPlainImport(node);
  if (node.type === "import_from_statement") return fromFromImport(node);
  return undefined;
}

function fromPlainImport(node: Node): PyImport | undefined {
  // `import a.b.c` and `import a.b.c as abc` — grammar puts either a
  // `dotted_name` or an `aliased_import` in the `name` field.
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return undefined;

  let moduleNode: Node | null = nameNode;
  let alias: string | undefined;
  if (nameNode.type === "aliased_import") {
    moduleNode = nameNode.childForFieldName("name");
    const aliasNode = nameNode.childForFieldName("alias");
    if (aliasNode) alias = flatText(aliasNode);
  }
  if (!moduleNode) return undefined;

  const module = flatText(moduleNode);
  if (module.length === 0) return undefined;

  const result: PyImport = {
    kind: "import",
    module,
    relativeLevel: 0,
    names: [],
    wildcard: false,
    line: lineOf(node),
    depth: module.split(".").length,
  };
  if (alias !== undefined) result.alias = alias;
  return result;
}

function fromFromImport(node: Node): PyImport | undefined {
  const moduleNode = node.childForFieldName("module_name");
  if (!moduleNode) return undefined;

  let relativeLevel = 0;
  let module: string;
  if (moduleNode.type === "relative_import") {
    // `relative_import` is `(import_prefix)` optionally followed by a
    // `(dotted_name)`. The prefix text is the run of dots.
    const prefix = moduleNode.namedChild(0);
    relativeLevel = prefix ? (flatText(prefix).match(/\./g) ?? []).length : 1;
    const dotted = moduleNode.childForFieldName("name") ?? moduleNode.namedChild(1);
    module = dotted && dotted.type === "dotted_name" ? flatText(dotted) : "";
  } else {
    module = flatText(moduleNode);
  }

  // `from __future__ import …` is a directive, not a dependency.
  if (module === "__future__") return undefined;

  const names: string[] = [];
  let wildcard = false;
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === "wildcard_import") {
      wildcard = true;
      continue;
    }
    if (child.id === moduleNode.id) continue;
    if (child.type === "dotted_name") {
      names.push(flatText(child));
    } else if (child.type === "aliased_import") {
      const inner = child.childForFieldName("name");
      if (inner) names.push(flatText(inner));
    }
  }

  // Depth as written: the relative dots count toward how far the
  // specifier reaches, so `from ..a.b import x` is depth 3 for
  // `deep_import.py`'s purposes, not 2.
  const segments = module.length > 0 ? module.split(".").length : 0;

  return {
    kind: "from_import",
    module,
    relativeLevel,
    names,
    wildcard,
    line: lineOf(node),
    depth: relativeLevel + segments,
  };
}
