#!/usr/bin/env tsx
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScoreResult } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const RESULTS_DIR = resolve(REPO_ROOT, "evals", "results");
const REPLAY_DIR = resolve(REPO_ROOT, "evals", "replay");
const DIFF_SUMMARY = resolve(REPO_ROOT, "evals", "diff-summary.md");

const TOLERANCE = 0.1; // ±10% pass-rate move before flagging a regression.

interface AgentRollup {
  pass: number;
  total: number;
}

/**
 * `pnpm run evals:diff` entry. Compares the per-agent pass rates from
 * `evals/replay/` (fresh replay against the current build) to the
 * pinned per-agent pass rates in
 * `evals/results/<latest-version>/summary.json`. Writes a one-page
 * Markdown summary at `evals/diff-summary.md` for the PR comment.
 *
 * The diff is *signal*, not a gate. Pass-rate moves within ±10% are
 * marked stable; moves outside that band are flagged (better → "+",
 * worse → "−").
 */
async function main(): Promise<void> {
  if (!existsSync(REPLAY_DIR)) {
    process.stdout.write(
      `evals:diff: ${REPLAY_DIR} not found — run \`pnpm run evals:replay\` first.\n`,
    );
    return;
  }

  const replayByAgent = collectAgentRollups(REPLAY_DIR);
  const pinnedSummary = readPinnedSummary();

  const lines: string[] = [
    "# Eval replay diff",
    "",
    `Replayed at: ${new Date().toISOString()}`,
    `Pinned version: ${pinnedSummary?.crimes_version ?? "(none)"}`,
    "",
    "| agent | pinned pass rate | replay pass rate | Δ | verdict |",
    "|-------|------------------|------------------|---|---------|",
  ];
  let regressionCount = 0;
  for (const [agent, rollup] of replayByAgent.entries()) {
    const replayRate = rollup.total === 0 ? 0 : rollup.pass / rollup.total;
    const pinnedRate = pinnedSummary?.per_agent[agent]?.structural_pass_rate ?? null;
    const delta = pinnedRate === null ? null : replayRate - pinnedRate;
    const verdict = classify(delta);
    if (verdict === "regression") regressionCount += 1;
    lines.push(
      `| ${agent} | ${pinnedRate === null ? "—" : pinnedRate.toFixed(2)} | ${replayRate.toFixed(2)} | ${delta === null ? "—" : signed(delta)} | ${verdict} |`,
    );
  }

  if (regressionCount > 0) {
    lines.push(
      "",
      `⚠️ ${regressionCount} agent(s) regressed by more than ${TOLERANCE * 100}% — investigate detector changes in this PR.`,
    );
  } else {
    lines.push(
      "",
      `No regressions outside ±${TOLERANCE * 100}% tolerance — eval signal is stable.`,
    );
  }

  await writeFile(DIFF_SUMMARY, lines.join("\n") + "\n", "utf8");
  process.stdout.write(`evals:diff: summary written to ${DIFF_SUMMARY}\n`);
}

function collectAgentRollups(dir: string): Map<string, AgentRollup> {
  const out = new Map<string, AgentRollup>();
  for (const agent of readdirSync(dir, { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    const agentDir = resolve(dir, agent.name);
    const rollup: AgentRollup = { pass: 0, total: 0 };
    for (const entry of readdirSync(agentDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const data = JSON.parse(
        readFileSync(resolve(agentDir, entry.name), "utf8"),
      ) as ScoreResult;
      rollup.pass += data.structural_score.passed;
      rollup.total += data.structural_score.passed + data.structural_score.failed;
    }
    out.set(agent.name, rollup);
  }
  return out;
}

interface PinnedSummary {
  crimes_version: string;
  per_agent: Record<string, { structural_pass_rate: number; scenarios_run: number }>;
}

function readPinnedSummary(): PinnedSummary | undefined {
  if (!existsSync(RESULTS_DIR)) return undefined;
  const versions = readdirSync(RESULTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => /^\d+\.\d+\.\d+/.test(name))
    .sort((a, b) => compareSemverDesc(a, b));
  for (const version of versions) {
    const summaryPath = resolve(RESULTS_DIR, version, "summary.json");
    if (existsSync(summaryPath)) {
      return JSON.parse(readFileSync(summaryPath, "utf8")) as PinnedSummary;
    }
  }
  return undefined;
}

function compareSemverDesc(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10));
  const pb = b.split(".").map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return bv - av;
  }
  return 0;
}

function classify(delta: number | null): "—" | "stable" | "improved" | "regression" {
  if (delta === null) return "—";
  if (Math.abs(delta) <= TOLERANCE) return "stable";
  return delta > 0 ? "improved" : "regression";
}

function signed(n: number): string {
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`evals:diff: ${message}\n`);
  process.exit(1);
});
