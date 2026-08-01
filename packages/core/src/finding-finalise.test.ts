import { describe, expect, it } from "vitest";
import type { Detector } from "./detector.js";
import { assignPackAndDetectorId } from "./finding-finalise.js";
import type { Finding } from "./finding.js";

function makeFinding(type: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id: "",
    type,
    pack: "language-js",
    detector_id: `${type}.js`,
    charge: "Test",
    severity: "low",
    confidence: 0.5,
    file: "src/x.ts",
    summary: "x",
    evidence: ["x"],
    effort: "quick",
    fix_shape: "x",
    scores: { severity: 0.4, confidence: 0.5 },
    ...overrides,
  };
}

function makeDetector(id: string, pack: Detector["pack"]): Detector {
  if (pack === "universal") {
    return {
      id,
      name: id,
      description: "x",
      whyItMatters: "x",
      pack: "universal",
      run: () => [],
    };
  }
  return {
    id,
    name: id,
    description: "x",
    whyItMatters: "x",
    pack: "language-js",
    run: () => [],
  };
}

describe("assignPackAndDetectorId", () => {
  it("sets pack and detector_id from the detector for a universal finding", () => {
    const f = makeFinding("finder_duplicate_filename");
    assignPackAndDetectorId(f, makeDetector("finder_duplicate_filename", "universal"));
    expect(f.pack).toBe("universal");
    expect(f.detector_id).toBe("finder_duplicate_filename");
  });

  it("qualifies detector_id with the pack suffix for language-js findings", () => {
    const f = makeFinding("large_function");
    assignPackAndDetectorId(f, makeDetector("large_function", "language-js"));
    expect(f.pack).toBe("language-js");
    expect(f.detector_id).toBe("large_function.js");
  });

  it("leaves type untouched (abstract grouping key)", () => {
    const f = makeFinding("large_function");
    assignPackAndDetectorId(f, makeDetector("large_function", "language-js"));
    expect(f.type).toBe("large_function");
  });

  it("does not double-suffix a detector id that already ends in .js", () => {
    const f = makeFinding("circular_dependency");
    assignPackAndDetectorId(f, makeDetector("circular_dependency.js", "language-js"));
    expect(f.detector_id).toBe("circular_dependency.js");
  });
});
