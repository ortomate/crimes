/**
 * Every filesystem location the eval harness reads or writes, resolved
 * once. Five of them accept an environment override so the harness can
 * be pointed at a synthetic tree — which is how the guard tests in
 * `harness-guards.test.ts` exercise the real `replay` / `diff` /
 * `verify-scenarios` scripts against a directory layout they can
 * construct, rather than asserting on a mock that cannot go vacuous.
 *
 * The overrides are also the mechanism `evals/README.md` § Retention
 * already names for archiving `evals/results/` to object storage
 * without rewriting history.
 *
 * A relative override resolves from the repo root; an absolute one is
 * taken as-is. Reads and writes share these constants — `evals`,
 * `evals:ranking`, `evals:replay` and `evals:diff` must never disagree
 * about where a baseline lives, because a baseline nobody can find is
 * indistinguishable from a baseline that is empty.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo root — `evals/runner/src` is three levels down. */
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

function fromEnv(name: string, ...defaultSegments: string[]): string {
  const override = process.env[name];
  return override !== undefined && override.length > 0
    ? resolve(REPO_ROOT, override)
    : resolve(REPO_ROOT, ...defaultSegments);
}

/** Per-version pinned eval outputs. Override: `EVALS_RESULTS_DIR`. */
export const RESULTS_DIR = fromEnv("EVALS_RESULTS_DIR", "evals", "results");

/** Re-scored output of `evals:replay`. Override: `EVALS_REPLAY_DIR`. */
export const REPLAY_DIR = fromEnv("EVALS_REPLAY_DIR", "evals", "replay");

/** One JSON file per scenario kind. Override: `EVALS_SCENARIOS_DIR`. */
export const SCENARIOS_DIR = fromEnv("EVALS_SCENARIOS_DIR", "evals", "scenarios");

/** Fixture registry. Override: `EVALS_FIXTURES_REGISTRY`. */
export const FIXTURES_REGISTRY = fromEnv(
  "EVALS_FIXTURES_REGISTRY",
  "evals",
  "fixtures",
  "fixtures.meta.json",
);

/** Markdown body the PR-comment step posts. Override: `EVALS_DIFF_SUMMARY`. */
export const DIFF_SUMMARY = fromEnv("EVALS_DIFF_SUMMARY", "evals", "diff-summary.md");

/** The built CLI every scan shells out to. Not overridable. */
export const CLI_DIST = resolve(REPO_ROOT, "packages", "cli", "dist", "index.js");
