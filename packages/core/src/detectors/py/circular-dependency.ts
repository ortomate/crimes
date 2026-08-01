import type { LanguagePyDetector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import type { ImportGraph } from "../../imports/types.js";
import { intrinsicFor, plural, severityScore } from "./shared.js";

/**
 * Python import cycles, over the shared import graph.
 *
 * Same Tarjan SCC walk as the JS detector, restricted to Python members.
 * The restriction matters: a mixed repo's graph carries both languages'
 * edges, and a "cycle" spanning both would be a cross-language finding
 * (0.15.0), not this one. Anchoring on the lexicographically first
 * member means the per-file detector loop emits each cycle exactly once.
 *
 * Python cycles are a genuinely different hazard from JS ones, which is
 * why this is not just the JS detector pointed at new files — see
 * `whyItMatters`.
 */
export const circularDependencyPyDetector: LanguagePyDetector = {
  id: "circular_dependency.py",
  name: "Circular Dependency (Python)",
  description:
    "Flags strongly-connected components among Python modules in the import graph.",
  whyItMatters:
    "A Python import cycle is not merely untidy — it can raise at import time. " +
    "Modules execute top to bottom as they are first imported, so when two modules " +
    "import each other the one that loses the race sees a half-initialised module " +
    "object and fails with `ImportError: cannot import name X from partially " +
    "initialized module`. Whether it raises depends on which module the process " +
    "imports first, so the same cycle can work under `pytest` and break under " +
    "`gunicorn`. Teams usually paper over it by moving an import inside a function, " +
    "which hides the cycle from every static reader — including the next agent — " +
    "without removing it.",

  pack: "language-py",
  run(ctx) {
    if (!ctx.imports) return [];
    const cycles = collectPythonCycles(ctx.imports);
    if (cycles.length === 0) return [];

    const findings: Finding[] = [];
    for (const cycle of cycles) {
      if (cycle[0] !== ctx.file) continue;
      findings.push(buildFinding(cycle));
    }
    return findings;
  },
};

const PY_FILE_RE = /\.pyi?$/;

/**
 * Tarjan's SCC algorithm over the Python subgraph. Iterative rather than
 * recursive — a deep dependency chain in a large package would otherwise
 * risk a stack overflow that takes out the whole scan.
 */
function collectPythonCycles(graph: ImportGraph): string[][] {
  const adj = new Map<string, Set<string>>();
  const ensure = (key: string): Set<string> => {
    const existing = adj.get(key);
    if (existing) return existing;
    const fresh = new Set<string>();
    adj.set(key, fresh);
    return fresh;
  };
  for (const edge of graph.edges) {
    if (edge.external || edge.to.length === 0) continue;
    if (!PY_FILE_RE.test(edge.from) || !PY_FILE_RE.test(edge.to)) continue;
    ensure(edge.from).add(edge.to);
    ensure(edge.to);
  }

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  for (const start of [...adj.keys()].sort()) {
    if (index.has(start)) continue;

    // Explicit work stack: each frame tracks how far through its
    // successors it has got.
    const work: Array<{ node: string; successors: string[]; i: number }> = [
      { node: start, successors: [...(adj.get(start) ?? [])].sort(), i: 0 },
    ];
    index.set(start, counter);
    lowlink.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.i < frame.successors.length) {
        const next = frame.successors[frame.i]!;
        frame.i += 1;
        if (!index.has(next)) {
          index.set(next, counter);
          lowlink.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({
            node: next,
            successors: [...(adj.get(next) ?? [])].sort(),
            i: 0,
          });
        } else if (onStack.has(next)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, index.get(next)!));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowlink.set(
          parent.node,
          Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!),
        );
      }
      if (lowlink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let popped: string;
        do {
          popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
        } while (popped !== frame.node);
        if (component.length >= 2) sccs.push(component.sort());
      }
    }
  }

  sccs.sort((a, b) => a[0]!.localeCompare(b[0]!));
  return sccs;
}

function buildFinding(cycle: string[]): Finding {
  const severity: Severity = cycle.length >= 3 ? "high" : "medium";
  const anchor = cycle[0]!;
  const related = cycle.filter((f) => f !== anchor);

  return {
    id: "",
    type: "circular_dependency",
    charge: "Circular Dependency",
    severity,
    confidence: 0.95,
    file: anchor,
    summary:
      `Import cycle through ${cycle.length} Python ${plural(cycle.length, "module")}: ` +
      "each module in the ring transitively imports itself. Depending on which module " +
      "the process imports first, this can raise ImportError at startup.",
    evidence: [
      `cycle size: ${cycle.length} ${plural(cycle.length, "module")}`,
      ...cycle.map((file) => `member: ${file}`),
      "Python executes a module top-to-bottom on first import, so a module in a cycle " +
        "can be observed half-initialised",
      "whichever module is imported first decides whether this raises — so it can pass " +
        "under pytest and fail under a production server",
    ],
    effort: "medium",
    fix_shape: "extract the shared names into a leaf module both can import",
    scores: {
      severity: severityScore(severity),
      confidence: 0.95,
      // Bigger rings are harder to break and more likely to surprise —
      // and unlike the JS case this can be a startup crash, so the base
      // sits above the JS detector's implied fallback.
      agent_risk: intrinsicFor({
        count: cycle.length,
        base: 0.68,
        step: 0.07,
        cap: 0.92,
      }),
    },
    suggested_actions: [
      {
        kind: "break_cycle",
        description:
          "Extract the names both ends need into a third module with no imports back " +
          "into the ring. Prefer that over moving the import inside a function — a " +
          "deferred import removes the error without removing the cycle, and hides it " +
          "from every static reader.",
        risk: "medium",
      },
    ],
    related_files: related.length > 0 ? related : undefined,
  };
}
