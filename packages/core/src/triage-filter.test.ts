import { describe, expect, it } from "vitest";
import type { Finding } from "./finding.js";
import { applyTriageFilter } from "./triage-filter.js";
import type { TriageEntry } from "./triage.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "crime_00001",
    type: "large_function",
    charge: "God Function",
    severity: "medium",
    confidence: 0.8,
    file: "src/foo.ts",
    symbol: "doStuff",
    summary: "stub",
    evidence: [],
    effort: "small",
    fix_shape: "extract pure helpers; keep the orchestrator thin",
    scores: { severity: 0.5, confidence: 0.8 },
    ...overrides,
  } as Finding;
}

function makeEntry(overrides: Partial<TriageEntry> = {}): TriageEntry {
  return {
    fingerprint: "large_function::src/foo.ts::doStuff",
    type: "large_function",
    file: "src/foo.ts",
    symbol: "doStuff",
    disposition: "wont-fix",
    reason: "legacy",
    owner: "@a",
    date: "2026-05-20",
    ...overrides,
  };
}

describe("applyTriageFilter", () => {
  it("hides findings with silencing dispositions by default", () => {
    const findings = [makeFinding()];
    const result = applyTriageFilter(findings, [makeEntry()], { showTriaged: false });
    expect(result.findings).toHaveLength(0);
    expect(result.hiddenCount).toBe(1);
  });

  it("annotates visible findings with fix-now disposition", () => {
    const findings = [makeFinding()];
    const result = applyTriageFilter(
      findings,
      [makeEntry({ disposition: "fix-now" })],
      { showTriaged: false },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.triaged?.disposition).toBe("fix-now");
    expect(result.findings[0]!.triaged?.reason).toBe("legacy");
    expect(result.findings[0]!.triaged?.owner).toBe("@a");
    expect(result.findings[0]!.triaged?.date).toBe("2026-05-20");
  });

  it("annotates fix-this-PR the same way", () => {
    const findings = [makeFinding()];
    const result = applyTriageFilter(
      findings,
      [makeEntry({ disposition: "fix-this-PR" })],
      { showTriaged: false },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.triaged?.disposition).toBe("fix-this-PR");
  });

  it("keeps silenced findings when showTriaged is true with a _hiddenTriage marker", () => {
    const findings = [makeFinding()];
    const result = applyTriageFilter(findings, [makeEntry()], { showTriaged: true });
    expect(result.findings).toHaveLength(1);
    expect(result.hiddenCount).toBe(0);
    const annotated = result.findings[0] as Finding & { _hiddenTriage?: TriageEntry };
    expect(annotated._hiddenTriage?.disposition).toBe("wont-fix");
  });

  it("ignores triage entries whose fingerprint matches nothing", () => {
    const findings = [makeFinding()];
    const result = applyTriageFilter(
      findings,
      [makeEntry({ fingerprint: "ghost::x::y" })],
      { showTriaged: false },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.triaged).toBeUndefined();
  });

  it("returns the original list when triage entries are empty", () => {
    const findings = [makeFinding(), makeFinding({ file: "src/bar.ts", symbol: "fn2" })];
    const result = applyTriageFilter(findings, [], { showTriaged: false });
    expect(result.findings).toEqual(findings);
    expect(result.hiddenCount).toBe(0);
  });

  it("counts multiple hidden findings correctly", () => {
    const findings = [
      makeFinding({ symbol: "a" }),
      makeFinding({ symbol: "b" }),
    ];
    const entries = [
      makeEntry({ fingerprint: "large_function::src/foo.ts::a", symbol: "a" }),
      makeEntry({ fingerprint: "large_function::src/foo.ts::b", symbol: "b" }),
    ];
    const result = applyTriageFilter(findings, entries, { showTriaged: false });
    expect(result.findings).toHaveLength(0);
    expect(result.hiddenCount).toBe(2);
  });
});
