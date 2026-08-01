import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import type { ImportEdge, ImportGraph } from "../imports/types.js";
import { circularDependencyDetector } from "./circular-dependency.js";

interface EdgeInput {
  from: string;
  to: string;
  specifier?: string;
  typeOnly?: boolean;
}

function makeGraph(edges: EdgeInput[]): ImportGraph {
  const out = new Map<string, ImportEdge[]>();
  const inMap = new Map<string, ImportEdge[]>();
  const files = new Set<string>();
  const fullEdges: ImportEdge[] = edges.map((e) => ({
    from: e.from,
    to: e.to,
    specifier: e.specifier ?? `./${e.to}`,
    external: false,
    typeOnly: e.typeOnly === true,
    dynamic: false,
  }));
  for (const e of fullEdges) {
    files.add(e.from);
    if (e.to.length > 0) files.add(e.to);
    const o = out.get(e.from) ?? [];
    o.push(e);
    out.set(e.from, o);
    if (e.to.length > 0) {
      const i = inMap.get(e.to) ?? [];
      i.push(e);
      inMap.set(e.to, i);
    }
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

describe("circularDependencyDetector", () => {
  it("fires once on a two-file cycle, anchored on the lex-first file", async () => {
    const graph = makeGraph([
      { from: "src/a.ts", to: "src/b.ts" },
      { from: "src/b.ts", to: "src/a.ts" },
    ]);
    const aFindings = await circularDependencyDetector.run(makeCtx("src/a.ts", graph));
    const bFindings = await circularDependencyDetector.run(makeCtx("src/b.ts", graph));
    expect(aFindings).toHaveLength(1);
    expect(bFindings).toHaveLength(0);
    expect(aFindings[0]!.severity).toBe("medium");
    expect(aFindings[0]!.related_files).toEqual(["src/b.ts"]);
  });

  it("escalates to high on a three-file cycle", async () => {
    const graph = makeGraph([
      { from: "src/a.ts", to: "src/b.ts" },
      { from: "src/b.ts", to: "src/c.ts" },
      { from: "src/c.ts", to: "src/a.ts" },
    ]);
    const findings = await circularDependencyDetector.run(makeCtx("src/a.ts", graph));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
    expect(
      new Set(
        findings[0]!.evidence
          .filter((e) => e.startsWith("member:"))
          .map((e) => e.replace("member: ", "")),
      ),
    ).toEqual(new Set(["src/a.ts", "src/b.ts", "src/c.ts"]));
  });

  it("skips type-only cycles", async () => {
    const graph = makeGraph([
      { from: "src/a.ts", to: "src/b.ts", typeOnly: true },
      { from: "src/b.ts", to: "src/a.ts", typeOnly: true },
    ]);
    const findings = await circularDependencyDetector.run(makeCtx("src/a.ts", graph));
    expect(findings).toEqual([]);
  });

  it("emits nothing for a cycle-free chain", async () => {
    const graph = makeGraph([
      { from: "src/a.ts", to: "src/b.ts" },
      { from: "src/b.ts", to: "src/c.ts" },
    ]);
    const findings = await circularDependencyDetector.run(makeCtx("src/a.ts", graph));
    expect(findings).toEqual([]);
  });

  it("emits nothing when ctx.imports is absent", async () => {
    const findings = await circularDependencyDetector.run({
      kind: "language-js",
      file: "src/a.ts",
      absolutePath: "/repo/src/a.ts",
      source: "",
      parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
      config: DEFAULT_CONFIG,
    });
    expect(findings).toEqual([]);
  });
});
