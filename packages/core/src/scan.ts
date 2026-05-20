import { readFile, realpath } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { discoverFiles, parseFile } from "@crimes/language-js";
import type { BaselineEntry, FailOn } from "./baseline.js";
import {
  BASELINE_RELATIVE_PATH,
  BaselineNotFoundError,
  loadBaseline,
  severityAtLeast,
} from "./baseline.js";
import type { CrimesConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type { AssetDetector, Detector } from "./detector.js";
import {
  builtInAssetDetectors,
  builtInDetectors,
  buildDetectorRegistry,
  collectKnownIds,
  filterAssetDetectors,
  filterDetectors,
} from "./detector-registry.js";
import { runAssetDetectorsForRoot } from "./scan-assets.js";
import type { Finding, ScanReport, ScanSummary } from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";
import {
  getChangedFiles,
  NotAGitRepoError,
  UnknownGitRefError,
} from "./git/changed-files.js";
import { collectResurfaced } from "./resurface.js";
import { loadTriage, resolveTriagePath } from "./triage.js";
import { DEFAULT_ALIAS_GROUPS } from "./ia/aliases.js";
import { buildIaIndex } from "./ia/build.js";
import type { IaConceptAliasGroup, IaIndex } from "./ia/types.js";
import { buildImportGraph } from "./imports/build.js";
import type { ImportGraph } from "./imports/types.js";
import { buildJsxShapeIndex } from "./jsx/shape-index.js";
import type { JsxShapeIndex } from "./jsx/shape-index.js";
import { buildFunctionHashIndex } from "./ast-hash/function-index.js";
import type { FunctionHashIndex } from "./ast-hash/function-index.js";
import { buildPettyIndex } from "./petty/build.js";
import type { PettyIndex } from "./petty/types.js";
import {
  buildScoringContext,
  finaliseFindingScores,
} from "./scoring/build.js";
import type { ScoringContext } from "./scoring/build.js";
import type {
  ApplySuppressionsOptions,
  SuppressionEntry,
} from "./suppressions.js";
import { partitionFindings } from "./suppressions.js";
import type { TriageEntry } from "./triage.js";
import { applyTriageFilter, type ApplyTriageFilterOptions } from "./triage-filter.js";
import {
  assignIds as assignIdsHelper,
  tagTierAndSortByRankScore,
} from "./context-helpers.js";

export interface ScanOptions {
  /** Absolute or relative path to scan. Defaults to cwd. */
  root?: string;
  /** Override config explicitly. */
  config?: CrimesConfig;
  /** Override detectors. Defaults to all built-ins. */
  detectors?: Detector[];
  /**
   * Override asset detectors. Defaults to all built-ins. Pass `[]` to
   * skip the asset-file second pass entirely.
   */
  assetDetectors?: AssetDetector[];
  /**
   * Restrict the scan to files changed in the working tree (and, when
   * `base` is also set, between `<base>...HEAD`). Requires `root` to be
   * inside a Git repository.
   */
  changed?: boolean;
  /**
   * Optional Git ref to compare against, e.g. `"main"` or `"origin/main"`.
   * Only meaningful when `changed` is true.
   */
  base?: string;
  /**
   * When false, disables the recency multiplier on rank_score so findings
   * sort by agent_risk alone. Default true.
   */
  recencyEnabled?: boolean;
  /**
   * Internal flag — when true, the scan does NOT attempt to resurface
   * triaged/baselined findings on touched files. Used by the resurface
   * pipeline itself to make a single inner scan call without recursing.
   * Not meant for external callers.
   *
   * @internal
   */
  __skipResurface?: boolean;
}

export async function scan(options: ScanOptions = {}): Promise<ScanReport> {
  const root = resolve(options.root ?? process.cwd());
  const config =
    options.config ??
    loadConfig(
      root,
      buildDetectorRegistry(builtInDetectors, builtInAssetDetectors),
    );
  const allKnownIds = collectKnownIds(builtInDetectors, builtInAssetDetectors);
  const detectors =
    options.detectors ??
    filterDetectors(builtInDetectors, config, allKnownIds);
  const assetDetectors =
    options.assetDetectors ??
    filterAssetDetectors(builtInAssetDetectors, config, allKnownIds);
  const inputs = await resolveScanInputs({ root, config, options });
  const indexes = await buildScanIndexes({ root, config, allFiles: inputs.allFiles });
  const findings = await runDetectorsForFiles({
    root,
    files: inputs.files,
    detectors,
    config,
    indexes,
  });
  const assetFindings = await runAssetDetectorsForRoot({
    root,
    config,
    detectors: assetDetectors,
  });
  findings.push(...assetFindings);

  // Backfill the per-finding scoring fields (churn / test_gap /
  // blast_radius) and recompute `agent_risk` from the unified 0.6.0
  // formula. Done once after all detectors have emitted so the
  // signal-source code lives in one place, not 17. Asset files aren't
  // in the scoring context — those findings get 0 for every backfilled
  // signal, which is intentional and documented.
  for (const f of findings) {
    finaliseFindingScores(f, indexes.scoring);
  }

  tagTierAndSortByRankScore(findings, config, { recencyEnabled: options.recencyEnabled ?? true });
  assignIdsHelper(findings);

  const report: ScanReport = {
    schema_version: SCHEMA_VERSION,
    report_type: "scan",
    repo: {
      name: basename(root),
      root,
    },
    summary: summarise(findings),
    findings,
  };
  if (inputs.changedAll !== undefined) {
    report.changed_files = inputs.changedAll;
  }

  if (!options.__skipResurface) {
    const resurfaced = await collectResurfaceForScan({ root, config, options });
    if (resurfaced.length > 0) {
      const merged = [...resurfaced, ...report.findings];
      const next: ScanReport = {
        ...report,
        findings: merged,
        summary: summarise(merged),
      };
      return next;
    }
  }
  return report;
}

/**
 * Resurface stage: re-run detectors on files in the diff against
 * `config.triage.resurfaceBase`, then keep only the findings whose
 * fingerprint matches a triage or baseline entry. Returns the annotated
 * resurfaced list. Empty when git is unavailable, the diff is empty, or
 * there's nothing to resurface — resurfacing is a quality-of-life feature
 * and must never make `scan()` fail.
 */
async function collectResurfaceForScan(args: {
  root: string;
  config: CrimesConfig;
  options: ScanOptions;
}): Promise<Finding[]> {
  const resurfaceBase = args.config.triage?.resurfaceBase ?? "main";
  if (resurfaceBase === "") return [];

  // Compute diff files. Any git failure (no repo, unknown ref) short-
  // circuits to "no resurfacing this run" — resurfacing is a quality-
  // of-life feature, never a fatal error.
  let diffPaths: string[];
  try {
    diffPaths = await getChangedFiles({ root: args.root, base: resurfaceBase });
  } catch (err) {
    if (err instanceof NotAGitRepoError || err instanceof UnknownGitRefError) {
      return [];
    }
    throw err;
  }
  if (diffPaths.length === 0) return [];

  // Convert absolute paths to repo-relative POSIX (matching Finding.file shape).
  // git emits canonical paths (`/private/var/...` on macOS); `args.root` may
  // still be the `/var/...` symlink the caller passed. realpath both sides
  // so the relative path comes out as `src/foo.ts`, not `../../private/var/.../src/foo.ts`.
  const rootReal = await safeRealpath(args.root);
  const diffFiles = new Set<string>(
    await Promise.all(
      diffPaths.map(async (abs) =>
        relative(rootReal, await safeRealpath(abs)).split(sep).join("/"),
      ),
    ),
  );

  // Load triage + baseline. Both files are optional — empty when absent.
  const [triageResult, baselineEntries] = await Promise.all([
    loadTriage(resolveTriagePath(args.root)),
    loadBaselineEntriesIfPresent(args.root),
  ]);

  if (triageResult.entries.length === 0 && baselineEntries.length === 0) {
    return [];
  }

  // Run one inner scan against the diff'd files (with __skipResurface to
  // avoid recursion). Then index findings by file and use that to
  // satisfy the reDetect callback. One scan instead of N — cheap.
  const innerReport = await scan({
    root: args.root,
    config: args.config,
    changed: true,
    base: resurfaceBase,
    __skipResurface: true,
  });
  const findingsByFile = new Map<string, Finding[]>();
  for (const f of innerReport.findings) {
    const list = findingsByFile.get(f.file);
    if (list) list.push(f);
    else findingsByFile.set(f.file, [f]);
  }
  const reDetect = async (file: string): Promise<Finding[]> =>
    findingsByFile.get(file) ?? [];

  return collectResurfaced({
    diffFiles,
    triageEntries: triageResult.entries,
    baselineEntries,
    reDetect,
  });
}

async function loadBaselineEntriesIfPresent(
  root: string,
): Promise<BaselineEntry[]> {
  try {
    const baseline = await loadBaseline(resolve(root, BASELINE_RELATIVE_PATH));
    return baseline.findings;
  } catch (err) {
    if (err instanceof BaselineNotFoundError) return [];
    throw err;
  }
}

interface ScanInputs {
  allFiles: string[];
  files: string[];
  changedAll?: string[];
}

async function resolveScanInputs(args: {
  root: string;
  config: CrimesConfig;
  options: ScanOptions;
}): Promise<ScanInputs> {
  const allFiles = await discoverFiles({
    root: args.root,
    include: args.config.include,
    exclude: args.config.exclude,
  });
  if (!args.options.changed) return { allFiles, files: allFiles };

  const restricted = await restrictToChanged({
    root: args.root,
    allFiles,
    base: args.options.base,
  });
  return {
    allFiles,
    files: restricted.scanFiles,
    changedAll: restricted.allChangedRepoPaths,
  };
}

interface ScanIndexes {
  ia?: IaIndex;
  petty?: PettyIndex;
  imports?: ImportGraph;
  jsxShapeIndex?: JsxShapeIndex;
  functionHashIndex?: FunctionHashIndex;
  scoring?: ScoringContext;
}

async function buildScanIndexes(args: {
  root: string;
  config: CrimesConfig;
  allFiles: string[];
}): Promise<ScanIndexes> {
  const { root, config, allFiles } = args;
  // Cross-file indexes always use the full discovered file set. `--changed`
  // gates finding emission, not the context detectors and scoring inspect.
  const ia = await safelyBuildIaIndex({
    root,
    allFiles,
    aliasGroups: resolveAliasGroups(config),
  });
  const petty = await safelyBuildPettyIndex({ root, allFiles });
  const imports = await safelyBuildImportGraph({ root, allFiles });
  const jsxShapeIndex = await safelyBuildJsxShapeIndex({ root, allFiles });
  const functionHashIndex = await safelyBuildFunctionHashIndex({ root, allFiles });
  const scoring = await safelyBuildScoringContext({ root, allFiles, imports });

  return { ia, petty, imports, jsxShapeIndex, functionHashIndex, scoring };
}

async function runDetectorsForFiles(args: {
  root: string;
  files: string[];
  detectors: Detector[];
  config: CrimesConfig;
  indexes: ScanIndexes;
}): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const absolutePath of args.files) {
    findings.push(...(await runDetectorsForFile({ ...args, absolutePath })));
  }
  return findings;
}

