import { fingerprintFinding } from "./fingerprint.js";
import type { Finding } from "./finding.js";
import type { TriageDisposition, TriageEntry } from "./triage.js";

const SILENCED: ReadonlySet<TriageDisposition> = new Set<TriageDisposition>([
  "needs-design",
  "wont-fix",
  "scaffolding",
]);

export interface ApplyTriageFilterOptions {
  /** When true, silenced findings stay visible with a `_hiddenTriage` marker. */
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
 *   default. With `showTriaged: true`, they stay in the list with a
 *   `_hiddenTriage` marker for downstream rendering.
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
  const byFingerprint = new Map<string, TriageEntry>();
  for (const entry of entries) {
    if (!byFingerprint.has(entry.fingerprint)) {
      byFingerprint.set(entry.fingerprint, entry);
    }
  }

  let hiddenCount = 0;
  const out: Finding[] = [];

  for (const finding of findings) {
    const entry = byFingerprint.get(fingerprintFinding(finding));
    if (!entry) {
      out.push(finding);
      continue;
    }

    if (SILENCED.has(entry.disposition)) {
      if (options.showTriaged) {
        const annotated = { ...finding } as Finding & { _hiddenTriage?: TriageEntry };
        annotated._hiddenTriage = entry;
        out.push(annotated);
      } else {
        hiddenCount += 1;
      }
      continue;
    }

    // fix-now or fix-this-PR — annotate and keep visible.
    out.push({
      ...finding,
      triaged: {
        disposition: entry.disposition as "fix-now" | "fix-this-PR",
        reason: entry.reason,
        owner: entry.owner,
        date: entry.date,
      },
    });
  }

  return { findings: out, hiddenCount };
}
