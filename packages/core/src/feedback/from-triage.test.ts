import { describe, expect, it } from "vitest";
import type { TriageDisposition, TriageEntry } from "../triage.js";
import {
  WONT_FIX_FALLBACK_VERDICT,
  feedbackEntryFromTriage,
  verdictForDisposition,
} from "./from-triage.js";

function triage(
  disposition: TriageDisposition,
  overrides: Partial<TriageEntry> = {},
): TriageEntry {
  return {
    fingerprint: "large_function::src/a.ts::doThing",
    type: "large_function",
    file: "src/a.ts",
    disposition,
    reason: "splitting this in the billing refactor",
    owner: "andrew",
    date: "2026-07-31",
    ...overrides,
  };
}

describe("verdictForDisposition", () => {
  it("treats committing to act as agreeing the finding is real", () => {
    expect(verdictForDisposition("fix-now")).toBe("tp");
    expect(verdictForDisposition("fix-this-PR")).toBe("tp");
    expect(verdictForDisposition("needs-design")).toBe("tp");
  });

  it("treats scaffolding as a known, intentional pattern", () => {
    expect(verdictForDisposition("scaffolding")).toBe("known");
  });

  it("refuses to guess a verdict for wont-fix", () => {
    // wont-fix conflates "crimes was wrong" with "crimes was right and
    // we accept it" — opposite calibration signals. Guessing fp would
    // also write an auto-suppression off an assumption.
    expect(verdictForDisposition("wont-fix")).toBeNull();
  });
});

describe("feedbackEntryFromTriage", () => {
  it("derives an entry from an unambiguous disposition", () => {
    const entry = feedbackEntryFromTriage({
      triage: triage("fix-now"),
      crimesVersion: "0.12.2",
    });
    expect(entry).not.toBeNull();
    expect(entry?.verdict).toBe("tp");
    expect(entry?.fingerprint).toBe("large_function::src/a.ts::doThing");
    expect(entry?.finding_type).toBe("large_function");
    expect(entry?.crimes_version).toBe("0.12.2");
  });

  it("carries the triage reason across as the note", () => {
    const entry = feedbackEntryFromTriage({
      triage: triage("fix-this-PR", { reason: "genuinely too long" }),
      crimesVersion: "0.12.2",
    });
    expect(entry?.note).toBe("genuinely too long");
  });

  it("returns null for wont-fix with no explicit verdict", () => {
    expect(
      feedbackEntryFromTriage({
        triage: triage("wont-fix"),
        crimesVersion: "0.12.2",
      }),
    ).toBeNull();
  });

  it("uses an explicit verdict to resolve wont-fix", () => {
    const entry = feedbackEntryFromTriage({
      triage: triage("wont-fix", { reason: "test helper, not domain code" }),
      crimesVersion: "0.12.2",
      explicitVerdict: "fp",
    });
    expect(entry?.verdict).toBe("fp");
    expect(entry?.note).toBe("test helper, not domain code");
  });

  it("ignores an explicit verdict for an unambiguous disposition", () => {
    const entry = feedbackEntryFromTriage({
      triage: triage("fix-now"),
      crimesVersion: "0.12.2",
      explicitVerdict: "fp",
    });
    expect(entry?.verdict).toBe("tp");
  });

  it("normalises a blank reason to null rather than an empty string", () => {
    const entry = feedbackEntryFromTriage({
      triage: triage("scaffolding", { reason: "   " }),
      crimesVersion: "0.12.2",
    });
    expect(entry?.note).toBeNull();
  });

  it("emits the stable JSONL field shape", () => {
    const entry = feedbackEntryFromTriage({
      triage: triage("fix-now"),
      crimesVersion: "0.12.2",
    });
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "crimes_version",
      "finding_type",
      "fingerprint",
      "note",
      "resurfaced_from",
      "scan_hash",
      "verdict",
    ]);
  });

  it("falls back to known for wont-fix in non-interactive callers", () => {
    const entry = feedbackEntryFromTriage({
      triage: triage("wont-fix"),
      crimesVersion: "0.12.2",
      explicitVerdict: WONT_FIX_FALLBACK_VERDICT,
    });
    expect(entry?.verdict).toBe("known");
  });
});
