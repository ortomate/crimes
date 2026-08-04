import { describe, expect, it } from "vitest";
import { scoreStructural } from "./score.js";
import { buildEvidenceIndex } from "./scan-helpers.js";
import type { ScanContext } from "./types.js";

const SCAN_CONTEXT: ScanContext = {
  detector_id_by_finding_id: { crime_00025: "locale_drift" },
  detector_id_by_charge: { "Host-Locale Drift": "locale_drift" },
};

describe("scoreStructural — referenced_files", () => {
  it("scores a file the agent had to discover", () => {
    const r = scoreStructural(
      "The problem is in src/date.ts.",
      { referenced_files: ["src/date.ts"] },
      undefined,
      "Review the billing module for locale bugs.",
    );
    expect(r.passed).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.details[0]?.skipped).toBeUndefined();
  });

  it("fails when the agent never names a file it had to discover", () => {
    const r = scoreStructural(
      "There is a locale problem somewhere.",
      { referenced_files: ["src/date.ts"] },
      undefined,
      "Review the billing module for locale bugs.",
    );
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(1);
  });

  it("does not score a path the prompt already handed the agent", () => {
    // The context-01-locale-drift regression: the prompt supplies
    // src/date.ts and asks which *helper* to avoid. A correct answer
    // that names the helper but not the path used to score 0.
    const r = scoreStructural(
      "Do not copy prettyDueDate — it calls toLocaleDateString().",
      { referenced_files: ["src/date.ts"] },
      undefined,
      "Use `crimes context src/date.ts --format json` to find locale-naive renderers.",
    );
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.details[0]?.skipped).toBe("path supplied by the scenario prompt");
  });

  it("still records the skipped check for transparency", () => {
    const r = scoreStructural(
      "irrelevant",
      { referenced_files: ["src/date.ts"] },
      undefined,
      "Look at src/date.ts",
    );
    expect(r.details).toHaveLength(1);
    expect(r.details[0]?.expected).toBe("src/date.ts");
  });

  it("scores discovered files while skipping prompt-supplied ones", () => {
    const r = scoreStructural(
      "Check src/nav.ts as well.",
      { referenced_files: ["src/date.ts", "src/nav.ts"] },
      undefined,
      "Start from src/date.ts.",
    );
    expect(r.passed).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.details.filter((d) => d.skipped !== undefined)).toHaveLength(1);
  });

  it("scores every file when no prompt is supplied (legacy replay)", () => {
    const r = scoreStructural("nothing here", { referenced_files: ["src/date.ts"] });
    expect(r.failed).toBe(1);
    expect(r.details[0]?.skipped).toBeUndefined();
  });
});

describe("scoreStructural — referenced_findings", () => {
  it("accepts slug, charge name, and crime id equivalently", () => {
    for (const ref of ["locale_drift", "Host-Locale Drift", "crime_00025"]) {
      const r = scoreStructural(
        `The issue is ${ref} in the date helper.`,
        { referenced_findings: ["locale_drift"] },
        SCAN_CONTEXT,
      );
      expect(r.passed, ref).toBe(1);
    }
  });
});

describe("scoreStructural — findings referenced by their own evidence", () => {
  /**
   * Both cases below are verbatim from the 0.18.1 run, where codex
   * scored a hard 0 while answering correctly. The scorer only knew
   * how to recognise a slug, a charge, or a `crime_NNNNN` id — and an
   * agent that quotes the finding's *receipts* has referenced it at
   * least as unambiguously as one that pastes its slug.
   */
  const CONTEXT: ScanContext = {
    detector_id_by_finding_id: {},
    detector_id_by_charge: {},
    detector_id_by_evidence: {
      "0 expect/assert calls": "weak_test_signal",
      '"2026-12-20"': "timezone_unsafe_parse",
      '"2026-12-25T07:00:00"': "timezone_unsafe_parse",
    },
  };

  it("credits an evidence line quoted verbatim (bugfix-04-weak-tests)", () => {
    const r = scoreStructural(
      "The finding evidence is:\n\n> `0 expect/assert calls`\n> `lines 537-548`",
      { referenced_findings: ["weak_test_signal"] },
      CONTEXT,
    );
    expect(r.passed).toBe(1);
  });

  it("credits a literal the evidence cites (bugfix-01-timezone-parse)", () => {
    const r = scoreStructural(
      'The responsible literal is `"2026-12-20"` in `startOfPromoWindow()`.',
      { referenced_findings: ["timezone_unsafe_parse"] },
      CONTEXT,
    );
    expect(r.passed).toBe(1);
  });

  it("counts evidence as a leading reference for expected_priority", () => {
    const r = scoreStructural(
      'The responsible literal is `"2026-12-20"`.',
      { expected_priority: "timezone_unsafe_parse" },
      CONTEXT,
    );
    expect(r.passed).toBe(1);
  });

  it("does not credit a finding whose evidence the response never quotes", () => {
    const r = scoreStructural(
      "Something is wrong with the dates somewhere.",
      { referenced_findings: ["timezone_unsafe_parse"] },
      CONTEXT,
    );
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(1);
  });

  it("still works when the context predates the evidence map", () => {
    const r = scoreStructural(
      "`0 expect/assert calls`",
      { referenced_findings: ["weak_test_signal"] },
      { detector_id_by_finding_id: {}, detector_id_by_charge: {} },
    );
    expect(r.failed).toBe(1);
  });
});

