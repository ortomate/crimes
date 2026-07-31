/**
 * Scoring data sources — the M2-completion piece of 0.6.0.
 *
 * Every finding now carries real `churn`, `test_gap`, and `blast_radius`
 * scores in addition to `severity` and `confidence`. These three values
 * are looked up per-file from indices built once per scan and attached
 * to `DetectorContext.scoring`. The unified `agent_risk` combines the
 * detector's own intrinsic judgement with the three context signals:
 *
 *   agent_risk = clamp01(
 *     0.40 * intrinsic        // detector-supplied scores.agent_risk
 *     + 0.20 * churn
 *     + 0.20 * test_gap
 *     + 0.20 * blast_radius
 *   )
 *
 * Reweighted in 0.12.2. The previous formula put 60% of the weight on
 * severity and confidence and discarded the detector's own value, which
 * left `agent_risk` correlated with severity at r=0.79 and with
 * blast_radius at r=0.06 — collapsed into severity, which PRD §10 says
 * must not happen.
 *
 * The three context scores are ordinal: the formulae may shift between
 * minor releases as we tune them, but the contract — higher is worse,
 * range [0, 1] — is stable.
 */

import { relative, sep } from "node:path";
import { getDefaultsFor } from "../detector-defaults.js";
import { resolveLanguagePackRouter } from "../discovery/language-pack-router.js";
import type { Finding, FindingScores, Severity } from "../finding.js";
import { collectChurn } from "../git/churn.js";
import type { CollectChurnResult } from "../git/churn.js";
import type { ImportGraph } from "../imports/types.js";
import { isTestFile } from "../util/test-files.js";
import { quartileScores } from "./quartile.js";

export interface ChurnIndex {
  /** Returns [0,1] churn for a file, from git log over the configured window. */
  forFile(repoPath: string): number;
  /**
   * True when the underlying git history is shallow or absent. Detectors
   * should treat churn as advisory when this is set.
   */
  limited: boolean;
  /** Short human-readable reason. Only set when `limited` is true. */
  limitedReason?: string;
}

export interface TestGapIndex {
  /**
   * Quartile-ranked test gap for this file in [0,1]. Higher = worse-covered
   * relative to other files in this scan. Falls back to the raw value when
   * the scan has fewer than 4 source files (no meaningful distribution).
   *
   * Returns 0 for test files themselves — the measure is not applicable
   * to them, not "well-covered".
   */
  forFile(repoPath: string): number;
  /**
   * Raw {0, 0.5, 1.0} value before quartile normalisation. Used by
   * `context.clues.test_gap.raw`.
   *
   * Returns 0 for test files themselves — not applicable, not well-covered.
   */
  rawForFile(repoPath: string): number;
}

export interface BlastRadiusIndex {
  /**
   * Returns [0,1] blast radius — normalised count of transitive importers
   * of the file.
   */
  forFile(repoPath: string): number;
  /**
   * Raw transitive importer count (pre-normalisation). Exposed so the
   * reporter can render "blast top-quartile (11 importers)" without the
   * renderer having to invert the normalisation.
   */
  countForFile(repoPath: string): number;
}

const RECENCY_FULL_DAYS = 7;
const RECENCY_DECAY_DAYS = 14;
const MS_PER_DAY = 86_400_000;

export function recencyForDate(
  iso: string | undefined,
  nowMs: number = Date.now(),
): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  const days = (nowMs - t) / MS_PER_DAY;
  if (days <= RECENCY_FULL_DAYS) return 1;
  if (days >= RECENCY_DECAY_DAYS) return 0;
  // Linear decay from 1 → 0 across (FULL, DECAY].
  return 1 - (days - RECENCY_FULL_DAYS) / (RECENCY_DECAY_DAYS - RECENCY_FULL_DAYS);
}

export interface RecencyIndex {
  /** Returns [0,1] recency boost for a file. 0 when git is unavailable. */
  forFile(repoPath: string): number;
  /** True when git history is shallow or absent. */
  limited: boolean;
  /** Short human-readable reason. Only set when `limited` is true. */
  limitedReason?: string;
}

export interface ScoringContext {
  churn: ChurnIndex;
  testGap: TestGapIndex;
  blastRadius: BlastRadiusIndex;
  recency: RecencyIndex;
  /**
   * Raw churn collection result — exposed so `context()` can populate
   * `clues.churn` without a second `collectChurn` call. Not intended for
   * use by detectors; treat it as internal plumbing for the context report.
   */
  churnResult?: CollectChurnResult;
}

