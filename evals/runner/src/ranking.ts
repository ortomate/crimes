import type { ExpectedArtifacts } from "./types.js";

/**
 * A ranking-quality metric over the scan's *own* ordering.
 *
 * ## Why this exists
 *
 * `structural_pass_rate` cannot see ranking. It matches a detector's
 * literal id in the agent's response text, and an agent quotes the
 * right id whether the scan ranked that finding 1st or 30th. The
 * `0.18.1` release rebuilt the ranking twice — `agent_risk` decoupled
 * from length and severity, `blast_radius` re-scaled — and moved
 * `structural_pass_rate` by noise in both directions. That was not the
 * changes doing nothing; it was the metric being blind.
 *
 * ## What this measures instead
 *
 * Nothing about the agent. This is a property of the scan alone: given
 * a scenario's expected finding set as relevance labels, how well does
 * the scan's default order surface them? That makes it
 *
 *  - **deterministic** — no agent invocation, no billing, no noise
 *    band to clear before a delta means anything;
 *  - **replayable across builds** — scan the same fixture with an old
 *    and a new CLI and the two numbers are directly comparable, which
 *    is the only way to answer "did the `agent_risk` work help?";
 *  - **narrow** — it says whether the *known* right answer ranks
 *    highly, and nothing about findings no scenario labels.
 *
 * ## Grading
 *
 * Graded relevance, because the scenarios already carry two tiers:
 * `expected_priority` is the finding the agent was supposed to lead
 * with, `referenced_findings` are the ones it should have mentioned.
 * Scoring both as simply "relevant" would make a re-ranking that
 * promotes the priority finding above its peers invisible — the exact
 * blindness this replaces.
 *
 *   rel 2  type === expected_priority
 *   rel 1  type ∈ referenced_findings
 *   rel 0  everything else
 *
 * ## What it does not measure
 *
 * A fixture emitting 3 findings cannot demonstrate a ranking change,
 * and its nDCG will sit near 1.0 whatever the scoring does. That is why
 * {@link RankingScore.total_findings} travels with every score: the
 * aggregate is only readable alongside the depth it was computed over.
 * Of the eval fixtures, only `01` (42 findings), `02` (99), `03` (55)
 * and `04` (92) have the depth to say anything.
 */
export interface RankedFinding {
  type: string;
  file: string;
}

export interface RankingScore {
  /**
   * nDCG of the scan's order against the scenario's labels, or `null`
   * when the scenario cannot be ranked at all (see {@link skipped}).
   */
  ndcg: number | null;
  /** Why this scenario contributes no nDCG. Absent on scored entries. */
  skipped?: string;
  /** 1-based rank of the first finding of any expected type. */
  first_relevant_rank: number | null;
  /** 1-based rank of the first `expected_priority` finding. */
  priority_rank: number | null;
  /** Findings the scan emitted — the depth the score was computed over. */
  total_findings: number;
  /** How many of them carried an expected type. */
  relevant_findings: number;
  /** Most common detector type in the top 20, and its share. */
  top20_dominant_type: string | null;
  top20_dominant_share: number;
  /** Distinct detector types in the top 20. */
  top20_distinct_types: number;
}

const TOP_N = 20;

export function scoreRanking(
  findings: readonly RankedFinding[],
  expected: ExpectedArtifacts,
): RankingScore {
  const concentration = concentrationOfTop(findings);

  const priority = expected.expected_priority;
  const relevantTypes = new Set(expected.referenced_findings ?? []);
  if (priority) relevantTypes.add(priority);

  const base: RankingScore = {
    ndcg: null,
    first_relevant_rank: null,
    priority_rank: null,
    total_findings: findings.length,
    relevant_findings: 0,
    ...concentration,
  };

  if (relevantTypes.size === 0) {
    return { ...base, skipped: "scenario declares no expected findings" };
  }

  const gains = findings.map((f) =>
    f.type === priority ? 2 : relevantTypes.has(f.type) ? 1 : 0,
  );
  const relevantCount = gains.filter((g) => g > 0).length;

  const firstRelevant = gains.findIndex((g) => g > 0);
  const firstPriority = priority ? findings.findIndex((f) => f.type === priority) : -1;

  if (relevantCount === 0) {
    // Nothing to rank. This is a *detection* failure, and
    // `evals:verify-scenarios` already gates scenario↔fixture drift.
    // Scoring it 0 would report a detector that stopped firing as a
    // ranking regression, which is a different bug with a different fix.
    return { ...base, skipped: "no finding of an expected type fired" };
  }

  return {
    ...base,
    ndcg: ndcg(gains),
    first_relevant_rank: firstRelevant + 1,
    priority_rank: firstPriority === -1 ? null : firstPriority + 1,
    relevant_findings: relevantCount,
  };
}

/**
 * Standard nDCG with the exponential gain `2^rel - 1`, over the whole
 * ranked list rather than a cut-off.
 *
 * No `@k`: the agent is handed the entire scan JSON, so every position
 * is one it could have read. A cut-off would score a finding at rank
 * 21 identically to one at rank 400 on the fixtures that have the depth
 * to tell them apart.
 */
function ndcg(gains: readonly number[]): number {
  const ideal = [...gains].sort((a, b) => b - a);
  const idcg = dcg(ideal);
  return idcg === 0 ? 0 : dcg(gains) / idcg;
}

function dcg(gains: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < gains.length; i += 1) {
    const gain = gains[i] ?? 0;
    if (gain === 0) continue;
    sum += (2 ** gain - 1) / Math.log2(i + 2);
  }
  return sum;
}

/**
 * How concentrated the head of the ranking is.
 *
 * Unlabelled, so it works on any repo — which matters because the
 * monoculture that motivated the `agent_risk` work was found by reading
 * top-20 lists on zulip and hono, not on any labelled fixture. zulip
 * went from 18 of 20 `large_function` to 16 of 20 `sync_io_in_hotpath`;
 * this is the number that says so without reading the list.
 *
 * It is a description, not a verdict. A repo can legitimately have one
 * dominant problem.
 */
function concentrationOfTop(findings: readonly RankedFinding[]): {
  top20_dominant_type: string | null;
  top20_dominant_share: number;
  top20_distinct_types: number;
} {
  const head = findings.slice(0, TOP_N);
  if (head.length === 0) {
    return {
      top20_dominant_type: null,
      top20_dominant_share: 0,
      top20_distinct_types: 0,
    };
  }
  const counts = new Map<string, number>();
  for (const f of head) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
  let dominant = "";
  let best = 0;
  // Ties broken by type name so the number is stable across runs.
  for (const [type, n] of [...counts].sort((a, b) =>
    b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1],
  )) {
    dominant = type;
    best = n;
    break;
  }
  return {
    top20_dominant_type: dominant,
    top20_dominant_share: best / head.length,
    top20_distinct_types: counts.size,
  };
}
