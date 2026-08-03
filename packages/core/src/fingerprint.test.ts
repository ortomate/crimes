import { describe, expect, it } from "vitest";
import { fingerprintFinding } from "./fingerprint.js";
import type { Finding } from "./finding.js";

function makeFinding(overrides: Partial<Finding>): Finding {
  return {
    id: "crime_00001",
    fingerprint: "",
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

describe("fingerprintFinding — discriminator (schema_version 0.4.0)", () => {
  it("omits the segment entirely when no discriminator is set", () => {
    // Back-compat is the point: a finding that carried no discriminator
    // before 0.4.0 must fingerprint to the same string after it, or every
    // pinned baseline entry in the wild breaks for no reason.
    const f = makeFinding({
      type: "large_function",
      file: "src/billing.ts",
      symbol: "generateInvoice",
    });
    expect(fingerprintFinding(f)).toBe("large_function::src/billing.ts::generateInvoice");
  });

  it("treats an empty-string discriminator as unset", () => {
    const f = makeFinding({ type: "large_file", file: "src/x.ts", discriminator: "" });
    expect(fingerprintFinding(f)).toBe("large_file::src/x.ts::");
  });

  it("separates two file-level findings that differ only by discriminator", () => {
    // This is the collision the discriminator exists to fix: before
    // 0.4.0, `crimes ignore` on one of these silently suppressed both.
    const subprocess = makeFinding({
      type: "magic_domain_literal_scatter",
      file: "src/detectors/x.ts",
      symbol: undefined,
      discriminator: "subprocess",
    });
    const property = makeFinding({
      type: "magic_domain_literal_scatter",
      file: "src/detectors/x.ts",
      symbol: undefined,
      discriminator: "property",
    });
    expect(fingerprintFinding(subprocess)).not.toBe(fingerprintFinding(property));
    // The empty symbol slot is still emitted, so splitting on `::` yields
    // four segments in a fixed order rather than an ambiguous three.
    expect(fingerprintFinding(subprocess)).toBe(
      "magic_domain_literal_scatter::src/detectors/x.ts::::subprocess",
    );
    expect(fingerprintFinding(subprocess).split("::")).toEqual([
      "magic_domain_literal_scatter",
      "src/detectors/x.ts",
      "",
      "subprocess",
    ]);
  });

  it("appends after the symbol slot when both are present", () => {
    const f = makeFinding({
      type: "exact_duplicate_block",
      file: "src/a.ts",
      symbol: "parse",
      discriminator: "3dbfcb76d2cc",
    });
    expect(fingerprintFinding(f)).toBe(
      "exact_duplicate_block::src/a.ts::parse::3dbfcb76d2cc",
    );
  });

  it("still collides when two findings agree on all four slots", () => {
    // Documented residual limitation: identical in every identity slot is
    // a detector-level gap, not something the schema can resolve.
    const a = makeFinding({ file: "src/x.ts", symbol: "f", discriminator: "h" });
    const b = makeFinding({ file: "src/x.ts", symbol: "f", discriminator: "h" });
    expect(fingerprintFinding(a)).toBe(fingerprintFinding(b));
  });
});
