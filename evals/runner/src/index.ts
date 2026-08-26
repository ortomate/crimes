#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { writeFile, rename, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { invokeClaude } from "./agents/claude.js";
import { invokeCodex } from "./agents/codex.js";
import type { AgentRunResult } from "./agents/claude.js";
import { runJudge } from "./judge.js";
import { FIXTURES_REGISTRY, REPO_ROOT, RESULTS_DIR, SCENARIOS_DIR } from "./paths.js";
import { buildScanContext, runScan } from "./scan-helpers.js";
import { scoreStructural } from "./score.js";
import type {
  FixtureRegistryEntry,
  FixturesRegistry,
  Scenario,
  ScenarioKind,
  ScoreResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

const AGENTS = ["claude", "codex"] as const;
type Agent = (typeof AGENTS)[number];

interface CliFlags {
  agent?: Agent;
  fixture?: string;
  scenario?: ScenarioKind;
  judge: boolean;
  bail: boolean;
  concurrency: number;
  /**
   * Optional suffix appended to the version-keyed output directory.
   * Used for repeat-run variance sampling without burning a patch
   * version — e.g. `--label r2` writes to `evals/results/0.7.2-r2/`.
   */
  label?: string;
  /**
   * Skip work items whose result file already exists, so an
   * interrupted run can be finished without re-billing the agent
   * invocations that already succeeded.
   */
  resume: boolean;
}

interface WorkItem {
  scenario: Scenario;
  fixture: FixtureRegistryEntry;
  agent: Agent;
}

async function main(): Promise<void> {
  const startMs = Date.now();
  const flags = parseFlags(process.argv.slice(2));
  const ctx = await loadRunContext(flags);
  if (!ctx) return;

  const { fixturesToRun, scenariosToRun, usableAgents } = ctx;
  const items = buildWorkItems(fixturesToRun, scenariosToRun, usableAgents);
  if (items.length === 0) {
    process.stdout.write("evals: no scenarios match the supplied filters.\n");
    return;
  }

  const crimesVersion = await readCrimesVersion();
  const outDirName = flags.label ? `${crimesVersion}-${flags.label}` : crimesVersion;
  const outDir = resolve(RESULTS_DIR, outDirName);
  mkdirSync(outDir, { recursive: true });

  const scanCache = new Map<string, Promise<string>>();
  let completed = 0;

  const pending = flags.resume
    ? items.filter(
        (item) => !existsSync(resolve(outDir, item.agent, `${item.scenario.id}.json`)),
      )
    : items;
  if (flags.resume) {
    const skipped = items.length - pending.length;
    process.stdout.write(
      `evals: --resume — ${skipped} result(s) already on disk, running ${pending.length}.\n`,
    );
    if (pending.length === 0) {
      process.stdout.write("evals: nothing left to run; rebuilding summary only.\n");
    }
  }

  await runPool(pending, flags.concurrency, async (item) => {
    const seq = ++completed;
    process.stdout.write(
      `evals: [${seq}/${pending.length}] ${item.agent} × ${item.scenario.id} (${item.fixture.name})\n`,
    );
    try {
      await processOne({ item, scanCache, flags, outDir, crimesVersion });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `evals: ${item.agent} × ${item.scenario.id} failed: ${message}\n`,
      );
      if (flags.bail) throw err;
    }
  });

  // Built from the result files on disk, not from an in-memory tally.
  // A tally dies with the process, so an interrupted run used to leave
  // a directory of valid results and no summary — and `evals:replay` /
  // `evals:diff` both pin the highest-versioned directory, so that
  // half-state silently became the baseline. Reading the directory also
  // makes `--scenario review --resume` produce a summary covering the
  // whole matrix rather than just the filtered subset.
  const summary = summariseResultsDir(outDir, crimesVersion);
  await writeJsonAtomic(resolve(outDir, "summary.json"), summary);
  const elapsed = formatDuration(Date.now() - startMs);
  // Canonical full matrix — a filtered run is by definition not a
  // complete baseline, so the filter must not lower the bar.
  const expected = loadScenarios().length * AGENTS.length;
  process.stdout.write(
    `\nevals: done. ${summary.total_scenarios} run × scenario combinations on disk ` +
      `in ${elapsed}.\nResults: ${outDir}\n`,
  );
  if (summary.total_scenarios < expected) {
    process.stdout.write(
      `evals: WARNING — ${expected - summary.total_scenarios} combination(s) missing. ` +
        `This directory is NOT a complete baseline; finish it with\n` +
        `  pnpm run evals -- --resume\n` +
        `before treating it as one (see evals/README.md).\n`,
    );
  }
}

