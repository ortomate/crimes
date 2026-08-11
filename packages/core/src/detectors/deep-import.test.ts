import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import type { ImportEdge, ImportGraph } from "../imports/types.js";
import { deepImportDetector } from "./deep-import.js";

interface EdgeInput {
  from: string;
  specifier: string;
  to?: string;
  external?: boolean;
  typeOnly?: boolean;
}

function makeGraph(edges: EdgeInput[]): ImportGraph {
  const out = new Map<string, ImportEdge[]>();
  const inMap = new Map<string, ImportEdge[]>();
  const files = new Set<string>();
  const fullEdges: ImportEdge[] = edges.map((e) => ({
    from: e.from,
    to: e.to ?? "",
    specifier: e.specifier,
    external: e.external ?? true,
    typeOnly: e.typeOnly === true,
    dynamic: false,
  }));
  for (const e of fullEdges) {
    files.add(e.from);
    const list = out.get(e.from) ?? [];
    list.push(e);
    out.set(e.from, list);
    if (!e.external && e.to.length > 0) {
      files.add(e.to);
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

describe("deepImportDetector", () => {
  it("fires on an unscoped package's deep dist path", async () => {
    const graph = makeGraph([{ from: "src/a.ts", specifier: "lib/dist/internal/x" }]);
    const findings = await deepImportDetector.run(makeCtx("src/a.ts", graph));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("deep_import");
    expect(findings[0]!.severity).toBe("low");
  });

  it("fires on a scoped package's deep internal path", async () => {
    const graph = makeGraph([
      { from: "src/a.ts", specifier: "@scope/lib/dist/internal/_private/x" },
      { from: "src/a.ts", specifier: "@scope/lib/dist/internal/_private/y" },
      { from: "src/a.ts", specifier: "@scope/lib/dist/internal/_private/z" },
    ]);
    const findings = await deepImportDetector.run(makeCtx("src/a.ts", graph));
    expect(findings).toHaveLength(1);
    // 3+ → medium.
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.evidence.some((e) => e.startsWith("specifier:"))).toBe(true);
  });

  it("does not fire on a shallow sub-export (`@scope/pkg/feature`)", async () => {
    const graph = makeGraph([{ from: "src/a.ts", specifier: "@scope/pkg/feature" }]);
    const findings = await deepImportDetector.run(makeCtx("src/a.ts", graph));
    expect(findings).toEqual([]);
  });

  it("ignores relative imports", async () => {
    const graph = makeGraph([
      {
        from: "src/a.ts",
        specifier: "./deep/path/to/file",
        external: false,
        to: "src/deep/path/to/file.ts",
      },
    ]);
    const findings = await deepImportDetector.run(makeCtx("src/a.ts", graph));
    expect(findings).toEqual([]);
  });

  it("ignores node: builtins even when the tail is deep", async () => {
    const graph = makeGraph([
      { from: "src/a.ts", specifier: "node:fs/promises/internal/something" },
    ]);
    const findings = await deepImportDetector.run(makeCtx("src/a.ts", graph));
    expect(findings).toEqual([]);
  });

  /**
   * The shape gap this closed in `0.25.2`: the detector expressed no
   * intrinsic, so a file reaching into one package's internals and a file
   * reaching into twenty-eight scored identically. cal.com has both.
   */
  it("ramps agent_risk with the number of deep specifiers", async () => {
    const deep = (n: number): EdgeInput[] =>
      Array.from({ length: n }, (_, i) => ({
        from: "src/a.ts",
        specifier: `@scope/lib${i}/dist/internal/_private/x`,
      }));
    const riskFor = async (n: number): Promise<number | undefined> => {
      const findings = await deepImportDetector.run(
        makeCtx("src/a.ts", makeGraph(deep(n))),
      );
      return findings[0]?.scores.agent_risk;
    };
    // base is the value already in force for a single offender, so the
    // 72% of cal.com's findings that have exactly one do not move.
    expect(await riskFor(1)).toBe(0.3);
    expect(await riskFor(2)).toBe(0.35);
    expect(await riskFor(6)).toBe(0.55);
    // capped, not unbounded
    expect(await riskFor(28)).toBe(0.55);
  });

  it("emits nothing when ctx.imports is absent", async () => {
    const findings = await deepImportDetector.run({
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
