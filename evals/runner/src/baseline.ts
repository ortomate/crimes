/**
 * Which `evals/results/<version>/` directory is *the* pinned baseline.
 *
 * `evals:replay` and `evals:diff` are two halves of one comparison, so
 * they have to answer this the same way. They did not. `diff` walked
 * the version list until it found a `summary.json`; `replay` took
 * `[0]` unconditionally. That was harmless only while the newest
 * directory always held a full agent sample — and it stopped being
 * true at `0.25.4`, when `evals:ranking` began writing
 * `<version>/ranking.json` on every patch bump. From then on `replay`
 * pinned a ranking-only directory, re-scored **zero** files, and
 * exited 0; `diff` found no replay output and also exited 0. Both CI
 * steps went green while measuring nothing, for eight bumps.
 *
 * So a baseline is defined once, here, and it is deliberately the
 * conjunction of what both consumers need:
 *
 *   - at least one `<agent>/<scenario>.json` — `replay`'s input, and
 *   - a `summary.json` beside them — `diff`'s comparison anchor.
 *
 * Requiring both also rules out a directory left half-written by a
 * killed run, which `evals/README.md` § "If a run dies part-way" warns
 * silently becomes the baseline.
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { sortResultsVersionsDesc } from "./versions.js";

export interface PinnedBaseline {
  /** Directory name, e.g. `0.25.1`. */
  version: string;
  /** Absolute path to it. */
  dir: string;
}

/** Why a version directory cannot serve as a baseline. */
export type BaselineRejection = "missing" | "no-agent-results" | "no-summary";

/**
 * Result files live one level down, under a per-agent directory.
 * Top-level files (`summary.json`, `ranking.json`) are not results.
 * Short-circuits on the first one found — this runs per candidate.
 */
export function hasAgentResults(versionDir: string): boolean {
  if (!existsSync(versionDir)) return false;
  for (const agent of readdirSync(versionDir, { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    for (const entry of readdirSync(resolve(versionDir, agent.name), {
      withFileTypes: true,
    })) {
      if (entry.isFile() && entry.name.endsWith(".json")) return true;
    }
  }
  return false;
}

/** `undefined` when the directory is a usable baseline. */
export function rejectBaseline(versionDir: string): BaselineRejection | undefined {
  if (!existsSync(versionDir)) return "missing";
  if (!hasAgentResults(versionDir)) return "no-agent-results";
  if (!existsSync(resolve(versionDir, "summary.json"))) return "no-summary";
  return undefined;
}

/** Human-readable form of {@link rejectBaseline}, for error output. */
export function explainRejection(reason: BaselineRejection): string {
  switch (reason) {
    case "missing":
      return "directory does not exist";
    case "no-agent-results":
      return "no <agent>/<scenario>.json files — ranking-only bump directory";
    case "no-summary":
      return "no summary.json — incomplete or killed run";
  }
}

/** Version-directory names under `resultsDir`, newest first. */
export function listResultsVersions(resultsDir: string): string[] {
  if (!existsSync(resultsDir)) return [];
  return sortResultsVersionsDesc(
    readdirSync(resultsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
}

/**
 * The newest directory that is a complete baseline, or `undefined`
 * when none is. Never falls back to "newest directory" — that fallback
 * is the bug this module exists for.
 */
export function selectPinnedBaseline(resultsDir: string): PinnedBaseline | undefined {
  for (const version of listResultsVersions(resultsDir)) {
    const dir = resolve(resultsDir, version);
    if (rejectBaseline(dir) === undefined) return { version, dir };
  }
  return undefined;
}

/**
 * One line per inspected directory, newest first, saying why each was
 * skipped. Fed into the failure message so "no baseline" arrives with
 * its evidence rather than as a bare exit code.
 */
export function describeRejectedVersions(resultsDir: string, limit = 5): string[] {
  return listResultsVersions(resultsDir)
    .slice(0, limit)
    .map((version) => {
      const reason = rejectBaseline(resolve(resultsDir, version));
      return `    ${version}: ${reason ? explainRejection(reason) : "usable"}`;
    });
}
