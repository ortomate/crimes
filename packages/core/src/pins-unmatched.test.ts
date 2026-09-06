import { describe, expect, it } from "vitest";
import type { CoverageWarning, Finding, ScanReport } from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";
import { fingerprintFinding } from "./fingerprint.js";
import { classifyUnmatchedPins } from "./pins-unmatched.js";
import { recordUnmatchedPins } from "./scan.js";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "crime_00001",
    fingerprint: "",
    type: "large_function",
    pack: "language-js",
    detector_id: "large_function.js",
    charge: "God Function",
    severity: "medium",
    confidence: 0.9,
    file: "src/a.ts",
    symbol: "fn",
    lines: [1, 100],
    summary: "spans 100 lines",
    evidence: [],
    effort: "small",
    fix_shape: "extract pure helpers",
    scores: { severity: 0.9, confidence: 0.9 },
    ...over,
  };
}

function report(findings: Finding[], over: Partial<ScanReport> = {}): ScanReport {
  const summary = { total: findings.length, high: 0, medium: 0, low: 0 };
  for (const f of findings) summary[f.severity] += 1;
  return {
    schema_version: SCHEMA_VERSION,
    report_type: "scan",
    repo: { name: "fixture", root: "/tmp/fixture" },
    summary,
    findings,
    coverage: {
      files_total: 3,
      files_by_language: { js: 3 },
      files_universal_only: 0,
      packs_loaded: ["universal", "language-js"],
    },
    ...over,
  };
}

function pinWarnings(r: ScanReport): CoverageWarning[] {
  return (r.coverage?.warnings ?? []).filter((w) =>
    w.kind.endsWith("_entries_unmatched"),
  );
}

describe("classifyUnmatchedPins — verdicts", () => {
  it("says nothing about an entry that still matches", () => {
    const f = finding();
    const result = classifyUnmatchedPins([f], [{ fingerprint: fingerprintFinding(f) }]);
    expect(result).toEqual({ superseded: [], noLongerReported: [] });
  });

  it("reports no verdict at all when there are no entries", () => {
    expect(classifyUnmatchedPins([finding()], [])).toEqual({
      superseded: [],
      noLongerReported: [],
    });
  });

  // The 0.8.0 migration, which is the reason this module exists: the
  // claim joined the fingerprint, so a pre-0.8.0 pin on a multi-claim
  // type stopped matching while its finding kept being reported.
  it("calls a pin superseded when the same claim is still reported under a new fingerprint", () => {
    const result = classifyUnmatchedPins(
      [finding({ claim: "too_long" })],
      // What 0.7.0 wrote: no claim segment.
      [{ fingerprint: "large_function::src/a.ts::fn" }],
    );

    expect(result.noLongerReported).toEqual([]);
    expect(result.superseded).toEqual([
      {
        fingerprint: "large_function::src/a.ts::fn",
        file: "src/a.ts",
        kind: "superseded",
        supersededBy: "large_function/too_long::src/a.ts::fn",
      },
    ]);
  });

  it("calls a pin no_longer_reported when nothing of that type fires in the file", () => {
    const result = classifyUnmatchedPins(
      [finding({ type: "large_file", symbol: undefined })],
      [{ fingerprint: "swallowed_error::src/a.ts::fn" }],
    );

    expect(result.superseded).toEqual([]);
    expect(result.noLongerReported).toEqual([
      {
        fingerprint: "swallowed_error::src/a.ts::fn",
        file: "src/a.ts",
        kind: "no_longer_reported",
      },
    ]);
  });

  // A pin that names a claim is a judgement on *that statement*. The
  // detector's other claim is a different question with a different
  // answer, so it is not evidence the pin was orphaned.
  it("does not treat a different claim of the same type as superseding", () => {
    const result = classifyUnmatchedPins(
      [finding({ type: "weak_test_signal", claim: "weak_matchers" })],
      [{ fingerprint: "weak_test_signal/no_assertions::src/a.ts::fn" }],
    );

    expect(result.superseded).toEqual([]);
    expect(result.noLongerReported).toHaveLength(1);
  });

  it("matches a claimed pin against the same claim", () => {
    const result = classifyUnmatchedPins(
      // Same claim, different discriminator — a 0.4.0-shaped drift.
      [
        finding({
          type: "weak_test_signal",
          claim: "no_assertions",
          discriminator: "d1",
        }),
      ],
      [{ fingerprint: "weak_test_signal/no_assertions::src/a.ts::fn" }],
    );

    expect(result.superseded).toHaveLength(1);
    expect(result.superseded[0]?.supersededBy).toBe(
      "weak_test_signal/no_assertions::src/a.ts::fn::d1",
    );
  });

  // A rename is a real change, not a fingerprint accident.
  it("does not call a pin superseded when the symbol differs", () => {
    const result = classifyUnmatchedPins(
      [finding({ claim: "too_long", symbol: "renamedFn" })],
      [{ fingerprint: "large_function::src/a.ts::fn" }],
    );

    expect(result.superseded).toEqual([]);
    expect(result.noLongerReported).toHaveLength(1);
  });

  it("does not call a pin superseded when the file differs", () => {
    const result = classifyUnmatchedPins(
      [finding({ claim: "too_long", file: "src/b.ts" })],
      [{ fingerprint: "large_function::src/a.ts::fn" }],
    );

    expect(result.superseded).toEqual([]);
    expect(result.noLongerReported).toHaveLength(1);
  });

  it("sorts each bucket by fingerprint so two runs agree", () => {
    const result = classifyUnmatchedPins(
      [],
      [
        { fingerprint: "z_type::src/z.ts::" },
        { fingerprint: "a_type::src/a.ts::" },
        { fingerprint: "m_type::src/m.ts::" },
      ],
    );

    expect(result.noLongerReported.map((p) => p.fingerprint)).toEqual([
      "a_type::src/a.ts::",
      "m_type::src/m.ts::",
      "z_type::src/z.ts::",
    ]);
  });

  it("falls back to the entry's file when the fingerprint has no file segment", () => {
    const result = classifyUnmatchedPins(
      [],
      [{ fingerprint: "bare", file: "src/fb.ts" }],
    );
    expect(result.noLongerReported[0]?.file).toBe("src/fb.ts");
  });
});

