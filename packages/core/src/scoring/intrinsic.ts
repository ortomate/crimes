/**
 * The evidence ladder every counting detector expresses its intrinsic
 * through.
 *
 * ## Why this is shared
 *
 * The formula was already universal — 14 detectors in
 * `packages/core/src/detectors/` inlined
 * `round(Math.min(base + (n - 1) * step, cap))` by hand, and the Python
 * slate factored the identical arithmetic into `py/shared.ts`. Two
 * hand-maintained copies of one formula is the mechanism by which
 * **7 of the 8 charges implemented in both packs came to disagree** —
 * see `docs/dogfooding/2026-08-11-cross-pack-intrinsics.md`.
 *
 * Extracting it changes no number. It makes the constants of a charge
 * addressable as data rather than as arithmetic buried in a detector
 * body, which is what lets {@link INTRINSIC_LADDERS} exist and what lets
 * a test compare two packs' answers for the same charge.
 */

/** Round to two decimals, the precision every score is expressed at. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * The constants a charge's intrinsic ramp is made of.
 *
 * `base` is the value for a single piece of evidence, `step` what each
 * additional piece adds, `cap` the ceiling however much there is.
 */
export interface IntrinsicLadder {
  base: number;
  step: number;
  cap: number;
}

/**
 * Score an intrinsic from an evidence count.
 *
 * `count` is the number of pieces of evidence, **not** the count minus
 * one — the `- 1` is the ladder's own, so `count === 1` yields exactly
 * `base`. A count of zero yields zero: no evidence, no charge.
 */
export function intrinsicFrom(count: number, ladder: IntrinsicLadder): number {
  if (count <= 0) return 0;
  const { base, step, cap } = ladder;
  return round(clamp01(Math.min(base + (count - 1) * step, cap)));
}
