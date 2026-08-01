import { describe, expect, it } from "vitest";
import { type CrimesConfig, DEFAULT_CONFIG } from "../config.js";
import type { UniversalDetectorContext } from "../detector.js";
import { largeFileDetector } from "./large-file.js";

function makeCtx(
  lineCount: number,
  opts: { file?: string; config?: CrimesConfig } = {},
): UniversalDetectorContext {
  const file = opts.file ?? "src/big.ts";
  const source = Array.from({ length: lineCount }, () => "x").join("\n");
  return {
    kind: "universal",
    file,
    absolutePath: `/tmp/${file}`,
    extension: file.match(/\.[^./]+$/)?.[0] ?? "",
    byteSize: source.length,
    readSource: async () => source,
    get lineCount() {
      return lineCount;
    },
    config: opts.config ?? DEFAULT_CONFIG,
  };
}

describe("largeFileDetector", () => {
  it("returns nothing for small files", async () => {
    const findings = await largeFileDetector.run(makeCtx(100));
    expect(findings).toEqual([]);
  });

  it("flags very large files as high", async () => {
    // 1200 lines vs 300-line default → ratio 4 → high.
    const findings = await largeFileDetector.run(makeCtx(1200));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("large_file");
    expect(findings[0]!.charge).toBe("God File");
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.evidence.length).toBeGreaterThan(0);
  });

  it("flags barely-over-threshold files as medium, not low", async () => {
    // 400 lines vs 300-line default → ratio 1.33 → medium.
    const findings = await largeFileDetector.run(makeCtx(400));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("medium");
  });

  it("escalates to high at >=2x threshold", async () => {
    // 2000 lines → ratio 6.67 → high.
    const huge = await largeFileDetector.run(makeCtx(2000));
    expect(huge[0]!.severity).toBe("high");
  });

  it("summary explains why large files are risky", async () => {
    const findings = await largeFileDetector.run(makeCtx(800));
    expect(findings[0]!.summary).toMatch(/coupling|context|edit/i);
  });
});