export interface BuildScoringContextOptions {
  /** Absolute repo root. */
  root: string;
  /** Absolute paths the scan discovered. */
  files: string[];
  /** Repo-wide import graph (from `buildImportGraph`). */
  imports: ImportGraph | undefined;
  /** Git-log window. Defaults to `"90d"`. */
  since?: string;
}

const CHURN_CAP = 20;
const BLAST_RADIUS_CAP = 50;

/**
 * Build the per-file scoring indices for a scan. Always returns a context
 * — index methods degrade to `0` when the underlying signal is missing
 * rather than throwing.
 */
export async function buildScoringContext(
  options: BuildScoringContextOptions,
): Promise<ScoringContext> {
  const since = options.since ?? "90d";

  const churnResult = await collectChurn({ root: options.root, since });
  const churnByFile = new Map<string, number>();
  for (const c of churnResult.files) {
    churnByFile.set(c.file, Math.min(c.changeCount / CHURN_CAP, 1));
  }
  const churn: ChurnIndex = {
    forFile(repoPath) {
      return churnByFile.get(repoPath) ?? 0;
    },
    limited: !churnResult.gitAvailable || churnResult.historyLimited === true,
    ...(churnResult.historyLimitedReason !== undefined
      ? { limitedReason: churnResult.historyLimitedReason }
      : !churnResult.gitAvailable
        ? {
            limitedReason:
              "not a git repository or git is unavailable; churn is unknown",
          }
        : {}),
  };

  const latestByFile = new Map<string, string>();
  for (const c of churnResult.files) {
    latestByFile.set(c.file, c.latestChange);
  }
  const recency: RecencyIndex = {
    forFile(repoPath) {
      return recencyForDate(latestByFile.get(repoPath));
    },
    limited: !churnResult.gitAvailable,
    ...(churnResult.gitAvailable ? {} : {
      limitedReason: "not a git repository or git is unavailable; recency is unknown",
    }),
  };

  const repoPaths = options.files.map((abs) =>
    toRepoPath(options.root, abs),
  );
  const testGap = buildTestGapIndex({
    repoPaths,
    imports: options.imports,
  });
  const blastRadius = buildBlastRadiusIndex({ imports: options.imports });

  return { churn, testGap, blastRadius, recency, churnResult };
}

function buildTestGapIndex(args: {
  repoPaths: string[];
  imports: ImportGraph | undefined;
}): TestGapIndex {
  const { repoPaths, imports } = args;
  const fileSet = new Set(repoPaths);
  const testFiles = new Set(repoPaths.filter((p) => isTestFile(p)));
  const langPack = resolveLanguagePackRouter();

  // Index every discovered file's basename without extension and parent
  // directory; we'll use these to find sibling tests.
  const siblingTestFor = (file: string): boolean => {
    const { dir, baseNoExt } = parseRepoPath(file);
    if (baseNoExt.length === 0) return false;
    // Sibling: ${dir}/${baseNoExt}.test.{ext} / .spec.{ext}
    for (const candidate of testFiles) {
      const parsed = parseRepoPath(candidate);
      if (parsed.dir === dir && stripTestSuffix(parsed.baseNoExt) === baseNoExt) {
        return true;
      }
    }
    return false;
  };

  const tellsTestCoversBasename = (file: string): boolean => {
    const { baseNoExt } = parseRepoPath(file);
    if (baseNoExt.length === 0) return false;
    for (const candidate of testFiles) {
      if (!candidate.includes("__tests__/")) continue;
      const parsed = parseRepoPath(candidate);
      if (stripTestSuffix(parsed.baseNoExt) === baseNoExt) return true;
    }
    return false;
  };

  const importedByTest = (file: string): boolean => {
    if (!imports) return false;
    const incoming = imports.in.get(file) ?? [];
    for (const edge of incoming) {
      if (isTestFile(edge.from)) return true;
    }
    return false;
  };

  const rawFor = (repoPath: string): number => {
    if (isTestFile(repoPath)) return 0;
    if (!fileSet.has(repoPath)) return 1;
    if (importedByTest(repoPath)) return 0;
    if (siblingTestFor(repoPath) || tellsTestCoversBasename(repoPath)) {
      return 0.5;
    }
    return 1;
  };

  // Only files a language pack claims can meaningfully have a test gap.
  // A README having no unit test is a category error, not a risk — and
  // including docs/JSON/YAML in the population used to push every
  // markdown file into the top test_gap quartile, which then dominated
  // agent_risk. Restricting the population also keeps the quartile
  // boundaries meaningful for the code files that remain.
  const testable = (p: string): boolean =>
    !isTestFile(p) && langPack.claimingPack(p) !== undefined;

  const sourcePaths = repoPaths.filter(testable);
  const rawValues = sourcePaths.map((p) => rawFor(p));
  const quartiles = quartileScores(rawValues);
  const quartileByPath = new Map<string, number>();
  sourcePaths.forEach((p, i) => quartileByPath.set(p, quartiles[i]!));

  return {
    forFile(repoPath) {
      if (isTestFile(repoPath)) return 0;
      // Unclaimed by any language pack — no test gap signal exists.
      if (langPack.claimingPack(repoPath) === undefined) return 0;
      return quartileByPath.get(repoPath) ?? rawFor(repoPath);
    },
    rawForFile(repoPath) {
      return rawFor(repoPath);
    },
  };
}

