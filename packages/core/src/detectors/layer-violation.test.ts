import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type CrimesConfig } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import type { ImportEdge, ImportGraph } from "../imports/types.js";
import { layerViolationDetector as _layerViolationDetector } from "./layer-violation.js";
const layerViolationDetector = _layerViolationDetector as LanguageJsDetector;

function makeGraph(edges: Omit<ImportEdge, "external" | "typeOnly" | "dynamic">[]): ImportGraph {
  const out = new Map<string, ImportEdge[]>();
  const inMap = new Map<string, ImportEdge[]>();
  const files = new Set<string>();
  const fullEdges: ImportEdge[] = edges.map((e) => ({
    from: e.from,
    to: e.to,
    specifier: e.specifier,
    external: false,
    typeOnly: false,
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

function makeCtx(args: {
  file: string;
  imports: ImportGraph;
  config: CrimesConfig;
}): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file: args.file,
    absolutePath: `/repo/${args.file}`,
    source: "",
    parsed: {
      lineCount: 0,
      functions: [],
      dateNowOrNewDateUses: [],
    },
    config: args.config,
    imports: args.imports,
  };
}

const TWO_LAYER_CONFIG: CrimesConfig = {
  ...DEFAULT_CONFIG,
  architecture: {
    layers: [
      { name: "ui", pattern: "src/components/**" },
      { name: "domain", pattern: "src/domain/**" },
    ],
    rules: [{ from: "domain", cannotImport: ["ui"] }],
  },
};

describe("layerViolationDetector", () => {
  it("fires once when a domain file imports a ui file", async () => {
    const graph = makeGraph([
      {
        from: "src/domain/billing.ts",
        to: "src/components/Pricing.tsx",
        specifier: "../components/Pricing",
      },
    ]);
    const findings = await layerViolationDetector.run(
      makeCtx({
        file: "src/domain/billing.ts",
        imports: graph,
        config: TWO_LAYER_CONFIG,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("layer_violation");
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.evidence.some((e) => e.includes("(layer: domain)"))).toBe(true);
    expect(findings[0]!.evidence.some((e) => e.includes("(layer: ui)"))).toBe(true);
    expect(findings[0]!.evidence.some((e) => e.startsWith("rule:"))).toBe(true);
    expect(findings[0]!.related_files).toEqual(["src/components/Pricing.tsx"]);
  });

  it("collapses multiple forbidden edges from one file into one finding", async () => {
    const graph = makeGraph([
      {
        from: "src/domain/billing.ts",
        to: "src/components/Pricing.tsx",
        specifier: "../components/Pricing",
      },
      {
        from: "src/domain/billing.ts",
        to: "src/components/Modal.tsx",
        specifier: "../components/Modal",
      },
      {
        from: "src/domain/billing.ts",
        to: "src/components/Card.tsx",
        specifier: "../components/Card",
      },
    ]);
    const findings = await layerViolationDetector.run(
      makeCtx({
        file: "src/domain/billing.ts",
        imports: graph,
        config: TWO_LAYER_CONFIG,
      }),
    );
    expect(findings).toHaveLength(1);
    // 3+ edges → escalates to high.
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.related_files).toEqual([
      "src/components/Card.tsx",
      "src/components/Modal.tsx",
      "src/components/Pricing.tsx",
    ]);
    // Three evidence rows + the rule row.
    const edgeEvidence = findings[0]!.evidence.filter((e) => e.includes("(layer:"));
    expect(edgeEvidence).toHaveLength(3);
  });

  it("emits nothing when the source file is outside any layer pattern", async () => {
    const graph = makeGraph([
      {
        from: "scripts/migrate.ts",
        to: "src/components/Pricing.tsx",
        specifier: "../src/components/Pricing",
      },
    ]);
    const findings = await layerViolationDetector.run(
      makeCtx({
        file: "scripts/migrate.ts",
        imports: graph,
        config: TWO_LAYER_CONFIG,
      }),
    );
    expect(findings).toEqual([]);
  });

  it("emits nothing for legal cross-layer edges (ui → domain when only domain→ui is forbidden)", async () => {
    const graph = makeGraph([
      {
        from: "src/components/Pricing.tsx",
        to: "src/domain/billing.ts",
        specifier: "../domain/billing",
      },
    ]);
    const findings = await layerViolationDetector.run(
      makeCtx({
        file: "src/components/Pricing.tsx",
        imports: graph,
        config: TWO_LAYER_CONFIG,
      }),
    );
    expect(findings).toEqual([]);
  });

  it("emits nothing when architecture config is absent", async () => {
    const graph = makeGraph([
      {
        from: "src/domain/billing.ts",
        to: "src/components/Pricing.tsx",
        specifier: "../components/Pricing",
      },
    ]);
    const findings = await layerViolationDetector.run(
      makeCtx({
        file: "src/domain/billing.ts",
        imports: graph,
        config: DEFAULT_CONFIG,
      }),
    );
    expect(findings).toEqual([]);
  });

  it("emits nothing when ctx.imports is absent", async () => {
    const findings = await layerViolationDetector.run({
      kind: "language-js",
      file: "src/domain/billing.ts",
      absolutePath: "/repo/src/domain/billing.ts",
      source: "",
      parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
      config: TWO_LAYER_CONFIG,
    });
    expect(findings).toEqual([]);
  });
});