interface RunContext {
  fixturesToRun: FixtureRegistryEntry[];
  scenariosToRun: Scenario[];
  usableAgents: Agent[];
}

async function loadRunContext(flags: CliFlags): Promise<RunContext | null> {
  if (!existsSync(FIXTURES_REGISTRY)) {
    process.stdout.write(
      `evals: ${FIXTURES_REGISTRY} not found — run \`pnpm run evals:setup\` first.\n`,
    );
    return null;
  }
  const registry = JSON.parse(
    readFileSync(FIXTURES_REGISTRY, "utf8"),
  ) as FixturesRegistry;
  const allScenarios = loadScenarios();
  if (registry.fixtures.length === 0 || allScenarios.length === 0) {
    process.stdout.write("evals: nothing to run (registry or scenarios empty).\n");
    return null;
  }

  const requestedAgents: Agent[] = flags.agent ? [flags.agent] : [...AGENTS];
  const usableAgents = await filterAvailableAgents(requestedAgents);
  if (usableAgents.length === 0) {
    process.stderr.write(
      "evals: no agent CLIs available. Install `claude` and/or `codex` and retry.\n",
    );
    process.exit(2);
    return null;
  }

  const fixturesToRun = registry.fixtures.filter(
    (f) => !flags.fixture || f.id === flags.fixture,
  );
  const scenariosToRun = allScenarios.filter((s) => {
    if (flags.scenario && s.kind !== flags.scenario) return false;
    return fixturesToRun.some((f) => f.id === s.fixture);
  });
  return { fixturesToRun, scenariosToRun, usableAgents };
}

async function filterAvailableAgents(requested: Agent[]): Promise<Agent[]> {
  const usable: Agent[] = [];
  for (const agent of requested) {
    if (await hasCommand(agent)) {
      usable.push(agent);
    } else {
      process.stderr.write(
        `evals: \`${agent}\` CLI not found on PATH — skipping ${agent} runs. ` +
          `Install it and re-authenticate, then re-run.\n`,
      );
    }
  }
  return usable;
}

function buildWorkItems(
  fixtures: FixtureRegistryEntry[],
  scenarios: Scenario[],
  agents: Agent[],
): WorkItem[] {
  const items: WorkItem[] = [];
  for (const scenario of scenarios) {
    const fixture = fixtures.find((f) => f.id === scenario.fixture);
    if (!fixture) continue;
    const fixtureDir = resolve(REPO_ROOT, fixture.path);
    if (!existsSync(fixtureDir)) {
      process.stderr.write(
        `evals: fixture ${fixture.path} not found on disk — skip (run evals:setup?).\n`,
      );
      continue;
    }
    for (const agent of agents) items.push({ scenario, fixture, agent });
  }
  return items;
}

interface ProcessOneArgs {
  item: WorkItem;
  scanCache: Map<string, Promise<string>>;
  flags: CliFlags;
  outDir: string;
  crimesVersion: string;
}

async function processOne(args: ProcessOneArgs): Promise<void> {
  const { item, scanCache, flags, outDir, crimesVersion } = args;
  const fixtureDir = resolve(REPO_ROOT, item.fixture.path);
  const scanJson = await getCachedScan(scanCache, fixtureDir);
  const scanContext = buildScanContext(scanJson);

  const agentResult = await invokeAgent(item.agent, item.scenario, scanJson);
  const structural = scoreStructural(
    agentResult.response,
    item.scenario.expected_artifacts,
    scanContext,
    item.scenario.prompt,
  );

  const result: ScoreResult = {
    scenario: item.scenario.id,
    agent: item.agent,
    crimes_version: crimesVersion,
    timestamp: new Date().toISOString(),
    run_id: randomUUID(),
    response: agentResult.response,
    scan_context: scanContext,
    structural_score: structural,
  };

  if (flags.judge) {
    try {
      const judge = await runJudge({
        scenario: item.scenario,
        response: agentResult.response,
      });
      if (judge) result.judge_score = judge;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `evals: judge pass failed for ${item.scenario.id} — ${message}\n`,
      );
    }
  }

  const agentDir = resolve(outDir, item.agent);
  mkdirSync(agentDir, { recursive: true });
  await writeJsonAtomic(resolve(agentDir, `${item.scenario.id}.json`), result);
}

