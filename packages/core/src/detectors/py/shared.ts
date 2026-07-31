/**
 * Shared helpers for the `language-py` detector slate.
 *
 * ## Detector ids are qualified; finding types are not
 *
 * Every Python detector declares `id: "<name>.py"` while the findings it
 * emits carry the abstract `type: "<name>"`. That split is deliberate:
 *
 *  - `Finding.type` stays abstract so cross-language grouping works —
 *    a `large_function` in `billing.py` and one in `billing.ts` are the
 *    same charge, and the reporter, baselines, suppressions and triage
 *    all key off `type`.
 *  - The detector's own `id` is qualified so it is separately
 *    addressable in config. `detectors.disable: ["large_function.py"]`
 *    turns off Python's without touching JS's, and the registry doesn't
 *    end up with two entries claiming the same id and different
 *    `optionsSchema`.
 *
 * The JS detectors keep their historical unqualified ids because
 * existing user configs reference them; `assignPackAndDetectorId` adds
 * the `.js` suffix to `Finding.detector_id` at finalisation. Python has
 * no legacy to preserve, so it is qualified from the start.
 *
 * ## Every Python detector sets its own `scores.agent_risk`
 *
 * Since 0.13.0 the detector-supplied intrinsic is the heaviest term in
 * the unified formula:
 *
 *     agent_risk = 0.40*intrinsic + 0.20*churn + 0.20*test_gap
 *                + 0.20*blast_radius
 *
 * Detectors that omit it fall back to a compressed severity-derived
 * default (high 0.75 / medium 0.55 / low 0.40), deliberately lower than
 * a real judgement so fallbacks cannot outrank considered ones. A Python
 * detector that skipped it would rank below its JS equivalent for no
 * reason other than not having an opinion — so all eight scale an
 * intrinsic to the evidence they actually found. {@link intrinsicFor} is
 * the shared ramp.
 */

import type { Severity } from "../../finding.js";

/** Matches the JS detectors' severity → `scores.severity` convention. */
export function severityScore(s: Severity): number {
  return s === "high" ? 0.85 : s === "medium" ? 0.6 : 0.35;
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Evidence-scaled intrinsic agent risk.
 *
 * `base` is what one piece of evidence is worth; each additional piece
 * adds `step`, saturating at `cap`. This is the same shape the JS
 * detectors use (`direct_date` ramps 0.45 + 0.07n to 0.85) — a detector
 * that found six offenders should outrank one that found a single
 * borderline case, and neither should reach 1.0 on count alone.
 */
export function intrinsicFor(args: {
  count: number;
  base: number;
  step: number;
  cap: number;
}): number {
  const { count, base, step, cap } = args;
  if (count <= 0) return 0;
  return round(clamp01(Math.min(base + (count - 1) * step, cap)));
}

/** Render at most `limit` line numbers, with an overflow note. */
export function lineList(lines: readonly number[], limit = 10): string {
  const shown = lines.slice(0, limit);
  const overflow = lines.length > limit ? `, …+${lines.length - limit} more` : "";
  return `lines: ${shown.join(", ")}${overflow}`;
}

/** Pluralise a count for evidence prose. */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}
