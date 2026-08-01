import { describe, expect, it } from "vitest";
import { fingerprintFinding } from "./fingerprint.js";
import type { Finding } from "./finding.js";

function makeFinding(overrides: Partial<Finding>): Finding {
  return {
    id: "crime_00001",
    type: "large_function",
    pack: "language-js",
    detector_id: "large_function.js",
    charge: "God Function",
    severity: "high",
    confidence: 0.9,
    file: "src/billing.ts",
    summary: "...",
    evidence: [],
    effort: "small",
    fix_shape: "extract pure helpers; keep the orchestrator thin",
    scores: { severity: 0.9, confidence: 0.9 },
    ...overrides,
  };
}

describe("fingerprintFinding", () => {
  it("uses type + file + symbol when symbol is present", () => {
    const f = makeFinding({
      type: "large_function",
      file: "src/billing.ts",
      symbol: "generateInvoice",
    });
    expect(fingerprintFinding(f)).toBe("large_function::src/billing.ts::generateInvoice");
  });

  it("leaves the symbol slot empty when no symbol is present", () => {
    const f = makeFinding({
      type: "large_file",
      file: "src/billing.ts",
      symbol: undefined,
    });
    expect(fingerprintFinding(f)).toBe("large_file::src/billing.ts::");
  });

  it("ignores per-scan id, line range, severity, and evidence", () => {
    // Two findings that differ in everything *except* their identity slots
    // should fingerprint identically — that's the whole point: a finding
    // that shifts a few lines after an unrelated edit should still be
    // classified as "unchanged" across the diff.
    const before = makeFinding({
      id: "crime_00001",
      type: "large_function",
      file: "src/billing.ts",
      symbol: "generateInvoice",
      lines: [37, 240],
      severity: "high",
      confidence: 0.95,
      evidence: ["lines 37-240 (204 lines)"],
    });
    const after = makeFinding({
      id: "crime_00007",
      type: "large_function",
      file: "src/billing.ts",
      symbol: "generateInvoice",
      lines: [42, 246],
      severity: "high",
      confidence: 0.94,
      evidence: ["lines 42-246 (205 lines)"],
    });
    expect(fingerprintFinding(before)).toBe(fingerprintFinding(after));
  });

  it("treats different detector types in the same file as different findings", () => {
    const a = makeFinding({ type: "large_file", file: "src/x.ts" });
    const b = makeFinding({ type: "todo_density", file: "src/x.ts" });
    expect(fingerprintFinding(a)).not.toBe(fingerprintFinding(b));
  });

  it("treats different files as different findings", () => {
    const a = makeFinding({
      type: "large_function",
      file: "src/a.ts",
      symbol: "f",
    });
    const b = makeFinding({
      type: "large_function",
      file: "src/b.ts",
      symbol: "f",
    });
    expect(fingerprintFinding(a)).not.toBe(fingerprintFinding(b));
  });

  it("treats different symbols in the same file as different findings", () => {
    const a = makeFinding({
      type: "large_function",
      file: "src/x.ts",
      symbol: "foo",
    });
    const b = makeFinding({
      type: "large_function",
      file: "src/x.ts",
      symbol: "bar",
    });
    expect(fingerprintFinding(a)).not.toBe(fingerprintFinding(b));
  });
});
