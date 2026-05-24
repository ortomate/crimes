import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { discoverFiles } from "./discovery/index.js";
import type { CrimesConfig } from "./config.js";
import { loadConfig } from "./config.js";
import {
  assignIds,
  buildGuidance,
  buildRisk,
  tagTierAndSortByRankScore,
  toRepoRelative,
} from "./context-helpers.js";
import {
  runDetectorsOnTarget,
  safelyBuildFunctionHashIndex,
  safelyBuildIaIndex,
  safelyBuildImportGraph,
  safelyBuildJsxShapeIndex,
  safelyBuildPettyIndex,
  safelyBuildScoringContext,
} from "./context-indexes.js";
import { findLikelyTests } from "./context-likely-tests.js";
import type { ContextRelatedFile } from "./context-related-files.js";
import { findRelatedFiles } from "./context-related-files.js";
import type { Detector } from "./detector.js";
import type { Finding } from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";
import {
  buildDetectorRegistry,
  builtInDetectors,
  filterDetectors,
} from "./detector-registry.js";
import { resolveAliasGroups } from "./scan.js";
import type {
  ApplySuppressionsOptions,
  SuppressionEntry,
  SuppressionForFile,
} from "./suppressions.js";
import { partitionFindings, suppressionsForFile } from "./suppressions.js";

export interface ContextOptions {
  /** Repo-relative or absolute path to the file to inspect. */
  file: string;
  /**
   * Explicit scan root. When omitted, `context()` walks up from the target
   * file to the nearest enclosing `package.json` and uses that directory as
   * the root; this makes `crimes context <nested-package-file>` work the
   * same from the monorepo root as from inside the nested package. When
   * provided, the value wins unconditionally — `--root` is the user
   * override and `context()` does not climb above it.
   */
  root?: string;
  /** Override config explicitly. */
  config?: CrimesConfig;
  /** Override detectors. Defaults to all built-ins. */
  detectors?: Detector[];
  /**
   * Suppression entries the CLI loaded for this scan root. When provided,
   * the per-file suppression block is populated under clues.suppressions.
   * Optional — when omitted, suppressions are not included in the report.
   */
  suppressionsEntries?: SuppressionEntry[];
}

export interface ContextRisk {
  /** Worst severity present in `findings`. `"none"` when there are none. */
  level: "none" | "low" | "medium" | "high";
  high: number;
  medium: number;
  low: number;
  /** Total finding count. */
  total: number;
}

/**
 * Ambient signals about a file that aren't findings but help an agent
 * understand the file's context. Frozen contract for Release B — field
 * names, types, and omission rules are part of the public API.
 *
 * Omission rules (per spec §5.7):
 * - `churn` omitted when git is unavailable.
 * - `suppressions` omitted when the file has no suppression entries.
 * - `test_gap.percentile` omitted when fewer than 4 files were scanned;
 *   in that case `label === "unknown"` and `raw` carries the raw value.
 * - `related_signals` is ALWAYS present and ALWAYS `[]` in Release A.
 * - `clues` itself is omitted when ALL of churn/suppressions/test_gap
 *   would be absent. In Release A `test_gap` is always populated, so
 *   `clues` is practically always present.
 */
export interface ContextClues {
  churn?: {
    commits_90d: number;
    last_commit_at: string;
    unique_authors_90d: number;
  };
  suppressions?: SuppressionForFile[];
  test_gap?: {
    raw: number;
    percentile?: number;
    label: "top-quartile" | "median" | "bottom-quartile" | "unknown";
  };
  /** Reserved for Release B. Always `[]` in Release A. */
  related_signals: unknown[];
}

export interface ContextReport {
  schema_version: typeof SCHEMA_VERSION;
  /** Discriminator. Always the literal `"context"`. */
  report_type: "context";
  repo: { name: string; root: string };
  /** Repo-relative path to the inspected file, forward slashes. */
  file: string;
  risk: ContextRisk;
  /** Deterministic, type-keyed safe-editing notes for an agent. */
  agent_guidance: string[];
  /**
   * Other files an agent should probably read before editing the target.
   * Discovered deterministically — IA finding passthrough, shared path
   * tokens, domain-prefix filename matches, same-directory siblings.
   * Always present (empty array when nothing fired); see
   * `related_files_reason` for the empty case.
   */
  related_files: ContextRelatedFile[];
  /** Repo-relative paths of test files likely covering `file`. */
  likely_tests: string[];
  /** Same Finding shape as `crimes scan`, filtered to the target file. */
  findings: Finding[];
  /**
   * Only present when `agent_guidance` is empty. Short string explaining
   * why — keeps `[]` from being read as "we didn't look".
   */
  agent_guidance_reason?: string;
  /**
   * Only present when `related_files` is empty. Short string explaining
   * why no neighbourhood file fired.
   */
  related_files_reason?: string;
  /**
   * Only present when `likely_tests` is empty. Short string explaining
   * what conventions were searched without a hit.
   */
  likely_tests_reason?: string;
  /**
   * Number of findings matched by an entry in `.crimes/suppressions.json`.
   * Only present when ≥1 suppression matched.
   */
  suppressed_count?: number;
  /**
   * Ambient signals about the file — git churn, suppression inventory,
   * test gap, and a reserved slot for Release B related signals.
   * Omitted when all substantive sub-blocks (churn/suppressions/test_gap)
   * would be absent. In Release A this threshold is never met because
   * test_gap is always populated.
   */
  clues?: ContextClues;
}

