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
import { TEST_DIR_RE, isTestFile, testBaseCovers } from "../util/test-files.js";
import { quartileScores } from "./quartile.js";
import {
  agentRiskClassOf,
  NEUTRAL_INTRINSIC,
  STRUCTURAL_CEILING,
} from "./agent-risk-class.js";

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
   * Returns [0,1] blast radius — normalised transitive-reach count for
   * the file (see {@link transitiveCountForFile}).
   */
  forFile(repoPath: string): number;
  /**
   * Size of the file's transitive importer closure (pre-normalisation) —
   * every in-repo file that reaches it through one or more import edges.
   * This is the integer `forFile` normalises.
   *
   * It is NOT a per-file fan-in measurement, and must never be rendered
   * as a bare "N importers". When the file participates in an import
   * cycle the walk returns to the start, so the file counts *itself*,
   * and every member of a strongly-connected component reports the same
   * value. On the zulip corpus that plateau put 866 findings on exactly
   * 798 and 825 on exactly 324; on hono six files all report 197 while
   * their direct fan-in ranges from 2 to 70.
   */
  transitiveCountForFile(repoPath: string): number;
  /**
   * Number of distinct in-repo files with a direct import edge to this
   * file — the honest "N files import this" number. Deduplicated across
   * multiple import statements from the same file, and excludes the file
   * itself. Does not feed the `blast_radius` score; it is a separate
   * signal reported alongside it.
   */
  directCountForFile(repoPath: string): number;
}

const RECENCY_FULL_DAYS = 7;
const RECENCY_DECAY_DAYS = 14;
const MS_PER_DAY = 86_400_000;

/**
 * Recency boost in [0,1] for a file's latest commit date.
 *
 * **Age is measured in whole UTC days, not in elapsed milliseconds.**
 * Without that, recency is a continuous function of wall-clock time: two
 * scans of an unchanged tree, seconds apart, produce slightly different
 * values, and any file whose true value sits near the report's 2-decimal
 * rounding boundary flips between them. That flip changes `rank_score`,
 * which changes the sort, which renumbers every `crime_NNNNN` id after
 * it — so `crimes explain <id>` from one scan pointed at a different
 * finding in the next. Measured on n8n `packages/cli`: two scans 93
 * seconds apart reordered four findings, and one file's `scores.recency`
 * moved 0.23 → 0.22.
 *
 * Both endpoints are floored to a UTC day, so the value changes only at
 * UTC midnight and changes for every file at the same moment. Flooring
 * the *difference* instead would give each file its own boundary at its
 * own commit-time-of-day, which shrinks the problem rather than removing
 * it: a scan pair straddling one file's boundary would still disagree.
 *
 * The remaining exposure is a scan pair that straddles UTC midnight.
 * That is a real limit, not a solved case — it is bounded and
 * predictable rather than continuous.
 */
