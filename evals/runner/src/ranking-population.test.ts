import { describe, expect, it } from "vitest";
import {
  type PopulationRow,
  diffDeepPopulation,
  depthMargins,
  floorPlacement,
} from "./ranking-population.js";

/**
 * Rows are the minimum of what `ranking-run.ts` already carries per
 * scenario: an id, the fixture it ran on, the depth the score was
 * computed over, and the score itself.
 */
function row(
  scenario: string,
  fixture: string,
  total_findings: number,
  ndcg: number | null = 0.5,
): PopulationRow {
  return { scenario, fixture, total_findings, ndcg };
}

/**
 * A deliberately faithful miniature of the real 0.24.0 shape: one
 * fixture two findings above the floor carrying most of the population,
 * plus a few deeper fixtures carrying the rest.
 */
function baselineRows(fx01Findings = 42): PopulationRow[] {
  return [
    row("a-01-x", "messy-ts-app", fx01Findings, 0.2),
    row("b-01-y", "messy-ts-app", fx01Findings, 0.3),
    row("c-01-z", "messy-ts-app", fx01Findings, 0.4),
    row("d-02-p", "react-dashboard", 99, 0.9),
    row("e-shallow", "tiny", 5, 1.0),
  ];
}

describe("depthMargins", () => {
  it("reports how far each deep fixture sits above the floor", () => {
    const margins = depthMargins(baselineRows(), 40);
    const fx01 = margins.find((m) => m.fixture === "messy-ts-app");
    expect(fx01).toBeDefined();
    expect(fx01?.margin).toBe(2);
    expect(fx01?.deep_scenarios).toBe(3);
  });

  it("excludes fixtures below the floor entirely", () => {
    const margins = depthMargins(baselineRows(), 40);
    expect(margins.map((m) => m.fixture)).not.toContain("tiny");
  });

  it("reports each deep fixture's share of the deep population", () => {
    const margins = depthMargins(baselineRows(), 40);
    const fx01 = margins.find((m) => m.fixture === "messy-ts-app");
    // 3 of the 4 deep scenarios ride on this one fixture.
    expect(fx01?.share).toBeCloseTo(0.75, 5);
  });

  it("flags a fixture as a cliff when a small margin carries a large share", () => {
    const margins = depthMargins(baselineRows(), 40);
    const fx01 = margins.find((m) => m.fixture === "messy-ts-app");
    const fx02 = margins.find((m) => m.fixture === "react-dashboard");
    // Two findings from dropping out, and it decides three quarters of
    // the headline aggregate. That is the shape that produces a phantom
    // movement larger than anything the product has ever really moved.
    expect(fx01?.cliff).toBe(true);
    // Fifty-nine findings of headroom is not a cliff, whatever its share.
    expect(fx02?.cliff).toBe(false);
  });

  it("sorts the most dangerous fixture first", () => {
    expect(depthMargins(baselineRows(), 40)[0]?.fixture).toBe("messy-ts-app");
  });
});

describe("diffDeepPopulation", () => {
  it("calls two runs comparable when the deep set is unchanged", () => {
    const d = diffDeepPopulation(baselineRows(), baselineRows(), 40);
    expect(d.comparable).toBe(true);
    expect(d.entered).toEqual([]);
    expect(d.left).toEqual([]);
    expect(d.stable).toBe(4);
  });

  it("is not fooled by scores moving while membership holds", () => {
    const after = baselineRows().map((r) => ({ ...r, ndcg: 0.99 }));
    const d = diffDeepPopulation(baselineRows(), after, 40);
    expect(d.comparable).toBe(true);
  });

  it("catches the population change when a fixture falls below the floor", () => {
    // Three findings removed — exactly what a suppression-shaped change
    // does — and the fixture drops out, taking its scenarios with it.
    const d = diffDeepPopulation(baselineRows(42), baselineRows(39), 40);
    expect(d.comparable).toBe(false);
    expect(d.left).toEqual(["a-01-x", "b-01-y", "c-01-z"]);
    expect(d.entered).toEqual([]);
  });

  it("reports the aggregate movement that is pure population change", () => {
    const d = diffDeepPopulation(baselineRows(42), baselineRows(39), 40);
    // before: mean(0.2,0.3,0.4,0.9) = 0.45 ; after: mean(0.9) = 0.9
    expect(d.prior_mean).toBeCloseTo(0.45, 5);
    expect(d.current_mean).toBeCloseTo(0.9, 5);
    expect(d.mean_delta).toBeCloseTo(0.45, 5);
    // The whole delta is attributable to membership, not to scoring.
    expect(d.delta_on_stable_set).toBeCloseTo(0, 5);
  });

  it("separates real movement from population movement when both happen", () => {
    const after = baselineRows(39).map((r) =>
      r.scenario === "d-02-p" ? { ...r, ndcg: 1.0 } : r,
    );
    const d = diffDeepPopulation(baselineRows(42), after, 40);
    expect(d.comparable).toBe(false);
    // The stable set moved 0.9 -> 1.0; everything else is membership.
    expect(d.delta_on_stable_set).toBeCloseTo(0.1, 5);
  });

  it("catches a fixture entering the deep set too", () => {
    const d = diffDeepPopulation(baselineRows(39), baselineRows(42), 40);
    expect(d.comparable).toBe(false);
    expect(d.entered).toEqual(["a-01-x", "b-01-y", "c-01-z"]);
    expect(d.left).toEqual([]);
  });

  it("ignores unscored scenarios on both sides", () => {
    const withNull = [...baselineRows(), row("f-01-null", "messy-ts-app", 42, null)];
    const d = diffDeepPopulation(withNull, withNull, 40);
    expect(d.stable).toBe(4);
    expect(d.comparable).toBe(true);
  });
});

