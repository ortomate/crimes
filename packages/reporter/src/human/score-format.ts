/**
 * Interpretive prose for raw `Finding.scores` floats. JSON output keeps
 * the raw values untouched — these helpers are the human-readable layer.
 *
 * Each helper takes the raw score plus an optional supplementary integer
 * from the scoring context (importer count, 90-day commit count, etc.).
 * When the integer is unavailable (e.g. git missing, scoring context
 * not wired in a test stub), the helper falls back to the quartile
 * label alone.
 */

export type QuartileLabel = "top-quartile" | "median" | "bottom-quartile" | "unknown";

function quartileFromScore(score: number): QuartileLabel {
  if (score >= 0.75) return "top-quartile";
  if (score <= 0.25) return "bottom-quartile";
  return "median";
}

/**
 * Render a blast-radius score as a quartile label, optionally suffixed
 * with the importer count.
 *
 * - `formatBlastRadius(0.85)` → `"top-quartile"`
 * - `formatBlastRadius(0.85, 11)` → `"top-quartile (11 importers)"`
 * - `formatBlastRadius(0.85, 1)` → `"top-quartile (1 importer)"`
 */
export function formatBlastRadius(score: number, importerCount?: number): string {
  const label = quartileFromScore(score);
  if (importerCount === undefined) return label;
  const noun = importerCount === 1 ? "importer" : "importers";
  return `${label} (${importerCount} ${noun})`;
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
