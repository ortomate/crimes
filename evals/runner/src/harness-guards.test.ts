/**
 * Vacuous-pass guards for the commands that report on the eval harness:
 * the three `evals-pr.yml` runs, plus `evals:variance`.
 *
 * These spawn the **real scripts** — `tsx src/replay.ts`, `src/diff.ts`,
 * `src/verify-scenarios.ts`, `src/variance.ts` — against a synthetic tree built in
 * a temp directory, and assert on the process exit status. That is the
 * point: the bug being guarded against was three commands that printed
 * an accurate description of doing nothing and exited 0, so a test that
 * only inspected their output would have passed on the broken build
 * too. Only the exit status is what CI reads.
 *
 * The synthetic tree is reached through the `EVALS_*` overrides in
 * `paths.ts`. Nothing here touches the repo's own `evals/results/`,
 * `evals/replay/` or `evals/diff-summary.md`.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(RUNNER_ROOT, "..", "..");

const TSX = [
  resolve(RUNNER_ROOT, "node_modules", ".bin", "tsx"),
  resolve(REPO_ROOT, "node_modules", ".bin", "tsx"),
].find((p) => existsSync(p));

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScript(
  script: "replay.ts" | "diff.ts" | "verify-scenarios.ts" | "variance.ts",
  env: Record<string, string>,
  args: string[] = [],
): RunResult {
  if (!TSX) throw new Error("tsx binary not found — run `pnpm install` first.");
  const proc = spawnSync(TSX, [resolve(HERE, script), ...args], {
    cwd: RUNNER_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (proc.error) throw proc.error;
  return { status: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

let root: string;

beforeAll(() => {
  root = mkdtempSync(resolve(tmpdir(), "crimes-evals-guard-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fresh, empty synthetic tree for one test. */
