import { compareMinor, minorKey } from "../suppressions.js";
import type { SuppressionEntry } from "../suppressions.js";
import { releaseNoteFor } from "./release-notes.js";

/**
 * One resurfaced suppression in `crimes feedback recheck` output —
 * carries everything the human / JSON renderer needs to surface the
 * "previously marked fp" prompt and the two suggested re-feedback
 * commands, without round-tripping to a fresh scan.
 */
export interface ResurfacedSuppression {
  fingerprint: string;
  type: string;
  file?: string;
  symbol?: string;
  /** The reason recorded on the original feedback `fp` entry. */
  reason: string;
  /** The full pin value from the suppression (e.g. `"0.6"` or `"0.6.3"`). */
  crimes_version_pinned: string;
  /** Per-detector release-notes hint, or the generic fallback. */
  hint: string;
}

export interface ResurfacedSuppressionsOptions {
  /** Filter by detector id, e.g. `"large_function"`. */
  detector?: string;
}

/**
 * Walk a suppressions list and return every feedback-sourced entry
 * whose pinned minor is older than the current crimes minor. Each
 * result carries the release-notes hint for (type, currentMinor) so
 * the renderer doesn't have to look it up itself. Manual suppressions
 * and current-minor or future-pinned feedback entries are skipped.
 */
export function resurfacedSuppressions(
  entries: SuppressionEntry[],
  currentVersion: string,
  options: ResurfacedSuppressionsOptions = {},
): ResurfacedSuppression[] {
  const currentMinor = minorKey(currentVersion);
  const result: ResurfacedSuppression[] = [];
  for (const e of entries) {
    if (e.source !== "feedback") continue;
    if (!e.crimes_version_pinned) continue;
    if (compareMinor(e.crimes_version_pinned, currentVersion) >= 0) {
      // Same-minor or future-pinned — not resurfaced.
      // Use compareMinor (numeric) instead of lexicographic string compare;
      // `"0.5" >= "0.10"` is true lexicographically but false numerically,
      // and the 0.9 → 0.10 boundary hit that exact case.
      continue;
    }
    if (options.detector && e.type !== options.detector) continue;
    const hit: ResurfacedSuppression = {
      fingerprint: e.fingerprint,
      type: e.type,
      reason: e.reason,
      crimes_version_pinned: e.crimes_version_pinned,
      // Pass the pin as well as the current minor: a user upgrading
      // 0.17 → 0.19 crossed 0.18's changes too, and looking up the
      // current minor alone would tell them nothing changed.
      hint: releaseNoteFor(e.type, currentMinor, minorKey(e.crimes_version_pinned)),
    };
    if (e.file !== undefined) hit.file = e.file;
    if (e.symbol !== undefined) hit.symbol = e.symbol;
    result.push(hit);
  }
  return result;
}