async function runDetectorsForFile(args: {
  root: string;
  absolutePath: string;
  detectors: Detector[];
  config: CrimesConfig;
  indexes: ScanIndexes;
}): Promise<Finding[]> {
  const file = toRepoPath(relative(args.root, args.absolutePath));
  const source = await readFile(args.absolutePath, "utf8");
  const parsed = parseFile({ absolutePath: args.absolutePath, source });
  const findings: Finding[] = [];

  for (const detector of args.detectors) {
    findings.push(
      ...(await detector.run({
        file,
        absolutePath: args.absolutePath,
        source,
        parsed,
        config: args.config,
        ...args.indexes,
      })),
    );
  }
  return findings;
}

/**
 * Filter a {@link ScanReport} through the suppressions list. Returns a
 * new report with `findings` partitioned, `summary` recomputed, and an
 * optional `suppressed_count` set when ≥1 entry matched. Pure — does not
 * mutate the input.
 */
export function applySuppressionsToScan(
  report: ScanReport,
  suppressions: SuppressionEntry[],
  options: ApplySuppressionsOptions,
): ScanReport {
  const { visible, suppressedCount } = partitionFindings(
    report.findings,
    suppressions,
    options,
  );
  const next: ScanReport = {
    ...report,
    summary: summariseVisible(visible),
    findings: visible,
  };
  if (suppressedCount > 0) next.suppressed_count = suppressedCount;
  return next;
}

