import { describe, expect, it } from "vitest";
import type { Finding } from "../finding.js";
import { fileRiskScore, repeatDecayedRankScores } from "./ranking.js";

const finding = (type: string, risk: number, claim?: string) =>
  ({
    type,
    claim,
    scores: { agent_risk: risk },
  }) as Finding;

describe("file risk priority", () => {
  it("does not let repeated mild observations bury a consequential finding", () => {
    const repeated = Array.from({ length: 30 }, () =>
      finding("swallowed_error", 0.3, "bland_fallback"),
    );
    expect(fileRiskScore(repeated)).toBe(0.3);
    expect(fileRiskScore([finding("contract_drift", 0.7)])).toBeGreaterThan(
      fileRiskScore(repeated),
    );
  });

  it("credits distinct claims without allowing an unbounded count bonus", () => {
    const many = Array.from({ length: 30 }, (_, i) => finding(`risk_${i}`, 0.4));
    expect(fileRiskScore(many)).toBeGreaterThan(0.4);
    expect(fileRiskScore(many)).toBeLessThan(0.6);
    expect(
      fileRiskScore([
        finding("weak_test_signal", 0.4, "no_assertions"),
        finding("weak_test_signal", 0.4, "weak_assertions"),
      ]),
    ).toBe(0.5);
  });
});

describe("repeat-claim decay", () => {
  const at = (file: string, type: string, risk: number) =>
    ({ file, type, scores: { agent_risk: risk } }) as Finding;

  it("decays further findings of one claim in one file, not other files", () => {
    const first = at("a.kt", "commented_out_code", 0.5);
    const second = at("a.kt", "commented_out_code", 0.5);
    const third = at("a.kt", "commented_out_code", 0.5);
    const elsewhere = at("b.kt", "commented_out_code", 0.5);
    const other = at("a.kt", "swallowed_error", 0.4);
    const keys = repeatDecayedRankScores([first, second, third, elsewhere, other]);
    expect(keys.get(first)).toBe(0.5);
    expect(keys.get(second)).toBeCloseTo(0.375);
    expect(keys.get(third)).toBeCloseTo(0.28125);
    expect(keys.get(elsewhere)).toBe(0.5);
    // A different claim in the same file is not a repeat, so it now
    // sorts above the file's second commented-out block.
    expect(keys.get(other)).toBe(0.4);
    expect(keys.get(other)!).toBeGreaterThan(keys.get(second)!);
  });
});
