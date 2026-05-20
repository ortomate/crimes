import type { BaselineEntry } from "./baseline.js";
import { fingerprintFinding } from "./fingerprint.js";
import type { Finding } from "./finding.js";
import type { TriageDisposition, TriageEntry } from "./triage.js";

export interface ResurfaceInput {
  /**
   * Repo-relative POSIX paths of files touched in the working tree +
   * branch diff. Empty set short-circuits to `[]`.
   */
  diffFiles: Set<string>;
  triageEntries: TriageEntry[];
  baselineEntries: BaselineEntry[];
  /**
   * Re-runs the relevant detector(s) on a single file and returns the
   * resulting findings. The scan pipeline supplies an implementation
   * that routes by detector type; tests pass a vitest mock.
   */
  reDetect: (file: string) => Promise<Finding[]>;
}

// Spec §5.3: only the silencing dispositions resurface. fix-now and
// fix-this-PR remain in the regular findings list with a `triaged`
// annotation; resurfacing them too would double-render them.
const RESURFACING_DISPOSITIONS: ReadonlySet<TriageDisposition> = new Set([
  "needs-design",
  "wont-fix",
  "scaffolding",
]);

/**
 * Build the resurfaced findings list: for every silenced triage or
 * baseline entry whose `file` is in `diffFiles`, re-run its detector and
 * emit any matching finding annotated with the prior disposition.
 *
 * Triage entries win over baseline entries when both match the same
 * fingerprint **and** the triage entry has a silencing disposition. A
 * non-silencing triage entry (fix-now / fix-this-PR) is ignored for
 * resurfacing — if a baseline entry exists for the same fingerprint, it
 * still resurfaces under the baseline branch.
 *
 * Resurfaced findings whose re-detect yields no match for the stored
 * fingerprint are silently dropped — they're already fixed.
 *
 * Findings produced by `reDetect` that have no matching stored
 * fingerprint are also dropped — they're fresh findings that the
 * main scan pipeline handles, not resurfaces.
 *
 * Pure (modulo the `reDetect` callback's side effects).
 */
export async function collectResurfaced(
  input: ResurfaceInput,
): Promise<Finding[]> {
  if (input.diffFiles.size === 0) return [];

  // Last-wins on duplicate fingerprints within each source list (matches
  // the convention in suppressions.ts / triage-filter.ts). Only silenced
  // triage entries enter the resurface map.
  const triageByPrint = new Map<string, TriageEntry>();
  for (const e of input.triageEntries) {
    if (!RESURFACING_DISPOSITIONS.has(e.disposition)) continue;
    triageByPrint.set(e.fingerprint, e);
  }
  const baselineByPrint = new Map<string, BaselineEntry>();
  for (const e of input.baselineEntries) {
    baselineByPrint.set(e.fingerprint, e);
  }

  // Files to re-detect = union of resurfacing-eligible triage and
  // baseline files that are also in the diff. Skipping non-silencing
  // triage entries here avoids a re-detect call for files whose only
  // triage entries are fix-now / fix-this-PR.
  const filesToReDetect = new Set<string>();
  for (const e of triageByPrint.values()) {
    if (input.diffFiles.has(e.file)) filesToReDetect.add(e.file);
  }
  for (const e of input.baselineEntries) {
    if (input.diffFiles.has(e.file)) filesToReDetect.add(e.file);
  }
  if (filesToReDetect.size === 0) return [];

  const resurfaced: Finding[] = [];

  for (const file of filesToReDetect) {
    const detected = await input.reDetect(file);
    for (const finding of detected) {
      const print = fingerprintFinding(finding);
      const triage = triageByPrint.get(print);
      const baseline = baselineByPrint.get(print);
      if (!triage && !baseline) continue;

      if (triage) {
        resurfaced.push({
          ...finding,
          previously_triaged: true,
          previous_triage: {
            disposition: triage.disposition,
            reason: triage.reason,
            owner: triage.owner,
            date: triage.date,
          },
        });
      } else if (baseline) {
        resurfaced.push({
          ...finding,
          previously_baselined: true,
          previous_baseline: {},
        });
      }
    }
  }

  return resurfaced;
}
