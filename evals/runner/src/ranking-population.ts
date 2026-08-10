/**
 * Guards on the population `mean_ndcg_deep` is computed over.
 *
 * ## Why this exists
 *
 * `mean_ndcg_deep` is the headline ranking number, and it is a mean over
 * whichever scenarios happen to sit on a fixture emitting at least
 * `DEPTH_FLOOR` findings. **That membership is an input to the metric,
 * and nothing reported when it changed.**
 *
 * Measured at `0.24.0`: fixture `01` emits **42** findings against a
 * floor of **40**, and **21 of the 28 deep scenarios (75%) ride on it**.
 * Remove three findings from that one fixture and 21 scenarios leave the
 * aggregate at once, moving the headline `0.3530 → 0.4863` — **+0.1333,
 * with no scoring change whatsoever.** For scale, the largest real
 * movement shipped to date is `0.24.0`'s `+0.0089` on the differentiated
 * bucket, and its headline moved `−0.0008`. The phantom is ~15× the
 * largest true signal the instrument has ever recorded.
 *
 * The historical record is clean — fixture `01` has sat at exactly 42
 * findings across all nine stored baselines, so no published number is
 * contaminated. It has been stable because nothing removed a finding
 * from `messy-ts-app` in nine releases, not because the metric is
 * robust. A release whose changes are suppression-shaped is precisely
 * the one that would walk off the cliff, and would read the fall as its
 * own success.
 *
 * ## What this module does
 *
 * Nothing to the metric. `mean_ndcg_deep` is computed exactly as before.
 * These are two diagnostics that make the failure loud:
 *
 *  - {@link depthMargins} — per deep fixture, how many findings of
 *    headroom it has and what share of the aggregate it decides. Printed
 *    on every run, so the cliff is visible without being asked about.
 *  - {@link diffDeepPopulation} — on `--compare`, whether the two runs
 *    are means over the *same* set, and how much of the movement
 *    survives restricting to the scenarios present in both.
 *
 * `comparable: false` does not mean the run is wrong. It means the two
 * headline numbers are means over different populations and **must not
 * be quoted as a before/after**; use `delta_on_stable_set` instead.
 */

/** The per-scenario fields these diagnostics need. */
export interface PopulationRow {
  scenario: string;
  fixture: string;
  /** Findings the scan emitted — what decides deep membership. */
  total_findings: number;
  /** `null` when the scenario could not be ranked at all. */
  ndcg: number | null;
}

export interface DepthMargin {
  fixture: string;
  total_findings: number;
  /** Findings this fixture can lose before it leaves the deep set. */
  margin: number;
  /** Deep scenarios riding on this fixture. */
  deep_scenarios: number;
  /** This fixture's share of the deep population, 0–1. */
  share: number;
  /**
   * A small margin on a fixture that decides a large share of the
   * aggregate. See {@link CLIFF_MARGIN} / {@link CLIFF_SHARE}.
   */
  cliff: boolean;
}

export interface DeepPopulationDiff {
  /** Scenarios in the current deep set that were not in the prior one. */
  entered: string[];
  /** Scenarios in the prior deep set that are not in the current one. */
  left: string[];
  /** Scenarios deep in both runs. */
  stable: number;
  /** `false` when membership moved, so the two means are not a before/after. */
  comparable: boolean;
  prior_mean: number | null;
  current_mean: number | null;
  /** Headline movement, membership change included — the misleading number. */
  mean_delta: number | null;
  /**
   * Movement restricted to scenarios deep in *both* runs. When
   * `comparable` is false this is the only attributable figure.
   */
  delta_on_stable_set: number | null;
}

/**
 * Findings of headroom at or below which a fixture is one ordinary
 * precision fix away from dropping out. Fixture `01` sits at 2.
 */
export const CLIFF_MARGIN = 5;

/**
 * Share of the deep population above which one fixture's departure
 * redefines the aggregate rather than nudging it. Fixture `01` is 0.75.
 */
export const CLIFF_SHARE = 0.25;

function scored(rows: readonly PopulationRow[]): PopulationRow[] {
  return rows.filter((r) => r.ndcg !== null);
}

function deepOf(rows: readonly PopulationRow[], floor: number): PopulationRow[] {
  return scored(rows).filter((r) => r.total_findings >= floor);
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Per deep fixture: headroom, share of the aggregate, and whether the
 * two together make it a cliff. Most dangerous first — smallest margin,
 * then largest share.
 */
export function depthMargins(
  rows: readonly PopulationRow[],
  floor: number,
): DepthMargin[] {
  const deep = deepOf(rows, floor);
  const byFixture = new Map<string, PopulationRow[]>();
  for (const r of deep) {
    const bucket = byFixture.get(r.fixture);
    if (bucket) bucket.push(r);
    else byFixture.set(r.fixture, [r]);
  }

  const out: DepthMargin[] = [];
  for (const [fixture, bucket] of byFixture) {
    // Every scenario on a fixture scans the same tree, so the depth is
    // a property of the fixture; take the minimum rather than assuming.
    const total = Math.min(...bucket.map((r) => r.total_findings));
    const margin = total - floor;
    const share = deep.length === 0 ? 0 : bucket.length / deep.length;
    out.push({
      fixture,
      total_findings: total,
      margin,
      deep_scenarios: bucket.length,
      share,
      cliff: margin <= CLIFF_MARGIN && share > CLIFF_SHARE,
    });
  }

  return out.sort((a, b) => a.margin - b.margin || b.share - a.share);
}

/**
 * Whether two runs' deep aggregates are means over the same scenarios,
 * and how much of the movement survives restricting to the ones both
 * runs scored deeply.
 */
export function diffDeepPopulation(
  prior: readonly PopulationRow[],
  current: readonly PopulationRow[],
  floor: number,
): DeepPopulationDiff {
  const priorDeep = deepOf(prior, floor);
  const currentDeep = deepOf(current, floor);
  const priorIds = new Set(priorDeep.map((r) => r.scenario));
  const currentIds = new Set(currentDeep.map((r) => r.scenario));

  const entered = currentDeep
    .filter((r) => !priorIds.has(r.scenario))
    .map((r) => r.scenario)
    .sort();
  const left = priorDeep
    .filter((r) => !currentIds.has(r.scenario))
    .map((r) => r.scenario)
    .sort();

  const stableIds = [...priorIds].filter((id) => currentIds.has(id));
  const priorById = new Map(priorDeep.map((r) => [r.scenario, r]));
  const currentById = new Map(currentDeep.map((r) => [r.scenario, r]));

  const priorMean = mean(priorDeep.map((r) => r.ndcg ?? 0));
  const currentMean = mean(currentDeep.map((r) => r.ndcg ?? 0));
  const stablePriorMean = mean(stableIds.map((id) => priorById.get(id)?.ndcg ?? 0));
  const stableCurrentMean = mean(stableIds.map((id) => currentById.get(id)?.ndcg ?? 0));

  return {
    entered,
    left,
    stable: stableIds.length,
    comparable: entered.length === 0 && left.length === 0,
    prior_mean: priorMean,
    current_mean: currentMean,
    mean_delta:
      priorMean === null || currentMean === null ? null : currentMean - priorMean,
    delta_on_stable_set:
      stablePriorMean === null || stableCurrentMean === null
        ? null
        : stableCurrentMean - stablePriorMean,
  };
}
