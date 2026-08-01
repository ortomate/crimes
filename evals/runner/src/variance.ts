#!/usr/bin/env tsx
/**
 * Reads every `evals/results/<crimes-version>(?:-<label>)?/` directory
 * that matches the current `packages/cli/package.json` `version` and
 * computes per-scenario mean ± stddev of the structural pass fraction
 * across the samples. Used to attach error bars to single-run reads
 * — the "Codex 0.78 vs Claude 0.76" kind of question.
 *
 * Convention:
 *   `evals/results/0.7.2/`        — canonical sample (no label)
 *   `evals/results/0.7.2-r2/`     — repeat sample
 *   `evals/results/0.7.2-r3/`     — repeat sample
 *
 * All directories whose name is `<version>` or starts with `<version>-`
 * are treated as samples of the same baseline.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScoreResult } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const RESULTS_DIR = resolve(REPO_ROOT, "evals", "results");

interface SampleScore {
  /** 0 to 1 — passed / (passed+failed). */
  fraction: number;
  /** raw passed count, for sanity. */
  passed: number;
  /** raw total count, for sanity. */
  total: number;
}

async function main(): Promise<void> {
  const version = await readCrimesVersion();
  const sampleDirs = findSampleDirs(version);
  if (sampleDirs.length === 0) {
    process.stderr.write(
      `variance: no result directories for version ${version} or ${version}-*\n`,
    );
    process.exit(2);
    return;
  }
  if (sampleDirs.length < 2) {
    process.stderr.write(
      `variance: only ${sampleDirs.length} sample for ${version} — need ≥2 for stddev. Re-run with --label.\n`,
    );
    process.exit(2);
    return;
  }

  // (scenario, agent) -> array of fractions, one per sample
  const samples = new Map<string, SampleScore[]>();

  for (const dir of sampleDirs) {
    for (const agentEntry of readdirSync(dir, { withFileTypes: true })) {
      if (!agentEntry.isDirectory()) continue;
      const agentDir = resolve(dir, agentEntry.name);
      for (const f of readdirSync(agentDir)) {
        if (!f.endsWith(".json")) continue;
        const r = JSON.parse(readFileSync(resolve(agentDir, f), "utf8")) as ScoreResult;
        const s = r.structural_score;
        const total = s.passed + s.failed;
        const fraction = total === 0 ? 0 : s.passed / total;
        const key = `${r.scenario}::${r.agent}`;
        const list = samples.get(key);
        if (list) list.push({ fraction, passed: s.passed, total });
        else samples.set(key, [{ fraction, passed: s.passed, total }]);
      }
    }
  }

  // Per (scenario, agent): mean, stddev, range
  const rows: Array<{
    scenario: string;
    agent: string;
    n: number;
    mean: number;
    stddev: number;
    min: number;
    max: number;
  }> = [];
  for (const [key, list] of samples) {
    if (list.length < 2) continue; // only present in one sample
    const [scenario, agent] = key.split("::");
    const xs = list.map((s) => s.fraction);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
    const stddev = Math.sqrt(variance);
    rows.push({
      scenario: scenario!,
      agent: agent!,
      n: list.length,
      mean,
      stddev,
      min: Math.min(...xs),
      max: Math.max(...xs),
    });
  }
  rows.sort(
    (a, b) => a.scenario.localeCompare(b.scenario) || a.agent.localeCompare(b.agent),
  );

  process.stdout.write(`variance: ${sampleDirs.length} samples for crimes ${version}:\n`);
  for (const d of sampleDirs) process.stdout.write(`  ${d}\n`);
  process.stdout.write("\n");

  process.stdout.write(
    `  ${pad("scenario", 32)}  ${pad("agent", 6)}  ${pad("n", 3)}  ${pad("mean", 6)}  ${pad("±sd", 6)}  ${pad("min", 6)}  ${pad("max", 6)}\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `  ${pad(r.scenario, 32)}  ${pad(r.agent, 6)}  ${pad(String(r.n), 3)}  ${pad(r.mean.toFixed(2), 6)}  ${pad(r.stddev.toFixed(2), 6)}  ${pad(r.min.toFixed(2), 6)}  ${pad(r.max.toFixed(2), 6)}\n`,
    );
  }

  // Agent-level overall: average of per-scenario means + pooled stddev
  process.stdout.write("\nOverall by agent (mean of per-scenario means):\n");
  const byAgent = new Map<string, number[]>();
  const stddevByAgent = new Map<string, number[]>();
  for (const r of rows) {
    if (!byAgent.has(r.agent)) byAgent.set(r.agent, []);
    if (!stddevByAgent.has(r.agent)) stddevByAgent.set(r.agent, []);
    byAgent.get(r.agent)!.push(r.mean);
    stddevByAgent.get(r.agent)!.push(r.stddev);
  }
  for (const [agent, means] of byAgent) {
    const m = means.reduce((a, b) => a + b, 0) / means.length;
    const sds = stddevByAgent.get(agent)!;
    const avgSd = sds.reduce((a, b) => a + b, 0) / sds.length;
    process.stdout.write(
      `  ${agent}: mean=${m.toFixed(3)}, avg per-scenario stddev=${avgSd.toFixed(3)}\n`,
    );
  }
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
