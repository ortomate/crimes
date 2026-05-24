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
    const graph = makeGraph([
      { from: "src/a.ts", to: "src/b.ts" },
    ]);
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