function buildBlastRadiusIndex(args: {
  imports: ImportGraph | undefined;
}): BlastRadiusIndex {
  const countMemo = new Map<string, number>();
  const { imports } = args;

  const countFor = (repoPath: string): number => {
    if (!imports) return 0;
    const cached = countMemo.get(repoPath);
    if (cached !== undefined) return cached;
    const count = transitiveImporterCount(imports, repoPath);
    countMemo.set(repoPath, count);
    return count;
  };

  return {
    forFile(repoPath) {
      const count = countFor(repoPath);
      return Math.min(count / BLAST_RADIUS_CAP, 1);
    },
    countForFile(repoPath) {
      return countFor(repoPath);
    },
  };
}

function transitiveImporterCount(
  imports: ImportGraph,
  start: string,
): number {
  const visited = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const incoming = imports.in.get(current) ?? [];
    for (const edge of incoming) {
      if (visited.has(edge.from)) continue;
      visited.add(edge.from);
      stack.push(edge.from);
    }
  }
  return visited.size;
}

/**
 * Severity → numeric mapping shared with the human reporter's risk badges.
 * Matches the prior detector convention so the new unified formula does not
 * shift the ordering of existing findings.
 */
const SEVERITY_NUMERIC: Record<Severity, number> = {
  high: 0.9,
  medium: 0.7,
  low: 0.45,
};

/**
 * Fallback intrinsic agent-risk for the detectors that don't express one
 * of their own. Derived from severity because it is the only signal
 * available for those findings — deliberately compressed relative to
 * SEVERITY_NUMERIC so a fallback finding doesn't outrank a detector that
 * actually made a judgement.
 *
 * Detectors SHOULD set `scores.agent_risk` themselves. See
 * `docs/scoring.md`.
 */
const FALLBACK_INTRINSIC: Record<Severity, number> = {
  high: 0.75,
  medium: 0.55,
  low: 0.40,
};

/**
 * Compute `agent_risk` from the unified formula. Pure — no side effects.
 *
 *   agent_risk = 0.40 * intrinsic     (the detector's own judgement)
 *              + 0.20 * churn
 *              + 0.20 * test_gap
 *              + 0.20 * blast_radius
 *
 * `intrinsic` is the detector-supplied `scores.agent_risk` — the only
 * genuinely agent-specific input in the system. It is where "multiple
 * sources of truth", "misleading name", and "hidden side effect" are
 * encoded (PRD §10), and it scales with the evidence the detector found:
 * `concept_alias_drift` rises with the number of competing aliases,
 * `mixed_utc_local_methods` with the number of offenders.
 *
 * Severity and confidence are deliberately NOT terms. Before 0.12.2 they
 * carried 60% of the weight while the detector's own value was discarded
 * outright, which made `agent_risk` track severity at r=0.79 and
 * blast_radius at r=0.06 — collapsed into severity, exactly what the PRD
 * says must not happen. Severity remains a separate axis in ranking and
 * is still reported per finding; it just no longer dominates this score.
 */
