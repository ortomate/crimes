import { describe, expect, it } from "vitest";
import type { Finding } from "../finding.js";
import { fileRiskScore } from "./ranking.js";

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
