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
  collectKnownIds,
  filterAssetDetectors,
  filterDetectors,
} from "./detector-registry.js";
import { resolveLanguagePackRouter } from "./discovery/language-pack-router.js";
import { buildCoverage } from "./discovery/coverage.js";
import { CoverageWarningLog } from "./discovery/coverage-warnings.js";
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

export async function scan(options: ScanOptions = {}): Promise<ScanReport> {
  const root = resolve(options.root ?? process.cwd());
  const config =
    options.config ??
    loadConfig(root, buildDetectorRegistry(builtInDetectors, builtInAssetDetectors));
  const allKnownIds = collectKnownIds(builtInDetectors, builtInAssetDetectors);
  const detectors =
    options.detectors ?? filterDetectors(builtInDetectors, config, allKnownIds);
  const assetDetectors =
    options.assetDetectors ??
    filterAssetDetectors(builtInAssetDetectors, config, allKnownIds);
  const inputs = await resolveScanInputs({ root, config, options });
  // One log for the whole scan. Discovery, the index build and the
  // per-file detector pass can each drop work and keep going; they all
  // report here so `coverage.warnings` is the single answer to "what
  // did this scan not look at?".
  const warnings = new CoverageWarningLog();
  // Aggregated by the pattern that authorised the skip, so pydantic's
  // 85 files are one warning naming `pydantic/v1`, not 85 warnings.
  for (const skip of inputs.toolingSkips ?? []) {
    warnings.record("files_excluded_by_tooling", skip.pattern, { file: skip.file });
  }
  await collectDiscoveryWarnings({
    root,
    include: config.include,
    exclude: config.exclude,
    discovered: inputs.allFiles,
    alsoAnalysed: assetDetectors.length > 0 ? await discoverAssetFiles(root, config) : [],
    alreadyExplained: (inputs.toolingSkips ?? []).map((s) => s.file),
    into: warnings,
  });
  const indexes = await buildScanIndexes({
    root,
    config,
    allFiles: inputs.allFiles,
    warnings,
  });
  // `--related-to` is applied here rather than in `resolveScanInputs`
  // because the walk needs the import graph, which is built above from
  // the *whole* file set. Narrowing before the graph existed would make
  // the working set define its own neighbourhood.
  const workingSet = await resolveWorkingSet({
    root,
    allFiles: inputs.allFiles,
    options,
    imports: indexes.imports,
    warnings,
  });
  const scanFiles = workingSet ? workingSet.absoluteFiles : inputs.files;

  const langPack = resolveLanguagePackRouter();
  const findings = await runDetectorsForFiles({
    root,
    files: scanFiles,
    detectors,
    config,
    indexes,
    langPack,
  });
  // Asset detectors run over the repo, not over a file list, so a
  // working-set scan filters their output rather than skipping the pass.
  // Skipping it would mean `--files public/logo.png` reported nothing.
  const assetFindings = await runAssetDetectorsForRoot({
    root,
    config,
    detectors: assetDetectors,
  });
  findings.push(
    ...(workingSet
      ? assetFindings.filter((f) => workingSet.repoPaths.has(f.file))
      : assetFindings),
  );

  // One place enforces the never-reportable policy, because ~50
  // detectors predate `scope-class` and none of them ask.
  //
  // `isNeverReportable` was written in 0.16.0 and consulted only by the
  // detectors added alongside it. Everything older reported freely on
  // generated and vendored code: on airflow that was 44 findings across
  // 15 `.gen.ts` files, from `large_function`, `large_file`,
  // `option_bag_junk_drawer`, `high_fan_in_fan_out`,
  // `magic_domain_literal_scatter`, `name_behavior_mismatch`,
  // `boolean_naming_drift` and `logic_in_comments` — a machine-written
  // API client accused of having a God Function.
  //
  // Filtering here rather than teaching every detector to check means
  // the policy cannot drift back out of sync, and a detector added
  // tomorrow inherits it without knowing it exists.
  // Not recorded in `coverage.warnings`: those files *were* analysed and
  // this is deliberate policy, not an accidental gap. Conflating the two
  // would make the field that exists to expose silent skips report an
  // intended one.
  // `.gitattributes linguist-generated` joins the same policy rather
  // than getting its own: it is the repository asserting provenance
  // about its own file, which is the claim `looksGeneratedSource` already
  // trusts from an `@generated` banner. Path heuristics miss the cases
  // that do not look generated — posthog declares
  // `frontend/src/queries/validators.js` and `frontend/src/products.tsx`,
  // neither of which any pattern would catch, and which carried 66 of
  // the 69 findings this drops there.
  //
  // Read once per scan, not per finding: the file is small but the
  // matcher build is not free and `findings` runs to five figures on a
  // large repo.
  const declaredGenerated = generatedMatcherFor(root);
  const reportable = findings.filter(
    (f) => !isNeverReportable(f.file) && !declaredGenerated(f.file),
  );
  findings.length = 0;
  findings.push(...reportable);

  const coverage = buildCoverage({
    files: inputs.allFiles,
    router: langPack,
    root,
    warnings: warnings.build(),
  });

  // Backfill the per-finding scoring fields (churn / test_gap /
  // blast_radius) and recompute `agent_risk` from the unified 0.6.0
  // formula. Done once after all detectors have emitted so the
  // signal-source code lives in one place, not 17. Asset files aren't
  // in the scoring context — those findings get 0 for every backfilled
  // signal, which is intentional and documented.
  for (const f of findings) {
    finaliseFindingScores(f, indexes.scoring);
  }

  tagTierAndSortByRankScore(findings, config, {
    recencyEnabled: options.recencyEnabled ?? true,
  });
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
  if (workingSet) {
    report.working_set = workingSet.summary;
  }
  report.coverage = coverage;

  const resurfaced = await collectResurfaceForScan({
    root,
    config,
    allFiles: inputs.allFiles,
    indexes,
    detectors,
  });
  if (resurfaced.length > 0) {
    const merged = [...resurfaced, ...report.findings];
    // Re-assign over the merged list. Resurfaced findings are collected
    // after the first `assignIdsHelper` call above and are prepended, so
    // without this they reach the report with no `fingerprint` and no
    // `id` — the two fields every consumer addresses a finding by, and
    // the ones `--show-triaged` exists to let a caller act on. Re-running
    // here also keeps `id` positional, which is the only thing it claims
    // to be; assigning ids to the resurfaced entries alone would leave
    // index 0 holding a higher number than index 1.
    assignIdsHelper(merged);
    const next: ScanReport = {
      ...report,
      findings: merged,
      summary: summarise(merged),
    };
    return next;
  }
  return report;
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

  const absoluteFiles = allFiles.filter((abs) => {
    for (const [rel, candidate] of byRepoPath) {
      if (candidate === abs) return selected.has(rel);
    }
    return false;
  });

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