// Paths and symbols are free text — symbols are detector-chosen prose
// ("read → parse"), and directories with spaces exist. Any printable
// separator lets two different subjects join into one identical key,
// which would report a pin as superseded by a finding about entirely
// different code. Both branches of the match need covering: the
// unclaimed pin takes the prefix/suffix path, the claimed pin takes the
// direct lookup.
describe("classifyUnmatchedPins — subject keys", () => {
  it("keeps subjects apart when a path contains a space (unclaimed pin)", () => {
    const result = classifyUnmatchedPins(
      // Joined on a space this is
      // "swallowed_error bland_fallback my src/a.ts fn", which ends with
      // " src/a.ts fn" — exactly the suffix the entry below searches for.
      [
        finding({
          type: "swallowed_error",
          claim: "bland_fallback",
          file: "my src/a.ts",
          symbol: "fn",
        }),
      ],
      [{ fingerprint: "swallowed_error::src/a.ts::fn" }],
    );

    expect(result.superseded).toEqual([]);
    expect(result.noLongerReported).toHaveLength(1);
  });

  it("keeps subjects apart when a path contains a space (claimed pin)", () => {
    const result = classifyUnmatchedPins(
      // Joined on a space both sides read
      // "weak_test_signal no_assertions src a.ts fn" despite naming a
      // different file and a different symbol.
      [
        finding({
          type: "weak_test_signal",
          claim: "no_assertions",
          file: "src",
          symbol: "a.ts fn",
        }),
      ],
      [{ fingerprint: "weak_test_signal/no_assertions::src a.ts::fn" }],
    );

    expect(result.superseded).toEqual([]);
    expect(result.noLongerReported).toHaveLength(1);
  });
});

describe("classifyUnmatchedPins — narrowed scans", () => {
  // Without this, `crimes scan --changed` reports the entire triage
  // file as stale on every run, because it only looked at four files.
  it("judges no entry whose file the scan did not look at", () => {
    const result = classifyUnmatchedPins(
      [finding({ file: "src/touched.ts" })],
      [{ fingerprint: "large_function::src/untouched.ts::fn" }],
      new Set(["src/touched.ts"]),
    );

    expect(result).toEqual({ superseded: [], noLongerReported: [] });
  });

  it("still judges an entry inside the narrowed set", () => {
    const result = classifyUnmatchedPins(
      [finding({ file: "src/touched.ts", claim: "too_long" })],
      [{ fingerprint: "large_function::src/touched.ts::fn" }],
      new Set(["src/touched.ts"]),
    );

    expect(result.superseded).toHaveLength(1);
  });
});

