#!/usr/bin/env tsx
/**
 * Attaches error bars to `structural_pass_rate` by comparing repeat
 * samples of the *same* input — the "is codex 0.61 → 0.58 a regression
 * or is it Tuesday" question.
 *
 * Two ways to name the samples:
 *
 * ```bash
 * # 1. every evals/results/<version>(-<label>)?/ matching packages/cli
 * pnpm run evals:variance
 *
 * # 2. explicit directories, for samples that live under different
 * #    version numbers but received identical input
 * pnpm run evals:variance -- --dirs evals/results/0.24.0,evals/results/0.25.0
 * ```
 *
 * Form 2 exists because the repeat samples this project actually has
 * were not paid for as repeat samples. A release that moves no
 * finding on any fixture hands its agents byte-identical input, so the
 * two version directories either side of it are a free repeat pair.
 * `0.24.0`/`0.25.0` and `0.21.0`/`0.22.0` are both such pairs. Form 1
 * cannot see them, because it matches on version.
 *
 * ## What it reports, and why the aggregate band is derived
 *
 * The number release notes quote is `structural_pass_rate` — pooled
 * `passed / (passed+failed)` over every assertion an agent faced. Its
 * band cannot be read off two aggregate samples: two points estimate a
 * standard deviation with roughly 60% error, which is how `0.12.1`'s
 * three samples produced a codex band (±3pp) that a later no-op release
 * exceeded on the first try.
 *
 * So the per-scenario variance is measured first, from all N samples,
 * and the aggregate band is *derived* from it. The aggregate is a
 * weighted mean of per-scenario fractions with weights equal to
 * assertion counts, so
 *
 *     sd(aggregate) = sqrt( Σ wᵢ² · sdᵢ² ) / Σ wᵢ
 *
 * which uses one estimate per scenario rather than one per run. With 48
 * scenarios that is 48 pieces of evidence instead of 2.
 *
 * `sdᵢ` is the **unbiased** sample standard deviation (÷ n−1). For the
 * common n=2 case that reduces to |Δᵢ|/√2, the standard paired-
 * difference estimator. This is a change from the version of this
 * script that shipped through `0.25.0`, which divided by n and so
 * under-reported every band by √(n/(n−1)) — 29% at n=2.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT, RESULTS_DIR } from "./paths.js";
import type { ScoreResult } from "./types.js";

/** One (scenario, agent) observation in one sample. */
interface Observation {
  /** 0 to 1 — passed / (passed+failed). */
  fraction: number;
  /** raw passed count, for sanity. */
  passed: number;
  /** assertion count — the weight this scenario carries in the pooled rate. */
  total: number;
  /**
   * False when the runner recorded an empty `scan_context`, i.e. the
   * scorer could not resolve charge names or `crime_NNNN` ids for this
   * result. Such a result is not a sample of the same measurement as
   * one scored with a populated context, so it is excluded and counted.
   */
  hasContext: boolean;
  /** The build that produced this score — see the mixed-scorer warning. */
  crimesVersion: string;
}

interface Row {
  scenario: string;
  agent: string;
  n: number;
  weight: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
  values: number[];
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const version = await readCrimesVersion();
  const sampleDirs = opts.dirs
    ? opts.dirs.map((d) => resolve(REPO_ROOT, d))
    : findSampleDirs(version);
  const label = opts.dirs ? "the requested directories" : `crimes ${version}`;

  for (const dir of sampleDirs) {
    if (existsSync(dir)) continue;
    process.stderr.write(`variance: no such directory ${dir}\n`);
    process.exit(2);
    return;
  }
  if (sampleDirs.length === 0) {
    process.stderr.write(
      `variance: no result directories for version ${version} or ${version}-*\n`,
    );
    process.exit(2);
    return;
  }
  if (sampleDirs.length < 2) {
    process.stderr.write(
      `variance: only ${sampleDirs.length} sample for ${label} — need ≥2 for stddev. Re-run with --label, or pass --dirs.\n`,
    );
    process.exit(2);
    return;
  }

  // (scenario, agent) -> one observation per sample, in sample order.
  const samples = new Map<string, Observation[]>();
  const versionsPerDir: string[][] = [];
  for (const dir of sampleDirs) {
    const seen = new Set<string>();
    for (const [key, obs] of readSample(dir)) {
      seen.add(obs.crimesVersion);
      const list = samples.get(key);
      if (list) list.push(obs);
      else samples.set(key, [obs]);
    }
    versionsPerDir.push([...seen].sort());
  }

