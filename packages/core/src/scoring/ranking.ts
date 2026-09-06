import type { Finding } from "../finding.js";

/** Shared ordering for every presentation. Scores are ordinal, not probabilities. */
export function findingRankScore(finding: Finding, recencyEnabled = true): number {
  return (
    (finding.scores.agent_risk ?? 0) *
    (1 + (recencyEnabled ? (finding.scores.recency ?? 0) : 0) * 0.5)
  );
}

/**
 * Lead with the strongest finding. Each additional claim contributes half
 * as much as the previous one, starting at one quarter. Repeated instances
 * of a claim do not earn more priority merely by being numerous.
 */
export function fileRiskScore(
  findings: readonly Finding[],
  recencyEnabled = true,
): number {
  const claims = new Map<string, number>();
  for (const finding of findings) {
    const claim = `${finding.type}/${finding.claim ?? ""}`;
    claims.set(
      claim,
      Math.max(claims.get(claim) ?? 0, findingRankScore(finding, recencyEnabled)),
    );
  }
  const scores = [...claims.values()].sort((a, b) => b - a);
  return scores.reduce(
    (sum, score, index) => sum + score * (index === 0 ? 1 : 0.5 ** (index + 1)),
    0,
  );
}
