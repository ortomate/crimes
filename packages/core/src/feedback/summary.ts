import type { FeedbackEntry, FeedbackSummary } from "./types.js";
import { latestPerFingerprint } from "./read.js";

/**
 * Compute a {@link FeedbackSummary} from a flat list of feedback
 * entries. Uses {@link latestPerFingerprint} to collapse the
 * append-only history to one verdict per fingerprint before counting.
 *
 * When entries carry a `repo` field (the global-rollup shape), the
 * returned summary includes a `by_repo` breakdown grouped by latest
 * verdict per (repo, fingerprint) pair.
 */
export function buildFeedbackSummary(entries: FeedbackEntry[]): FeedbackSummary {
  const hasRepo = entries.some((e) => e.repo !== undefined);

  // Per-repo, latest-per-fingerprint when scope is global. Per-fingerprint
  // when scope is local (no repo field).
  const keyFor = (e: FeedbackEntry): string =>
    hasRepo ? `${e.repo ?? ""}::${e.fingerprint}` : e.fingerprint;

  const latest = new Map<string, FeedbackEntry>();
  for (const e of entries) {
    const key = keyFor(e);
    const prior = latest.get(key);
    if (!prior || e.timestamp >= prior.timestamp) latest.set(key, e);
  }

  const summary: FeedbackSummary = {
    total: latest.size,
    by_verdict: { tp: 0, fp: 0, known: 0 },
    by_detector: {},
    by_version: {},
  };
  if (hasRepo) summary.by_repo = {};

  for (const e of latest.values()) {
    summary.by_verdict[e.verdict] += 1;
    summary.by_detector[e.finding_type] ??= { tp: 0, fp: 0, known: 0 };
    summary.by_detector[e.finding_type]![e.verdict] += 1;
    summary.by_version[e.crimes_version] =
      (summary.by_version[e.crimes_version] ?? 0) + 1;
    if (summary.by_repo && e.repo) {
      summary.by_repo[e.repo] = (summary.by_repo[e.repo] ?? 0) + 1;
    }
  }
  return summary;
}

/** Re-export so call sites can pull both from feedback/index. */
export { latestPerFingerprint };

/**
 * Count feedback entries (raw, not latest-per-fingerprint) grouped by
 * `finding_type`. Used by the reporter to decide whether to suppress
 * the inline "Give feedback:" hint for a given detector — after 5+
 * entries the user doesn't need the prompt anymore.
 */
export function countEntriesByDetector(entries: FeedbackEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) {
    counts[e.finding_type] = (counts[e.finding_type] ?? 0) + 1;
  }
  return counts;
}
