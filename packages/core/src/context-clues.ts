// Type-only import — erased at compile time, so this does not create a
// runtime cycle with context.ts, which imports this module's functions.
import type { ContextClues, ContextReport } from "./context.js";
import type { Finding } from "./finding.js";
import type { ScoringContext } from "./scoring/build.js";
import { suppressionsForFile } from "./suppressions.js";
import type { SuppressionEntry } from "./suppressions.js";

/** Minimum discovered files before quartile ranking is meaningful. */
const QUARTILE_MIN_FILES = 4;

/**
 * Build the ambient-signals `clues` block for a context report.
 *
 * Extracted from `context()` in 0.12.2 — it was 63 of that function's
 * 193 lines and depends on nothing but its arguments, so it belongs
 * with the other `context-*` helpers rather than inline in the
 * orchestrator.
 *
 * Returns `undefined` when no substantive block is populated, which is
 * the caller's signal to omit `clues` entirely. `related_signals` alone
 * does not count — it is always `[]` today.
 */
export function buildClues(args: {
  scoring: ScoringContext | undefined;
  fileRel: string;
  findings: Finding[];
  fileCount: number;
  suppressionsEntries?: SuppressionEntry[] | undefined;
}): ContextClues | undefined {
  const { scoring, fileRel, findings, fileCount } = args;
  const clues: ContextClues = { related_signals: [] };

  // churn — present only when git data is available for this file.
  // Read off ScoringContext.churnResult, which buildScoringContext
  // already obtained, so context() needs no second collectChurn call.
  if (scoring?.churnResult?.gitAvailable === true) {
    const churnEntry = scoring.churnResult.files.find((f) => f.file === fileRel);
    if (churnEntry) {
      clues.churn = {
        commits_90d: churnEntry.changeCount,
        last_commit_at: churnEntry.latestChange,
        unique_authors_90d: churnEntry.uniqueAuthors,
      };
    }
  }

  // suppressions — per-file inventory, regardless of whether any
  // matched on this run.
  if (args.suppressionsEntries) {
    const supps = suppressionsForFile(
      args.suppressionsEntries,
      fileRel,
      findings,
    );
    if (supps.length > 0) clues.suppressions = supps;
  }

  // test_gap — raw {0, 0.5, 1} plus the quartile percentile and label.
  // Skipped rather than fabricated when scoring is unavailable.
  if (scoring) {
    const raw = scoring.testGap.rawForFile(fileRel);
    const score = scoring.testGap.forFile(fileRel);
    clues.test_gap =
      fileCount >= QUARTILE_MIN_FILES
        ? { raw, percentile: score, label: quartileLabel(score) }
        : { raw, label: "unknown" };
  }

  if (!clues.churn && !clues.suppressions && !clues.test_gap) return undefined;
  return clues;
}

function quartileLabel(score: number): "top-quartile" | "bottom-quartile" | "median" {
  if (score >= 0.75) return "top-quartile";
  if (score <= 0.25) return "bottom-quartile";
  return "median";
}

/**
 * Fill the optional `*_reason` fields that explain an empty array.
 *
 * Mutates `report` in place — it is a freshly-built local in `context()`
 * and the key ordering of the original literal must be preserved, so
 * returning a copy would be both wasteful and risky.
 */
export function applyEmptyReasons(
  report: ContextReport,
  args: { unclaimedExtension: string | undefined },
): void {
  const { agent_guidance, related_files, likely_tests, findings } = report;

  if (agent_guidance.length === 0) {
    report.agent_guidance_reason =
      findings.length === 0 && related_files.length === 0
        ? "no findings on this file and no deterministic related files"
        : "findings on this file did not match any keyed guidance line";
  }

  // A missing language pack is a more useful explanation than the
  // generic one above, so it overrides it: universal detectors did run,
  // but everything pack-specific was skipped.
  if (args.unclaimedExtension !== undefined) {
    const suffix =
      findings.length === 0
        ? "Universal checks ran (no findings)."
        : "Showing universal-pack findings only.";
    report.agent_guidance_reason = `no language pack claims ${args.unclaimedExtension} files; install or wait for one. ${suffix}`;
  }

  if (related_files.length === 0) {
    report.related_files_reason =
      "no neighbourhood signal: no IA finding related_files, no shared domain tokens, no domain-prefix filenames, no same-directory siblings";
  }
  if (likely_tests.length === 0) {
    report.likely_tests_reason =
      "no test file matched the target basename (looked for siblings, " +
      "__tests__/ and tests/ directories, and the .test / .spec / _test / " +
      "test_ naming conventions) and no test file imports it";
  }
}