/**
 * Filter a {@link ScanReport} through the triage list. Mirrors
 * {@link applySuppressionsToScan}: returns a new report with `findings`
 * partitioned, `summary` recomputed, and `triage_hidden_count` set when
 * ≥1 silencing entry matched. Pure — does not mutate the input.
 *
 * Apply this **before** suppressions in the CLI pipeline so the renderer
 * can distinguish "user triaged this" (`Finding.triaged` /
 * `Finding.hidden_triage`) from "suppression hit".
 */
export function applyTriageToScan(
  report: ScanReport,
  triage: TriageEntry[],
  options: ApplyTriageFilterOptions,
): ScanReport {
  const { findings, hiddenCount } = applyTriageFilter(
    report.findings,
    triage,
    options,
  );
  const next: ScanReport = {
    ...report,
    summary: summariseVisible(findings),
    findings,
  };
  if (hiddenCount > 0) next.triage_hidden_count = hiddenCount;
  return next;
}

function summariseVisible(findings: Finding[]): ScanSummary {
  const summary: ScanSummary = { total: findings.length, high: 0, medium: 0, low: 0 };
  for (const f of findings) summary[f.severity] += 1;
  return summary;
}

async function safelyBuildPettyIndex(args: {
  root: string;
  allFiles: string[];
}): Promise<PettyIndex | undefined> {
  try {
    return await buildPettyIndex({ root: args.root, files: args.allFiles });
  } catch {
    return undefined;
  }
}

