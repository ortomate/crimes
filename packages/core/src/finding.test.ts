import { describe, expect, it } from "vitest";
import type { Finding } from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";

describe("SCHEMA_VERSION", () => {
  it("is 0.3.0 — universal pack release", () => {
    expect(SCHEMA_VERSION).toBe("0.3.0");
  });
});

describe("Finding shape", () => {
  it("accepts a finding with explicit pack + detector_id", () => {
    const f: Finding = {
      id: "crime_00001",
      type: "large_file",
      detector_id: "large_file",
      pack: "universal",
      charge: "God File",
      severity: "high",
      confidence: 0.9,
      file: "src/big.ts",
      summary: "test",
      evidence: ["test"],
      effort: "medium",
      fix_shape: "split by responsibility",
      scores: { severity: 0.85, confidence: 0.9 },
    };
    expect(f.pack).toBe("universal");
    expect(f.detector_id).toBe("large_file");
  });

  it("accepts a finding that omits pack + detector_id (back-compat for stubs)", () => {
    // Optional during Phase 0 — Task 3.3 makes them required after the
    // central finalisation pass guarantees they're always populated.
    const f: Finding = {
      id: "crime_00002",
      type: "large_file",
      charge: "God File",
      severity: "low",
      confidence: 0.5,
      file: "src/small.ts",
      summary: "test",
      evidence: ["test"],
      effort: "quick",
      fix_shape: "split by responsibility",
      scores: { severity: 0.4, confidence: 0.5 },
    };
    expect(f.pack).toBeUndefined();
  });
});