/**
 * Walk upward from `start` (a directory path) looking for an enclosing
 * `package.json`. Returns the absolute path of the directory that contains
 * it, or `undefined` if none is found before the filesystem root.
 *
 * The walk is bounded by the filesystem root — there is no separate stop
 * condition, so callers that want to confine the search to a specific
 * subtree should resolve `start` and check against that subtree themselves.
 *
 * Callers should pass an already-canonicalised (realpath'd) directory so
 * the returned root matches the canonical form of any sibling absolute
 * paths the caller will compare against — `context()` realpaths the
 * target file before calling in, which keeps all comparisons consistent.
 */
export async function findNearestPackageRoot(
  start: string,
): Promise<string | undefined> {
  let dir = resolve(start);
  // Guard against `parse(dir).root === dir` looping forever on filesystem root.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir || parent === parse(dir).root) {
      // Final check at the filesystem root before giving up.
      if (existsSync(join(parent, "package.json"))) return parent;
      return undefined;
    }
    dir = parent;
  }
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/**
 * Resolve the scan root for a `context()` call.
 *
 *   1. If the caller passed an explicit `--root`, honour it verbatim.
 *   2. Otherwise, walk up from the target file's directory to the nearest
 *      enclosing `package.json` and use that directory.
 *   3. If no `package.json` exists above the target, fall back to
 *      `process.cwd()` — the historical default.
 *
 * Step 2 is the fix for "monorepo root: `crimes context
 * examples/pkg/src/foo.ts` returns no findings". The target file lives
 * inside a workspace package with its own `package.json`; we want the
 * scan to be scoped to that package, not the whole monorepo.
 */
async function resolveContextRoot(args: {
  targetAbs: string;
  explicitRoot: string | undefined;
}): Promise<string> {
  if (args.explicitRoot !== undefined) {
    // Canonicalise so it lines up with the realpath'd targetAbs.
    return safeRealpath(resolve(args.explicitRoot));
  }
  const packageRoot = await findNearestPackageRoot(dirname(args.targetAbs));
  if (packageRoot) return packageRoot;
  return safeRealpath(resolve(process.cwd()));
}

