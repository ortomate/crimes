import { readFile } from "node:fs/promises";
import { looksMinifiedSource } from "./util/scope-class.js";
import { relative, sep } from "node:path";
import { parseFile } from "@crimes/language-js";
import { parsePyFile } from "@crimes/language-py";
import type { CrimesConfig } from "./config.js";
import type {
  CrossLanguageDetector,
  CrossLanguageDetectorContext,
  Detector,
  LanguageJsDetectorContext,
  LanguagePyDetectorContext,
  PackedFile,
} from "./detector.js";
import { groupDetectorsByPack } from "./detector-registry.js";
import { CoverageWarningLog } from "./discovery/coverage-warnings.js";
import { buildUniversalContext } from "./discovery/universal-context.js";
import type { LanguagePackRouter } from "./discovery/language-pack-router.js";
import { assignPackAndDetectorId } from "./finding-finalise.js";
import type { Finding } from "./finding.js";
import type { FunctionHashIndex } from "./ast-hash/function-index.js";
import type { IaIndex } from "./ia/types.js";
import { resolveAliasGroups } from "./ia/aliases.js";
import type { ImportGraph } from "./imports/types.js";
import type { JsxShapeIndex } from "./jsx/shape-index.js";
import type { PettyIndex } from "./petty/types.js";
import type { ScoringContext } from "./scoring/build.js";
import type { AgentConfigIndex } from "./agents/types.js";
import type { ManifestIndex } from "./manifest/types.js";
import type { RiskIndex } from "./risk/types.js";
import { discoverEnvInventoryFiles } from "./risk/env-inventory.js";
import {
  safelyBuildAgentConfigIndex,
  safelyBuildFunctionHashIndex,
  safelyBuildIaIndex,
  safelyBuildImportGraph,
  safelyBuildJsxShapeIndex,
  safelyBuildManifestIndex,
  safelyBuildPettyIndex,
  safelyBuildRiskIndex,
  safelyBuildScoringContext,
} from "./indexes.js";

/**
 * The cross-file index bundle and the per-file detector pass.
 *
 * Extracted from scan.ts in 0.12.2. Both `scan()` and the resurface
 * stage need to run detectors over a file set, and the resurface stage
 * lives in its own module — without this shared home the two would
 * import each other.
 */

export interface ScanIndexes {
  ia?: IaIndex;
  petty?: PettyIndex;
  imports?: ImportGraph;
  jsxShapeIndex?: JsxShapeIndex;
  functionHashIndex?: FunctionHashIndex;
  scoring?: ScoringContext;
  /** Cross-file policy / contract / env / indirection inventory (0.16.0). */
  risk?: RiskIndex;
  /** package.json + lockfile inventory (0.16.0). */
  manifest?: ManifestIndex;
  /** Repo-local agent configuration inventory (0.16.0). */
  agentConfig?: AgentConfigIndex;
  /**
   * Everything the index build dropped without failing (0.17.0). Always
   * present so downstream stages can keep recording into it; `scan()`
   * folds it into `ScanReport.coverage.warnings`.
   */
  warnings?: CoverageWarningLog;
}