function tree(name: string): string {
  const dir = resolve(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const SCENARIO_ID = "guard-synthetic-review";

/**
 * One scenario, deliberately checking for a detector slug the stored
 * response names verbatim, so the structural score is non-zero and
 * `evals:diff` has a real pass rate to compare.
 */
function writeScenarios(dir: string, fixture = "01"): string {
  const scenariosDir = resolve(dir, "scenarios");
  writeJson(resolve(scenariosDir, "review.json"), [
    {
      id: SCENARIO_ID,
      fixture,
      kind: "review",
      prompt: "Review this fixture and name the worst finding.",
      expected_artifacts: { referenced_findings: ["god_function"] },
    },
  ]);
  return scenariosDir;
}

/**
 * A stored agent result. `scan_context.detector_id_by_evidence` is
 * present (empty) on purpose — that is what tells replay the context is
 * current, so it scores from the file instead of re-scanning a fixture.
 * Keeps these tests hermetic and off the CLI.
 */
function storedResult(scenario = SCENARIO_ID): unknown {
  return {
    scenario,
    agent: "claude",
    crimes_version: "0.0.0-guard",
    timestamp: "2026-01-01T00:00:00.000Z",
    run_id: "guard-run",
    response: "The god_function finding is the most dangerous thing in this fixture.",
    scan_context: {
      detector_id_by_finding_id: {},
      detector_id_by_charge: {},
      detector_id_by_evidence: {},
    },
    structural_score: { passed: 1, failed: 0, details: [] },
  };
}

/** A complete baseline: agent result files plus the summary beside them. */
function writeFullBaseline(resultsDir: string, version: string, scenario?: string): void {
  writeJson(
    resolve(resultsDir, version, "claude", `${SCENARIO_ID}.json`),
    storedResult(scenario),
  );
  writeJson(resolve(resultsDir, version, "summary.json"), {
    crimes_version: version,
    total_scenarios: 1,
    per_agent: { claude: { structural_pass_rate: 1, scenarios_run: 1 } },
    per_scenario_kind: {},
  });
}

/**
 * What every patch bump has written since `0.25.4`: a version directory
 * holding a ranking report and nothing else. Newest by name, useless as
 * a replay input.
 */
function writeRankingOnly(resultsDir: string, version: string): void {
  writeJson(resolve(resultsDir, version, "ranking.json"), {
    crimes_version: version,
    mean_ndcg_deep: 0.5,
  });
}

describe("evals:replay refuses to pass vacuously", () => {
  it("exits non-zero when the newest results directory is ranking-only", () => {
    // The production shape exactly: `0.26.0/ranking.json` on top, and
    // nothing under it in this tree. Replay used to print
    // "0 result files re-scored" and exit 0 here.
    const dir = tree("ranking-only");
    const results = resolve(dir, "results");
    writeRankingOnly(results, "0.26.0");
    const run = runScript("replay.ts", {
      EVALS_RESULTS_DIR: results,
      EVALS_REPLAY_DIR: resolve(dir, "replay"),
      EVALS_SCENARIOS_DIR: writeScenarios(dir),
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("no pinned baseline");
    expect(run.stderr).toContain("ranking-only");
  });

  it("picks the newest complete baseline, not the newest directory", () => {
    // The real repo on 2026-08-26: 0.25.4 through 0.26.0 are all
    // ranking-only, and 0.25.1 is the last directory holding agent
    // results. Replay has to reach past the newer names to find it —
    // and has to agree with `evals:diff`, which already did.
    const dir = tree("shadowed-baseline");
    const results = resolve(dir, "results");
    writeRankingOnly(results, "0.26.0");
    writeRankingOnly(results, "0.25.4");
    writeFullBaseline(results, "0.25.1");
    const out = resolve(dir, "replay");
    const run = runScript("replay.ts", {
      EVALS_RESULTS_DIR: results,
      EVALS_REPLAY_DIR: out,
      EVALS_SCENARIOS_DIR: writeScenarios(dir),
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("pinned at 0.25.1");
    expect(run.stdout).toContain("1 result file re-scored");
    expect(existsSync(resolve(out, "claude", `${SCENARIO_ID}.json`))).toBe(true);
  });

  it("exits non-zero when --version names a directory with no agent results", () => {
    const dir = tree("explicit-ranking-only");
    const results = resolve(dir, "results");
    writeRankingOnly(results, "0.26.0");
    writeFullBaseline(results, "0.25.1");
    const run = runScript(
      "replay.ts",
      {
        EVALS_RESULTS_DIR: results,
        EVALS_REPLAY_DIR: resolve(dir, "replay"),
        EVALS_SCENARIOS_DIR: writeScenarios(dir),
      },
      ["--version", "0.26.0"],
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("nothing to replay");
  });

  it("exits non-zero when every stored result names a scenario that is gone", () => {
    // Baseline and scenarios drifted apart: files exist, none scoreable.
    // The count reaching zero is what must fail, however it got there.
    const dir = tree("scenario-drift");
    const results = resolve(dir, "results");
    writeFullBaseline(results, "0.25.1", "deleted-scenario-id");
    const run = runScript("replay.ts", {
      EVALS_RESULTS_DIR: results,
      EVALS_REPLAY_DIR: resolve(dir, "replay"),
      EVALS_SCENARIOS_DIR: writeScenarios(dir),
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("re-scored 0 result files");
  });
});

describe("evals:diff refuses to pass vacuously", () => {
  it("exits non-zero when the replay directory does not exist", () => {
    const dir = tree("diff-no-replay");
    const results = resolve(dir, "results");
    writeFullBaseline(results, "0.25.1");
    const run = runScript("diff.ts", {
      EVALS_RESULTS_DIR: results,
      EVALS_REPLAY_DIR: resolve(dir, "replay"),
      EVALS_DIFF_SUMMARY: resolve(dir, "diff-summary.md"),
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("did not produce output");
    expect(existsSync(resolve(dir, "diff-summary.md"))).toBe(false);
  });

  it("exits non-zero when the replay directory holds no result files", () => {
    const dir = tree("diff-empty-replay");
    const results = resolve(dir, "results");
    writeFullBaseline(results, "0.25.1");
    const replay = resolve(dir, "replay");
    mkdirSync(resolve(replay, "claude"), { recursive: true });
    const run = runScript("diff.ts", {
      EVALS_RESULTS_DIR: results,
      EVALS_REPLAY_DIR: replay,
      EVALS_DIFF_SUMMARY: resolve(dir, "diff-summary.md"),
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("wrote nothing");
  });

  it("exits non-zero when no replayed agent appears in the pinned summary", () => {
    // A table whose every row is "—" reads as "no regressions".
    const dir = tree("diff-unpinned-agent");
    const results = resolve(dir, "results");
    writeJson(
      resolve(results, "0.25.1", "claude", `${SCENARIO_ID}.json`),
      storedResult(),
    );
    writeJson(resolve(results, "0.25.1", "summary.json"), {
      crimes_version: "0.25.1",
      total_scenarios: 0,
      per_agent: {},
      per_scenario_kind: {},
    });
    const replay = resolve(dir, "replay");
    writeJson(resolve(replay, "claude", `${SCENARIO_ID}.json`), storedResult());
    const summaryPath = resolve(dir, "diff-summary.md");
    const run = runScript("diff.ts", {
      EVALS_RESULTS_DIR: results,
      EVALS_REPLAY_DIR: replay,
      EVALS_DIFF_SUMMARY: summaryPath,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Nothing was compared");
    expect(readFileSync(summaryPath, "utf8")).toContain("No agent was actually compared");
  });

  it("exits zero and compares agents after a replay that really ran", () => {
    // The whole CI pipeline over a synthetic tree: replay, then diff.
    const dir = tree("diff-happy-path");
    const results = resolve(dir, "results");
    writeRankingOnly(results, "0.26.0");
    writeFullBaseline(results, "0.25.1");
    const replay = resolve(dir, "replay");
    const summaryPath = resolve(dir, "diff-summary.md");
    const env = {
      EVALS_RESULTS_DIR: results,
      EVALS_REPLAY_DIR: replay,
      EVALS_SCENARIOS_DIR: writeScenarios(dir),
      EVALS_DIFF_SUMMARY: summaryPath,
    };
    expect(runScript("replay.ts", env).status).toBe(0);
    const run = runScript("diff.ts", env);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("1 agent(s) compared against 0.25.1");
    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toContain("| claude |");
    expect(summary).not.toContain("No agent was actually compared");
  });
});

describe("evals:verify-scenarios refuses to pass vacuously", () => {
  it("exits non-zero when a registry fixture is missing on disk", () => {
    // Pre-`evals:setup` state. This used to print
    // "N scenario(s) reconciled" — counting scenarios it had skipped —
    // and exit 0.
    const dir = tree("verify-missing-fixture");
    const registry = resolve(dir, "fixtures.meta.json");
    writeJson(registry, {
      schema_version: "0.1.0",
      fixtures: [
        {
          id: "01",
          path: resolve(dir, "never-materialised"),
          name: "synthetic",
          kind: "oss-clone",
          purpose: "guard fixture",
        },
      ],
    });
    const run = runScript("verify-scenarios.ts", {
      EVALS_FIXTURES_REGISTRY: registry,
      EVALS_SCENARIOS_DIR: writeScenarios(dir),
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("never checked");
    expect(run.stderr).toContain("evals:setup");
  });

  it("exits non-zero when a scenario names a fixture the registry lacks", () => {
    const dir = tree("verify-unknown-fixture");
    const fixtureDir = resolve(dir, "present-fixture");
    mkdirSync(fixtureDir, { recursive: true });
    const registry = resolve(dir, "fixtures.meta.json");
    writeJson(registry, {
      schema_version: "0.1.0",
      fixtures: [
        {
          id: "01",
          path: fixtureDir,
          name: "synthetic",
          kind: "hand-crafted",
          purpose: "guard fixture",
        },
      ],
    });
    const run = runScript("verify-scenarios.ts", {
      EVALS_FIXTURES_REGISTRY: registry,
      // Scenario points at fixture 99, which the registry never defines.
      EVALS_SCENARIOS_DIR: writeScenarios(dir, "99"),
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("not in registry");
  });

  it("exits non-zero when there are no scenarios to check", () => {
    const dir = tree("verify-no-scenarios");
    const registry = resolve(dir, "fixtures.meta.json");
    writeJson(registry, { schema_version: "0.1.0", fixtures: [] });
    const emptyScenarios = resolve(dir, "scenarios");
    mkdirSync(emptyScenarios, { recursive: true });
    const run = runScript("verify-scenarios.ts", {
      EVALS_FIXTURES_REGISTRY: registry,
      EVALS_SCENARIOS_DIR: emptyScenarios,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("no scenarios found");
  });
});

/**
 * A result file `evals:variance` will accept as an observation: a
 * populated `detector_id_by_finding_id` (else it is dropped as
 * context-less) and a stable assertion count (else as rubric drift).
 */
function varianceResult(scenario: string, passed: number, failed: number): unknown {
  return {
    scenario,
    agent: "claude",
    crimes_version: "0.25.1",
    timestamp: "2026-01-01T00:00:00.000Z",
    run_id: `run-${scenario}-${passed}`,
    response: "irrelevant to variance",
    scan_context: {
      detector_id_by_finding_id: { crime_00001: "god_function" },
      detector_id_by_charge: {},
      detector_id_by_evidence: {},
    },
    structural_score: { passed, failed, details: [] },
  };
}

function writeVarianceSample(
  dir: string,
  results: Array<{ scenario: string; passed: number; failed: number }>,
): string {
  for (const r of results) {
    writeJson(
      resolve(dir, "claude", `${r.scenario}.json`),
      varianceResult(r.scenario, r.passed, r.failed),
    );
  }
  return dir;
}

describe("evals:variance refuses to pass vacuously", () => {
  it("exits non-zero when a sample directory holds no agent results", () => {
    // `--dirs <real>,<ranking-only>` used to print "2 samples of the
    // requested directories", drop every pair as absent, render an empty
    // table with no bands, and exit 0.
    const dir = tree("variance-ranking-only");
    const real = writeVarianceSample(resolve(dir, "0.25.1"), [
      { scenario: "a", passed: 1, failed: 1 },
    ]);
    const rankingOnly = resolve(dir, "0.26.0");
    writeJson(resolve(rankingOnly, "ranking.json"), { mean_ndcg_deep: 0.5 });
    const run = runScript("variance.ts", {}, ["--dirs", `${real},${rankingOnly}`]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("is not a sample");
  });

  it("exits non-zero when no pair survives pairing across the samples", () => {
    // Both directories hold real results, but they share no
    // (scenario, agent) pair — so every pair is excluded and the band is
    // computed over nothing.
    const dir = tree("variance-disjoint");
    const a = writeVarianceSample(resolve(dir, "0.25.1"), [
      { scenario: "only-in-a", passed: 1, failed: 1 },
    ]);
    const b = writeVarianceSample(resolve(dir, "0.25.1-r2"), [
      { scenario: "only-in-b", passed: 2, failed: 0 },
    ]);
    const run = runScript("variance.ts", {}, ["--dirs", `${a},${b}`]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("nothing was measured");
  });

  it("still reports a band when the samples really do line up", () => {
    const dir = tree("variance-happy-path");
    const a = writeVarianceSample(resolve(dir, "0.25.1"), [
      { scenario: "shared", passed: 1, failed: 1 },
    ]);
    const b = writeVarianceSample(resolve(dir, "0.25.1-r2"), [
      { scenario: "shared", passed: 2, failed: 0 },
    ]);
    const run = runScript("variance.ts", {}, ["--dirs", `${a},${b}`]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("derived aggregate sd");
  });
});
