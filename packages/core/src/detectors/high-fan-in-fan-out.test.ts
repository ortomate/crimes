import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import type { ImportEdge, ImportGraph } from "../imports/types.js";
import { highFanInFanOutDetector } from "./high-fan-in-fan-out.js";

interface EdgeInput {
  from: string;
  to: string;
}

function makeGraph(edges: EdgeInput[]): ImportGraph {
  const out = new Map<string, ImportEdge[]>();
  const inMap = new Map<string, ImportEdge[]>();
  const files = new Set<string>();
  const fullEdges: ImportEdge[] = edges.map((e) => ({
    from: e.from,
    to: e.to,
    specifier: `./${e.to}`,
    external: false,
    typeOnly: false,
    dynamic: false,
  }));
  for (const e of fullEdges) {
    files.add(e.from);
    files.add(e.to);
    const o = out.get(e.from) ?? [];
    o.push(e);
    out.set(e.from, o);
    const i = inMap.get(e.to) ?? [];
    i.push(e);
    inMap.set(e.to, i);
  }
  return { edges: fullEdges, out, in: inMap, files };
}

function makeCtx(file: string, graph: ImportGraph): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file,
    absolutePath: `/repo/${file}`,
    source: "",
    parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
    config: DEFAULT_CONFIG,
    imports: graph,
  };
}

describe("highFanInFanOutDetector", () => {
  it("fires on a heavy fan-in utility module", async () => {
    // util.ts is imported by f0..f19 (20 importers); the f-files have
    // fan-out of 1 each.
    const edges: EdgeInput[] = [];
    for (let i = 0; i < 20; i++) {
      edges.push({ from: `src/f${i}.ts`, to: "src/util.ts" });
    }
    const graph = makeGraph(edges);
    const findings = await highFanInFanOutDetector.run(makeCtx("src/util.ts", graph));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("high_fan_in_fan_out");
    expect(findings[0]!.evidence.some((e) => e.startsWith("fan-in: 20"))).toBe(true);
  });

  it("does not fire on a leaf file with no importers", async () => {
    const edges: EdgeInput[] = [];
    for (let i = 0; i < 20; i++) {
      edges.push({ from: `src/f${i}.ts`, to: "src/util.ts" });
    }
    const graph = makeGraph(edges);
    const findings = await highFanInFanOutDetector.run(makeCtx("src/f0.ts", graph));
    expect(findings).toEqual([]);
  });

  it("returns nothing on a tiny graph (no meaningful percentile)", async () => {
    const graph = makeGraph([{ from: "src/a.ts", to: "src/b.ts" }]);
    const findings = await highFanInFanOutDetector.run(makeCtx("src/b.ts", graph));
    expect(findings).toEqual([]);
  });

  it("escalates to medium for a 99th-percentile importer", async () => {
    // 50 importers of util → util sits well above p99.
    const edges: EdgeInput[] = [];
    for (let i = 0; i < 50; i++) {
      edges.push({ from: `src/f${i}.ts`, to: "src/util.ts" });
    }
    const graph = makeGraph(edges);
    const findings = await highFanInFanOutDetector.run(makeCtx("src/util.ts", graph));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("medium");
  });

  it("emits nothing when ctx.imports is absent", async () => {
    const findings = await highFanInFanOutDetector.run({
      kind: "language-js",
      file: "src/util.ts",
      absolutePath: "/repo/src/util.ts",
      source: "",
      parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
      config: DEFAULT_CONFIG,
    });
    expect(findings).toEqual([]);
  });
});

/**
 * A shared type module's fan-in is its job, not a smell.
 *
 * Field notes from choreograph.cc: "`src/lib/types.ts` flagged at 33
 * importers. High fan-in is a shared types module's entire job.
 * Consider exempting modules whose exports are type-only."
 *
 * **The suggested rule was measured and rejected.** That file exports
 * 24 interfaces and exactly one `const`, so an exports-are-type-only
 * test fails on the very file the complaint is about — and adding one
 * constant to any types module would silently re-arm the finding.
 *
 * The importer side is already in the graph (`ImportEdge.typeOnly`,
 * which this detector never consulted) and separates the case cleanly:
 * 19 of that file's 20 importers write `import type`.
 *
 * What moves is the *judgement*, not the evidence. The coupling is real
 * — change an interface and every importer fails to compile — but it
 * fails loudly and immediately, which is a different risk from a runtime
 * hub. The count stays, the finding stays, and the evidence gains the
 * split.
 */
/** N files importing `target`, plus enough background to set the p99. */
function graphWithFanIn(
  target: string,
  fanIn: number,
  opts: { typeOnly: boolean },
): ImportGraph {
  const edges: EdgeInput[] = [];
  for (let i = 0; i < fanIn; i += 1) edges.push({ from: `src/c${i}.ts`, to: target });
  // Background so the percentile cutoffs are not degenerate.
  for (let i = 0; i < 60; i += 1) {
    edges.push({ from: `src/c${i}.ts`, to: `src/leaf${i % 30}.ts` });
  }
  const graph = makeGraph(edges);
  if (opts.typeOnly) {
    const inEdges = graph.in.get(target)!;
    graph.in.set(
      target,
      inEdges.map((e) => ({ ...e, typeOnly: true })),
    );
  }
  return graph;
}

async function run(file: string, graph: ImportGraph) {
  return await highFanInFanOutDetector.run(makeCtx(file, graph));
}

describe("highFanInFanOutDetector — type-only importers", () => {
  it("does not promote a type-only hub to medium on fan-in alone", async () => {
    const graph = graphWithFanIn("src/types.ts", 40, { typeOnly: true });
    const findings = await run("src/types.ts", graph);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("low");
  });

  it("still promotes a runtime hub with the same fan-in", async () => {
    const graph = graphWithFanIn("src/hub.ts", 40, { typeOnly: false });
    const findings = await run("src/hub.ts", graph);
    expect(findings[0]!.severity).toBe("medium");
  });

  it("keeps the count and says how many importers take types only", async () => {
    // Evidence before judgement: "40 importers, 40 type-only" is a fact
    // worth having on an audit run.
    const graph = graphWithFanIn("src/types.ts", 40, { typeOnly: true });
    const evidence = (await run("src/types.ts", graph))[0]!.evidence.join(" ");
    expect(evidence).toMatch(/fan-in: 40 importers/);
    expect(evidence).toMatch(/40 of 40 importers take types only/);
  });

  it("tolerates a types module that also exports a constant", async () => {
    // choreograph's exports one `JOB_STUCK_THRESHOLD_SECONDS`. A rule a
    // single value import defeats is a rule that quietly stops working.
    const graph = graphWithFanIn("src/types.ts", 40, { typeOnly: true });
    // Make one of the 40 a value import.
    const edges = graph.in.get("src/types.ts")!;
    edges[0] = { ...edges[0]!, typeOnly: false };
    const findings = await run("src/types.ts", graph);
    expect(findings[0]!.severity).toBe("low");
  });

  it("promotes once value importers are the majority", async () => {
    const graph = graphWithFanIn("src/mixed.ts", 40, { typeOnly: true });
    const edges = graph.in.get("src/mixed.ts")!;
    for (let i = 0; i < 20; i += 1) edges[i] = { ...edges[i]!, typeOnly: false };
    const findings = await run("src/mixed.ts", graph);
    expect(findings[0]!.severity).toBe("medium");
  });
});