export async function buildScanIndexes(args: {
  root: string;
  config: CrimesConfig;
  allFiles: string[];
  /** Reuse an existing log instead of starting a fresh one. */
  warnings?: CoverageWarningLog;
}): Promise<ScanIndexes> {
  const { root, config, allFiles } = args;
  // One log for the whole index build. Every builder below can drop a
  // file and keep going; without a shared collector each drop is
  // indistinguishable from "that file was clean".
  const warnings = args.warnings ?? new CoverageWarningLog();
  // Cross-file indexes always use the full discovered file set. `--changed`
  // gates finding emission, not the context detectors and scoring inspect.
  const ia = await safelyBuildIaIndex({
    root,
    allFiles,
    aliasGroups: resolveAliasGroups(config),
    warnings,
  });
  const petty = await safelyBuildPettyIndex({ root, allFiles, warnings });
  const imports = await safelyBuildImportGraph({ root, allFiles, warnings });
  const jsxShapeIndex = await safelyBuildJsxShapeIndex({ root, allFiles, warnings });
  const functionHashIndex = await safelyBuildFunctionHashIndex({
    root,
    allFiles,
    warnings,
  });
  const scoring = await safelyBuildScoringContext({
    root,
    allFiles,
    imports,
    warnings,
  });
  const envInventoryFiles = await discoverEnvInventoryFiles(root);
  const risk = await safelyBuildRiskIndex({
    root,
    allFiles,
    envInventoryFiles,
    warnings,
  });
  const manifest = await safelyBuildManifestIndex({ root, warnings });
  const agentConfig = await safelyBuildAgentConfigIndex({ root, warnings });

  return {
    ia,
    petty,
    imports,
    jsxShapeIndex,
    functionHashIndex,
    scoring,
    risk,
    manifest,
    agentConfig,
    warnings,
  };
}

export async function runDetectorsForFiles(args: {
  root: string;
  files: string[];
  detectors: Detector[];
  config: CrimesConfig;
  indexes: ScanIndexes;
  langPack: LanguagePackRouter;
}): Promise<Finding[]> {
  // Group detectors by pack once per scan rather than per file — the
  // detector list is invariant across the file loop, so re-grouping
  // for every file is wasted work proportional to repo size.
  const grouped = groupDetectorsByPack(args.detectors);
  const findings: Finding[] = [];
  // Cross-language detectors need every pack's parsed output, so the
  // per-file loop collects it as it goes rather than re-parsing the
  // repo a second time. Only populated when a cross-language detector
  // is actually enabled — otherwise this is pure memory cost on every
  // scan for a feature nobody asked for.
  const crossDetectors = grouped["cross-language"] ?? [];
  const packedFiles: PackedFile[] = [];

  for (const absolutePath of args.files) {
    findings.push(
      ...(await runDetectorsForFile({
        root: args.root,
        absolutePath,
        config: args.config,
        indexes: args.indexes,
        langPack: args.langPack,
        grouped,
        ...(crossDetectors.length > 0 ? { collectInto: packedFiles } : {}),
      })),
    );
  }

  if (crossDetectors.length > 0) {
    findings.push(
      ...(await runCrossLanguageDetectors({
        root: args.root,
        detectors: crossDetectors,
        config: args.config,
        indexes: args.indexes,
        packedFiles,
      })),
    );
  }

  return findings;
}

/**
 * Run the cross-language pass. Called once per scan, after every
 * per-language pass has completed — a cross-language finding is a
 * disagreement *between* files, so there is no per-file iteration here.
 */
export async function runCrossLanguageDetectors(args: {
  root: string;
  detectors: CrossLanguageDetector[];
  config: CrimesConfig;
  indexes: ScanIndexes;
  packedFiles: PackedFile[];
}): Promise<Finding[]> {
  // Stable order so evidence strings and the anchor file a detector
  // picks don't shift between runs on the same repo.
  const files = [...args.packedFiles].sort((a, b) => a.file.localeCompare(b.file));
  const ctx: CrossLanguageDetectorContext = {
    kind: "cross-language",
    root: args.root,
    files,
    config: args.config,
    ia: args.indexes.ia,
    imports: args.indexes.imports,
    scoring: args.indexes.scoring,
  };

  const findings: Finding[] = [];
  for (const detector of args.detectors) {
    const emitted = await detector.run(ctx);
    findings.push(...emitted.map((f) => assignPackAndDetectorId(f, detector)));
  }
  return findings;
}