  const n = sampleDirs.length;
  const rows: Row[] = [];
  let droppedPartial = 0;
  let droppedContext = 0;
  let droppedRubric = 0;
  for (const [key, list] of samples) {
    const [scenario, agent] = key.split("::");
    if (list.length < n) {
      // Present in some samples only — a scenario the later run added.
      droppedPartial += 1;
      continue;
    }
    if (list.some((o) => !o.hasContext)) {
      droppedContext += 1;
      continue;
    }
    const weight = list[0]!.total;
    if (list.some((o) => o.total !== weight)) {
      // The rubric itself changed between samples: these are not repeat
      // measurements of one thing, whatever the directory names say.
      droppedRubric += 1;
      continue;
    }
    const xs = list.map((o) => o.fraction);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const stddev = Math.sqrt(
      xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (xs.length - 1),
    );
    rows.push({
      scenario: scenario!,
      agent: agent!,
      n: xs.length,
      weight,
      mean,
      stddev,
      min: Math.min(...xs),
      max: Math.max(...xs),
      values: xs,
    });
  }
  rows.sort(
    (a, b) => a.scenario.localeCompare(b.scenario) || a.agent.localeCompare(b.agent),
  );

  process.stdout.write(`variance: ${n} samples of ${label}:\n`);
  sampleDirs.forEach((d, i) => {
    process.stdout.write(`  ${d}  [scored by ${versionsPerDir[i]!.join(", ")}]\n`);
  });
  // Every sample must have been scored by ONE scorer, or the spread
  // being measured is partly the scorer moving and partly the agent —
  // which is the thing this script exists to separate. Re-score the
  // older sample first: `evals:replay --version <v> --out <dir>`.
  const scorers = new Set(versionsPerDir.flat());
  if (scorers.size > 1) {
    process.stdout.write(
      `\n  WARNING: these samples were scored by ${scorers.size} different builds (${[...scorers].sort().join(", ")}).\n` +
        "  Any scorer change between them is being reported as agent variance.\n" +
        "  Replay both under one build before believing the band.\n",
    );
  }
  if (droppedPartial > 0) {
    process.stdout.write(
      `\n  ${droppedPartial} (scenario, agent) pair(s) absent from at least one sample — excluded.\n`,
    );
  }
  if (droppedContext > 0) {
    process.stdout.write(
      `  ${droppedContext} pair(s) scored against an empty scan_context in at least one sample — excluded, see below.\n`,
    );
  }
  if (droppedRubric > 0) {
    process.stdout.write(
      `  ${droppedRubric} pair(s) whose assertion count differs between samples — excluded, the rubric moved.\n`,
    );
  }
  process.stdout.write("\n");