describe("largeFileDetector — test_file shape", () => {
  it("does not flag a 900-line `.test.ts` file (under the 1500 default)", async () => {
    const findings = await largeFileDetector.run(
      makeCtx(900, { file: "packages/core/src/reporter.test.ts" }),
    );
    expect(findings).toEqual([]);
  });

  it("does not flag a 900-line file under `__tests__/`", async () => {
    const findings = await largeFileDetector.run(
      makeCtx(900, { file: "packages/foo/src/__tests__/feature.ts" }),
    );
    expect(findings).toEqual([]);
  });

  it("flags a 1700-line test file as low (between 1× and 2× threshold)", async () => {
    const findings = await largeFileDetector.run(
      makeCtx(1700, { file: "packages/core/src/context.spec.ts" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("low");
    expect(findings[0]!.evidence.join(" ")).toContain("test file");
  });

  it("escalates a 3500-line test file to medium (≥2× threshold)", async () => {
    const findings = await largeFileDetector.run(
      makeCtx(3500, { file: "packages/core/src/giant.test.ts" }),
    );
    expect(findings[0]!.severity).toBe("medium");
  });

  it("test_file agent_risk is lower than a same-size domain file", async () => {
    const test = await largeFileDetector.run(
      makeCtx(1800, { file: "packages/core/src/x.test.ts" }),
    );
    const domain = await largeFileDetector.run(
      makeCtx(1800, { file: "packages/core/src/x.ts" }),
    );
    const testRisk = test[0]!.scores.agent_risk;
    const domainRisk = domain[0]!.scores.agent_risk;
    expect(testRisk).toBeDefined();
    expect(domainRisk).toBeDefined();
    expect(testRisk!).toBeLessThan(domainRisk!);
  });

  it("honours `thresholds.largeFile.test_file` override", async () => {
    const config: CrimesConfig = {
      ...DEFAULT_CONFIG,
      thresholds: {
        ...DEFAULT_CONFIG.thresholds,
        largeFile: { test_file: 400 },
      },
    };
    const findings = await largeFileDetector.run(
      makeCtx(500, { file: "src/small.test.ts", config }),
    );
    expect(findings).toHaveLength(1);
  });

  it("honours `thresholds.largeFile.domain` over legacy `largeFileLines`", async () => {
    const config: CrimesConfig = {
      ...DEFAULT_CONFIG,
      thresholds: {
        ...DEFAULT_CONFIG.thresholds,
        largeFile: { domain: 1000 },
      },
    };
    // 500 lines would normally hit the 300-line legacy default. With
    // domain bumped to 1000, the same file is now under threshold.
    const findings = await largeFileDetector.run(
      makeCtx(500, { file: "src/big.ts", config }),
    );
    expect(findings).toEqual([]);
  });
});

describe("largeFileDetector — docs shape", () => {
  it("does not flag a 900-line reference doc (under the 1000 default)", async () => {
    const findings = await largeFileDetector.run(
      makeCtx(900, { file: "docs/configuration.md" }),
    );
    expect(findings).toEqual([]);
  });

  it("would have flagged that same doc as high under the domain budget", async () => {
    // The point of the shape: 900 lines of prose is 3× the 300-line
    // domain budget, which is why prose used to need a suppression.
    const findings = await largeFileDetector.run(
      makeCtx(900, { file: "docs/config.ts" }),
    );
    expect(findings[0]!.severity).toBe("high");
  });

  it("flags a 1800-line doc as low (between 1× and 2× threshold)", async () => {
    const findings = await largeFileDetector.run(
      makeCtx(1800, { file: "docs/json-schema.md" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("low");
    expect(findings[0]!.evidence.join(" ")).toContain("shape: document");
    expect(findings[0]!.fix_shape).toContain("per-topic pages");
  });

  it("escalates a 2500-line doc to medium (≥2× threshold)", async () => {
    const findings = await largeFileDetector.run(
      makeCtx(2500, { file: "docs/everything.md" }),
    );
    expect(findings[0]!.severity).toBe("medium");
  });

  it("covers the prose extensions but not data formats", async () => {
    for (const file of [
      "README.md",
      "docs/guide.mdx",
      "notes.markdown",
      "docs/index.rst",
      "docs/manual.adoc",
      "CHANGES.txt",
    ]) {
      expect(await largeFileDetector.run(makeCtx(900, { file }))).toEqual([]);
    }
    // Data, not prose — a 900-line config still earns the domain budget.
    for (const file of ["package.json", "config.yaml", "data.csv"]) {
      const findings = await largeFileDetector.run(makeCtx(900, { file }));
      expect(findings, file).toHaveLength(1);
    }
  });

  it("docs agent_risk sits between test_file and domain at the same size", async () => {
    const size = 2000;
    const docs = await largeFileDetector.run(makeCtx(size, { file: "docs/a.md" }));
    const test = await largeFileDetector.run(makeCtx(size, { file: "src/a.test.ts" }));
    const domain = await largeFileDetector.run(makeCtx(size, { file: "src/a.ts" }));
    expect(test[0]!.scores.agent_risk!).toBeLessThan(docs[0]!.scores.agent_risk!);
    expect(docs[0]!.scores.agent_risk!).toBeLessThan(domain[0]!.scores.agent_risk!);
  });

  it("honours `thresholds.largeFile.docs` override", async () => {
    const config: CrimesConfig = {
      ...DEFAULT_CONFIG,
      thresholds: {
        ...DEFAULT_CONFIG.thresholds,
        largeFile: { docs: 400 },
      },
    };
    const findings = await largeFileDetector.run(
      makeCtx(500, { file: "docs/short.md", config }),
    );
    expect(findings).toHaveLength(1);
  });

  it("summary talks about reading fragments, not about coupling", async () => {
    const findings = await largeFileDetector.run(makeCtx(1500, { file: "PRD.md" }));
    expect(findings[0]!.summary).toMatch(/fragment|section/i);
    expect(findings[0]!.summary).not.toMatch(/coupling/i);
  });
});

describe("largeFileDetector — universal pack", () => {
  it("fires on a 1200-line .rs file", async () => {
    const _source = Array.from({ length: 1200 }, () => "x").join("\n");
    const findings = await largeFileDetector.run(makeCtx(1200, { file: "src/main.rs" }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.file).toBe("src/main.rs");
  });

  it("uses the test_file shape on a foo_test.py path", async () => {
    const _source = Array.from({ length: 900 }, () => "x").join("\n");
    const findings = await largeFileDetector.run(
      makeCtx(900, { file: "tests/foo_test.py" }),
    );
    // 900 < 1500 default test_file threshold → no finding.
    expect(findings).toEqual([]);
  });
});
