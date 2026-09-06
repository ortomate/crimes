import type { AnalysisInputs } from "./analysis-inputs.js";
import { profileAsync } from "./profile.js";
import { buildFunctionHashIndex } from "./ast-hash/function-index.js";
import type { FunctionHashIndex } from "./ast-hash/function-index.js";
import type { CoverageWarningLog } from "./discovery/coverage-warnings.js";
import { buildIaIndex } from "./ia/build.js";
import type { IaConceptAliasGroup, IaIndex } from "./ia/types.js";
import { buildImportGraph } from "./imports/build.js";
import type { ImportGraph } from "./imports/types.js";
import type { PySymbolIndex } from "./py/symbol-index.js";
import { buildJsxShapeIndex } from "./jsx/shape-index.js";
import type { JsxShapeIndex } from "./jsx/shape-index.js";
import { buildPettyIndex } from "./petty/build.js";
import type { PettyIndex } from "./petty/types.js";
import { buildScoringContext } from "./scoring/build.js";
import type { ScoringContext } from "./scoring/build.js";
import { buildRiskIndex } from "./risk/build.js";
import type { RiskIndex } from "./risk/types.js";
import { buildManifestIndex } from "./manifest/build.js";
import type { ManifestIndex } from "./manifest/types.js";
import { buildAgentConfigIndex } from "./agents/build.js";
import type { AgentConfigIndex } from "./agents/types.js";

/**
 * Cross-file index builders shared by `scan()` and `context()`. Each is
 * a thin try/catch wrapper returning `undefined` on failure rather than
 * crashing the run — a scan should degrade gracefully when one
 * repo-level index can't be built, not abort.
 *
 * These lived in two places until 0.12.2: `context-indexes.ts` exported
 * them, and `scan.ts` carried byte-identical private copies. Both call
 * sites now share this module.
 *
 * Degrading gracefully is not the same as degrading quietly. Every
 * wrapper takes an optional `warnings` log and records an
 * `index_unavailable` entry when it swallows: a missing import graph
 * silently zeroes `blast_radius` for the whole repo, and a report that
 * doesn't say so is a report that lies with confidence.
 */

/**
 * Files whose analysis is affected when a repo-level index fails. Used
 * as the `files` count on `index_unavailable`, because the failure is
 * not scoped to any one file — it costs every file the detectors that
 * read that index.
 */
function affectedCount(files: readonly string[] | undefined): number {
  return files?.length ?? 0;
}

export async function safelyBuildIaIndex(args: {
  root: string;
  allFiles: string[];
  inputs?: AnalysisInputs;
  aliasGroups?: IaConceptAliasGroup[];
  warnings?: CoverageWarningLog;
}): Promise<IaIndex | undefined> {
  try {
    return await profileAsync("index.ia", () =>
      buildIaIndex({
        inputs: args.inputs,
        root: args.root,
        files: args.allFiles,
        ...(args.aliasGroups !== undefined ? { aliasGroups: args.aliasGroups } : {}),
        ...(args.warnings !== undefined ? { warnings: args.warnings } : {}),
      }),
    );
  } catch {
    args.warnings?.record("index_unavailable", "ia", {
      files: affectedCount(args.allFiles),
    });
    return undefined;
  }
}

export async function safelyBuildPettyIndex(args: {
  root: string;
  allFiles: string[];
  inputs?: AnalysisInputs;
  warnings?: CoverageWarningLog;
}): Promise<PettyIndex | undefined> {
  try {
    return await profileAsync("index.petty", () =>
      buildPettyIndex({
        inputs: args.inputs,
        root: args.root,
        files: args.allFiles,
        ...(args.warnings !== undefined ? { warnings: args.warnings } : {}),
      }),
    );
  } catch {
    args.warnings?.record("index_unavailable", "petty", {
      files: affectedCount(args.allFiles),
    });
    return undefined;
  }
}

export async function safelyBuildJsxShapeIndex(args: {
  root: string;
  allFiles: string[];
  inputs?: AnalysisInputs;
  warnings?: CoverageWarningLog;
}): Promise<JsxShapeIndex | undefined> {
  try {
    return await profileAsync("index.jsx", () =>
      buildJsxShapeIndex({
        inputs: args.inputs,
        root: args.root,
        files: args.allFiles,
        ...(args.warnings !== undefined ? { warnings: args.warnings } : {}),
      }),
    );
  } catch {
    args.warnings?.record("index_unavailable", "jsx_shape", {
      files: affectedCount(args.allFiles),
    });
    return undefined;
  }
}