export async function runDetectorsForFile(args: {
  root: string;
  absolutePath: string;
  config: CrimesConfig;
  indexes: ScanIndexes;
  langPack: LanguagePackRouter;
  grouped: ReturnType<typeof groupDetectorsByPack>;
  /**
   * When present, each file this pass parses is appended here for the
   * cross-language pass. Absent when no cross-language detector is
   * enabled, so the corpus is never held in memory for nothing.
   */
  collectInto?: PackedFile[];
}): Promise<Finding[]> {
  const file = toRepoPath(relative(args.root, args.absolutePath));

  const findings: Finding[] = [];

  // Universal pack: always runs, no language-pack dependency.
  const universalDetectors = args.grouped.universal ?? [];
  if (universalDetectors.length > 0) {
    const universalCtx = await buildUniversalContext({
      root: args.root,
      absolutePath: args.absolutePath,
      file,
      config: args.config,
      indexes: args.indexes,
    });
    for (const detector of universalDetectors) {
      const detectorFindings = await detector.run(universalCtx);
      findings.push(...detectorFindings.map((f) => assignPackAndDetectorId(f, detector)));
    }
  }

  // Language-js pack: runs only when the JS pack claims the file's extension.
  // Parse when the pack claims the file and *either* it has detectors
  // to run or the cross-language pass needs the corpus. Gating purely on
  // detector count would hand the cross-language pass an empty JS side
  // whenever someone disabled the JS detectors, and it would report the
  // resulting one-sidedness as if the language were absent.
  const jsDetectors = args.grouped["language-js"] ?? [];
  if (
    (jsDetectors.length > 0 || args.collectInto !== undefined) &&
    args.langPack.claims("language-js", args.absolutePath)
  ) {
    const source = await readFile(args.absolutePath, "utf8");
    // A minified bundle is vendored code whatever its filename says, and
    // every finding in one is about code nobody wrote. See
    // {@link looksMinifiedSource}.
    if (looksMinifiedSource(source)) return findings;
    const parsed = parseFile({ absolutePath: args.absolutePath, source });
    const jsCtx: LanguageJsDetectorContext = {
      kind: "language-js",
      file,
      absolutePath: args.absolutePath,
      source,
      parsed,
      config: args.config,
      ...args.indexes,
    };
    for (const detector of jsDetectors) {
      const detectorFindings = await detector.run(jsCtx);
      findings.push(...detectorFindings.map((f) => assignPackAndDetectorId(f, detector)));
    }
    args.collectInto?.push({
      pack: "language-js",
      file,
      absolutePath: args.absolutePath,
      parsed,
    });
  }

  // Language-py pack: runs only when the Python pack claims the file's
  // extension. Same shape as the JS branch above — the routing seam is
  // the point of this release, so the two read identically.
  const pyDetectors = args.grouped["language-py"] ?? [];
  if (
    (pyDetectors.length > 0 || args.collectInto !== undefined) &&
    args.langPack.claims("language-py", args.absolutePath)
  ) {
    const source = await readFile(args.absolutePath, "utf8");
    const parsed = await parsePyFile({
      absolutePath: args.absolutePath,
      source,
    });
    // tree-sitter recovers from a syntax error and hands back a partial
    // tree. Detectors that judge a whole file (`py/weak_test_signal`)
    // return [] on that partial tree — correctly, but invisibly. Record
    // it so "no findings" can be told apart from "never really parsed".
    if (parsed.hasSyntaxErrors) {
      args.indexes.warnings?.record("files_partial_parse", "language-py", { file });
    }
    const pyCtx: LanguagePyDetectorContext = {
      kind: "language-py",
      file,
      absolutePath: args.absolutePath,
      source,
      parsed,
      config: args.config,
      ia: args.indexes.ia,
      petty: args.indexes.petty,
      imports: args.indexes.imports,
      scoring: args.indexes.scoring,
    };
    for (const detector of pyDetectors) {
      const detectorFindings = await detector.run(pyCtx);
      findings.push(...detectorFindings.map((f) => assignPackAndDetectorId(f, detector)));
    }
    args.collectInto?.push({
      pack: "language-py",
      file,
      absolutePath: args.absolutePath,
      parsed,
    });
  }

  return findings;
}

export function toRepoPath(p: string): string {
  return p.split(sep).join("/");
}
