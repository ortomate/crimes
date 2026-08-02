/**
 * Per-detector release-notes map used by `crimes feedback recheck`.
 * Keyed by (detector_id, target_minor) — when a suppression resurfaces
 * for re-confirmation, we look up "what changed for this detector in
 * the current minor?" so the user can decide whether to push the pin
 * forward (`fp`) or mark the finding resolved (`tp`).
 *
 * Entries are added as we ship detector behavioural changes. Falls
 * back to a generic message when no entry exists for the pair.
 */
export const RELEASE_NOTES: Record<string, Record<string, string>> = {
  direct_date: {
    "0.7":
      "direct_date now skips test files. Likely resolved if your fp was on a test file.",
  },
  large_function: {
    "0.6":
      "cli_command_registrar shape added — Commander DSL chains get a 200-line budget. Likely resolved for register*Command findings.",
    "0.17":
      "Fingerprints now carry the start line as a discriminator, for anonymous callbacks that share a synthesized symbol within one file (schema_version 0.4.0). Re-record the pin against the callback you meant. Pins on named functions are unaffected.",
  },
  todo_density: {
    "0.6":
      "Detector now skips its own source file. Likely resolved if your file defines the TODO-density regex.",
  },
  large_file: {
    "0.6":
      "test_file shape added — test suites get a 1500-line budget. Likely resolved for *.test.ts / __tests__/ findings.",
    "0.17":
      "docs shape added — .md/.mdx/.rst/.adoc/.txt get a 1000-line budget at low/medium severity. Likely resolved for prose findings.",
  },
  magic_domain_literal_scatter: {
    "0.17":
      "Fingerprints now carry the literal as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that could cover several literals — re-record it against the one you meant.",
  },
  exact_duplicate_block: {
    "0.17":
      "Fingerprints now carry the duplicate group's body hash as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that could cover several groups — re-record it against the one you meant. Evidence strings are also reproducible run-to-run now.",
  },
  near_duplicate_block: {
    "0.17":
      "Fingerprints now carry the shape group's body hash as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that could cover several groups — re-record it against the one you meant.",
  },
  weak_test_signal: {
    "0.17":
      "Fingerprints now carry the test's title as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that covered every test in the file — re-record it against the test you meant.",
  },
  commented_out_code: {
    "0.17":
      "Fingerprints now carry a hash of the comment block as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that covered every block in the file — re-record it against the block you meant.",
  },
  logic_in_comments: {
    "0.17":
      "Fingerprints now carry a hash of the comment block as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that covered every rule comment in the file — re-record it against the one you meant.",
  },
  swallowed_error: {
    "0.17":
      "Fingerprints now carry the protected operation as a discriminator, for handlers whose enclosing function and protected callee are shared (schema_version 0.4.0). Re-record the pin against the handler you meant. Pins on handlers that were already uniquely named are unaffected.",
  },
  unbounded_async_fanout: {
    "0.17":
      "Fingerprints now carry the collection expression as a discriminator, for fan-outs whose enclosing function and per-element call are shared (schema_version 0.4.0). Re-record the pin against the fan-out you meant. Pins on fan-outs that were already uniquely named are unaffected.",
  },
  name_behavior_mismatch: {
    "0.17":
      "Fingerprints now carry the start line as a discriminator, for functions that share a name within one file (schema_version 0.4.0). Re-record the pin against the function you meant. Pins on uniquely-named functions are unaffected.",
  },
  return_shape_roulette: {
    "0.17":
      "Fingerprints now carry the start line as a discriminator, for anonymous functions that share the `<anonymous>` symbol within one file (schema_version 0.4.0). Re-record the pin against the function you meant. Pins on named functions are unaffected.",
  },
  negative_flag_maze: {
    "0.17":
      "Fingerprints now carry a hash of the conditional as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that covered every conditional in the file — re-record it against the one you meant.",
  },
  duplicated_role_status_plan_check: {
    "0.17":
      "Fingerprints now carry the field and literal as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that covered every policy literal anchored on that file — re-record it against the one you meant.",
  },
  duplicate_component_shape: {
    "0.17":
      "Fingerprints now carry the structural shape hash as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that covered every shape group anchored on that file — re-record it against the group you meant.",
  },
  contract_drift: {
    "0.17":
      "Fingerprints now carry the other declaration as a discriminator, where one declaration drifts against several (schema_version 0.4.0). Re-record the pin against the pair you meant. Pins on single-pair findings are unaffected.",
  },
};

export const RELEASE_NOTES_FALLBACK =
  "detector behaviour unchanged. Re-confirm or mark resolved." as const;

/**
 * Look up the release-notes hint for a (detector_id, target_minor)
 * pair. Returns {@link RELEASE_NOTES_FALLBACK} when there's no entry.
 */
export function releaseNoteFor(detectorId: string, targetMinor: string): string {
  return RELEASE_NOTES[detectorId]?.[targetMinor] ?? RELEASE_NOTES_FALLBACK;
}
