#!/usr/bin/env tsx
/**
 * Compute the ranking-quality metric for the current build.
 *
 * Scans every fixture once with the built CLI and scores each
 * scenario's expected finding set against the scan's own order. No
 * agents are invoked, so this is cheap, deterministic and — unlike
 * `structural_pass_rate` — directly comparable between two builds of
 * crimes. See `ranking.ts` for what the number does and does not mean.
 *
 *   pnpm run evals:ranking                     # write results/<version>/ranking.json
 *   pnpm run evals:ranking -- --out FILE       # write somewhere else
 *   pnpm run evals:ranking -- --compare FILE   # diff against an earlier file
 *   pnpm run evals:ranking -- --cli PATH --label 0.17.1
 *                                              # scan with another build
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DepthMargin,
  type FloorPlacement,
  type PopulationRow,
  depthMargins,
  diffDeepPopulation,
  floorPlacement,
  renderDepthComposition,
  renderPopulationVerdict,
} from "./ranking-population.js";
import { type RankedFinding, type RankingScore, scoreRanking } from "./ranking.js";
import { RANKING_REFERENCE_DATE, runScan } from "./scan-helpers.js";
import type { FixturesRegistry, Scenario } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const FIXTURES_REGISTRY = resolve(REPO_ROOT, "evals", "fixtures", "fixtures.meta.json");
const SCENARIOS_DIR = resolve(REPO_ROOT, "evals", "scenarios");
const RESULTS_DIR = resolve(REPO_ROOT, "evals", "results");

/**
 * Below this many findings a fixture cannot demonstrate a ranking
 * change — every ordering scores near 1.0. The headline aggregate is
 * computed over the deep fixtures only; the all-fixtures number is
 * reported beside it so the difference is visible rather than chosen
 * silently.
 *
 * **Was 40 through `0.24.0`, re-centred to 28 in `0.25.0`, and the deep
 * population is unchanged by the move.** Fixture depths are
 * `[1, 3, 4, 5, 9, 13, 42, 55, 92, 99]` — a 28-finding empty gap, with
 * the old floor perched 2 findings under the nearest deep fixture and 27
 * over the nearest shallow one. Fixture `01` sat at 42 carrying 75% of
 * the deep set, so losing 3 findings from it moved the headline by
 * +0.1333 on membership alone, ~15× the largest real movement ever
 * shipped. Every floor in `[14, 42]` selects the same four fixtures, so
 * re-centring costs nothing: `mean_ndcg_deep` is byte-identical and all
 * nine stored baselines stay comparable. 28 balances the two sides at 14
 * findings of slack each. See `ranking-population.ts` and
 * `evals/README.md` § "The depth cliff".
 */
const DEPTH_FLOOR = 28;

interface ScenarioRanking extends RankingScore {
  scenario: string;
  fixture: string;
}

