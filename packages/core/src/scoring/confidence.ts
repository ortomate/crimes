/**
 * Deterministic confidence and severity ladders.
 *
 * Every 0.16.0 detector scores the same way: start from a base
 * confidence that reflects how certain the *structural* match is, then
 * add named boosts for corroborating signals and subtract named damps for
 * mitigating ones. The result is clamped and rounded so two runs on the
 * same repo produce byte-identical JSON.
 *
 * The reason this is a module rather than a convention: `Finding.evidence`
 * is supposed to let a reader reconstruct the verdict. A confidence of
 * 0.82 that came from `0.6 + 0.12 + 0.1` is explainable; one that came
 * from a hand-tuned literal is not. {@link ConfidenceLadder.explain}
 * renders the arithmetic straight into evidence.
 */

import type { Severity } from "../finding.js";

/** One named contribution to a confidence score. */
export interface ConfidenceSignal {
  /** Short stable label, e.g. `"cross-package match"`. */
  label: string;
  /** Signed delta. Positive corroborates; negative mitigates. */
  delta: number;
}

/**
 * Rounding granularity. Two decimal places — enough resolution to rank,
 * coarse enough that a float-arithmetic wobble can never flip an ordering
 * between platforms.
 */
const PRECISION = 100;

/**
 * Accumulates named signals into a final confidence in [0.05, 0.98].
 *
 * The ceiling is deliberately below 1.0: these detectors read structure,
 * not semantics, and a detector that claims certainty is lying. The floor
 * exists so a heavily-damped finding still carries a usable number rather
 * than 0, which downstream ranking would read as "ignore entirely".
 */
export class ConfidenceLadder {
  private readonly base: number;
  private readonly signals: ConfidenceSignal[] = [];

  constructor(base: number) {
    this.base = base;
  }

  /**
   * Record a signal. `when` is evaluated by the caller so call sites read
   * as a flat list of rules rather than a pile of `if`s.
   */
  add(when: boolean, label: string, delta: number): this {
    if (when) this.signals.push({ label, delta });
    return this;
  }

  /** Multiply the running total — used for scope damping. */
  scale(factor: number, label: string): this {
    if (factor === 1) return this;
    const before = this.rawTotal();
    const after = before * factor;
    this.signals.push({ label, delta: after - before });
    return this;
  }

  /** Every signal that fired, in insertion order. */
  get applied(): readonly ConfidenceSignal[] {
    return this.signals;
  }

  /** Did any signal fire? */
  get hasSignals(): boolean {
    return this.signals.length > 0;
  }

  /** Final clamped, rounded confidence. */
  value(): number {
    return clamp(round(this.rawTotal()), 0.05, 0.98);
  }

  /**
   * One-line arithmetic trace for `Finding.evidence`, e.g.
   * `confidence 0.82 = 0.60 base + 0.12 (cross-package match) + 0.10 (domain concept: billing)`.
   *
   * Returns just the value when nothing beyond the base fired, so a
   * plain finding doesn't carry a pointless "= 0.60 base" line.
   */
  explain(): string {
    const value = this.value();
    if (this.signals.length === 0) {
      return `confidence ${fmt(value)}`;
    }
    const parts = this.signals.map(
      (s) => `${s.delta < 0 ? "-" : "+"} ${fmt(Math.abs(s.delta))} (${s.label})`,
    );
    return `confidence ${fmt(value)} = ${fmt(this.base)} base ${parts.join(" ")}`;
  }

  private rawTotal(): number {
    let total = this.base;
    for (const s of this.signals) total += s.delta;
    return total;
  }
}

/**
 * Map a 0-1 severity score onto the three-value public `Severity`.
 *
 * The thresholds are shared so `severity` and `scores.severity` can never
 * disagree — a finding labelled `high` with `scores.severity: 0.3` is the
 * kind of contradiction that makes the JSON contract untrustworthy.
 */
export function severityFromScore(score: number): Severity {
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "medium";
  return "low";
}

/**
 * Inverse of {@link severityFromScore} for detectors that pick the label
 * first. Returns the midpoint of the band so the round-trip is stable.
 */
export function scoreFromSeverity(severity: Severity): number {
  switch (severity) {
    case "high":
      return 0.8;
    case "medium":
      return 0.55;
    case "low":
      return 0.3;
  }
}

/**
 * Accumulates severity the same way {@link ConfidenceLadder} accumulates
 * confidence, then hands back both the numeric score and the matching
 * public label so the two cannot drift.
 */
export class SeverityLadder {
  private readonly ladder: ConfidenceLadder;

  constructor(base: number) {
    this.ladder = new ConfidenceLadder(base);
  }

  add(when: boolean, label: string, delta: number): this {
    this.ladder.add(when, label, delta);
    return this;
  }

  /** Numeric 0-1 score for `scores.severity`. */
  score(): number {
    return this.ladder.value();
  }

  /** Public three-value label, always consistent with {@link score}. */
  severity(): Severity {
    return severityFromScore(this.score());
  }

  /** Signals that fired, for evidence. */
  get applied(): readonly ConfidenceSignal[] {
    return this.ladder.applied;
  }

  /** Escalation trace naming only the signals that raised severity. */
  explain(): string | undefined {
    const raised = this.ladder.applied.filter((s) => s.delta > 0);
    if (raised.length === 0) return undefined;
    return `severity raised by: ${raised
      .map((s) => s.label)
      .sort()
      .join(", ")}`;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * PRECISION) / PRECISION;
}

function fmt(value: number): string {
  return value.toFixed(2);
}

/**
 * Collect the derivation of a finding's scores for
 * `Finding.score_rationale`.
 *
 * Exists so the ten detectors that use the ladders all produce the same
 * shape, and so the split from `evidence` is made once rather than
 * remembered seventeen times.
 */
export function scoreRationale(
  confidence: ConfidenceLadder,
  severity?: SeverityLadder,
): string[] {
  const out = [confidence.explain()];
  const escalation = severity?.explain();
  if (escalation !== undefined) out.push(escalation);
  return out;
}
