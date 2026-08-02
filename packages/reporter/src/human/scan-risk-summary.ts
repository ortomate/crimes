import type { Finding } from "@crimes/core";
import { formatBlastRadius, formatChurn } from "./score-format.js";

export function fileRiskSummary(findings: Finding[]): string | undefined {
  const summary = collectRiskSummary(findings);
  if (
    summary.maxChurn === undefined &&
    summary.maxBlast === undefined &&
    !summary.anyTestGap
  ) {
    return undefined;
  }
  const parts: string[] = [];
  if (summary.maxChurn !== undefined) {
    parts.push(`churn ${formatChurn(summary.maxChurn)}`);
  }
  if (summary.anyTestGap) {
    parts.push(`test gap ${dominantTestGap(summary.testGapBuckets)}`);
  }
  if (summary.maxBlast !== undefined) {
    parts.push(
      `blast ${formatBlastRadius(summary.maxBlast, {
        direct: summary.maxDirectImporters,
        transitive: summary.maxTransitiveImporters,
      })}`,
    );
  }
  return parts.join(" · ");
}

interface RiskSummary {
  maxChurn?: number;
  maxBlast?: number;
  /**
   * The two importer counts are tracked separately and never merged.
   * Every finding in a group shares one file, so these are that file's
   * values; taking a max is just a tolerant way to skip findings from
   * stubs that carry no scoring context.
   */
  maxDirectImporters?: number;
  maxTransitiveImporters?: number;
  anyTestGap: boolean;
  testGapBuckets: Record<TestGapBucket, number>;
}

function collectRiskSummary(findings: Finding[]): RiskSummary {
  const summary: RiskSummary = {
    anyTestGap: false,
    testGapBuckets: {
      "top-quartile": 0,
      "~median": 0,
      "bottom-quartile": 0,
      unknown: 0,
    },
  };
  for (const f of findings) {
    summary.maxChurn = maxOptional(summary.maxChurn, f.scores.churn);
    summary.maxBlast = maxOptional(summary.maxBlast, f.scores.blast_radius);
    summary.maxDirectImporters = maxOptional(
      summary.maxDirectImporters,
      f.scores.blast_radius_direct_importers,
    );
    summary.maxTransitiveImporters = maxOptional(
      summary.maxTransitiveImporters,
      f.scores.blast_radius_transitive_importers,
    );
    if (f.scores.test_gap !== undefined) {
      summary.anyTestGap = true;
      summary.testGapBuckets[testGapBucket(f.scores.test_gap)] += 1;
    }
  }
  return summary;
}

function maxOptional(
  current: number | undefined,
  next: number | undefined,
): number | undefined {
  if (next === undefined) return current;
  return current === undefined ? next : Math.max(current, next);
}

type TestGapBucket = "top-quartile" | "~median" | "bottom-quartile" | "unknown";

function testGapBucket(score: number): TestGapBucket {
  if (score >= 0.75) return "top-quartile";
  if (score <= 0.25) return "bottom-quartile";
  return "~median";
}

function dominantTestGap(buckets: Record<TestGapBucket, number>): TestGapBucket {
  const order: TestGapBucket[] = [
    "top-quartile",
    "~median",
    "bottom-quartile",
    "unknown",
  ];
  let bestBucket: TestGapBucket = "unknown";
  let bestCount = -1;
  for (const bucket of order) {
    if (buckets[bucket] > bestCount) {
      bestCount = buckets[bucket];
      bestBucket = bucket;
    }
  }
  return bestBucket;
}
