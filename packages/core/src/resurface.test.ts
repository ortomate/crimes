import { describe, expect, it, vi } from "vitest";
import type { BaselineEntry } from "./baseline.js";
import type { Finding } from "./finding.js";
import { collectResurfaced, type ResurfaceInput } from "./resurface.js";
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

function makeTriage(overrides: Partial<TriageEntry> = {}): TriageEntry {
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

function makeBaseline(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    fingerprint: "large_function::src/foo.ts::doStuff",
    type: "large_function",
    charge: "God Function",
    severity: "medium",
    file: "src/foo.ts",
    symbol: "doStuff",
    ...overrides,
  };
}

describe("collectResurfaced", () => {
  it("returns empty when diffFiles is empty", async () => {
    const input: ResurfaceInput = {
      diffFiles: new Set(),
      triageEntries: [makeTriage()],
      baselineEntries: [makeBaseline()],
      reDetect: vi.fn().mockResolvedValue([makeFinding()]),
    };
    const result = await collectResurfaced(input);
    expect(result).toHaveLength(0);
    expect(input.reDetect).not.toHaveBeenCalled();
  });

  it("annotates a triaged finding from a touched file", async () => {
    const input: ResurfaceInput = {
      diffFiles: new Set(["src/foo.ts"]),
      triageEntries: [makeTriage()],
      baselineEntries: [],
      reDetect: vi.fn().mockResolvedValue([makeFinding()]),
    };
    const result = await collectResurfaced(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.previously_triaged).toBe(true);
    expect(result[0]!.previous_triage?.disposition).toBe("wont-fix");
    expect(result[0]!.previous_triage?.reason).toBe("legacy");
    expect(result[0]!.previous_triage?.owner).toBe("@a");
    expect(result[0]!.previous_triage?.date).toBe("2026-05-20");
  });

  it("annotates a baselined finding from a touched file", async () => {
    const input: ResurfaceInput = {
      diffFiles: new Set(["src/foo.ts"]),
      triageEntries: [],
      baselineEntries: [makeBaseline()],
      reDetect: vi.fn().mockResolvedValue([makeFinding()]),
    };
    const result = await collectResurfaced(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.previously_baselined).toBe(true);
    expect(result[0]!.previously_triaged).toBeUndefined();
  });

  it("drops resurfaced entries silently when re-detect finds no match", async () => {
    const input: ResurfaceInput = {
      diffFiles: new Set(["src/foo.ts"]),
      triageEntries: [makeTriage()],
      baselineEntries: [],
      reDetect: vi.fn().mockResolvedValue([]),
    };
    const result = await collectResurfaced(input);
    expect(result).toHaveLength(0);
  });

  it("drops findings whose fingerprint doesn't match any stored entry", async () => {
    // Detector re-runs and finds a NEW finding on the same file that isn't
    // in triage or baseline — should not be resurfaced (it's a fresh
    // finding, the scan-pipeline's main loop will handle it).
    const input: ResurfaceInput = {
      diffFiles: new Set(["src/foo.ts"]),
      triageEntries: [makeTriage()],
      baselineEntries: [],
      reDetect: vi.fn().mockResolvedValue([makeFinding({ symbol: "differentFunction" })]),
    };
    const result = await collectResurfaced(input);
    expect(result).toHaveLength(0);
  });

  it("prefers triage over baseline when both match the same fingerprint", async () => {
    const input: ResurfaceInput = {
      diffFiles: new Set(["src/foo.ts"]),
      triageEntries: [makeTriage({ disposition: "needs-design" })],
      baselineEntries: [makeBaseline()],
      reDetect: vi.fn().mockResolvedValue([makeFinding()]),
    };
    const result = await collectResurfaced(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.previously_triaged).toBe(true);
    expect(result[0]!.previously_baselined).toBeUndefined();
    expect(result[0]!.previous_triage?.disposition).toBe("needs-design");
  });

  it("only invokes reDetect for files in diffFiles", async () => {
    const reDetect = vi.fn().mockResolvedValue([makeFinding()]);
    const input: ResurfaceInput = {
      diffFiles: new Set(["src/foo.ts"]),
      triageEntries: [
        makeTriage(),
        makeTriage({
          fingerprint: "large_function::src/other.ts::y",
          file: "src/other.ts",
        }),
      ],
      baselineEntries: [],
      reDetect,
    };
    await collectResurfaced(input);
    expect(reDetect).toHaveBeenCalledTimes(1);
    expect(reDetect).toHaveBeenCalledWith("src/foo.ts");
  });

  it("calls reDetect once per touched file even when multiple entries match", async () => {
    const reDetect = vi
      .fn()
      .mockResolvedValue([makeFinding({ symbol: "a" }), makeFinding({ symbol: "b" })]);
    const input: ResurfaceInput = {
      diffFiles: new Set(["src/foo.ts"]),
      triageEntries: [
        makeTriage({ fingerprint: "large_function::src/foo.ts::a", symbol: "a" }),
        makeTriage({ fingerprint: "large_function::src/foo.ts::b", symbol: "b" }),
      ],
      baselineEntries: [],
      reDetect,
    };
    const result = await collectResurfaced(input);
    expect(reDetect).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
  });

  it("preserves detector order in the output", async () => {
    const reDetect = vi
      .fn()
      .mockResolvedValue([
        makeFinding({ symbol: "second" }),
        makeFinding({ symbol: "first" }),
      ]);
    const input: ResurfaceInput = {
      diffFiles: new Set(["src/foo.ts"]),
      triageEntries: [
        makeTriage({ fingerprint: "large_function::src/foo.ts::first", symbol: "first" }),
        makeTriage({
          fingerprint: "large_function::src/foo.ts::second",
          symbol: "second",
        }),
      ],
      baselineEntries: [],
      reDetect,
    };
    const result = await collectResurfaced(input);
    expect(result[0]!.symbol).toBe("second");
    expect(result[1]!.symbol).toBe("first");
  });

  // Spec §5.3: only silenced dispositions (needs-design / wont-fix /
  // scaffolding) resurface. fix-now / fix-this-PR stay visible in the
  // regular findings list via applyTriageFilter's `triaged` annotation,
  // so resurfacing them too would produce a duplicate row in the output.
  it("does not resurface fix-now triage entries", async () => {
    const input: ResurfaceInput = {
      diffFiles: new Set(["src/foo.ts"]),
      triageEntries: [makeTriage({ disposition: "fix-now" })],
      baselineEntries: [],
      reDetect: vi.fn().mockResolvedValue([makeFinding()]),
    };
    const result = await collectResurfaced(input);
    expect(result).toHaveLength(0);
    expect(input.reDetect).not.toHaveBeenCalled();
  });

  it("does not resurface fix-this-PR triage entries", async () => {
    const input: ResurfaceInput = {
      diffFiles: new Set(["src/foo.ts"]),
      triageEntries: [makeTriage({ disposition: "fix-this-PR" })],
      baselineEntries: [],
      reDetect: vi.fn().mockResolvedValue([makeFinding()]),
    };
    const result = await collectResurfaced(input);
    expect(result).toHaveLength(0);
  });

  it("resurfaces needs-design / wont-fix / scaffolding dispositions", async () => {
    for (const disposition of ["needs-design", "wont-fix", "scaffolding"] as const) {
      const input: ResurfaceInput = {
        diffFiles: new Set(["src/foo.ts"]),
        triageEntries: [makeTriage({ disposition })],
        baselineEntries: [],
        reDetect: vi.fn().mockResolvedValue([makeFinding()]),
      };
      const result = await collectResurfaced(input);
      expect(result, `disposition ${disposition} should resurface`).toHaveLength(1);
      expect(result[0]!.previous_triage?.disposition).toBe(disposition);
    }
  });

  it("falls back to baseline annotation when triage entry is non-silencing and a baseline match exists", async () => {
    // Edge case: same fingerprint has a fix-now triage entry AND a baseline
    // entry. fix-now doesn't resurface, but the baseline entry should still
    // surface — otherwise editing the file would skip the baseline reminder.
    const input: ResurfaceInput = {
      diffFiles: new Set(["src/foo.ts"]),
      triageEntries: [makeTriage({ disposition: "fix-now" })],
      baselineEntries: [makeBaseline()],
      reDetect: vi.fn().mockResolvedValue([makeFinding()]),
    };
    const result = await collectResurfaced(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.previously_baselined).toBe(true);
    expect(result[0]!.previously_triaged).toBeUndefined();
  });
});
