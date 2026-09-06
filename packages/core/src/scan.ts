import { profileAsync } from "./profile.js";
import type { AnalysisInputs } from "./analysis-inputs.js";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { discoverFiles } from "./discovery/index.js";
import type { ToolingSkip } from "./manifest/tooling-excludes.js";
import { applyRepoToolingExcludes } from "./scan-tooling-excludes.js";
import type { FailOn } from "./baseline.js";
import { severityAtLeast } from "./baseline.js";
import type { CrimesConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type { AssetDetector, Detector } from "./detector.js";
import {
  builtInAssetDetectors,
  builtInDetectors,
  buildDetectorRegistry,
  applyClaimDisable,
  collectKnownIds,
  filterAssetDetectors,
  filterDetectors,
} from "./detector-registry.js";
import { resolveLanguagePackRouter } from "./discovery/language-pack-router.js";
import { buildCoverage } from "./discovery/coverage.js";
import {
  CoverageWarningLog,
  mergeCoverageWarnings,
} from "./discovery/coverage-warnings.js";
import { isNeverReportable } from "./util/scope-class.js";
import { generatedMatcherFor } from "./manifest/gitattributes.js";
import { collectDiscoveryWarnings } from "./discovery/undiscovered.js";
import { discoverAssetFiles, runAssetDetectorsForRoot } from "./scan-assets.js";
import type { Finding, ScanReport, ScanSummary, WorkingSet } from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";
import { getChangedFiles } from "./git/changed-files.js";
// resolveAliasGroups now lives with the alias catalogue it merges into.
// Still imported here (buildScanIndexes uses it) and re-exported
// because it is part of the public @crimes/core API surface and
// context.ts imports it from this module.
import { resolveAliasGroups } from "./ia/aliases.js";
import type { ImportGraph } from "./imports/types.js";
export { resolveAliasGroups };
import { finaliseFindingScores } from "./scoring/build.js";
import type { ApplySuppressionsOptions, SuppressionEntry } from "./suppressions.js";
import { partitionFindings } from "./suppressions.js";
import type { TriageEntry } from "./triage.js";
import { applyTriageFilter, type ApplyTriageFilterOptions } from "./triage-filter.js";
import {
  classifyUnmatchedPins,
  type PinLike,
  type ScannedFiles,
  type UnmatchedPin,
} from "./pins-unmatched.js";
import {
  assignIdsAndFingerprints as assignIdsHelper,
  tagTierAndSortByRankScore,
} from "./context-helpers.js";
import { safeRealpath } from "./util/realpath.js";
import { buildScanIndexes, runDetectorsForFiles, toRepoPath } from "./scan-detect.js";
import { collectResurfaceForScan } from "./scan-resurface.js";

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
   * Restrict the scan to an explicit working set. Paths may be
   * repo-relative or absolute. Narrows which files emit findings; the
   * cross-file indexes are still built from the whole repo.
   *
   * This is the selector `--changed` cannot serve: an agent scoping a
   * change it has not made yet is sitting on a clean tree, so
   * `--changed --base main` returns nothing.
   */
  files?: string[];
  /**
   * Restrict the scan to these files plus their import-graph neighbours,
   * in both directions — what they import and what imports them.
   *
   * Symmetric on purpose. "What should I look at before changing this"
   * has two halves: the files it depends on can break it, and the files
   * that depend on it are what it can break.
   */
  relatedTo?: string[];
  /** Import-graph hops `relatedTo` walks. Default 1. */
  relatedDepth?: number;
  /**
   * When false, disables the recency multiplier on rank_score so findings
   * sort by agent_risk alone. Default true.
   */
  recencyEnabled?: boolean;
}

/** Analysis is shared by scan and context; report filtering never rebuilds indexes. */
export interface RepositoryAnalysis {
  report: ScanReport;
  allFiles: string[];
  assetFiles: string[];
  indexes: import("./scan-detect.js").ScanIndexes;
  config: CrimesConfig;
  detectors: Detector[];
}

export async function scan(options: ScanOptions = {}): Promise<ScanReport> {
  const analysis = await analyseRepository(options);
  const { report, config, allFiles, indexes, detectors } = analysis;
  const resurfaced = await collectResurfaceForScan({
    root: report.repo.root,
    config,
    allFiles,
    indexes,
    detectors,
  });
  if (resurfaced.length === 0) return report;
  const findings = [...resurfaced, ...report.findings];
  assignIdsHelper(findings);
  return { ...report, findings, summary: summarise(findings) };
}