describe("buildEvidenceIndex — what earns a place in the map", () => {
  it("indexes an evidence line and the literals it quotes", () => {
    const index = buildEvidenceIndex([
      {
        type: "timezone_unsafe_parse",
        evidence: ['unsafe literals: "2026-12-25T07:00:00", "2026-12-20"'],
      },
    ]);
    expect(index['"2026-12-20"']).toBe("timezone_unsafe_parse");
    expect(index['unsafe literals: "2026-12-25T07:00:00", "2026-12-20"']).toBe(
      "timezone_unsafe_parse",
    );
  });

  it("drops a string two detector types share", () => {
    // The `has()` rule, applied to the scorer: a token that identifies
    // more than one thing identifies nothing. Crediting here would
    // report an agent as having found a detector it never mentioned.
    const index = buildEvidenceIndex([
      { type: "large_function", evidence: ["120 lines"] },
      { type: "large_file", evidence: ["120 lines"] },
    ]);
    expect(index["120 lines"]).toBeUndefined();
  });

  it("drops bare line references, which say nothing about which detector", () => {
    const index = buildEvidenceIndex([
      { type: "weak_test_signal", evidence: ["lines 537-548", "lines: 29, 33"] },
    ]);
    expect(index["lines 537-548"]).toBeUndefined();
    expect(index["lines: 29, 33"]).toBeUndefined();
  });

  it("drops strings too short to be a reference", () => {
    const index = buildEvidenceIndex([{ type: "todo_density", evidence: ["3 TODOs"] }]);
    expect(index["3 TODOs"]).toBeUndefined();
  });

  it("drops plain prose, which an agent can write without citing anything", () => {
    // `arrow declaration` is a real `large_function` evidence line on
    // fixture 04. It is also a phrase an agent can use while describing
    // unrelated code, and crediting that would be matching on a name
    // alone — the mistake `2e9b2da` removed from the product.
    const index = buildEvidenceIndex([
      { type: "large_function", evidence: ["arrow declaration"] },
      { type: "weak_test_signal", evidence: ["0 expect/assert calls"] },
      { type: "direct_date", evidence: ["use an injected clock instead"] },
    ]);
    expect(index["arrow declaration"]).toBeUndefined();
    expect(index["use an injected clock instead"]).toBeUndefined();
    // Kept: digits and punctuation make it a citation, not a phrase.
    expect(index["0 expect/assert calls"]).toBe("weak_test_signal");
  });
});

describe("extractFilePaths coverage (via scoreStructural)", () => {
  /**
   * Guards the measurement bug found in 0.14.0: the extension list is
   * apparatus, and an omission fails a check silently rather than
   * erroring, so a missing language reads as an agent that cannot find
   * files.
   */
  const cases: Array<[string, string]> = [
    ["python module", "billing/ledger.py"],
    ["python stub", "billing/ledger.pyi"],
    ["typescript", "src/billing.ts"],
    ["tsx", "src/App.tsx"],
    ["markdown", "docs/readme.md"],
    ["asset", "public/hero.png"],
    ["toml", "pyproject.toml"],
    ["rust", "src/main.rs"],
    ["go", "cmd/main.go"],
  ];

  for (const [label, path] of cases) {
    it(`credits a ${label} path the agent named`, () => {
      const result = scoreStructural(`I looked at \`${path}\` and it has no test.`, {
        referenced_files: [path],
      });
      const detail = result.details.find((d) => d.check === "referenced_files");
      expect(detail?.passed, `${path} was not extracted from the response`).toBe(true);
    });
  }
});
