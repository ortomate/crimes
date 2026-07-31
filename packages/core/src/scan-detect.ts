import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { parseFile } from "@crimes/language-js";
import { parsePyFile } from "@crimes/language-py";
import type { CrimesConfig } from "./config.js";
import type {
  Detector,
  LanguageJsDetectorContext,
  LanguagePyDetectorContext,
} from "./detector.js";
import { groupDetectorsByPack } from "./detector-registry.js";
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
import {
  safelyBuildFunctionHashIndex,
  safelyBuildIaIndex,
  safelyBuildImportGraph,
  safelyBuildJsxShapeIndex,
  safelyBuildPettyIndex,
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
}

export async function buildScanIndexes(args: {
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
  for (const absolutePath of args.files) {
    findings.push(
      ...(await runDetectorsForFile({
        root: args.root,
        absolutePath,
        config: args.config,
        indexes: args.indexes,
        langPack: args.langPack,
        grouped,
      })),
    );
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
  const jsDetectors = args.grouped["language-js"] ?? [];
  if (
    jsDetectors.length > 0 &&
    args.langPack.claims("language-js", args.absolutePath)
  ) {
    const source = await readFile(args.absolutePath, "utf8");
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
  }

  // Language-py pack: runs only when the Python pack claims the file's
  // extension. Same shape as the JS branch above — the routing seam is
  // the point of this release, so the two read identically.
  const pyDetectors = args.grouped["language-py"] ?? [];
  if (
    pyDetectors.length > 0 &&
    args.langPack.claims("language-py", args.absolutePath)
  ) {
    const source = await readFile(args.absolutePath, "utf8");
    const parsed = await parsePyFile({
      absolutePath: args.absolutePath,
      source,
    });
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
  }

  return findings;
}

export function toRepoPath(p: string): string {
  return p.split(sep).join("/");
}