export async function safelyBuildFunctionHashIndex(args: {
  root: string;
  allFiles: string[];
  inputs?: AnalysisInputs;
  warnings?: CoverageWarningLog;
}): Promise<FunctionHashIndex | undefined> {
  try {
    return await profileAsync("index.function-hash", () =>
      buildFunctionHashIndex({
        inputs: args.inputs,
        root: args.root,
        files: args.allFiles,
        ...(args.warnings !== undefined ? { warnings: args.warnings } : {}),
      }),
    );
  } catch {
    args.warnings?.record("index_unavailable", "function_hash", {
      files: affectedCount(args.allFiles),
    });
    return undefined;
  }
}

export async function safelyBuildImportGraph(args: {
  root: string;
  allFiles: string[];
  inputs?: AnalysisInputs;
  warnings?: CoverageWarningLog;
  /**
   * Receives the repo-wide Python symbol index, which is built from the
   * Python parse this builder already performs. Not invoked when the
   * graph build throws — a symbol index derived from a half-finished
   * pass would be a silent partial answer, and this index's whole
   * discipline is refusing to answer rather than answering on partial
   * evidence.
   */
  onPySymbolIndex?: (index: PySymbolIndex) => void;
}): Promise<ImportGraph | undefined> {
  try {
    return await profileAsync("index.imports", () =>
      buildImportGraph({
        inputs: args.inputs,
        root: args.root,
        files: args.allFiles,
        ...(args.warnings !== undefined ? { warnings: args.warnings } : {}),
        ...(args.onPySymbolIndex !== undefined
          ? { onPySymbolIndex: args.onPySymbolIndex }
          : {}),
      }),
    );
  } catch {
    args.warnings?.record("index_unavailable", "imports", {
      files: affectedCount(args.allFiles),
    });
    return undefined;
  }
}

export async function safelyBuildScoringContext(args: {
  root: string;
  allFiles: string[];
  inputs?: AnalysisInputs;
  imports: ImportGraph | undefined;
  warnings?: CoverageWarningLog;
}): Promise<ScoringContext | undefined> {
  try {
    return await profileAsync("index.scoring", () =>
      buildScoringContext({
        root: args.root,
        files: args.allFiles,
        imports: args.imports,
      }),
    );
  } catch {
    args.warnings?.record("index_unavailable", "scoring", {
      files: affectedCount(args.allFiles),
    });
    return undefined;
  }
}

export async function safelyBuildRiskIndex(args: {
  root: string;
  allFiles: string[];
  inputs?: AnalysisInputs;
  envInventoryFiles?: string[];
  warnings?: CoverageWarningLog;
}): Promise<RiskIndex | undefined> {
  try {
    return await profileAsync("index.risk", () =>
      buildRiskIndex({
        inputs: args.inputs,
        root: args.root,
        files: args.allFiles,
        ...(args.envInventoryFiles !== undefined
          ? { envInventoryFiles: args.envInventoryFiles }
          : {}),
      }),
    );
  } catch {
    args.warnings?.record("index_unavailable", "risk", {
      files: affectedCount(args.allFiles),
    });
    return undefined;
  }
}

export async function safelyBuildManifestIndex(args: {
  root: string;
  warnings?: CoverageWarningLog;
}): Promise<ManifestIndex | undefined> {
  try {
    return await profileAsync("index.manifest", () =>
      buildManifestIndex({ root: args.root }),
    );
  } catch {
    args.warnings?.record("index_unavailable", "manifest", { files: 1 });
    return undefined;
  }
}

export async function safelyBuildAgentConfigIndex(args: {
  root: string;
  warnings?: CoverageWarningLog;
}): Promise<AgentConfigIndex | undefined> {
  try {
    return await profileAsync("index.agent-config", () =>
      buildAgentConfigIndex({ root: args.root }),
    );
  } catch {
    args.warnings?.record("index_unavailable", "agent_config", { files: 1 });
    return undefined;
  }
}