/**
 * The real fixture depths at 0.24.0. `depthMargins` answers "is this
 * fixture close to the floor"; this answers the different question "is
 * the floor in a sensible place given every fixture we have", whose
 * remedy is to move the constant rather than the fixture.
 */
const REAL_DEPTHS_0_24_0 = [1, 3, 4, 5, 9, 13, 42, 55, 92, 99];

describe("floorPlacement", () => {
  it("finds the fixtures either side of the floor", () => {
    const p = floorPlacement(REAL_DEPTHS_0_24_0, 40);
    expect(p.nearest_below).toBe(13);
    expect(p.nearest_above).toBe(42);
  });

  it("measures how much either side can move before the population changes", () => {
    const p = floorPlacement(REAL_DEPTHS_0_24_0, 40);
    // The two sides are asymmetric because membership is `>= floor`: the
    // 42-finding fixture is safe *at* 40 so it can lose 2, while the
    // 13-finding one is deep *at* 40 so it can only gain 26.
    expect(p.margin_above).toBe(2);
    expect(p.margin_below).toBe(26);
    expect(p.well_placed).toBe(false);
  });

  it("centring the floor in the empty gap makes it well placed", () => {
    const p = floorPlacement(REAL_DEPTHS_0_24_0, 28);
    // 42 - 28 = 14 to lose; 28 - 13 - 1 = 14 to gain. Balanced.
    expect(p.margin_above).toBe(14);
    expect(p.margin_below).toBe(14);
    expect(p.well_placed).toBe(true);
  });

  it("recommends the centre of the gap", () => {
    expect(floorPlacement(REAL_DEPTHS_0_24_0, 40).suggested_floor).toBe(28);
  });

  it("keeps the deep population identical anywhere inside the gap", () => {
    // This is what licenses moving the constant without invalidating the
    // nine stored baselines: every floor in [14, 42] selects the same
    // four fixtures, so mean_ndcg_deep cannot move.
    const deepAt = (floor: number) =>
      REAL_DEPTHS_0_24_0.filter((d) => d >= floor).join(",");
    const reference = deepAt(40);
    for (let floor = 14; floor <= 42; floor += 1) {
      expect(deepAt(floor)).toBe(reference);
    }
  });

  it("reports a floor that lands exactly on a fixture depth as badly placed", () => {
    const p = floorPlacement(REAL_DEPTHS_0_24_0, 42);
    expect(p.margin_above).toBe(0);
    expect(p.well_placed).toBe(false);
  });

  it("survives a distribution with nothing below the floor", () => {
    const p = floorPlacement([50, 60], 28);
    expect(p.nearest_below).toBeNull();
    expect(p.margin_below).toBeNull();
    expect(p.well_placed).toBe(true);
  });

  it("survives a distribution with nothing above the floor", () => {
    const p = floorPlacement([1, 5], 28);
    expect(p.nearest_above).toBeNull();
    expect(p.margin_above).toBeNull();
    // Nothing clears the floor at all — that is a broken instrument, not
    // a well-placed one.
    expect(p.well_placed).toBe(false);
  });
});