interface RankingReport {
  crimes_version: string;
  /**
   * The `CRIMES_NOW` every fixture was scanned at. Recorded because
   * `rank_score` includes a `recency` term, so a report is only
   * comparable to another taken at the same reference date — see
   * {@link RANKING_REFERENCE_DATE}. Absent on reports written before
   * `0.25.7`, which were taken at whatever the wall clock said.
   */
  reference_date?: string;
  depth_floor: number;
  /** Mean nDCG over scored scenarios on fixtures with real depth. */
  mean_ndcg_deep: number | null;
  /** Mean nDCG over every scored scenario, shallow fixtures included. */
  mean_ndcg_all: number | null;
  scored_deep: number;
  scored_all: number;
  skipped: number;
  /**
   * Per deep fixture, how many findings it can lose before it leaves the
   * aggregate and what share of the aggregate it decides. Diagnostic
   * only — nothing here feeds `mean_ndcg_deep`, which is computed
   * exactly as it was for the nine baselines already on disk.
   */
  depth_margins: DepthMargin[];
  /**
   * Where `depth_floor` sits relative to every fixture depth. When this
   * reports `well_placed: false`, the cheap remedy is usually to move
   * the constant into the empty gap rather than to change a fixture.
   */
  floor_placement: FloorPlacement;
  scenarios: ScenarioRanking[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const outFlag = flagValue(args, "--out");
  const compareFlag = flagValue(args, "--compare");
  const cliFlag = flagValue(args, "--cli");
  const labelFlag = flagValue(args, "--label");

  const version = labelFlag ?? readCrimesVersion();
  if (cliFlag) {
    process.stderr.write(
      `evals:ranking: scanning with ${cliFlag} (not this tree's build)\n`,
    );
  }
  const fixtures = loadFixtures();
  const scenarios = loadScenarios();

  const scanCache = new Map<string, RankedFinding[]>();
  const rows: ScenarioRanking[] = [];

  for (const scenario of scenarios) {
    const fixture = fixtures.find((f) => f.id === scenario.fixture);
    if (!fixture) continue;
    const fixtureDir = resolve(REPO_ROOT, fixture.path);
    if (!existsSync(fixtureDir)) {
      process.stderr.write(
        `evals:ranking: fixture ${fixture.path} not on disk — skip (run evals:setup?).\n`,
      );
      continue;
    }
    let findings = scanCache.get(fixtureDir);
    if (!findings) {
      findings = parseFindings(await runScan(fixtureDir, cliFlag));
      scanCache.set(fixtureDir, findings);
    }
    rows.push({
      scenario: scenario.id,
      fixture: fixture.name,
      ...scoreRanking(findings, scenario.expected_artifacts),
    });
  }

  const report = summarise(version, rows);
  const outPath = outFlag
    ? resolve(REPO_ROOT, outFlag)
    : resolve(RESULTS_DIR, version, "ranking.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  render(report, outPath);
  if (compareFlag) renderComparison(report, compareFlag);
}

function summarise(version: string, rows: ScenarioRanking[]): RankingReport {
  const scored = rows.filter((r) => r.ndcg !== null);
  const deep = scored.filter((r) => r.total_findings >= DEPTH_FLOOR);
  return {
    crimes_version: version,
    reference_date: RANKING_REFERENCE_DATE,
    depth_floor: DEPTH_FLOOR,
    mean_ndcg_deep: mean(deep.map((r) => r.ndcg ?? 0)),
    mean_ndcg_all: mean(scored.map((r) => r.ndcg ?? 0)),
    scored_deep: deep.length,
    scored_all: scored.length,
    skipped: rows.length - scored.length,
    depth_margins: depthMargins(rows, DEPTH_FLOOR),
    floor_placement: floorPlacement(
      scored.map((r) => r.total_findings),
      DEPTH_FLOOR,
    ),
    scenarios: rows,
  };
}

/** The report's rows in the shape the population diagnostics take. */
function populationRows(report: RankingReport): PopulationRow[] {
  return report.scenarios.map((s) => ({
    scenario: s.scenario,
    fixture: s.fixture,
    total_findings: s.total_findings,
    ndcg: s.ndcg,
  }));
}

function render(report: RankingReport, outPath: string): void {
  const lines: string[] = [];
  lines.push("");
  lines.push(`crimes ${report.crimes_version} — ranking quality (scan-only)`);
  lines.push("");
  for (const r of [...report.scenarios].sort((a, b) => (a.ndcg ?? 2) - (b.ndcg ?? 2))) {
    if (r.ndcg === null) continue;
    const depth = r.total_findings >= report.depth_floor ? " " : "·";
    lines.push(
      `  ${depth} ${r.ndcg.toFixed(3)}  ${pad(r.scenario, 38)} ` +
        `first@${String(r.first_relevant_rank).padStart(3)} ` +
        `of ${String(r.total_findings).padStart(3)}`,
    );
  }
  lines.push("");
  lines.push(
    `  mean nDCG, fixtures with >=${report.depth_floor} findings: ` +
      `${fmt(report.mean_ndcg_deep)}  (n=${report.scored_deep})`,
  );
  lines.push(
    `  mean nDCG, all scored scenarios:              ` +
      `${fmt(report.mean_ndcg_all)}  (n=${report.scored_all})`,
  );
  lines.push(`  skipped (nothing to rank):                    ${report.skipped}`);
  lines.push("");
  lines.push(`  · = shallow fixture, cannot demonstrate a ranking change`);
  lines.push("");
  lines.push(
    ...renderDepthComposition(
      report.depth_margins,
      report.floor_placement,
      report.depth_floor,
    ),
  );
  lines.push("");
  lines.push(`  written to ${outPath}`);
  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function renderComparison(report: RankingReport, rawPath: string): void {
  // Relative paths resolve against the repo root, not the runner's own
  // cwd — `pnpm run evals:ranking` from the root would otherwise look
  // for `evals/results/...` inside `evals/runner/`.
  const comparePath = resolve(REPO_ROOT, rawPath);
  if (!existsSync(comparePath)) {
    process.stderr.write(`evals:ranking: --compare file not found: ${comparePath}\n`);
    return;
  }
  const prior = JSON.parse(readFileSync(comparePath, "utf8")) as RankingReport;
  const priorById = new Map(prior.scenarios.map((s) => [s.scenario, s]));

  const lines: string[] = [];
  lines.push(`  vs ${prior.crimes_version}`);
  // A report taken at a different reference date carries a different
  // `recency` term for every fixture edited near it, so part of any
  // delta belongs to the calendar rather than to the build. Say so
  // rather than letting it read as a scanner change.
  if (prior.reference_date !== report.reference_date) {
    lines.push("");
    lines.push(
      `  ⚠ REFERENCE DATE DIFFERS: ${prior.reference_date ?? "unpinned (wall clock)"} → ${report.reference_date ?? "unpinned (wall clock)"}`,
    );
    lines.push("    rank_score includes a recency term, so any fixture edited within");
    lines.push("    14 days of either date contributes a delta that is not the build.");
  }
  lines.push("");
  let moved = 0;
  for (const r of report.scenarios) {
    const was = priorById.get(r.scenario);
    if (!was || was.ndcg === null || r.ndcg === null) continue;
    const delta = r.ndcg - was.ndcg;
    if (Math.abs(delta) < 0.0005) continue;
    moved += 1;
    const sign = delta > 0 ? "+" : "";
    lines.push(
      `  ${pad(r.scenario, 38)} ${was.ndcg.toFixed(3)} -> ${r.ndcg.toFixed(3)}  ` +
        `${sign}${delta.toFixed(3)}`,
    );
  }
  if (moved === 0) lines.push("  no scenario moved.");
  lines.push("");
  lines.push(
    `  mean nDCG (deep): ${fmt(prior.mean_ndcg_deep)} -> ${fmt(report.mean_ndcg_deep)}`,
  );
  lines.push(
    `  mean nDCG (all):  ${fmt(prior.mean_ndcg_all)} -> ${fmt(report.mean_ndcg_all)}`,
  );

  // The deep mean is a mean over whichever scenarios cleared the floor.
  // If that set moved, the two numbers above are not a before and after,
  // and saying so is the whole point of this block.
  lines.push("");
  lines.push(
    ...renderPopulationVerdict(
      diffDeepPopulation(
        populationRows(prior),
        populationRows(report),
        report.depth_floor,
      ),
    ),
  );
  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function parseFindings(scanJson: string): RankedFinding[] {
  const parsed = JSON.parse(scanJson) as { findings?: unknown };
  if (!Array.isArray(parsed.findings)) return [];
  const out: RankedFinding[] = [];
  for (const entry of parsed.findings) {
    if (!entry || typeof entry !== "object") continue;
    const f = entry as { type?: unknown; file?: unknown };
    if (typeof f.type !== "string") continue;
    out.push({ type: f.type, file: typeof f.file === "string" ? f.file : "" });
  }
  return out;
}

function loadFixtures(): FixturesRegistry["fixtures"] {
  const registry = JSON.parse(
    readFileSync(FIXTURES_REGISTRY, "utf8"),
  ) as FixturesRegistry;
  return registry.fixtures;
}

function loadScenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const file of readdirSync(SCENARIOS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const data = JSON.parse(
      readFileSync(resolve(SCENARIOS_DIR, file), "utf8"),
    ) as Scenario[];
    if (Array.isArray(data)) out.push(...data);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function readCrimesVersion(): string {
  const pkg = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "packages", "cli", "package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10000) / 10000;
}

function fmt(n: number | null): string {
  return n === null ? "  n/a" : n.toFixed(4);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`evals:ranking: ${message}\n`);
  process.exit(1);
});
