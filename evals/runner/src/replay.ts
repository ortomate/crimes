#!/usr/bin/env tsx
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCodexResponse } from "./agents/codex-transcript.js";
import { buildScanContext, runScan } from "./scan-helpers.js";
import { sortResultsVersionsDesc } from "./versions.js";
import { scoreStructural } from "./score.js";
import type { FixturesRegistry, ScanContext, Scenario, ScoreResult } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const RESULTS_DIR = resolve(REPO_ROOT, "evals", "results");
const SCENARIOS_DIR = resolve(REPO_ROOT, "evals", "scenarios");
const FIXTURES_REGISTRY = resolve(REPO_ROOT, "evals", "fixtures", "fixtures.meta.json");
const REPLAY_DIR = resolve(REPO_ROOT, "evals", "replay");

/**
 * `pnpm run evals:replay` entry. Re-scores every committed result file
 * under the latest `evals/results/<version>/` against the current
 * crimes build (specifically, the current set of detector ids and the
 * file/finding regex shapes in score.ts). No agent invocations.
 *
 * Output lands in `evals/replay/<agent>/<scenario-id>.json` with the
 * same {@link ScoreResult} shape as a fresh run but a new run_id and
 * an updated `crimes_version` reflecting the build under test.
 */
async function main(): Promise<void> {
  const latest = pickLatestVersion();
  if (!latest) {
    process.stdout.write(
      "evals:replay: no pinned results under evals/results/ yet — nothing to replay.\n",
    );
    return;
  }
  process.stdout.write(
    `evals:replay: replaying results pinned at ${latest.version} against the current build.\n`,
  );

  const scenarios = loadScenarios();
  const scenarioById = new Map(scenarios.map((s) => [s.id, s]));
  const fixtureDirById = loadFixtureDirMap();

  const versionDir = resolve(RESULTS_DIR, latest.version);
  const replayCrimesVersion = await readCrimesVersion();
  // Memoize re-derived scan contexts per fixture — only used as a
  // fallback when a stored result predates `scan_context`.
  const scanContextCache = new Map<string, Promise<ScanContext | null>>();

  let count = 0;
  for (const agentEntry of readdirSync(versionDir, { withFileTypes: true })) {
    // summary.json (and any future top-level files) live next to the
    // agent directories — skip non-directories so we don't try to walk
    // them as if they held per-scenario results.
    if (!agentEntry.isDirectory()) continue;
    const agentName = agentEntry.name;
    const agentDir = resolve(versionDir, agentName);
    const stat = readdirSync(agentDir, { withFileTypes: true });
    for (const entry of stat) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = resolve(agentDir, entry.name);
      const stored = JSON.parse(readFileSync(filePath, "utf8")) as ScoreResult;
      const scenario = scenarioById.get(stored.scenario);
      if (!scenario) {
        process.stderr.write(
          `evals:replay: ${entry.name} references unknown scenario ${stored.scenario} — skipping.\n`,
        );
        continue;
      }
      // Re-derive when the stored context predates a lookup map the
      // current scorer reads. A stored context missing
      // `detector_id_by_evidence` is not "no evidence matched" — it is
      // a file written before that map existed, and replaying against
      // it would silently score the new build with the old scorer's
      // reach and report the difference as zero.
      const scanContext =
        stored.scan_context?.detector_id_by_evidence !== undefined
          ? stored.scan_context
          : await deriveScanContext(scenario, fixtureDirById, scanContextCache);
      // Result files written before the codex JSONL fix stored the raw
      // transcript as `response`. Normalise on read so replays score
      // the agent's answer, not the tool output it happened to print.
      // No-op for already-clean responses.
      const scoredResponse = extractCodexResponse(stored.response);
      const structural = scoreStructural(
        scoredResponse,
        scenario.expected_artifacts,
        scanContext ?? undefined,
        scenario.prompt,
      );
      const replayed: ScoreResult = {
        scenario: stored.scenario,
        agent: stored.agent,
        crimes_version: replayCrimesVersion,
        timestamp: new Date().toISOString(),
        run_id: stored.run_id,
        response: stored.response,
        structural_score: structural,
      };
      if (scanContext) replayed.scan_context = scanContext;
      if (stored.judge_score) replayed.judge_score = stored.judge_score;

      const outDir = resolve(REPLAY_DIR, agentName);
      mkdirSync(outDir, { recursive: true });
      await writeFile(
        resolve(outDir, entry.name),
        JSON.stringify(replayed, null, 2) + "\n",
        "utf8",
      );
      count += 1;
    }
  }

  process.stdout.write(
    `evals:replay: ${count} result file${count === 1 ? "" : "s"} re-scored → ${REPLAY_DIR}\n`,
  );
}

function pickLatestVersion(): { version: string } | undefined {
  if (!existsSync(RESULTS_DIR)) return undefined;
  const versions = sortResultsVersionsDesc(
    readdirSync(RESULTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
  const top = versions[0];
  return top ? { version: top } : undefined;
}

function loadFixtureDirMap(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(FIXTURES_REGISTRY)) return out;
  try {
    const registry = JSON.parse(
      readFileSync(FIXTURES_REGISTRY, "utf8"),
    ) as FixturesRegistry;
    for (const f of registry.fixtures) out.set(f.id, resolve(REPO_ROOT, f.path));
  } catch {
    // surfaced by the runner already; ignore here
  }
  return out;
}

/**
 * Fallback path for result files written before `scan_context` shipped.
 * Re-runs `crimes scan` on the scenario's fixture so the scorer can do
 * charge-name and `crime_NNNN` lookups even when scoring legacy results.
 * Returns null when the fixture is gone (e.g. setup hasn't run) — the
 * scorer then degrades to slug-only matching.
 */
async function deriveScanContext(
  scenario: Scenario,
  fixtureDirById: Map<string, string>,
  cache: Map<string, Promise<ScanContext | null>>,
): Promise<ScanContext | null> {
  const fixtureDir = fixtureDirById.get(scenario.fixture);
  if (!fixtureDir || !existsSync(fixtureDir)) return null;
  let pending = cache.get(fixtureDir);
  if (!pending) {
    pending = runScan(fixtureDir)
      .then((json) => buildScanContext(json))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `evals:replay: could not re-scan ${fixtureDir} for scan_context — ${message}\n`,
        );
        return null;
      });
    cache.set(fixtureDir, pending);
  }
  return pending;
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
    } catch {
      // surfaced by the runner already; ignore here
    }
  }
  return out;
}

async function readCrimesVersion(): Promise<string> {
  const pkgPath = resolve(REPO_ROOT, "packages", "cli", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`evals:replay: ${message}\n`);
  process.exit(1);
});

// Required so the helper compiles standalone when `join` isn't used in
// the main path (tsc strict unused-import is paranoid about this).
void join;
