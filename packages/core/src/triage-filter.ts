import { fingerprintFinding } from "./fingerprint.js";
import type { Finding } from "./finding.js";
import type { TriageEntry } from "./triage.js";

export interface ApplyTriageFilterOptions {
  /**
   * When true, silenced findings stay visible carrying a `hidden_triage`
   * annotation so the renderer can show them with their disposition;
   * when false, they're removed from `findings[]` and counted in
   * `hiddenCount`.
   */
  showTriaged: boolean;
}

export interface TriageFilterResult {
  findings: Finding[];
  /** Number of findings hidden because of a silencing triage entry. */
  hiddenCount: number;
}

/**
 * Partition findings against `.crimes/triage.json` entries:
 *
 * - `fix-now` / `fix-this-PR` matches receive a `triaged` annotation and
 *   stay in the visible findings list.
 * - `needs-design` / `wont-fix` / `scaffolding` matches are removed by
 *   default. With `showTriaged: true`, they stay in the list annotated
 *   with `hidden_triage` for downstream rendering.
 * - Unmatched findings pass through unchanged.
 *
 * Pure — does not mutate inputs.
 */
export function applyTriageFilter(
  findings: Finding[],
  entries: TriageEntry[],
  options: ApplyTriageFilterOptions,
): TriageFilterResult {
  if (entries.length === 0) {
    return { findings, hiddenCount: 0 };
  }
  // Last-wins on duplicate fingerprints — matches `partitionFindings`
  // in suppressions.ts and the semantics of `upsertTriageEntry`.
  const byFingerprint = new Map<string, TriageEntry>();
  for (const entry of entries) {
    byFingerprint.set(entry.fingerprint, entry);
  }

  let hiddenCount = 0;
  const out: Finding[] = [];

  for (const finding of findings) {
    // Resurfaced findings carry their own `previous_triage` /
    // `previous_baseline` block from the resurface pipeline and are
    // surfaced precisely so the user can re-confirm them. Silencing them
    // here by fingerprint match would defeat the resurface UX. Pass
    // through unchanged; the renderer's resurface block keys off
    // `previously_triaged` / `previously_baselined`.
    if (finding.previously_triaged === true || finding.previously_baselined === true) {
      out.push(finding);
      continue;
    }

    const entry = byFingerprint.get(fingerprintFinding(finding));
    if (!entry) {
      out.push(finding);
      continue;
    }

    // Exhaustive disposition check — future enum additions trigger a
    // compile error in the `never` branch below.
    switch (entry.disposition) {
      case "fix-now":
      case "fix-this-PR":
        out.push({
          ...finding,
          triaged: {
            disposition: entry.disposition,
            reason: entry.reason,
            owner: entry.owner,
            date: entry.date,
          },
        });
        break;
      case "needs-design":
      case "wont-fix":
      case "scaffolding":
        if (options.showTriaged) {
          out.push({
            ...finding,
            hidden_triage: {
              disposition: entry.disposition,
              reason: entry.reason,
              owner: entry.owner,
              date: entry.date,
            },
          });
        } else {
          hiddenCount += 1;
        }
        break;
      default: {
        const exhaustive: never = entry.disposition;
        throw new Error(`unhandled disposition: ${String(exhaustive)}`);
      }
    }
  }

  return { findings: out, hiddenCount };
}
