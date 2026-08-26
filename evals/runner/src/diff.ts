#!/usr/bin/env tsx
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describeRejectedVersions, selectPinnedBaseline } from "./baseline.js";
import { DIFF_SUMMARY, REPLAY_DIR, RESULTS_DIR } from "./paths.js";
import type { ScoreResult } from "./types.js";

const TOLERANCE = 0.1; // ±10% pass-rate move before flagging a regression.

interface AgentRollup {
  pass: number;
  total: number;
}

type Verdict = "no data" | "unpinned" | "stable" | "improved" | "regression";

/**
 * `pnpm run evals:diff` entry. Compares the per-agent pass rates from
 * `evals/replay/` (fresh replay against the current build) to the
 * per-agent pass rates in the pinned baseline's `summary.json`. Writes
 * a one-page Markdown summary at `evals/diff-summary.md` for the PR
 * comment.
 *
 * The pinned baseline is chosen by {@link selectPinnedBaseline}, the
 * same function `evals:replay` uses — the two are halves of one
 * comparison and must not be able to pick different directories.
 *
 * ## What is and isn't a gate
 *
 * A **pass-rate move** is signal, not a gate: moves within ±10% are
 * marked stable, moves outside it are flagged (better → "+", worse →
 * "−"), and either way this exits `0`.
 *
 * A **missing or empty comparison** is a gate. Producing a table with
 * no rows in it and calling that "stable" is the failure mode this
 * command shipped with: `evals/replay/` absent printed a note and
 * exited 0, so CI went green having compared nothing.
 *
 * ## Exit codes
 *
 * | code | meaning |
 * |------|---------|
 * | `0`  | at least one agent was actually compared |
 * | `1`  | unexpected error |
 * | `2`  | nothing to compare — replay output or pinned baseline missing |
 */
async function main(): Promise<void> {
  if (!existsSync(REPLAY_DIR)) {
    return failNoInput(
      `${REPLAY_DIR} not found — \`pnpm run evals:replay\` did not produce output.`,
    );
  }

  const replayByAgent = collectAgentRollups(REPLAY_DIR);
  if (replayByAgent.size === 0) {
    return failNoInput(
      `${REPLAY_DIR} holds no <agent>/<scenario>.json files — the replay wrote nothing.`,
    );
  }

  const baseline = selectPinnedBaseline(RESULTS_DIR);
  if (!baseline) {
    const inspected = describeRejectedVersions(RESULTS_DIR);
    return failNoInput(
      `no pinned baseline under ${RESULTS_DIR} to compare against.\n` +
        (inspected.length > 0
          ? `Newest directories inspected:\n${inspected.join("\n")}`
          : "The results directory is empty."),
    );
  }
  const pinnedSummary = readPinnedSummary(baseline.dir);

  const lines: string[] = [
    "# Eval replay diff",
    "",
    `Replayed at: ${new Date().toISOString()}`,
    `Pinned version: ${pinnedSummary?.crimes_version ?? baseline.version}`,
    "",
    "| agent | pinned pass rate | replay pass rate | Δ | verdict |",
    "|-------|------------------|------------------|---|---------|",
  ];
  let regressionCount = 0;
  let comparedCount = 0;
  for (const [agent, rollup] of replayByAgent.entries()) {
    const pinnedRate = pinnedSummary?.per_agent[agent]?.structural_pass_rate ?? null;
    const replayRate = rollup.total === 0 ? null : rollup.pass / rollup.total;
    const delta =
      pinnedRate === null || replayRate === null ? null : replayRate - pinnedRate;
    const verdict = classify(replayRate, pinnedRate, delta);
    if (verdict === "regression") regressionCount += 1;
    if (delta !== null) comparedCount += 1;
    lines.push(
      `| ${agent} | ${fmt(pinnedRate)} | ${fmt(replayRate)} | ${delta === null ? "—" : signed(delta)} | ${verdict} |`,
    );
  }

  if (comparedCount === 0) {
    // Every row is "—". A table of dashes read as "no regressions" is
    // exactly the vacuous pass this gate exists to catch, so say what
    // happened in the summary and fail rather than posting it as news.
    lines.push(
      "",
      "⚠️ **No agent was actually compared.** Every replayed agent is either " +
        "empty or absent from the pinned summary — this diff measured nothing.",
    );
    await writeFile(DIFF_SUMMARY, lines.join("\n") + "\n", "utf8");
    return failNoInput(
      `replayed agents (${[...replayByAgent.keys()].join(", ")}) do not line up with ` +
        `the pinned summary in ${baseline.dir}. Nothing was compared.`,
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
  process.stdout.write(
    `evals:diff: ${comparedCount} agent(s) compared against ${baseline.version}; ` +
      `summary written to ${DIFF_SUMMARY}\n`,
  );
}

function failNoInput(message: string): never {
  process.stderr.write(`evals:diff: ${message}\n`);
  process.exit(2);
}

function collectAgentRollups(dir: string): Map<string, AgentRollup> {
  const out = new Map<string, AgentRollup>();
  for (const agent of readdirSync(dir, { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    const agentDir = resolve(dir, agent.name);
    const rollup: AgentRollup = { pass: 0, total: 0 };
    let files = 0;
    for (const entry of readdirSync(agentDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const data = JSON.parse(
        readFileSync(resolve(agentDir, entry.name), "utf8"),
      ) as ScoreResult;
      rollup.pass += data.structural_score.passed;
      rollup.total += data.structural_score.passed + data.structural_score.failed;
      files += 1;
    }
    // An agent directory with no result files in it is not an agent
    // that scored zero — it is an agent that was never replayed.
    if (files > 0) out.set(agent.name, rollup);
  }
  return out;
}

interface PinnedSummary {
  crimes_version: string;
  per_agent: Record<string, { structural_pass_rate: number; scenarios_run: number }>;
}

function readPinnedSummary(baselineDir: string): PinnedSummary | undefined {
  const summaryPath = resolve(baselineDir, "summary.json");
  if (!existsSync(summaryPath)) return undefined;
  return JSON.parse(readFileSync(summaryPath, "utf8")) as PinnedSummary;
}

function classify(
  replayRate: number | null,
  pinnedRate: number | null,
  delta: number | null,
): Verdict {
  if (replayRate === null) return "no data";
  if (pinnedRate === null || delta === null) return "unpinned";
  if (Math.abs(delta) <= TOLERANCE) return "stable";
  return delta > 0 ? "improved" : "regression";
}

function fmt(rate: number | null): string {
  return rate === null ? "—" : rate.toFixed(2);
}

function signed(n: number): string {
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`evals:diff: ${message}\n`);
  process.exit(1);
});