function getCachedScan(
  cache: Map<string, Promise<string>>,
  fixtureDir: string,
): Promise<string> {
  let existing = cache.get(fixtureDir);
  if (!existing) {
    existing = runScan(fixtureDir);
    cache.set(fixtureDir, existing);
  }
  return existing;
}

/**
 * Minimal promise pool: schedules at most `concurrency` `worker` calls in
 * flight at a time. Each worker is called with the work item; rejected
 * workers abort future scheduling but in-flight workers still drain.
 */
async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  let aborted = false;
  const launch = async (): Promise<void> => {
    while (!aborted) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        await worker(items[idx]!);
      } catch {
        aborted = true;
        return;
      }
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < lanes; i += 1) workers.push(launch());
  await Promise.all(workers);
}

function parseFlags(args: string[]): CliFlags {
  const flags: CliFlags = { judge: false, bail: false, concurrency: 4, resume: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    // `pnpm run evals -- --flag` forwards a literal "--" through to argv;
    // tolerate it instead of rejecting as unknown.
    if (arg === "--") continue;
    if (arg === "--judge") flags.judge = true;
    else if (arg === "--bail") flags.bail = true;
    else if (arg === "--resume") flags.resume = true;
    else if (arg === "--agent") {
      const value = args[++i] as Agent | undefined;
      if (value && (AGENTS as readonly string[]).includes(value)) {
        flags.agent = value;
      } else {
        process.stderr.write(`evals: --agent must be one of: ${AGENTS.join(", ")}\n`);
        process.exit(2);
      }
    } else if (arg === "--fixture") {
      flags.fixture = args[++i];
    } else if (arg === "--scenario") {
      const value = args[++i] as ScenarioKind | undefined;
      const known: ScenarioKind[] = ["refactor", "bugfix", "review", "context", "plan"];
      if (value && known.includes(value)) {
        flags.scenario = value;
      } else {
        process.stderr.write(`evals: --scenario must be one of: ${known.join(", ")}\n`);
        process.exit(2);
      }
    } else if (arg === "--concurrency") {
      const raw = args[++i];
      const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (!Number.isInteger(value) || value < 1) {
        process.stderr.write("evals: --concurrency must be a positive integer\n");
        process.exit(2);
      }
      flags.concurrency = value;
    } else if (arg === "--label") {
      const raw = args[++i];
      if (!raw || !/^[A-Za-z0-9._-]+$/.test(raw)) {
        process.stderr.write(
          "evals: --label must be a non-empty token of [A-Za-z0-9._-]\n",
        );
        process.exit(2);
      }
      flags.label = raw;
    } else if (arg.startsWith("--")) {
      process.stderr.write(`evals: unknown flag ${arg}\n`);
      process.exit(2);
    }
  }
  return flags;
}

function loadScenarios(): Scenario[] {
  if (!existsSync(SCENARIOS_DIR)) return [];
  const out: Scenario[] = [];
  for (const file of readdirSync(SCENARIOS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(
        readFileSync(resolve(SCENARIOS_DIR, file), "utf8"),
      ) as Scenario[];
      if (Array.isArray(data)) out.push(...data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`evals: failed to parse ${file} — ${message}\n`);
    }
  }
  return out;
}

