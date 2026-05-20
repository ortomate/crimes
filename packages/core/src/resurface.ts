import type { BaselineEntry } from "./baseline.js";
import { fingerprintFinding } from "./fingerprint.js";
import type { Finding } from "./finding.js";
import type { TriageEntry } from "./triage.js";

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

/**
 * Build the resurfaced findings list: for every triage or baseline
 * entry whose `file` is in `diffFiles`, re-run its detector and emit
 * any matching finding annotated with the prior disposition.
 *
 * Triage entries win over baseline entries when both match the same
 * fingerprint.
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
  // the convention in suppressions.ts / triage-filter.ts).
  const triageByPrint = new Map<string, TriageEntry>();
  for (const e of input.triageEntries) {
    triageByPrint.set(e.fingerprint, e);
  }
  const baselineByPrint = new Map<string, BaselineEntry>();
  for (const e of input.baselineEntries) {
    baselineByPrint.set(e.fingerprint, e);
  }

  // Files to re-detect = union of triage and baseline files that are
  // also in the diff.
  const filesToReDetect = new Set<string>();
  for (const e of input.triageEntries) {
    if (input.diffFiles.has(e.file)) filesToReDetect.add(e.file);
  }
  for (const e of input.baselineEntries) {
    if (input.diffFiles.has(e.file)) filesToReDetect.add(e.file);
  }

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