/** Internal shared entry point. Context selects its target from the complete corpus. */
export async function analyseRepository(
  options: ScanOptions = {},
  inputsForAnalysis?: AnalysisInputs,
): Promise<RepositoryAnalysis> {
  const root = resolve(options.root ?? process.cwd());
  const config =
    options.config ??
    loadConfig(root, buildDetectorRegistry(builtInDetectors, builtInAssetDetectors));
  const knownIds = collectKnownIds(builtInDetectors, builtInAssetDetectors);
  const detectors =
    options.detectors ?? filterDetectors(builtInDetectors, config, knownIds);
  const assetDetectors =
    options.assetDetectors ??
    filterAssetDetectors(builtInAssetDetectors, config, knownIds);
  const inputs = await profileAsync("discovery.source", () =>
    resolveScanInputs({ root, config, options }),
  );
  const assetFiles =
    assetDetectors.length > 0
      ? await profileAsync("discovery.assets", () => discoverAssetFiles(root, config))
      : [];
  const warnings = await profileAsync("discovery.warnings", () =>
    discoveryWarnings(root, config, inputs, assetFiles),
  );
  const indexes = await buildScanIndexes({
    inputs: inputsForAnalysis,
    root,
    config,
    allFiles: inputs.allFiles,
    warnings,
  });
  const workingSet = await resolveWorkingSet({
    root,
    allFiles: inputs.allFiles,
    options,
    imports: indexes.imports,
    warnings,
  });
  const langPack = resolveLanguagePackRouter();
  const findings = await profileAsync("detectors.files", () =>
    runDetectorsForFiles({
      root,
      files: inputs.allFiles,
      detectors,
      config,
      indexes,
      langPack,
    }),
  );
  findings.push(
    ...(await profileAsync("detectors.assets", () =>
      runAssetDetectorsForRoot({ root, config, detectors: assetDetectors }),
    )),
  );
  // Run against the complete corpus even for a working set: cross-language
  // and anchored repo findings must see both sides before selecting results.
  const selected =
    workingSet?.repoPaths ??
    (inputs.changedAll === undefined ? undefined : new Set(inputs.changedAll));
  const declaredGenerated = generatedMatcherFor(root);
  const reportable = applyClaimDisable(
    findings.filter(
      (f) =>
        (selected === undefined || selected.has(f.file)) &&
        !isNeverReportable(f.file) &&
        !declaredGenerated(f.file),
    ),
    config,
  );
  for (const finding of reportable) finaliseFindingScores(finding, indexes.scoring);
  tagTierAndSortByRankScore(reportable, config, {
    recencyEnabled: options.recencyEnabled ?? true,
  });
  assignIdsHelper(reportable);
  const report: ScanReport = {
    schema_version: SCHEMA_VERSION,
    report_type: "scan",
    ranking: { recency_enabled: options.recencyEnabled ?? true },
    repo: { name: basename(root), root },
    summary: summarise(reportable),
    findings: reportable,
    coverage: buildCoverage({
      files: inputs.allFiles,
      router: langPack,
      root,
      warnings: warnings.build(),
    }),
  };
  if (report.coverage) {
    const enabled = new Set([...detectors, ...assetDetectors].map((d) => d.id));
    report.coverage.detectors_default_off = [
      ...builtInDetectors,
      ...builtInAssetDetectors,
    ]
      .filter((d) => d.defaultOff && !enabled.has(d.id))
      .map((d) => d.id)
      .sort();
  }
  if (inputs.changedAll !== undefined) report.changed_files = inputs.changedAll;
  if (workingSet) report.working_set = workingSet.summary;
  return { report, allFiles: inputs.allFiles, assetFiles, indexes, config, detectors };
}

async function discoveryWarnings(
  root: string,
  config: CrimesConfig,
  inputs: ScanInputs,
  assetFiles: string[],
): Promise<CoverageWarningLog> {
  const warnings = new CoverageWarningLog();
  for (const skip of inputs.toolingSkips ?? []) {
    warnings.record("files_excluded_by_tooling", skip.pattern, { file: skip.file });
  }
  await collectDiscoveryWarnings({
    root,
    include: config.include,
    exclude: config.exclude,
    discovered: inputs.allFiles,
    alsoAnalysed: assetFiles,
    alreadyExplained: (inputs.toolingSkips ?? []).map((s) => s.file),
    into: warnings,
  });
  return warnings;
}

interface ScanInputs {
  allFiles: string[];
  files: string[];
  changedAll?: string[];
  /**
   * Files the repository's own tooling excludes. Carried out of
   * discovery rather than recorded there because the warning log is
   * created after `resolveScanInputs` runs; every one of these is
   * reported under `coverage.warnings[]`.
   */
  toolingSkips?: ToolingSkip[];
}

