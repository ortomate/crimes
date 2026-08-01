import { describe, expect, it } from "vitest";
import {
  ConfidenceLadder,
  SeverityLadder,
  scoreFromSeverity,
  severityFromScore,
} from "./confidence.js";

describe("ConfidenceLadder", () => {
  it("sums only the signals that fired", () => {
    const ladder = new ConfidenceLadder(0.6)
      .add(true, "cross-package match", 0.1)
      .add(false, "three or more files", 0.1)
      .add(true, "domain concept", 0.05);
    expect(ladder.value()).toBe(0.75);
    expect(ladder.applied.map((s) => s.label)).toEqual([
      "cross-package match",
      "domain concept",
    ]);
  });

  it("clamps below 1 — a structural reader is never certain", () => {
    const ladder = new ConfidenceLadder(0.9)
      .add(true, "a", 0.3)
      .add(true, "b", 0.3);
    expect(ladder.value()).toBe(0.98);
  });

  it("clamps above 0 so a damped finding still ranks", () => {
    const ladder = new ConfidenceLadder(0.5).add(true, "damp", -0.9);
    expect(ladder.value()).toBe(0.05);
  });

  it("rounds to two places so float wobble cannot flip an ordering", () => {
    const ladder = new ConfidenceLadder(0.1)
      .add(true, "a", 0.2)
      .add(true, "b", 0.4);
    // 0.1 + 0.2 + 0.4 is 0.7000000000000001 in IEEE754.
    expect(ladder.value()).toBe(0.7);
    expect(Number.isInteger(ladder.value() * 100)).toBe(true);
  });

  it("renders the arithmetic so a reader can reconstruct the verdict", () => {
    const explain = new ConfidenceLadder(0.6)
      .add(true, "cross-package match", 0.12)
      .add(true, "domain concept: billing", -0.05)
      .explain();
    expect(explain).toBe(
      "confidence 0.67 = 0.60 base + 0.12 (cross-package match) - 0.05 (domain concept: billing)",
    );
  });

  it("omits the arithmetic when nothing beyond the base fired", () => {
    expect(new ConfidenceLadder(0.6).explain()).toBe("confidence 0.60");
  });

  it("scales the running total and records the scaling as a signal", () => {
    const ladder = new ConfidenceLadder(0.8).scale(0.5, "fixture scope");
    expect(ladder.value()).toBe(0.4);
    expect(ladder.applied[0]?.label).toBe("fixture scope");
  });

  it("is a no-op when scaled by 1", () => {
    const ladder = new ConfidenceLadder(0.8).scale(1, "production scope");
    expect(ladder.hasSignals).toBe(false);
    expect(ladder.value()).toBe(0.8);
  });
});

describe("severity mapping", () => {
  it("maps scores onto the three public bands", () => {
    expect(severityFromScore(0.9)).toBe("high");
    expect(severityFromScore(0.7)).toBe("high");
    expect(severityFromScore(0.69)).toBe("medium");
    expect(severityFromScore(0.4)).toBe("medium");
    expect(severityFromScore(0.39)).toBe("low");
    expect(severityFromScore(0)).toBe("low");
  });

  it("round-trips through the band midpoint", () => {
    for (const severity of ["low", "medium", "high"] as const) {
      expect(severityFromScore(scoreFromSeverity(severity))).toBe(severity);
    }
  });
});

describe("SeverityLadder", () => {
  it("keeps the label and the numeric score consistent", () => {
    const ladder = new SeverityLadder(0.4)
      .add(true, "payment operation", 0.35)
      .add(false, "queue publish", 0.2);
    expect(ladder.score()).toBe(0.75);
    expect(ladder.severity()).toBe("high");
    // The invariant that matters: a finding labelled `high` can never
    // carry a `scores.severity` in the low band.
    expect(severityFromScore(ladder.score())).toBe(ladder.severity());
  });

  it("names only the signals that raised severity, sorted", () => {
    const ladder = new SeverityLadder(0.4)
      .add(true, "queue publish", 0.2)
      .add(true, "payment operation", 0.3)
      .add(true, "deliberate suppression", -0.2);
    expect(ladder.explain()).toBe(
      "severity raised by: payment operation, queue publish",
    );
  });

  it("returns no escalation line when nothing raised severity", () => {
    const ladder = new SeverityLadder(0.4).add(true, "damped", -0.1);
    expect(ladder.explain()).toBeUndefined();
  });
});
