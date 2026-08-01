import { describe, expect, it } from "vitest";
import { scoreStructural } from "./score.js";
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
