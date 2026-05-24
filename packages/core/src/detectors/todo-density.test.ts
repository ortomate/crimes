import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { UniversalDetectorContext } from "../detector.js";
import { todoDensityDetector } from "./todo-density.js";

function makeCtx(args: {
  file?: string;
  source: string;
  config?: typeof DEFAULT_CONFIG;
  padLines?: number;
}): UniversalDetectorContext {
  const file = args.file ?? "src/todo.ts";
  const sourceLines = args.source.split(/\r?\n/).length;
  const baseLinesCount = sourceLines + (args.padLines ?? 0);

  return {
    kind: "universal",
    file,
    absolutePath: `/tmp/${file}`,
    extension: file.match(/\.[^./]+$/)?.[0] ?? "",
    byteSize: args.source.length,
    readSource: async () => args.source,
    get lineCount() {
      return baseLinesCount;
    },
    config: args.config ?? DEFAULT_CONFIG,
  };
}

describe("todoDensityDetector", () => {
  it("returns nothing when there are no markers", async () => {
    const findings = await todoDensityDetector.run(
      makeCtx({ source: "export const x = 1;\n" }),
    );
    expect(findings).toEqual([]);
  });

  it("counts TODO, FIXME, XXX, HACK separately", async () => {
    const src = ["// TODO: a", "// FIXME: b", "// XXX: c", "// HACK: d"].join("\n");
    const findings = await todoDensityDetector.run(makeCtx({ source: src }));
    expect(findings).toHaveLength(1);
    const evidence = findings[0]!.evidence.join(" ");
    expect(evidence).toContain("TODO");
    expect(evidence).toContain("FIXME");
    expect(evidence).toContain("XXX");
    expect(evidence).toContain("HACK");
  });

  it("ranks a handful of markers as low, not high", async () => {
    // 5 markers in a 1000-line file: count<8, density 5/kloc < threshold 10
    // After the floor check (count>=3) it fires at low.
    const src = Array.from({ length: 5 }, (_, i) => `// TODO: thing ${i}`).join("\n");
    const findings = await todoDensityDetector.run(
      makeCtx({ source: src, padLines: 1000 }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("low");
  });

  it("ranks moderately many markers as medium", async () => {
    // 10 markers: count >= 8 → medium.
    const src = Array.from({ length: 10 }, (_, i) => `// TODO: ${i}`).join("\n");
    const findings = await todoDensityDetector.run(
      makeCtx({ source: src, padLines: 500 }),
    );
    expect(findings[0]!.severity).toBe("medium");
  });

  it("ranks extreme density as high only when both count and density are extreme", async () => {
    // 25 markers in a 30-line file: count>=20 AND density~833/kloc → high.
    const src = Array.from({ length: 25 }, (_, i) => `// TODO: ${i}`).join("\n");
    const findings = await todoDensityDetector.run(makeCtx({ source: src }));
    expect(findings[0]!.severity).toBe("high");
  });

  it("does not rank elevated density as high when count is moderate", async () => {
    // 14 markers in a small file — high density but moderate count → medium.
    const src = Array.from({ length: 14 }, (_, i) => `// TODO: ${i}`).join("\n");
    const findings = await todoDensityDetector.run(makeCtx({ source: src }));
    expect(findings[0]!.severity).toBe("medium");
  });

  it("exempts the detector source that defines the marker pattern", async () => {
    // Mirrors the production detector: a file containing the literal
    // `TODO|FIXME|XXX|HACK` token sequence is the detector source itself
    // (or a fixture/test of it) and should not flag itself.
    const src = [
      "const TODO_PATTERN = /\\b(TODO|FIXME|XXX|HACK)\\b/g;",
      "// TODO: this should not count",
      "// FIXME: nor this",
      "// XXX: nor this either",
    ].join("\n");
    const findings = await todoDensityDetector.run(makeCtx({ source: src }));
    expect(findings).toEqual([]);
  });

  it("does NOT exempt prose that mentions one marker name", async () => {
    // Counter-test: a comment that just says "TODO" without the full
    // pipe-separated set should still count.
    const src = Array.from({ length: 6 }, (_, i) => `// TODO: ${i}`).join("\n");
    const findings = await todoDensityDetector.run(
      makeCtx({ source: src, padLines: 100 }),
    );
    expect(findings).toHaveLength(1);
  });

  it("reports line range spanning first to last marker", async () => {
    const src = [
      "export const a = 1;",
      "// TODO: first",
      "export const b = 2;",
      "// FIXME: last",
      "export const c = 3;",
    ].join("\n");
    const findings = await todoDensityDetector.run(makeCtx({ source: src }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.lines).toEqual([2, 4]);
  });

  describe("todoDensityDetector — universal pack", () => {
    it("fires on a Python file with multiple TODOs", async () => {
      const source = [
        "# TODO: implement auth",
        "# FIXME: handle nulls",
        "# TODO: refactor this",
        "# XXX: hack",
        "def main():",
        "    pass",
      ].join("\n");
      const findings = await todoDensityDetector.run(
        makeCtx({ source, file: "src/auth.py" }),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]!.file).toBe("src/auth.py");
    });
  });
});
