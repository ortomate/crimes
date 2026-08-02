import { describe, expect, it } from "vitest";
import type { Finding, ScanReport } from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";

describe("SCHEMA_VERSION", () => {
  it("is 0.5.0 — blast-radius importer counts split", () => {
    expect(SCHEMA_VERSION).toBe("0.5.0");
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

  it("accepts a language-js finding with pack + detector_id", () => {
    // Task 3.3: pack and detector_id are now required on every Finding.
    const f: Finding = {
      id: "crime_00002",
      type: "large_file",
      pack: "language-js",
      detector_id: "large_file.js",
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
    expect(f.pack).toBe("language-js");
    expect(f.detector_id).toBe("large_file.js");
  });
});

describe("ScanReport.coverage", () => {
  it("accepts a coverage block", () => {
    const report: ScanReport = {
      schema_version: SCHEMA_VERSION,
      report_type: "scan",
      repo: { name: "x", root: "/x" },
      summary: { total: 0, high: 0, medium: 0, low: 0 },
      findings: [],
      coverage: {
        files_total: 100,
        files_by_language: { js: 80 },
        files_universal_only: 20,
        packs_loaded: ["universal", "language-js"],
      },
    };
    expect(report.coverage?.files_total).toBe(100);
  });

  it("makes coverage optional (back-compat)", () => {
    const report: ScanReport = {
      schema_version: SCHEMA_VERSION,
      report_type: "scan",
      repo: { name: "x", root: "/x" },
      summary: { total: 0, high: 0, medium: 0, low: 0 },
      findings: [],
    };
    expect(report.coverage).toBeUndefined();
  });
});
