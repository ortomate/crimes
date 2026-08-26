#!/usr/bin/env tsx
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { extractCodexResponse } from "./agents/codex-transcript.js";
import {
  type PinnedBaseline,
  describeRejectedVersions,
  hasAgentResults,
  selectPinnedBaseline,
} from "./baseline.js";
import {
  FIXTURES_REGISTRY,
  REPLAY_DIR,
  REPO_ROOT,
  RESULTS_DIR,
  SCENARIOS_DIR,
} from "./paths.js";
import { buildScanContext, runScan } from "./scan-helpers.js";
import { scoreStructural } from "./score.js";
import type { FixturesRegistry, ScanContext, Scenario, ScoreResult } from "./types.js";

/**
 * `pnpm run evals:replay` entry. Re-scores every committed result file
 * under the pinned baseline in `evals/results/` against the current
 * crimes build (specifically, the current set of detector ids and the
 * file/finding regex shapes in score.ts). No agent invocations.
 *
 * Output lands in `evals/replay/<agent>/<scenario-id>.json` with the
 * same {@link ScoreResult} shape as a fresh run but a new run_id and
 * an updated `crimes_version` reflecting the build under test.
 *
 * ## Exit codes
 *
 * | code | meaning |
 * |------|---------|
 * | `0`  | at least one result file was re-scored |
 * | `1`  | unexpected error |
 * | `2`  | no replayable input — nothing was re-scored |
 *
 * **There is no successful zero.** Re-scoring nothing is never "nothing
 * to do"; it means the input is missing, and this command exists to be
 * a CI gate. It used to print `0 result files re-scored` and exit 0 —
 * see `baseline.ts` for how that stayed invisible for eight bumps.
 *
 * ## Flags
 *
 * Two flags exist for the case the default does not cover — re-scoring
 * an *older* sample so that two samples can be compared under one
 * scorer. Without them, a scorer fix silently makes the current sample
 * incomparable with every sample already on disk, which is exactly the
 * comparison `evals:variance` needs:
 *
 * ```bash
 * pnpm run evals:replay -- --version 0.24.0 --out evals/replay-0.24.0
 * ```
 *
 * - `--version <v>` replays `evals/results/<v>/` instead of the pinned
 *   baseline. Only needs agent result files — a `summary.json` is
 *   `evals:diff`'s concern, and the variance flow deliberately reaches
 *   for samples that predate one.
 * - `--out <dir>` writes somewhere other than `evals/replay/`, so two
 *   replays can sit side by side. Relative paths resolve from the repo
 *   root.
 */
async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const source = resolveSource(opts.version);
  const outRoot = opts.out ? resolve(REPO_ROOT, opts.out) : REPLAY_DIR;
  clearDisposableOutRoot(outRoot);
  process.stdout.write(
    `evals:replay: replaying results pinned at ${source.version} against the current build.\n`,
  );

  const scenarios = loadScenarios();
  const scenarioById = new Map(scenarios.map((s) => [s.id, s]));
  const fixtureDirById = loadFixtureDirMap();

  const replayCrimesVersion = await readCrimesVersion();
  // Memoize re-derived scan contexts per fixture — only used as a
  // fallback when a stored result predates `scan_context`.
  const scanContextCache = new Map<string, Promise<ScanContext | null>>();

  let count = 0;
  let skipped = 0;
  for (const agentEntry of readdirSync(source.dir, { withFileTypes: true })) {
    // summary.json (and any future top-level files) live next to the
    // agent directories — skip non-directories so we don't try to walk
    // them as if they held per-scenario results.
    if (!agentEntry.isDirectory()) continue;
    const agentName = agentEntry.name;
    const agentDir = resolve(source.dir, agentName);
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
        skipped += 1;
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

      const outDir = resolve(outRoot, agentName);
      mkdirSync(outDir, { recursive: true });
      await writeFile(
        resolve(outDir, entry.name),
        JSON.stringify(replayed, null, 2) + "\n",
        "utf8",
      );
      count += 1;
    }
  }

  if (count === 0) {
    process.stderr.write(
      `evals:replay: re-scored 0 result files from ${source.dir} — nothing was measured.\n` +
        (skipped > 0
          ? `evals:replay: ${skipped} file(s) referenced scenarios that no longer exist; ` +
            "the baseline and evals/scenarios/ have drifted apart.\n"
          : "evals:replay: the directory holds no readable agent results.\n"),
    );
    process.exit(2);
    return;
  }

  process.stdout.write(
    `evals:replay: ${count} result file${count === 1 ? "" : "s"} re-scored → ${outRoot}\n` +
      (skipped > 0
        ? `evals:replay: WARNING — ${skipped} file(s) skipped (unknown scenario). ` +
          "The replay covers less than the pinned baseline, so its pass rate is " +
          "not directly comparable.\n"
        : ""),
  );
}

/**
 * Picks the directory to replay, or exits `2`. Never returns a
 * directory it has not confirmed holds agent result files — "found a
 * directory" and "found something to replay" are different claims, and
 * conflating them is what made this command pass vacuously.
 */
function resolveSource(explicit: string | undefined): PinnedBaseline {
  if (explicit !== undefined) {
    const dir = resolve(RESULTS_DIR, explicit);
    if (!existsSync(dir)) {
      return failNoInput(`no results directory ${dir}.`);
    }
    if (!hasAgentResults(dir)) {
      return failNoInput(
        `${dir} holds no <agent>/<scenario>.json files — nothing to replay.`,
      );
    }
    return { version: explicit, dir };
  }
  const picked = selectPinnedBaseline(RESULTS_DIR);
  if (picked) return picked;
  const inspected = describeRejectedVersions(RESULTS_DIR);
  return failNoInput(
    `no pinned baseline under ${RESULTS_DIR}.\n` +
      "A baseline needs agent result files and a summary.json beside them.\n" +
      (inspected.length > 0
        ? `Newest directories inspected:\n${inspected.join("\n")}\n`
        : "The results directory is empty.\n") +
      "Produce one with `pnpm run evals`, or name an older sample with " +
      "`--version <v>`.",
  );
}

function failNoInput(message: string): never {
  process.stderr.write(`evals:replay: ${message}\n`);
  process.exit(2);
}

/**
 * A second replay into a directory that still holds the first one's
 * output leaves `evals:diff` reading a mixture of both. Only clear the
 * two shapes `.gitignore` already declares disposable — `evals/replay`
 * and its `evals/replay-<version>` siblings — so an arbitrary `--out`
 * is never deleted.
 */
function clearDisposableOutRoot(outRoot: string): void {
  if (!existsSync(outRoot)) return;
  const isDisposable =
    dirname(outRoot) === resolve(REPO_ROOT, "evals") &&
    basename(outRoot).startsWith("replay");
  if (isDisposable) rmSync(outRoot, { recursive: true, force: true });
}

interface ReplayOptions {
  version?: string;
  out?: string;
}

function parseArgs(argv: string[]): ReplayOptions {
  const opts: ReplayOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version") opts.version = argv[++i];
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg?.startsWith("--version=")) opts.version = arg.slice("--version=".length);
    else if (arg?.startsWith("--out=")) opts.out = arg.slice("--out=".length);
  }
  return opts;
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