interface ResolvedWorkingSet {
  /** Absolute paths, in `allFiles` order, that detectors should process. */
  absoluteFiles: string[];
  /** The same set as repo-relative POSIX paths, for filtering asset findings. */
  repoPaths: Set<string>;
  /** What lands on `ScanReport.working_set`. */
  summary: WorkingSet;
}

/**
 * Turn `files` / `relatedTo` into the set of files that may emit
 * findings.
 *
 * Returns `undefined` when the caller named neither, which is the whole
 * -repo case and must stay byte-identical to a scan that never knew this
 * function existed.
 *
 * `relatedTo` walks the import graph in **both** directions: a file's
 * imports can break it, and its importers are what it can break. The
 * walk is breadth-first with a visited set, so a cycle terminates —
 * unlike `transitiveImporterCount`, which deliberately does not
 * cycle-break because it feeds a different question.
 */
async function resolveWorkingSet(args: {
  root: string;
  allFiles: string[];
  options: ScanOptions;
  imports: ImportGraph | undefined;
  warnings: CoverageWarningLog;
}): Promise<ResolvedWorkingSet | undefined> {
  const { root, allFiles, options, imports, warnings } = args;
  const named = options.relatedTo ?? options.files;
  if (named === undefined || named.length === 0) return undefined;
  const selector = options.relatedTo !== undefined ? "related-to" : "files";

  // Map every discovered file to its repo-relative form once, so the
  // caller's paths — absolute or relative, either separator — resolve
  // against the same strings the report uses.
  const rootReal = await safeRealpath(root);
  const byRepoPath = new Map<string, string>();
  for (const abs of allFiles) {
    byRepoPath.set(toRepoPath(relative(rootReal, await safeRealpath(abs))), abs);
  }

  const seeds: string[] = [];
  for (const raw of named) {
    const abs = isAbsolute(raw) ? raw : resolve(root, raw);
    const rel = toRepoPath(relative(rootReal, await safeRealpath(abs)));
    if (!byRepoPath.has(rel)) {
      // Loudly, not silently. A typo'd path that narrows the scan to
      // nothing produces a report that reads "clean".
      warnings.record("working_set_path_unmatched", raw, { file: rel });
      continue;
    }
    seeds.push(rel);
  }

  const selected =
    selector === "related-to"
      ? expandThroughImports(seeds, imports, options.relatedDepth ?? 1)
      : new Set(seeds);

  const absoluteFiles = [...byRepoPath]
    .filter(([rel]) => selected.has(rel))
    .map(([, abs]) => abs);

  const summary: WorkingSet = {
    selector,
    seeds: [...seeds].sort(),
    files: [...selected].sort(),
  };
  if (selector === "related-to") summary.depth = options.relatedDepth ?? 1;

  return { absoluteFiles, repoPaths: selected, summary };
}

/**
 * Breadth-first walk out from `seeds` over both in- and out-edges.
 *
 * With no import graph — the index failed to build, and
 * `coverage.warnings` already says so — this degrades to the seeds
 * themselves rather than to the whole repo. Silently widening a scan
 * the user asked to narrow would be the worse failure.
 */
function expandThroughImports(
  seeds: string[],
  imports: ImportGraph | undefined,
  depth: number,
): Set<string> {
  const selected = new Set(seeds);
  if (!imports || depth < 1) return selected;
  let frontier = [...seeds];
  for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const edge of imports.out.get(file) ?? []) {
        if (edge.to.length > 0 && !selected.has(edge.to)) {
          selected.add(edge.to);
          next.push(edge.to);
        }
      }
      for (const edge of imports.in.get(file) ?? []) {
        if (!selected.has(edge.from)) {
          selected.add(edge.from);
          next.push(edge.from);
        }
      }
    }
    frontier = next;
  }
  return selected;
}

async function resolveScanInputs(args: {
  root: string;
  config: CrimesConfig;
  options: ScanOptions;
}): Promise<ScanInputs> {
  const discovered = await discoverFiles({
    root: args.root,
    include: args.config.include,
    exclude: args.config.exclude,
  });
  const { allFiles, toolingSkips } = applyRepoToolingExcludes(
    args.root,
    discovered,
    args.config,
  );
  if (!args.options.changed) return { allFiles, files: allFiles, toolingSkips };

  const restricted = await restrictToChanged({
    root: args.root,
    allFiles,
    base: args.options.base,
  });
  return {
    allFiles,
    files: restricted.scanFiles,
    changedAll: restricted.allChangedRepoPaths,
    toolingSkips,
  };
}