export function recencyForDate(
  iso: string | undefined,
  nowMs: number = Date.now(),
): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  const days = Math.floor(nowMs / MS_PER_DAY) - Math.floor(t / MS_PER_DAY);
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
            limitedReason: "not a git repository or git is unavailable; churn is unknown",
          }
        : {}),
  };

  const latestByFile = new Map<string, string>();
  for (const c of churnResult.files) {
    latestByFile.set(c.file, c.latestChange);
  }
  // One clock reading for the whole scan. Per-call `Date.now()` would
  // let a scan that straddles a day boundary score its first files
  // differently from its last.
  const nowMs = Date.now();
  const recency: RecencyIndex = {
    forFile(repoPath) {
      return recencyForDate(latestByFile.get(repoPath), nowMs);
    },
    limited: !churnResult.gitAvailable,
    ...(churnResult.gitAvailable
      ? {}
      : {
          limitedReason: "not a git repository or git is unavailable; recency is unknown",
        }),
  };

  const repoPaths = options.files.map((abs) => toRepoPath(options.root, abs));
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
      if (parsed.dir === dir && testBaseCovers(parsed.baseNoExt, baseNoExt)) {
        return true;
      }
    }
    return false;
  };

  /**
   * A test living in a dedicated test directory rather than beside the
   * file it covers, matched on basename.
   *
   * `__tests__/` is the JS convention; `tests/` is the dominant Python
   * one (`tests/test_billing.py` covers `billing.py`) and is also common
   * in JS repos that keep tests out of `src/`. Both are recognised for
   * both languages — gating the directory name on the file's language
   * would put a "JS and Python disagree about what tests/ means"
   * conditional into core scoring, which is the kind of seam this
   * release exists to avoid.
   */
  const namedTestDirCoversBasename = (file: string): boolean => {
    const { baseNoExt } = parseRepoPath(file);
    if (baseNoExt.length === 0) return false;
    for (const candidate of testFiles) {
      if (!TEST_DIR_RE.test(candidate)) continue;
      const parsed = parseRepoPath(candidate);
      if (testBaseCovers(parsed.baseNoExt, baseNoExt)) return true;
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
    if (siblingTestFor(repoPath) || namedTestDirCoversBasename(repoPath)) {
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
  sourcePaths.forEach((p, i) => {
    quartileByPath.set(p, quartiles[i]!);
  });

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

/**
 * Blast radius on a log scale, bounded and comparable across repos.
 *
 * ## Three shapes, and why this is the third
 *
 * **Linear (`min(transitive / 50, 1)`)** saturated: 47% of zulip's
 * findings scored exactly 1.0, and hono had six files all reporting a
 * closure of 197 while their direct fan-in ranged from 2 to 70. A score
 * that is 1.0 for half a report ranks nothing.
 *
 * **Quartile-ranked** removed the top-end pinning but cost more than
 * the decision anticipated: hono went from 22 distinct values to 4, and
 * it could not separate a tied block larger than a quartile (54% of
 * hono findings at 0 became 53% at 0.25). It also gave up cross-repo
 * comparability.
 *
 * **Log-scaled** is what this is. `log1p(reach) / log1p(REFERENCE)`
 * bounds the top by construction while keeping every distinct count a
 * distinct score, and a fixed reference means two repos' numbers mean
 * the same thing again.
 *
 * ## The reference
 *
 * {@link BLAST_RADIUS_LOG_REFERENCE} is 2000 — roughly 30% above the
 * largest closure in the corpus (n8n `packages/cli`, 1527; hono peaks
 * at 244). Chosen so no real repository clamps and the top of the range
 * stays reachable rather than hypothetical. A repo larger than the
 * corpus clamps at 1.0, which is the correct behaviour for a bounded
 * score, not a regression to saturation.
 *
 * ## Direct fan-in: a bounded contributor, not a strict tiebreaker
 *
 * The plan was for direct fan-in to break exact ties in the closure.
 * Implemented literally that is invisible: at a closure of 197 the gap
 * to 198 is 0.0006, and `scores` are reported to two decimals, so
 * hono's six-file plateau would still read 0.70 six times — failing at
 * exactly the case the tiebreaker exists for.
 *
 * So direct fan-in carries a fixed 15% of the score instead. It cannot
 * dominate — a difference in closure of any size outweighs it — but it
 * does separate the members of a strongly-connected component, which is
 * the thing a reader needs. On hono's plateau: closure 197 with 2
 * direct importers scores 0.62, the same closure with 70 scores 0.71.
 *
 * The absolute integers remain available and unrounded as
 * `blast_radius_transitive_importers` and
 * `blast_radius_direct_importers`.
 */
function buildBlastRadiusIndex(args: {
  imports: ImportGraph | undefined;
}): BlastRadiusIndex {
  const transitiveMemo = new Map<string, number>();
  const directMemo = new Map<string, number>();
  const { imports } = args;

  const transitiveFor = (repoPath: string): number => {
    if (!imports) return 0;
    const cached = transitiveMemo.get(repoPath);
    if (cached !== undefined) return cached;
    const count = transitiveImporterCount(imports, repoPath);
    transitiveMemo.set(repoPath, count);
    return count;
  };

  const directFor = (repoPath: string): number => {
    if (!imports) return 0;
    const cached = directMemo.get(repoPath);
    if (cached !== undefined) return cached;
    const count = directImporterCount(imports, repoPath);
    directMemo.set(repoPath, count);
    return count;
  };

  return {
    forFile(repoPath) {
      if (!imports) return 0;
      return blastRadiusScore(transitiveFor(repoPath), directFor(repoPath));
    },
    transitiveCountForFile(repoPath) {
      return transitiveFor(repoPath);
    },
    directCountForFile(repoPath) {
      return directFor(repoPath);
    },
  };
}

/**
 * Closure size at which the reach term reaches 1.0. See
 * {@link buildBlastRadiusIndex} for how this number was chosen.
 */
const BLAST_RADIUS_LOG_REFERENCE = 2000;

/**
 * Direct fan-in at which the fan-in term reaches its 15% maximum. The
 * corpus peak is 216 (n8n `packages/cli`).
 */
const DIRECT_IMPORTERS_LOG_REFERENCE = 250;

/** Share of the score carried by direct fan-in. */
const DIRECT_WEIGHT = 0.15;

/**
 * Combine reach and fan-in into the reported `blast_radius`. Exported
 * for the unit tests, which pin the plateau-separation property.
 */
export function blastRadiusScore(transitive: number, direct: number): number {
  const reach = logNormalise(transitive, BLAST_RADIUS_LOG_REFERENCE);
  const fanIn = logNormalise(direct, DIRECT_IMPORTERS_LOG_REFERENCE);
  return round(clamp01((1 - DIRECT_WEIGHT) * reach + DIRECT_WEIGHT * fanIn));
}

function logNormalise(count: number, reference: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.log1p(count) / Math.log1p(reference), 1);
}

/**
 * Size of the transitive importer closure of `start`.
 *
 * Deliberately unchanged: this is the number `blast_radius` has always
 * normalised, and retuning the score is a calibration decision made
 * separately. Note that it counts `start` itself whenever `start` sits on
 * an import cycle — the walk reaches back round to it — so the result is
 * "files that can reach this one, plus this one if it is cyclic", not a
 * fan-in count. See {@link BlastRadiusIndex.transitiveCountForFile}.
 */
function transitiveImporterCount(imports: ImportGraph, start: string): number {
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
 * Distinct in-repo files with a direct import edge to `target`.
 *
 * `imports.in` holds one edge per import statement, so a file that
 * imports the same module twice (a value import plus an `import type`,
 * say) contributes two edges and must be counted once. A self-edge is
 * excluded: a module importing itself is not an importer of it in any
 * sense a reader would expect.
 */
function directImporterCount(imports: ImportGraph, target: string): number {
  const incoming = imports.in.get(target) ?? [];
  const sources = new Set<string>();
  for (const edge of incoming) {
    if (edge.from === target) continue;
    sources.add(edge.from);
  }
  return sources.size;
}

/**
 * Severity → numeric mapping shared with the human reporter's risk badges.
 * Matches the prior detector convention so the new unified formula does not
 * shift the ordering of existing findings.
 */
const _SEVERITY_NUMERIC: Record<Severity, number> = {
  high: 0.9,
  medium: 0.7,
  low: 0.45,
};

/**
 * Compute `agent_risk` from the unified formula. Pure — no side effects.
 *
 * Severity is not an input. Deriving the fallback intrinsic from it was
 * how `agent_risk` stayed correlated with severity for the ~18 detectors
 * that express no intrinsic of their own; a flat neutral value says what
 * is actually known about those findings, which is nothing.
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
  /**
   * Finding type (or pack-qualified detector id). Decides the
   * agent-risk class — see `scoring/agent-risk-class.ts`.
   */
  type: string | undefined;
  /** Detector-supplied intrinsic agent risk. */
  intrinsic?: number | undefined;
  churn: number;
  test_gap: number;
  blast_radius: number;
}): number {
  const intrinsic =
    typeof args.intrinsic === "number" && Number.isFinite(args.intrinsic)
      ? clamp01(args.intrinsic)
      : NEUTRAL_INTRINSIC;
  const raw =
    0.4 * intrinsic + 0.2 * args.churn + 0.2 * args.test_gap + 0.2 * args.blast_radius;
  const scored = round(clamp01(raw));

  const klass = agentRiskClassOf(args.type);
  if (klass === "structural") return Math.min(scored, STRUCTURAL_CEILING);
  return scored;
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
    finding.scores.blast_radius_transitive_importers =
      scoring.blastRadius.transitiveCountForFile(finding.file);
    finding.scores.blast_radius_direct_importers = scoring.blastRadius.directCountForFile(
      finding.file,
    );
    finding.scores.recency = recency;
  }
  // Read the detector's own judgement BEFORE overwriting the field.
  // 30 of 48 detectors set this; prior to 0.12.2 it was discarded.
  const intrinsic = finding.scores.agent_risk;
  finding.scores.agent_risk = computeAgentRisk({
    type: finding.detector_id ?? finding.type,
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
