import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";
import type { ImportEdge, ImportGraph } from "../imports/types.js";
import { intrinsicFrom } from "../scoring/intrinsic.js";

/**
 * Fires once per strongly-connected component (SCC) of size ≥ 2 in the
 * import graph. Type-only cycles are skipped — they do not contribute
 * runtime risk, only declaration churn.
 *
 * Each cycle is anchored on the lexicographically first file in the SCC
 * so the per-file detector loop emits each finding exactly once.
 */
export const circularDependencyDetector: LanguageJsDetector = {
  id: "circular_dependency",
  name: "Circular Dependency",
  description:
    "Flags strongly-connected components in the import graph — files that " +
    "transitively depend on themselves.",
  whyItMatters:
    "Cycles in the import graph force every consumer to load the whole " +
    "ring whether they wanted to or not, and they make tree-shaking and " +
    "test isolation unreliable. Agents editing one file in the cycle " +
    "often introduce subtle re-entry bugs because the runtime ordering " +
    "is no longer obvious from the code.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.imports) return [];
    const sccs = collectValueCycles(ctx.imports);
    if (sccs.length === 0) return [];

    const findings: Finding[] = [];
    for (const cycle of sccs) {
      const anchor = cycle[0];
      if (anchor !== ctx.file) continue;
      findings.push(buildFinding(cycle));
    }
    return findings;
  },
};

/**
 * Tarjan's strongly-connected-component algorithm over the value-edge
 * subgraph (type-only edges dropped first). Each SCC is returned with
 * its members sorted lexicographically so emission is deterministic and
 * the anchor file is always position 0.
 */
function collectValueCycles(graph: ImportGraph): string[][] {
  const adj = buildValueAdjacency(graph);
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let index = 0;

  const nodes = [...adj.keys()].sort();

  const strongConnect = (v: string): void => {
    indices.set(v, index);
    lowlinks.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length >= 2) sccs.push(component.sort());
    }
  };

  for (const v of nodes) {
    if (!indices.has(v)) strongConnect(v);
  }

  // Cycles within the SCC graph can include the entry-point pair
  // exactly. Tarjan already collapses repeated visits; sort the output
  // by anchor for deterministic emission order.
  sccs.sort((a, b) => a[0]!.localeCompare(b[0]!));
  return sccs;
}

function buildValueAdjacency(graph: ImportGraph): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const ensure = (key: string): Set<string> => {
    const existing = adj.get(key);
    if (existing) return existing;
    const fresh = new Set<string>();
    adj.set(key, fresh);
    return fresh;
  };
  for (const edge of graph.edges) {
    if (edge.external) continue;
    if (edge.to.length === 0) continue;
    if (edgeIsTypeOnly(edge)) continue;
    ensure(edge.from).add(edge.to);
    ensure(edge.to);
  }
  return adj;
}

function edgeIsTypeOnly(edge: ImportEdge): boolean {
  return edge.typeOnly === true;
}

function buildFinding(cycle: string[]): Finding {
  const severity: Severity = cycle.length >= 3 ? "high" : "medium";
  const confidence = 0.95;
  const anchor = cycle[0]!;

  const evidence: string[] = [
    `cycle size: ${cycle.length} file${cycle.length === 1 ? "" : "s"}`,
  ];
  // Show every file in dependency order (lex anchor → next → … → anchor).
  for (const file of cycle) evidence.push(`member: ${file}`);

  const related = cycle.filter((f) => f !== anchor);

  return {
    id: "",
    type: "circular_dependency",
    charge: "Circular Dependency",
    severity,
    confidence,
    file: anchor,
    summary:
      `Detected an import cycle through ${cycle.length} file` +
      `${cycle.length === 1 ? "" : "s"}: each file in the ring transitively ` +
      "depends on itself. Edits inside the cycle risk re-entry bugs and " +
      "make tree-shaking unreliable.",
    evidence,
    effort: "medium",
    fix_shape: "extract shared types to a leaf module",
    scores: {
      severity: severityScore(severity),
      confidence,
      // A ring of eight is not the same finding as a ring of two, and
      // until 0.25.2 this detector scored them identically: it expressed
      // no intrinsic, so every cycle took the flat 0.45 from
      // INTRINSIC_DEFAULTS while the Python twin ramped 0.68 → 0.92 on
      // the same evidence. On hono, a 4-file cycle and a 2-file cycle
      // both landed on agent_risk 0.09.
      //
      // The ladder counts `cycle.length - 1`, not `cycle.length`,
      // because an SCC cannot have fewer than two members: one unit of
      // evidence is the smallest ring there is. That makes `base` the
      // value of a 2-file cycle, which is exactly the 0.45 this detector
      // already scored — so no existing finding moves down, and only
      // rings of three or more move at all.
      //
      // The constants are NOT the Python pack's, deliberately. That
      // detector argues its higher 0.68 base on `ImportError` at import
      // time, which is a Python-specific failure a TypeScript cycle
      // does not have. The gap is recorded in KNOWN_DISAGREEMENTS with
      // that argument rather than closed by copying a number across a
      // language boundary it was reasoned about within.
      //
      // 0.70 as the ceiling puts a large ring above `large_function`
      // (0.55) and below `missing_agent_context` (0.80), which is the
      // right neighbourhood for "you cannot reason about this a piece
      // at a time". Reached at seven files. Note the whole class is then
      // scaled by STRUCTURAL_CEILING, so the visible span is 0.14–0.21
      // of the pre-scale value.
      agent_risk: intrinsicFrom(cycle.length - 1, {
        base: 0.45,
        step: 0.06,
        cap: 0.7,
      }),
    },
    suggested_actions: [
      {
        kind: "break_cycle",
        description:
          "Extract the shared types or helpers into a third module both " +
          "ends of the cycle can import from, or convert one direction to " +
          "an `import type` so it does not contribute a runtime edge.",
        risk: "medium",
      },
    ],
    related_files: related.length > 0 ? related : undefined,
  };
}

function severityScore(s: Severity): number {
  return s === "high" ? 0.85 : s === "medium" ? 0.6 : 0.35;
}
