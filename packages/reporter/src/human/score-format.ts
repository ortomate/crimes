/**
 * Interpretive prose for raw `Finding.scores` floats. JSON output keeps
 * the raw values untouched — these helpers are the human-readable layer.
 *
 * Each helper takes the raw score plus optional supplementary integers
 * from the scoring context (importer counts, 90-day commit count, etc.).
 * When those are unavailable (e.g. git missing, scoring context not
 * wired in a test stub), the helper falls back to the quartile label
 * alone. A helper that receives an integer must name what it counts —
 * see {@link formatBlastRadius}.
 */

export type QuartileLabel = "top-quartile" | "median" | "bottom-quartile" | "unknown";

function quartileFromScore(score: number): QuartileLabel {
  if (score >= 0.75) return "top-quartile";
  if (score <= 0.25) return "bottom-quartile";
  return "median";
}

/** The two integers behind a `blast_radius` score. */
export interface BlastRadiusCounts {
  /** `scores.blast_radius_direct_importers` — genuine per-file fan-in. */
  direct?: number;
  /** `scores.blast_radius_transitive_importers` — reachability closure. */
  transitive?: number;
}

/**
 * Render a blast-radius score as a quartile label, suffixed with whichever
 * importer counts are available.
 *
 * The two counts are always labelled. Rendering the transitive closure as
 * a bare "N importers" was the pre-0.5.0 defect: on the zulip corpus it
 * claimed `slack.py` had 798 importers when 5 files import it, because the
 * closure collapses to the size of the strongly-connected component the
 * file sits in.
 *
 * - `formatBlastRadius(0.85)` → `"top-quartile"`
 * - `formatBlastRadius(1, { direct: 5, transitive: 798 })` →
 *   `"top-quartile (5 direct / 798 transitive importers)"`
 * - `formatBlastRadius(0.85, { direct: 11, transitive: 11 })` →
 *   `"top-quartile (11 direct importers)"` — nothing extra is reachable,
 *   so the second number carries no information.
 */
export function formatBlastRadius(score: number, counts?: BlastRadiusCounts): string {
  const label = quartileFromScore(score);
  const direct = counts?.direct;
  const transitive = counts?.transitive;
  if (direct === undefined && transitive === undefined) return label;
  if (direct !== undefined && transitive !== undefined && transitive !== direct) {
    return `${label} (${direct} direct / ${transitive} transitive importers)`;
  }
  const kind = direct !== undefined ? "direct" : "transitive";
  const n = direct !== undefined ? direct : transitive!;
  const noun = n === 1 ? "importer" : "importers";
  return `${label} (${n} ${kind} ${noun})`;
}

/**
 * Render a churn score as either a commit-count summary (when commit
 * data is available) or a high/medium/low band.
 *
 * - `formatChurn(0.6, 24, "2026-05-18T12:30:00Z")` →
 *   `"24 commits over 90d · last touched <relative>"`
 * - `formatChurn(0.6, 24)` → `"24 commits over 90d"`
 * - `formatChurn(0.8)` → `"high"`
 * - `formatChurn(0.5)` → `"medium"`
 * - `formatChurn(0.2)` → `"low"`
 */
export function formatChurn(
  score: number,
  commits90d?: number,
  lastCommitAt?: string,
  now: Date = new Date(),
): string {
  if (commits90d !== undefined) {
    let result = `${commits90d} commits over 90d`;
    if (lastCommitAt) {
      result += ` · last touched ${humanDateSince(lastCommitAt, now)}`;
    }
    return result;
  }
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "medium";
  return "low";
}

/**
 * Render a test-gap score as a quartile label. When a pre-computed
 * label is provided (from `ContextReport.clues.test_gap.label`), use it
 * directly; otherwise derive from the raw score.
 *
 * - `formatTestGap(1.0, "top-quartile")` → `"top-quartile"`
 * - `formatTestGap(0.5)` → `"median"`
 * - `formatTestGap(0)` → `"bottom-quartile"`
 */
export function formatTestGap(score: number, label?: QuartileLabel): string {
  if (label && label !== "unknown") return label;
  return quartileFromScore(score);
}

function humanDateSince(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = now.getTime() - then;
  const days = Math.round(diffMs / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}
