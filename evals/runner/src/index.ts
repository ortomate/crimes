#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { writeFile, rename, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { invokeClaude } from "./agents/claude.js";
import { invokeCodex } from "./agents/codex.js";
import type { AgentRunResult } from "./agents/claude.js";
import { runJudge } from "./judge.js";
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const FIXTURES_REGISTRY = resolve(
  REPO_ROOT,
  "evals",
  "fixtures",
  "fixtures.meta.json",
);
const SCENARIOS_DIR = resolve(REPO_ROOT, "evals", "scenarios");
const RESULTS_DIR = resolve(REPO_ROOT, "evals", "results");

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
}

interface WorkItem {
  scenario: Scenario;
  fixture: FixtureRegistryEntry;
  agent: Agent;
}

interface Tally {
  total: number;
  passByAgent: Map<string, number>;
  totalByAgent: Map<string, number>;
  passByAgentKind: Map<string, number>;
  totalByAgentKind: Map<string, number>;
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
  const outDirName = flags.label
    ? `${crimesVersion}-${flags.label}`
    : crimesVersion;
  const outDir = resolve(RESULTS_DIR, outDirName);
  mkdirSync(outDir, { recursive: true });

  const scanCache = new Map<string, Promise<string>>();
  const tally = createTally();
  let completed = 0;

  await runPool(items, flags.concurrency, async (item) => {
    const seq = ++completed;
    process.stdout.write(
      `evals: [${seq}/${items.length}] ${item.agent} × ${item.scenario.id} (${item.fixture.name})\n`,
    );
    try {
      await processOne({ item, scanCache, flags, outDir, crimesVersion, tally });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `evals: ${item.agent} × ${item.scenario.id} failed: ${message}\n`,
      );
      if (flags.bail) throw err;
    }
  });

  const summary = buildSummary(crimesVersion, scenariosToRun, usableAgents, tally);
  await writeJsonAtomic(resolve(outDir, "summary.json"), summary);
  const elapsed = formatDuration(Date.now() - startMs);
  process.stdout.write(
    `\nevals: done. ${tally.total} run × scenario combinations in ${elapsed}.\n` +
      `Results: ${outDir}\n`,
  );
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
  tally: Tally;
}

async function processOne(args: ProcessOneArgs): Promise<void> {
  const { item, scanCache, flags, outDir, crimesVersion, tally } = args;
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
      const judge = await runJudge({ scenario: item.scenario, response: agentResult.response });
      if (judge) result.judge_score = judge;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `evals: judge pass failed for ${item.scenario.id} — ${message}\n`,
      );
    }
  }

  updateTally(tally, item, structural);
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

function createTally(): Tally {
  return {
    total: 0,
    passByAgent: new Map(),
    totalByAgent: new Map(),
    passByAgentKind: new Map(),
    totalByAgentKind: new Map(),
  };
}

function updateTally(
  tally: Tally,
  item: WorkItem,
  structural: { passed: number; failed: number },
): void {
  tally.total += 1;
  const all = structural.passed + structural.failed;
  tally.passByAgent.set(item.agent, (tally.passByAgent.get(item.agent) ?? 0) + structural.passed);
  tally.totalByAgent.set(item.agent, (tally.totalByAgent.get(item.agent) ?? 0) + all);
  const kindKey = `${item.scenario.kind}::${item.agent}`;
  tally.passByAgentKind.set(kindKey, (tally.passByAgentKind.get(kindKey) ?? 0) + structural.passed);
  tally.totalByAgentKind.set(kindKey, (tally.totalByAgentKind.get(kindKey) ?? 0) + all);
}

function buildSummary(
  crimesVersion: string,
  scenarios: Scenario[],
  agents: Agent[],
  tally: Tally,
): Record<string, unknown> {
  const perAgent: Record<string, { structural_pass_rate: number; scenarios_run: number }> = {};
  for (const agent of agents) {
    const total = tally.totalByAgent.get(agent) ?? 0;
    const pass = tally.passByAgent.get(agent) ?? 0;
    perAgent[agent] = {
      structural_pass_rate: total === 0 ? 0 : round(pass / total),
      scenarios_run: scenarios.length,
    };
  }
  const perKind: Record<ScenarioKind, Record<string, number>> = {} as Record<
    ScenarioKind,
    Record<string, number>
  >;
  for (const scenario of scenarios) {
    const kind = scenario.kind as ScenarioKind;
    if (!perKind[kind]) perKind[kind] = {};
    for (const agent of agents) {
      const key = `${kind}::${agent}`;
      const total = tally.totalByAgentKind.get(key) ?? 0;
      const pass = tally.passByAgentKind.get(key) ?? 0;
      perKind[kind][agent] = total === 0 ? 0 : round(pass / total);
    }
  }
  return {
    crimes_version: crimesVersion,
    total_scenarios: tally.total,
    per_agent: perAgent,
    per_scenario_kind: perKind,
  };
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
  const flags: CliFlags = { judge: false, bail: false, concurrency: 4 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    // `pnpm run evals -- --flag` forwards a literal "--" through to argv;
    // tolerate it instead of rejecting as unknown.
    if (arg === "--") continue;
    if (arg === "--judge") flags.judge = true;
    else if (arg === "--bail") flags.bail = true;
    else if (arg === "--agent") {
      const value = args[++i] as Agent | undefined;
      if (value && (AGENTS as readonly string[]).includes(value)) {
        flags.agent = value;
      } else {
        process.stderr.write(
          `evals: --agent must be one of: ${AGENTS.join(", ")}\n`,
        );
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
        process.stderr.write(
          `evals: --scenario must be one of: ${known.join(", ")}\n`,
        );
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
      process.stderr.write(
        `evals: failed to parse ${file} — ${message}\n`,
      );
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

async function writeJsonAtomic(
  filePath: string,
  data: unknown,
): Promise<void> {
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