async function safelyBuildImportGraph(args: {
  root: string;
  allFiles: string[];
}): Promise<ImportGraph | undefined> {
  try {
    return await buildImportGraph({ root: args.root, files: args.allFiles });
  } catch {
    return undefined;
  }
}

async function safelyBuildJsxShapeIndex(args: {
  root: string;
  allFiles: string[];
}): Promise<JsxShapeIndex | undefined> {
  try {
    return await buildJsxShapeIndex({ root: args.root, files: args.allFiles });
  } catch {
    return undefined;
  }
}

async function safelyBuildFunctionHashIndex(args: {
  root: string;
  allFiles: string[];
}): Promise<FunctionHashIndex | undefined> {
  try {
    return await buildFunctionHashIndex({ root: args.root, files: args.allFiles });
  } catch {
    return undefined;
  }
}

async function safelyBuildScoringContext(args: {
  root: string;
  allFiles: string[];
  imports: ImportGraph | undefined;
}): Promise<ScoringContext | undefined> {
  try {
    return await buildScoringContext({
      root: args.root,
      files: args.allFiles,
      imports: args.imports,
    });
  } catch {
    return undefined;
  }
}

function toRepoPath(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Build the IA index, but never let a failure here break the scan.
 * Returns `undefined` on any error -- detectors that need the index
 * (IA detectors) should treat absence as "skip this finding kind", not
 * as a fatal condition.
 */
async function safelyBuildIaIndex(args: {
  root: string;
  allFiles: string[];
  aliasGroups?: IaConceptAliasGroup[];
}): Promise<IaIndex | undefined> {
  try {
    return await buildIaIndex({
      root: args.root,
      files: args.allFiles,
      ...(args.aliasGroups !== undefined
        ? { aliasGroups: args.aliasGroups }
        : {}),
    });
  } catch {
    return undefined;
  }
}

/**
 * Resolve the alias-group catalogue used to build the IA index.
 *
 * Config groups are **additive** to the built-in defaults: an entry that
 * shares an `id` with a default group is appended verbatim (the
 * concept_alias_drift detector dedupes hits per group, so duplicates are
 * harmless). A future `ia.aliasGroupsReplace: true` opt-in could swap
 * "additive" for "replace".
 */
export function resolveAliasGroups(
  config: CrimesConfig,
): IaConceptAliasGroup[] {
  const overrides = config.ia?.aliasGroups ?? [];
  if (overrides.length === 0) return DEFAULT_ALIAS_GROUPS;
  return [...DEFAULT_ALIAS_GROUPS, ...overrides];
}

interface RestrictToChangedResult {
  /**
   * Absolute paths that the detectors should actually process —
   * intersection of `allFiles` (discoverable source files) with the set
   * of files git reports as changed. Realpath-normalised on both sides
   * so macOS `/var` vs `/private/var` lines up.
   */
  scanFiles: string[];
  /**
   * Every changed file git returned, normalised to repo-relative POSIX
   * paths and sorted. Includes files that aren't in the discoverable
   * source set (markdown, JSON, lockfiles, etc.) — surfaced verbatim in
   * `ScanReport.changed_files` so an agent can confirm what it touched
   * even when the diff is clean.
   */
  allChangedRepoPaths: string[];
}

async function restrictToChanged(args: {
  root: string;
  allFiles: string[];
  base?: string;
}): Promise<RestrictToChangedResult> {
  const { root, allFiles, base } = args;
  const changedAbs = await getChangedFiles({ root, base });

  // `git rev-parse --show-toplevel` returns the canonicalised repo path
  // (e.g. /private/var/folders/... on macOS). `discoverFiles` returns
  // whatever path was passed in, which may still be the /var/... symlink.
  // Compare on realpaths so the intersection works.
  const changedReal = new Set<string>();
  for (const abs of changedAbs) {
    changedReal.add(await safeRealpath(abs));
  }

  const scanFiles: string[] = [];
  for (const abs of allFiles) {
    if (changedReal.has(await safeRealpath(abs))) scanFiles.push(abs);
  }

  // Repo-relative POSIX list of every change git reported — even files
  // outside the discoverable source set. This is the `changed_files`
  // ScanReport field; sort + dedupe so the output is deterministic.
  const rootReal = await safeRealpath(root);
  const seenRepoPaths = new Set<string>();
  for (const abs of changedAbs) {
    const real = await safeRealpath(abs);
    const rel = toRepoPath(relative(rootReal, real));
    if (rel.length === 0) continue;
    seenRepoPaths.add(rel);
  }
  const allChangedRepoPaths = [...seenRepoPaths].sort();

  return { scanFiles, allChangedRepoPaths };
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}


function summarise(findings: Finding[]): ScanSummary {
  const summary: ScanSummary = { total: findings.length, high: 0, medium: 0, low: 0 };
  for (const f of findings) summary[f.severity] += 1;
  return summary;
}

/**
 * Annotate a {@link ScanReport} with the CI gate decision for
 * `crimes scan --changed --fail-on`. Returns a new report carrying the
 * threshold (`fail_on`) and a boolean (`failed`) that flips to `true` when
 * at least one finding meets or exceeds the threshold.
 *
 * Pure — does not mutate the input. Reuses {@link severityAtLeast} so the
 * threshold semantics match `crimes baseline check`.
 */
export interface ApplyScanFailOnOptions {
  /**
   * When true, `needs-design` triage entries (visible via
   * `--show-triaged`) participate in the gate. Off by default —
   * silenced triage entries normally never trip the gate.
   */
  gateNeedsDesign?: boolean;
  /**
   * When true, resurfaced findings (`previously_triaged` /
   * `previously_baselined`) participate in the gate. Off by default —
   * resurface surfaces a reminder, not a block.
   */
  gateResurfaced?: boolean;
}

export function applyScanFailOn(
  report: ScanReport,
  failOn: FailOn,
  options: ApplyScanFailOnOptions = {},
): ScanReport {
  // Suppressed findings (only present when --show-suppressed was set)
  // never trip the gate — gate semantics are independent of display.
  // hidden_triage findings (only present when --show-triaged was set)
  // are similarly excluded unless --gate-needs-design opts in.
  const failed = report.findings.some((f) => {
    if (f.suppressed === true) return false;
    if (
      (f.previously_triaged === true || f.previously_baselined === true) &&
      !options.gateResurfaced
    ) {
      return false;
    }
    if (f.hidden_triage !== undefined) {
      if (
        f.hidden_triage.disposition === "needs-design" &&
        options.gateNeedsDesign
      ) {
        // fall through to severity check
      } else {
        return false;
      }
    }
    return severityAtLeast(f.severity, failOn);
  });
  return { ...report, fail_on: failOn, failed };
}