  process.stdout.write(
    `  ${pad("scenario", 36)}  ${pad("agent", 6)}  ${pad("n", 3)}  ${pad("mean", 6)}  ${pad("±sd", 6)}  ${pad("min", 6)}  ${pad("max", 6)}\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `  ${pad(r.scenario, 36)}  ${pad(r.agent, 6)}  ${pad(String(r.n), 3)}  ${pad(r.mean.toFixed(2), 6)}  ${pad(r.stddev.toFixed(2), 6)}  ${pad(r.min.toFixed(2), 6)}  ${pad(r.max.toFixed(2), 6)}\n`,
    );
  }

  writeAgentSection(rows, samples, n);
  writeWorstOffenders(rows);
}

/**
 * Per agent: the pooled `structural_pass_rate` each sample produced,
 * the spread of per-scenario estimates, and the derived aggregate band.
 */
function writeAgentSection(
  rows: Row[],
  samples: Map<string, Observation[]>,
  n: number,
): void {
  const agents = [...new Set(rows.map((r) => r.agent))].sort();
  process.stdout.write("\nPer agent, on the pairs measured in every sample:\n");
  for (const agent of agents) {
    const mine = rows.filter((r) => r.agent === agent);
    const totalWeight = mine.reduce((a, r) => a + r.weight, 0);

    // The pooled rate each sample would report on this shared subset.
    const perSample: number[] = [];
    for (let i = 0; i < n; i += 1) {
      let passed = 0;
      for (const r of mine) {
        const list = samples.get(`${r.scenario}::${r.agent}`)!;
        passed += list[i]!.passed;
      }
      perSample.push(passed / totalWeight);
    }

    // sd(Σwᵢxᵢ / Σwᵢ) with the wᵢ fixed and the xᵢ independent.
    const varianceSum = mine.reduce(
      (a, r) => a + r.weight * r.weight * r.stddev * r.stddev,
      0,
    );
    const sdAgg = Math.sqrt(varianceSum) / totalWeight;
    const meanScenarioSd = mine.reduce((a, r) => a + r.stddev, 0) / mine.length;
    const neverMoved = mine.filter((r) => r.stddev === 0).length;

    process.stdout.write(
      `\n  ${agent}: ${mine.length} scenarios, ${totalWeight} assertions\n`,
    );
    process.stdout.write(
      `    pooled structural_pass_rate per sample: ${perSample.map((x) => x.toFixed(4)).join(" → ")}\n`,
    );
    process.stdout.write(
      `    observed spread ${((Math.max(...perSample) - Math.min(...perSample)) * 100).toFixed(1)}pp\n`,
    );
    process.stdout.write(
      `    per-scenario sd: mean ${meanScenarioSd.toFixed(3)}, ${neverMoved}/${mine.length} never moved\n`,
    );
    process.stdout.write(
      `    derived aggregate sd ${sdAgg.toFixed(4)} → band ±${(2 * sdAgg * 100).toFixed(1)}pp (2sd)\n`,
    );
  }
}

/**
 * The scenarios that supply most of the band. Worth naming, because a
 * scenario that swings 0 → 1 on identical input is either genuinely
 * ambiguous or scored by a rubric that cannot see the answer, and both
 * are fixable — unlike "agents are stochastic", which is not.
 */
function writeWorstOffenders(rows: Row[]): void {
  const moving = rows.filter((r) => r.stddev > 0);
  if (moving.length === 0) return;
  // Share is computed within an agent, because that is the band each
  // scenario is actually widening: claude's variance does not enter
  // codex's number.
  const totalVarByAgent = new Map<string, number>();
  for (const r of rows) {
    totalVarByAgent.set(r.agent, (totalVarByAgent.get(r.agent) ?? 0) + contribution(r));
  }
  const ranked = [...moving].sort(
    (a, b) =>
      contribution(b) / totalVarByAgent.get(b.agent)! -
      contribution(a) / totalVarByAgent.get(a.agent)!,
  );
  process.stdout.write("\nWorst offenders (share of their own agent's band variance):\n");
  for (const r of ranked.slice(0, 12)) {
    const share = contribution(r) / totalVarByAgent.get(r.agent)!;
    process.stdout.write(
      `  ${pad(r.scenario, 36)}  ${pad(r.agent, 6)}  ${r.values.map((v) => v.toFixed(2)).join(" → ")}  (${(share * 100).toFixed(1)}%)\n`,
    );
  }
}

/** This scenario's term in `Σ wᵢ² · sdᵢ²`. */
function contribution(r: Row): number {
  return r.weight * r.weight * r.stddev * r.stddev;
}

function readSample(dir: string): Array<[string, Observation]> {
  const out: Array<[string, Observation]> = [];
  for (const agentEntry of readdirSync(dir, { withFileTypes: true })) {
    if (!agentEntry.isDirectory()) continue;
    const agentDir = resolve(dir, agentEntry.name);
    for (const f of readdirSync(agentDir)) {
      if (!f.endsWith(".json")) continue;
      const r = JSON.parse(readFileSync(resolve(agentDir, f), "utf8")) as ScoreResult;
      const s = r.structural_score;
      const total = s.passed + s.failed;
      out.push([
        `${r.scenario}::${r.agent}`,
        {
          fraction: total === 0 ? 0 : s.passed / total,
          passed: s.passed,
          total,
          hasContext:
            Object.keys(r.scan_context?.detector_id_by_finding_id ?? {}).length > 0,
          crimesVersion: r.crimes_version,
        },
      ]);
    }
  }
  return out;
}

interface VarianceOptions {
  dirs?: string[];
}

function parseArgs(argv: string[]): VarianceOptions {
  const opts: VarianceOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dirs") opts.dirs = splitDirs(argv[++i]);
    else if (arg?.startsWith("--dirs="))
      opts.dirs = splitDirs(arg.slice("--dirs=".length));
  }
  return opts;
}

function splitDirs(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

function findSampleDirs(version: string): string[] {
  if (!existsSync(RESULTS_DIR)) return [];
  const out: string[] = [];
  for (const e of readdirSync(RESULTS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name === version || e.name.startsWith(`${version}-`)) {
      out.push(resolve(RESULTS_DIR, e.name));
    }
  }
  return out.sort();
}

async function readCrimesVersion(): Promise<string> {
  const pkgPath = resolve(REPO_ROOT, "packages", "cli", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`variance: ${message}\n`);
  process.exit(1);
});
