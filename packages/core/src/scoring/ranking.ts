import type { Finding } from "../finding.js";

/** Shared ordering for every presentation. Scores are ordinal, not probabilities. */
export function findingRankScore(finding: Finding, recencyEnabled = true): number {
  return (
    (finding.scores.agent_risk ?? 0) *
    (1 + (recencyEnabled ? (finding.scores.recency ?? 0) : 0) * 0.5)
  );
}

/**
 * Share of its sort key each further finding of one claim in one file
 * keeps: the second sorts at 0.75 of its score, the third at 0.56.
 *
 * A file's fifth commented-out block is not a fifth reason to open that
 * file, but without this it took a fifth place in the top ten: on a
 * mobile app one 35-line region of alternative server configurations
 * filled five. Scores are untouched; only the order is. On the labelled
 * ranking scenarios (0.31) this raised 27 and lowered 5, mean nDCG over
 * the deep set +0.0025. The same principle as {@link fileRiskScore}.
 */
export const REPEAT_CLAIM_DECAY = 0.75;

/**
 * Sort keys for findings already in rank-score order: each finding's
 * {@link findingRankScore}, decayed by how many findings of the same
 * claim in the same file precede it.
 */
export function repeatDecayedRankScores(
  sorted: readonly Finding[],
  recencyEnabled = true,
): Map<Finding, number> {
  const seen = new Map<string, number>();
  const keys = new Map<Finding, number>();
  for (const finding of sorted) {
    const claim = `${finding.file}\0${finding.type}\0${finding.claim ?? ""}`;
    const earlier = seen.get(claim) ?? 0;
    seen.set(claim, earlier + 1);
    keys.set(
      finding,
      findingRankScore(finding, recencyEnabled) * REPEAT_CLAIM_DECAY ** earlier,
    );
  }
  return keys;
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