export function computeAgentRisk(args: {
  severity: Severity;
  /** Detector-supplied intrinsic agent risk. Falls back to severity. */
  intrinsic?: number | undefined;
  churn: number;
  test_gap: number;
  blast_radius: number;
}): number {
  const intrinsic =
    typeof args.intrinsic === "number" && Number.isFinite(args.intrinsic)
      ? clamp01(args.intrinsic)
      : FALLBACK_INTRINSIC[args.severity];
  const raw =
    0.40 * intrinsic +
    0.20 * args.churn +
    0.20 * args.test_gap +
    0.20 * args.blast_radius;
  return round(clamp01(raw));
}

/**
 * Populate `churn` / `test_gap` / `blast_radius` on a finding from the
 * scoring context, then recompute `agent_risk` from the unified formula.
 *
 * Detectors set `severity`, `confidence`, and — for 30 of 48 — their own
 * `agent_risk`. That last value is now the heaviest input to the unified
 * formula rather than being discarded; see {@link computeAgentRisk}.
 * Detectors that don't set one fall back to a severity-derived default.
 *
 * When `scoring` is absent — typically in detector unit-test stubs — the
 * three context-derived fields are left unset and treated as 0, so a
 * finding's score reduces to `0.40 * intrinsic`.
 */
export function finaliseFindingScores(
  finding: Finding,
  scoring: ScoringContext | undefined,
): void {
  // Backfill detector-supplied effort + fix_shape from the per-type
  // defaults map. Detectors that set their own values keep them; only
  // missing or invalid values are replaced.
  const defaults = getDefaultsFor(finding.type);
  const currentEffort = (finding as Partial<Finding>).effort;
  if (
    currentEffort !== "quick" &&
    currentEffort !== "small" &&
    currentEffort !== "medium" &&
    currentEffort !== "large"
  ) {
    finding.effort = defaults.effort;
  }
  const currentShape = (finding as Partial<Finding>).fix_shape;
  if (
    typeof currentShape !== "string" ||
    currentShape.trim() === "" ||
    currentShape.includes("\n") ||
    currentShape.length > 120
  ) {
    finding.fix_shape = defaults.fix_shape;
  }

  let churn = 0;
  let test_gap = 0;
  let blast_radius = 0;
  if (scoring) {
    churn = round(scoring.churn.forFile(finding.file));
    test_gap = round(scoring.testGap.forFile(finding.file));
    blast_radius = round(scoring.blastRadius.forFile(finding.file));
    const recency = round(scoring.recency.forFile(finding.file));
    finding.scores.churn = churn;
    finding.scores.test_gap = test_gap;
    finding.scores.blast_radius = blast_radius;
    finding.scores.blast_radius_importers = scoring.blastRadius.countForFile(
      finding.file,
    );
    finding.scores.recency = recency;
  }
  // Read the detector's own judgement BEFORE overwriting the field.
  // 30 of 48 detectors set this; prior to 0.12.2 it was discarded.
  const intrinsic = finding.scores.agent_risk;
  finding.scores.agent_risk = computeAgentRisk({
    severity: finding.severity,
    intrinsic,
    churn,
    test_gap,
    blast_radius,
  });
}

/**
 * Return true when at least one of `churn`, `test_gap`, or `blast_radius`
 * on a finding is greater than 0.5. The human reporter uses this to
 * decide whether to show the "Risk profile" block alongside the finding.
 */
export function hasNotableScores(scores: FindingScores): boolean {
  return (
    (scores.churn ?? 0) > 0.5 ||
    (scores.test_gap ?? 0) > 0.5 ||
    (scores.blast_radius ?? 0) > 0.5
  );
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function toRepoPath(root: string, abs: string): string {
  const rel = abs.startsWith(root) ? relative(root, abs) : abs;
  return rel.split(sep).join("/");
}

function parseRepoPath(repoPath: string): { dir: string; baseNoExt: string } {
  const lastSlash = repoPath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? repoPath.slice(0, lastSlash) : "";
  const base = lastSlash >= 0 ? repoPath.slice(lastSlash + 1) : repoPath;
  const dot = base.indexOf(".");
  const baseNoExt = dot >= 0 ? base.slice(0, dot) : base;
  return { dir, baseNoExt };
}

function stripTestSuffix(base: string): string {
  return base.replace(/\.(test|spec)$/, "");
}