describe("recordUnmatchedPins", () => {
  it("records nothing when every entry still matches", () => {
    const out = recordUnmatchedPins(report([finding({ claim: "too_long" })]), {
      triage: [{ fingerprint: "large_function/too_long::src/a.ts::fn" }],
    });
    expect(out.coverage?.warnings).toBeUndefined();
  });

  it("records nothing when there are no entries", () => {
    const out = recordUnmatchedPins(report([finding()]), {
      triage: [],
      suppressions: [],
    });
    expect(out.coverage?.warnings).toBeUndefined();
  });

  it("warns about a triage entry the scan no longer matches", () => {
    const out = recordUnmatchedPins(report([finding({ claim: "too_long" })]), {
      triage: [{ fingerprint: "large_function::src/a.ts::fn" }],
    });

    const [warning] = pinWarnings(out);
    expect(warning?.kind).toBe("triage_entries_unmatched");
    expect(warning?.subject).toBe("superseded");
    expect(warning?.entries).toBe(1);
    expect(warning?.files).toBe(1);
    expect(warning?.examples).toEqual(["src/a.ts"]);
    expect(warning?.detail).toContain("no longer matches any finding");
    expect(warning?.remedy).toContain("crimes migrate-pins --format json");
  });

  it("warns about suppressions under their own kind", () => {
    const out = recordUnmatchedPins(report([finding()]), {
      suppressions: [{ fingerprint: "swallowed_error::src/gone.ts::" }],
    });

    const [warning] = pinWarnings(out);
    expect(warning?.kind).toBe("suppression_entries_unmatched");
    expect(warning?.subject).toBe("no_longer_reported");
    expect(warning?.detail).toContain("suppression entry");
    expect(warning?.remedy).toContain(".crimes/suppressions.json");
  });

  // `files` is contracted as a file count comparable to `files_total`;
  // `entries` is what the reader actually has on disk. Several pins
  // routinely name one file, so conflating them misreports both.
  it("counts entries and distinct files separately", () => {
    const out = recordUnmatchedPins(report([finding()]), {
      triage: [
        { fingerprint: "a_type::src/same.ts::x" },
        { fingerprint: "b_type::src/same.ts::y" },
        { fingerprint: "c_type::src/other.ts::z" },
      ],
    });

    const [warning] = pinWarnings(out);
    expect(warning?.entries).toBe(3);
    expect(warning?.files).toBe(2);
    expect(warning?.examples).toEqual(["src/other.ts", "src/same.ts"]);
  });

  it("splits the two verdicts into separate warnings", () => {
    const out = recordUnmatchedPins(report([finding({ claim: "too_long" })]), {
      triage: [
        { fingerprint: "large_function::src/a.ts::fn" },
        { fingerprint: "swallowed_error::src/a.ts::gone" },
      ],
    });

    expect(
      pinWarnings(out)
        .map((w) => w.subject)
        .sort(),
    ).toEqual(["no_longer_reported", "superseded"]);
  });

  it("does not mutate the input report", () => {
    const input = report([finding({ claim: "too_long" })]);
    const snapshot = JSON.parse(JSON.stringify(input));
    recordUnmatchedPins(input, {
      triage: [{ fingerprint: "large_function::src/a.ts::fn" }],
    });
    expect(input).toEqual(snapshot);
  });

  it("leaves findings, summary and scores untouched", () => {
    const input = report([finding({ claim: "too_long" })]);
    const out = recordUnmatchedPins(input, {
      triage: [{ fingerprint: "large_function::src/a.ts::fn" }],
    });
    expect(out.findings).toEqual(input.findings);
    expect(out.summary).toEqual(input.summary);
  });

  it("keeps existing coverage warnings and re-sorts largest-first", () => {
    const existing: CoverageWarning = {
      kind: "files_excluded",
      subject: "config.exclude",
      files: 99,
      detail: "…",
    };
    const input = report([finding()], {
      coverage: {
        files_total: 3,
        files_by_language: { js: 3 },
        files_universal_only: 0,
        packs_loaded: ["universal"],
        warnings: [existing],
      },
    });

    const out = recordUnmatchedPins(input, {
      triage: [{ fingerprint: "swallowed_error::src/gone.ts::" }],
    });

    expect(out.coverage?.warnings).toHaveLength(2);
    expect(out.coverage?.warnings?.[0]).toEqual(existing);
  });

  // `files` is 0 here, which is why the contract carves these kinds out
  // of "always >= 1": a fingerprint with an empty file segment names no
  // file, and `entries` is the count that still means something.
  it("still reports an entry that names no file, sized in entries", () => {
    const out = recordUnmatchedPins(report([]), {
      suppressions: [{ fingerprint: "some_type::::sym" }],
    });

    const [warning] = pinWarnings(out);
    expect(warning?.entries).toBe(1);
    expect(warning?.files).toBe(0);
    expect(warning?.examples).toBeUndefined();
    // No "across N files" clause, and the singular noun comes from the
    // entry count rather than the absent file count.
    expect(warning?.detail).not.toContain("across");
    expect(warning?.detail).toContain("1 suppression entry");
  });

  // A report with no coverage block scanned nothing, so there is no
  // scan for an entry to have failed to match.
  it("is a no-op when the report has no coverage block", () => {
    const input = report([finding()], { coverage: undefined });
    const out = recordUnmatchedPins(input, {
      triage: [{ fingerprint: "swallowed_error::src/gone.ts::" }],
    });
    expect(out).toBe(input);
  });

  it("judges only entries inside changed_files", () => {
    const input = report([finding({ file: "src/touched.ts" })], {
      changed_files: ["src/touched.ts"],
    });
    const out = recordUnmatchedPins(input, {
      triage: [{ fingerprint: "large_function::src/untouched.ts::fn" }],
    });
    expect(pinWarnings(out)).toEqual([]);
  });

  it("judges only entries inside a working set", () => {
    const input = report([finding({ file: "src/touched.ts" })], {
      working_set: {
        selector: "files",
        seeds: ["src/touched.ts"],
        files: ["src/touched.ts"],
      },
    });
    const out = recordUnmatchedPins(input, {
      triage: [{ fingerprint: "large_function::src/untouched.ts::fn" }],
    });
    expect(pinWarnings(out)).toEqual([]);
  });
});
