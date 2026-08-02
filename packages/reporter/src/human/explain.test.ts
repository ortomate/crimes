import type { ExplainReport, Finding, FindingScores } from "@crimes/core";
import { SCHEMA_VERSION } from "@crimes/core";
import { describe, expect, it } from "vitest";
import { formatExplainReport } from "./explain.js";

function explainReport(scores: Partial<FindingScores>): ExplainReport {
  const finding: Finding = {
    id: "crime_00001",
    type: "large_function",
    pack: "language-js",
    detector_id: "large_function.js",
    charge: "God Function",
    severity: "high",
    confidence: 0.9,
    file: "src/slack.py",
    summary: "big",
    evidence: [],
    effort: "large",
    fix_shape: "split it",
    scores: { severity: 0.9, confidence: 0.9, ...scores },
  } as Finding;
  return {
    schema_version: SCHEMA_VERSION,
    report_type: "explain",
    finding,
    detector: { type: "large_function", charge: "God Function", description: "d" },
    why_it_matters: "w",
    likely_remedies: [],
    suggested_suppression_command: "crimes ignore x",
  };
}

describe("formatExplainReport — blast radius line", () => {
  it("reports the measured counts rather than inverting the capped score", () => {
    // Before this fix `explain` said "50+ transitive importers (cap
    // reached)" — honest about the kind of number, but it threw the
    // magnitude away and never told you the direct fan-in at all.
    const out = formatExplainReport(
      explainReport({
        blast_radius: 1,
        blast_radius_direct_importers: 5,
        blast_radius_transitive_importers: 798,
      }),
      { noColor: true },
    );
    expect(out).toContain("5 files import this directly");
    expect(out).toContain("798 reach it transitively");
    // The cap is still disclosed — the score is pinned, the counts are not.
    expect(out).toContain("capped at 50");
    expect(out).not.toContain("50+ transitive importers");
  });

  it("says so plainly when nothing imports the file", () => {
    const out = formatExplainReport(
      explainReport({
        blast_radius: 0,
        blast_radius_direct_importers: 0,
        blast_radius_transitive_importers: 0,
      }),
      { noColor: true },
    );
    expect(out).toContain("no other files import this one");
  });

  it("omits the transitive clause when the two counts agree", () => {
    const out = formatExplainReport(
      explainReport({
        blast_radius: 0.08,
        blast_radius_direct_importers: 4,
        blast_radius_transitive_importers: 4,
      }),
      { noColor: true },
    );
    expect(out).toContain("4 files import this directly");
    expect(out).not.toContain("transitively");
  });

  it("falls back to a score-derived estimate when counts are absent", () => {
    const out = formatExplainReport(explainReport({ blast_radius: 0.4 }), {
      noColor: true,
    });
    expect(out).toContain("blast radius: 0.40");
    expect(out).toContain("transitive");
  });
});