export async function context(options: ContextOptions): Promise<ContextReport> {
  const cwd = resolve(process.cwd());
  const initialRoot = resolve(options.root ?? cwd);
  const targetInput = isAbsolute(options.file)
    ? resolve(options.file)
    : resolve(initialRoot, options.file);
  // Canonicalise the target path so symlinked temp dirs (macOS /var vs
  // /private/var) line up with the discovered package root, which is also
  // canonicalised. Without this, `relative(root, targetAbs)` produces
  // `../../private/var/...` paths on darwin temp dirs.
  const targetAbs = await safeRealpath(targetInput);

  const root = await resolveContextRoot({
    targetAbs,
    explicitRoot: options.root,
  });
  const config =
    options.config ?? loadConfig(root, buildDetectorRegistry(builtInDetectors));
  const detectors =
    options.detectors ?? filterDetectors(builtInDetectors, config);

  const fileRel = toRepoRelative(root, targetAbs);

  const allFiles = await discoverFiles({
    root,
    include: config.include,
    exclude: config.exclude,
  });

  // Cross-file indexes are built over the WHOLE repo so single-file context
  // still gets repo-level IA and petty-crimes signal.
  const ia = await safelyBuildIaIndex({
    root,
    allFiles,
    aliasGroups: resolveAliasGroups(config),
  });
  const petty = await safelyBuildPettyIndex({ root, allFiles });
  const imports = await safelyBuildImportGraph({ root, allFiles });
  const jsxShapeIndex = await safelyBuildJsxShapeIndex({ root, allFiles });
  const functionHashIndex = await safelyBuildFunctionHashIndex({ root, allFiles });
  const scoring = await safelyBuildScoringContext({
    root,
    allFiles,
    imports,
  });

  const findings = await runDetectorsOnTarget({
    allFiles,
    targetAbs,
    root,
    config,
    detectors,
    ia,
    petty,
    imports,
    jsxShapeIndex,
    functionHashIndex,
    scoring,
  });
  tagTierAndSortByRankScore(findings, config);
  assignIds(findings);

  const likely_tests = await findLikelyTests({ root, fileRel, targetAbs, allFiles });

  // Repo-relative POSIX paths for every discovered file — the
  // related-files helper works in that vocabulary so it can compare
  // against IA index keys without re-resolving.
  const allFilesRel = allFiles.map((abs) =>
    toRepoRelative(root, abs),
  );
  const related_files = findRelatedFiles({
    fileRel,
    allFilesRel,
    ia,
    findings,
    likelyTests: likely_tests,
  });

  const agent_guidance = buildGuidance(findings, related_files);
  const risk = buildRisk(findings);

  // Key ordering inside the literal matters — `JSON.stringify` preserves
  // insertion order, and `agent_guidance` is the field agents read first,
  // so it goes ahead of `findings`. Optional `*_reason` fields are placed
  // immediately after the array they explain so a human scanning the JSON
  // can find them in one breath.
  const report: ContextReport = {
    schema_version: SCHEMA_VERSION,
    report_type: "context",
    repo: { name: basename(root), root },
    file: fileRel,
    risk,
    agent_guidance,
    related_files,
    likely_tests,
    findings,
  };

  if (agent_guidance.length === 0) {
    report.agent_guidance_reason =
      findings.length === 0 && related_files.length === 0
        ? "no findings on this file and no deterministic related files"
        : "findings on this file did not match any keyed guidance line";
  }
  if (related_files.length === 0) {
    report.related_files_reason =
      "no neighbourhood signal: no IA finding related_files, no shared domain tokens, no domain-prefix filenames, no same-directory siblings";
  }
  if (likely_tests.length === 0) {
    report.likely_tests_reason =
      "no sibling, __tests__, .test, .spec, _test, or _spec files matched the target basename";
  }

  // ── clues block ────────────────────────────────────────────────────────────
  // Build the ambient signals block (frozen contract for Release B).
  const clues: ContextClues = { related_signals: [] };

  // churn — present only when git data is available for the inspected file.
  // Plumbing note: ScoringContext.churnResult is the raw CollectChurnResult
  // that buildScoringContext already obtained. We surface it here so context()
  // doesn't need a second collectChurn call (Option 1 from the task spec).
  if (scoring?.churnResult?.gitAvailable === true) {
    const churnEntry = scoring.churnResult.files.find(
      (f) => f.file === fileRel,
    );
    if (churnEntry) {
      clues.churn = {
        commits_90d: churnEntry.changeCount,
        last_commit_at: churnEntry.latestChange,
        unique_authors_90d: churnEntry.uniqueAuthors,
      };
    }
  }

  // suppressions — per-file inventory (regardless of whether any matched today).
  if (options.suppressionsEntries) {
    const supps = suppressionsForFile(
      options.suppressionsEntries,
      fileRel,
      findings,
    );
    if (supps.length > 0) {
      clues.suppressions = supps;
    }
  }

  // test_gap — raw {0, 0.5, 1} + quartile-ranked percentile + label.
  // Always populated when scoring is available. When scoring is absent
  // (e.g. an exotic failure in safelyBuildScoringContext), we skip the
  // block rather than fabricating a value.
  if (scoring) {
    const raw = scoring.testGap.rawForFile(fileRel);
    const score = scoring.testGap.forFile(fileRel);
    const eligible = allFiles.length >= 4;
    clues.test_gap = eligible
      ? {
          raw,
          percentile: score,
          label:
            score >= 0.75
              ? "top-quartile"
              : score <= 0.25
                ? "bottom-quartile"
                : "median",
        }
      : { raw, label: "unknown" };
  }

  // Omit clues entirely if all three substantive blocks are absent.
  // related_signals alone does NOT count — it is always [] in Release A.
  // In practice this threshold is never met because test_gap is always
  // populated when scoring succeeds, and scoring succeeds in the vast
  // majority of cases.
  if (clues.churn || clues.suppressions || clues.test_gap) {
    report.clues = clues;
  }

  return report;
}

/**
 * Filter a {@link ContextReport} through the suppressions list. Same
 * shape as {@link applySuppressionsToScan} — pure, returns a new report,
 * recomputes the `risk` totals from the visible set.
 */
export function applySuppressionsToContext(
  report: ContextReport,
  suppressions: SuppressionEntry[],
  options: ApplySuppressionsOptions,
): ContextReport {
  const { visible, suppressedCount } = partitionFindings(
    report.findings,
    suppressions,
    options,
  );
  const next: ContextReport = {
    ...report,
    findings: visible,
    risk: buildRisk(visible),
  };
  if (suppressedCount > 0) next.suppressed_count = suppressedCount;
  return next;
}
