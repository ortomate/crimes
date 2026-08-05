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
    // without; the remaining nine landed in 0.17.2.
    const changed = [
      "commented_out_code",
      "contract_drift",
      "duplicate_component_shape",
      "duplicated_role_status_plan_check",
      "exact_duplicate_block",
      "large_function",
      "logic_in_comments",
      "magic_domain_literal_scatter",
      "name_behavior_mismatch",
      "near_duplicate_block",
      "negative_flag_maze",
      "return_shape_roulette",
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

  it("a pin that skips a minor still sees the notes for the minors it crossed", () => {
    // The lookup used to key on the current minor *exactly*, so every
    // note went unreachable the moment the next minor shipped. 0.18.0
    // silently orphaned all fifteen 0.17 notes; a user upgrading
    // 0.17 → 0.19 was told "detector behaviour unchanged" about the
    // fingerprint change that invalidated their pin.
    //
    // A release is not the unit a user upgrades across — a span is.
    const note = releaseNoteFor("magic_domain_literal_scatter", "0.19", "0.16");
    expect(note).not.toBe(RELEASE_NOTES_FALLBACK);
    expect(note).toMatch(/discriminator/);
  });

  it("does not surface notes for minors older than the pin", () => {
    // A user pinned at 0.17 already lived through 0.17's changes.
    const note = releaseNoteFor("large_function", "0.19", "0.17");
    expect(note).not.toMatch(/cli_command_registrar/);
  });

  it("concatenates every note across a multi-minor span, oldest first", () => {
    const note = releaseNoteFor("large_file", "0.19", "0.5");
    expect(note).toMatch(/test_file shape/);
    expect(note).toMatch(/docs shape/);
    expect(note.indexOf("test_file shape")).toBeLessThan(note.indexOf("docs shape"));
  });

  it("every detector whose fingerprint changed still tells a 0.19 upgrader to re-record", () => {
    // The 0.19.0 release is the first to ship a span of unpublished
    // minors (0.18.0–0.18.4 were internal eval-baseline markers), so
    // this is the case the exact-match lookup got wrong in production.
    const changed = [
      "commented_out_code",
      "contract_drift",
      "duplicate_component_shape",
      "duplicated_role_status_plan_check",
      "exact_duplicate_block",
      "large_function",
      "logic_in_comments",
      "magic_domain_literal_scatter",
      "name_behavior_mismatch",
      "near_duplicate_block",
      "negative_flag_maze",
      "return_shape_roulette",
      "swallowed_error",
      "unbounded_async_fanout",
      "weak_test_signal",
    ];
    for (const detector of changed) {
      const note = releaseNoteFor(detector, "0.19", "0.16");
      expect(note, detector).not.toBe(RELEASE_NOTES_FALLBACK);
      expect(note, detector).toMatch(/re-record/i);
    }
  });

  it("carries a note for every detector whose behaviour changed in 0.18", () => {
    // These shipped between 0.18.0 and 0.18.4 and reached users only in
    // 0.19.0. Each changes what fires, so a pin may now be stale for a
    // reason that has nothing to do with the code it names.
    const changed = [
      "commented_out_code",
      "parallel_destination",
      "pass_through_abstraction",
      "cross_language_route_drift",
      "boolean_naming_drift",
      "sync_io_in_hotpath",
      "weak_test_signal",
    ];
    for (const detector of changed) {
      const note = releaseNoteFor(detector, "0.18", "0.17");
      expect(note, detector).not.toBe(RELEASE_NOTES_FALLBACK);
    }
  });
});

describe("0.21 precision pass", () => {
  it("carries a note for every detector whose precision changed", () => {
    // Four detectors were retuned in 0.21.0 off one field report. Each
    // moves either what fires or how severely, so a pinned suppression
    // may now be stale for a reason that has nothing to do with the
    // code it names.
    for (const detector of [
      "logic_in_comments",
      "direct_date",
      "high_fan_in_fan_out",
      "name_behavior_mismatch",
    ]) {
      expect(releaseNoteFor(detector, "0.21", "0.20"), detector).not.toBe(
        RELEASE_NOTES_FALLBACK,
      );
    }
  });

  it("still reaches the 0.17 fingerprint notes from an older pin", () => {
    // The span lookup is what makes this work; an exact-minor lookup
    // would have orphaned them again the moment 0.21 shipped.
    const note = releaseNoteFor("logic_in_comments", "0.21", "0.16");
    expect(note).toMatch(/discriminator/);
    expect(note).toMatch(/whole words|substrings/);
  });
});
