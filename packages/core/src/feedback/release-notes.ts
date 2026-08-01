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
  },
  todo_density: {
    "0.6":
      "Detector now skips its own source file. Likely resolved if your file defines the TODO-density regex.",
  },
  large_file: {
    "0.6":
      "test_file shape added — test suites get a 1500-line budget. Likely resolved for *.test.ts / __tests__/ findings.",
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
