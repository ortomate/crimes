import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { parseFile } from "@crimes/language-js";
import type { CrimesConfig } from "./config.js";
import type { Detector } from "./detector.js";
import type { Finding } from "./finding.js";
import { buildFunctionHashIndex } from "./ast-hash/function-index.js";
import type { FunctionHashIndex } from "./ast-hash/function-index.js";
import { buildIaIndex } from "./ia/build.js";
import type { IaConceptAliasGroup, IaIndex } from "./ia/types.js";
import { buildImportGraph } from "./imports/build.js";
import type { ImportGraph } from "./imports/types.js";
import { buildJsxShapeIndex } from "./jsx/shape-index.js";
import type { JsxShapeIndex } from "./jsx/shape-index.js";
import { buildPettyIndex } from "./petty/build.js";
import type { PettyIndex } from "./petty/types.js";
import {
  buildScoringContext,
  finaliseFindingScores,
} from "./scoring/build.js";
import type { ScoringContext } from "./scoring/build.js";

/**
 * Cross-file index builders used by `context()`. Each is a thin
 * try/catch wrapper that returns `undefined` on failure rather than
 * crashing the whole context run — single-file context should degrade
 * gracefully when one of the repo-level indexes can't be built.
 */

export async function safelyBuildIaIndex(args: {
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

export async function safelyBuildPettyIndex(args: {
  root: string;
  allFiles: string[];
}): Promise<PettyIndex | undefined> {
  try {
    return await buildPettyIndex({ root: args.root, files: args.allFiles });
  } catch {
    return undefined;
  }
}

export async function safelyBuildJsxShapeIndex(args: {
  root: string;
  allFiles: string[];
}): Promise<JsxShapeIndex | undefined> {
  try {
    return await buildJsxShapeIndex({ root: args.root, files: args.allFiles });
  } catch {
    return undefined;
  }
}

export async function safelyBuildFunctionHashIndex(args: {
  root: string;
  allFiles: string[];
}): Promise<FunctionHashIndex | undefined> {
  try {
    return await buildFunctionHashIndex({ root: args.root, files: args.allFiles });
  } catch {
    return undefined;
  }
}

export async function safelyBuildImportGraph(args: {
  root: string;
  allFiles: string[];
}): Promise<ImportGraph | undefined> {
  try {
    return await buildImportGraph({ root: args.root, files: args.allFiles });
  } catch {
    return undefined;
  }
}

export async function safelyBuildScoringContext(args: {
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

/**
 * Run every detector on the target file, applying the cross-file
 * indexes as detector context. Returns the detector findings filtered
 * to those that are about the target file (either `file` matches or
 * the target is in `related_files`).
 */
export async function runDetectorsOnTarget(args: {
  allFiles: string[];
  targetAbs: string;
  root: string;
  config: CrimesConfig;
  detectors: Detector[];
  ia?: IaIndex;
  petty?: PettyIndex;
  imports?: ImportGraph;
  jsxShapeIndex?: JsxShapeIndex;
  functionHashIndex?: FunctionHashIndex;
  scoring?: ScoringContext;
}): Promise<Finding[]> {
  const {
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
  } = args;
  if (!allFiles.includes(targetAbs)) return [];

  const file = toRepoPath(relative(root, targetAbs));
  const source = await readFile(targetAbs, "utf8");
  const parsed = parseFile({ absolutePath: targetAbs, source });

  const findings: Finding[] = [];
  for (const detector of detectors) {
    if (detector.pack !== "language-js") continue;
    const detectorFindings = await detector.run({
      kind: "language-js",
      file,
      absolutePath: targetAbs,
      source,
      parsed,
      config,
      ia,
      petty,
      imports,
      jsxShapeIndex,
      functionHashIndex,
      scoring,
    });
    findings.push(...detectorFindings);
  }

  // Backfill per-finding scores (churn / test_gap / blast_radius) and
  // recompute agent_risk from the unified formula. Detectors that ran
  // before scoring landed may have set agent_risk themselves; the
  // finalisation pass overwrites with the canonical value.
  for (const f of findings) {
    finaliseFindingScores(f, scoring);
  }

  // `crimes context <file>` must only show findings that are *about*
  // <file>. IA detectors fire at scan time using a deterministic anchor
  // file (e.g. the lex-first source file in the repo), which may not be
  // the target. Keep only findings whose `.file` or `.related_files`
  // reference the target.
  return findings.filter(
    (f) => f.file === file || (f.related_files ?? []).includes(file),
  );
}

function toRepoPath(p: string): string {
  return p.split(sep).join("/");
}
