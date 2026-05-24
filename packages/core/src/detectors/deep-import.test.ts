import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import type { ImportEdge, ImportGraph } from "../imports/types.js";
import { deepImportDetector as _deepImportDetector } from "./deep-import.js";
const deepImportDetector = _deepImportDetector as LanguageJsDetector;

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
    const graph = makeGraph([
      { from: "src/a.ts", specifier: "lib/dist/internal/x" },
    ]);
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
    const graph = makeGraph([
      { from: "src/a.ts", specifier: "@scope/pkg/feature" },
    ]);
    const findings = await deepImportDetector.run(makeCtx("src/a.ts", graph));
    expect(findings).toEqual([]);
  });

  it("ignores relative imports", async () => {
    const graph = makeGraph([
      { from: "src/a.ts", specifier: "./deep/path/to/file", external: false, to: "src/deep/path/to/file.ts" },
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
