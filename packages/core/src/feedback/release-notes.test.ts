import { describe, expect, it } from "vitest";
import {
  RELEASE_NOTES,
  RELEASE_NOTES_FALLBACK,
  releaseNoteFor,
} from "./release-notes.js";

describe("releaseNoteFor", () => {
  it("returns the baked-in hint for a known (detector, minor) pair", () => {
    expect(releaseNoteFor("direct_date", "0.7")).toMatch(/skips test files/);
    expect(releaseNoteFor("large_function", "0.6")).toMatch(/cli_command_registrar/);
  });

  it("falls back when no entry exists for the detector", () => {
    expect(releaseNoteFor("brand_new_detector", "0.7")).toBe(RELEASE_NOTES_FALLBACK);
  });

  it("falls back when the detector exists but the minor doesn't", () => {
    expect(releaseNoteFor("direct_date", "0.99")).toBe(RELEASE_NOTES_FALLBACK);
  });

  it("the map is non-empty (covers at least the §6.1 / §6.3 fixes)", () => {
    expect(Object.keys(RELEASE_NOTES).length).toBeGreaterThan(0);
  });

  it("every detector whose fingerprint changed in 0.17 tells the user to re-record", () => {
    // A fingerprint change breaks pinned suppressions. Shipping one
    // without a note leaves `crimes feedback recheck` saying "detector
    // behaviour unchanged" about the one change that invalidated the
    // pin. 0.17.0 shipped three such detectors with notes and three
    // without; the four here landed in 0.17.2.
    const changed = [
      "commented_out_code",
      "contract_drift",
      "exact_duplicate_block",
      "large_function",
      "logic_in_comments",
      "magic_domain_literal_scatter",
      "near_duplicate_block",
      "swallowed_error",
      "unbounded_async_fanout",
      "weak_test_signal",
    ];
    for (const detector of changed) {
      const note = releaseNoteFor(detector, "0.17");
      expect(note, detector).not.toBe(RELEASE_NOTES_FALLBACK);
      expect(note, detector).toMatch(/re-record/i);
    }
  });
});