async function hasCommand(command: string): Promise<boolean> {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function readCrimesVersion(): Promise<string> {
  const pkgPath = resolve(REPO_ROOT, "packages", "cli", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

async function invokeAgent(
  agent: Agent,
  scenario: Scenario,
  scanJson: string,
): Promise<AgentRunResult> {
  const prompt = composePrompt(scenario, scanJson);
  if (agent === "claude") {
    return invokeClaude({ prompt });
  }
  return invokeCodex({ prompt });
}

function composePrompt(scenario: Scenario, scanJson: string): string {
  return (
    `# Scenario: ${scenario.id} (kind: ${scenario.kind})\n\n` +
    `${scenario.prompt}\n\n` +
    `# crimes scan output (the context for your answer)\n\n` +
    "```json\n" +
    scanJson.trim() +
    "\n```\n"
  );
}

interface EvalSummary {
  crimes_version: string;
  total_scenarios: number;
  per_agent: Record<string, { structural_pass_rate: number; scenarios_run: number }>;
  per_scenario_kind: Record<string, Record<string, number>>;
}

/**
 * Build the summary by reading every result file under `outDir`.
 *
 * Deliberately *not* accumulated during the run. A tally lives in the
 * process, so a run that is killed part-way leaves a directory of valid
 * per-scenario results with no summary at all — and since `evals:replay`
 * and `evals:diff` both pin the highest-versioned directory, that
 * half-state silently becomes the baseline every later comparison is
 * made against.
 *
 * Reading the directory also fixes the filtered-rerun case: finishing a
 * broken run with `--scenario review --resume` now writes a summary
 * describing the whole matrix, not just the scenarios that re-ran.
 *
 * Arithmetic is unchanged from the tally it replaces: per agent and per
 * `kind::agent`, sum `structural_score.passed` over `passed + failed`.
 */
function summariseResultsDir(outDir: string, crimesVersion: string): EvalSummary {
  const allScenarios = loadScenarios();
  // The *full* scenario set, never the filtered one. This summary
  // describes the whole directory, so a `--scenario review --resume`
  // must not stamp it with the count of the scenarios that re-ran.
  const scenariosRun = allScenarios.length;
  const kindOf = new Map(allScenarios.map((s) => [s.id, s.kind]));
  const passByAgent = new Map<string, number>();
  const totalByAgent = new Map<string, number>();
  const passByAgentKind = new Map<string, number>();
  const totalByAgentKind = new Map<string, number>();
  const agents: string[] = [];
  let total = 0;

  if (existsSync(outDir)) {
    for (const entry of readdirSync(outDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const agent = entry.name;
      agents.push(agent);
      for (const file of readdirSync(resolve(outDir, agent))) {
        if (!file.endsWith(".json")) continue;
        let result: ScoreResult;
        try {
          result = JSON.parse(
            readFileSync(resolve(outDir, agent, file), "utf8"),
          ) as ScoreResult;
        } catch {
          // A truncated file from a hard kill: skip it rather than
          // abort, and let the completeness warning report the gap.
          continue;
        }
        const structural = result.structural_score;
        if (!structural) continue;
        const kind = kindOf.get(result.scenario);
        if (kind === undefined) continue;
        const all = structural.passed + structural.failed;
        total += 1;
        passByAgent.set(agent, (passByAgent.get(agent) ?? 0) + structural.passed);
        totalByAgent.set(agent, (totalByAgent.get(agent) ?? 0) + all);
        const key = `${kind}::${agent}`;
        passByAgentKind.set(key, (passByAgentKind.get(key) ?? 0) + structural.passed);
        totalByAgentKind.set(key, (totalByAgentKind.get(key) ?? 0) + all);
      }
    }
  }
  agents.sort();

  const perAgent: EvalSummary["per_agent"] = {};
  for (const agent of agents) {
    const t = totalByAgent.get(agent) ?? 0;
    perAgent[agent] = {
      structural_pass_rate: t === 0 ? 0 : round((passByAgent.get(agent) ?? 0) / t),
      scenarios_run: scenariosRun,
    };
  }

  const perKind: EvalSummary["per_scenario_kind"] = {};
  for (const kind of new Set(kindOf.values())) {
    perKind[kind] = {};
    for (const agent of agents) {
      const key = `${kind}::${agent}`;
      const t = totalByAgentKind.get(key) ?? 0;
      perKind[kind]![agent] = t === 0 ? 0 : round((passByAgentKind.get(key) ?? 0) / t);
    }
  }

  return {
    crimes_version: crimesVersion,
    total_scenarios: total,
    per_agent: perAgent,
    per_scenario_kind: perKind,
  };
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  // Write to a tempfile in the same dir, then rename — protects against
  // partial writes from a crashed run.
  await mkdir(dirname(filePath), { recursive: true });
  const tmpDir = await mkdtemp(join(tmpdir(), "crimes-eval-write-"));
  const tmpFile = join(tmpDir, "result.json");
  await writeFile(tmpFile, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmpFile, filePath);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`evals: ${message}\n`);
  process.exit(1);
});