/**
 * Record which `.crimes/triage.json` and `.crimes/suppressions.json`
 * entries matched **nothing** in this scan, as `coverage.warnings[]`.
 *
 * Run this **before** {@link applyTriageToScan} and
 * {@link applySuppressionsToScan}, on the untouched findings list. Both
 * of those remove findings, and a finding one of them removed looks
 * exactly like an entry that stopped matching — classify after them and
 * every silenced finding reports itself as a lapsed pin.
 *
 * Nothing here changes `findings`, `summary` or any score. The only
 * output is a warning, because the bug is that a no-op was silent, not
 * that the wrong findings were reported.
 *
 * A narrowed scan (`--changed`, `--files`, `--related-to`) judges only
 * entries whose file it actually looked at — see {@link ScannedFiles}.
 * Pure — does not mutate the input.
 */
export function recordUnmatchedPins(
  report: ScanReport,
  pins: { triage?: readonly PinLike[]; suppressions?: readonly PinLike[] },
): ScanReport {
  // No coverage block means zero discovered files; there is no scan for
  // an entry to have matched, so there is nothing to report about one.
  if (report.coverage === undefined) return report;

  const triage = pins.triage ?? [];
  const suppressions = pins.suppressions ?? [];
  if (triage.length === 0 && suppressions.length === 0) return report;

  const scanned = scannedFilesOf(report);
  const log = new CoverageWarningLog();
  recordPinGroup(
    log,
    "triage_entries_unmatched",
    classifyUnmatchedPins(report.findings, triage, scanned),
  );
  recordPinGroup(
    log,
    "suppression_entries_unmatched",
    classifyUnmatchedPins(report.findings, suppressions, scanned),
  );
  if (log.isEmpty()) return report;

  return {
    ...report,
    coverage: {
      ...report.coverage,
      warnings: mergeCoverageWarnings(report.coverage.warnings, log.build()),
    },
  };
}

/**
 * The files this scan looked at, or `undefined` when it looked at all of
 * them. `changed_files` and `working_set` are the two ways a report says
 * it is narrower than the repo.
 */
function scannedFilesOf(report: ScanReport): ScannedFiles {
  if (report.working_set !== undefined) return new Set(report.working_set.files);
  if (report.changed_files !== undefined) return new Set(report.changed_files);
  return undefined;
}

/**
 * One bucket per subject, counting entries and distinct files
 * separately: several pins routinely name one file, and `files` is
 * contracted to be a file count.
 */
function recordPinGroup(
  log: CoverageWarningLog,
  kind: "triage_entries_unmatched" | "suppression_entries_unmatched",
  result: { superseded: UnmatchedPin[]; noLongerReported: UnmatchedPin[] },
): void {
  recordPinBucket(log, kind, "superseded", result.superseded);
  recordPinBucket(log, kind, "no_longer_reported", result.noLongerReported);
}

function recordPinBucket(
  log: CoverageWarningLog,
  kind: "triage_entries_unmatched" | "suppression_entries_unmatched",
  subject: string,
  pins: readonly UnmatchedPin[],
): void {
  if (pins.length === 0) return;
  log.record(kind, subject, { entries: pins.length });
  // Sorted before recording so `examples` is the first five files in
  // path order rather than the first five in entry order.
  const files = [...new Set(pins.map((pin) => pin.file))].filter((f) => f !== "").sort();
  for (const file of files) log.record(kind, subject, { file });
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
  const { findings, hiddenCount } = applyTriageFilter(report.findings, triage, options);
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

/**
 * Build the IA index, but never let a failure here break the scan.
 * Returns `undefined` on any error -- detectors that need the index
 * (IA detectors) should treat absence as "skip this finding kind", not
 * as a fatal condition.
 */

/**
 * Resolve the alias-group catalogue used to build the IA index.
 *
 * Config groups are **additive** to the built-in defaults: an entry that
 * shares an `id` with a default group is appended verbatim (the
 * concept_alias_drift detector dedupes hits per group, so duplicates are
 * harmless). A future `ia.aliasGroupsReplace: true` opt-in could swap
 * "additive" for "replace".
 */

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
      if (f.hidden_triage.disposition === "needs-design" && options.gateNeedsDesign) {
        // fall through to severity check
      } else {
        return false;
      }
    }
    return severityAtLeast(f.severity, failOn);
  });
  return { ...report, fail_on: failOn, failed };
}
