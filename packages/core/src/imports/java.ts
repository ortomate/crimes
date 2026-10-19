import type { AnalysisInputs } from "../analysis-inputs.js";
/**
 * Java contribution to the repo-wide import graph.
 *
 * Same contract as `python.ts`: resolution lives in
 * `@crimes/language-java`, core only assembles edges into the one shared
 * graph. What Java adds is the implicit same-package edge — see that
 * package's `imports/resolve.ts` — without which a class used across its
 * package scored a blast radius of zero.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  buildJavaTypeIndex,
  parseJavaFile,
  resolveJavaReferences,
  type JavaFileTypesInput,
} from "@crimes/language-java";
import { type CoverageWarningLog, errnoOf } from "../discovery/coverage-warnings.js";
import type { ImportEdge } from "./types.js";

export interface BuildJavaImportEdgesOptions {
  inputs?: AnalysisInputs;
  root: string;
  files: string[];
  maxFiles?: number;
  warnings?: CoverageWarningLog;
}

export interface JavaImportEdgeResult {
  edges: ImportEdge[];
  /** Every Java file considered, repo-relative, so leaves are graph nodes. */
  files: string[];
  limited: boolean;
  droppedFiles: number;
}

/**
 * Parse every discovered Java file and resolve its imports and type
 * references. Best-effort per file: one that fails to read or parse
 * contributes no edges and is recorded, rather than failing the scan.
 */
export async function buildJavaImportEdges(
  options: BuildJavaImportEdgesOptions,
): Promise<JavaImportEdgeResult> {
  const root = resolve(options.root);
  const maxFiles = options.maxFiles ?? 5000;
  const all = options.files.filter((abs) => abs.endsWith(".java"));
  const javaFiles = all.slice(0, maxFiles);
  const repoPaths = javaFiles.map((abs) => toRepoPath(root, abs));
  if (javaFiles.length === 0) {
    return { edges: [], files: [], limited: false, droppedFiles: 0 };
  }

  const inputs: JavaFileTypesInput[] = [];
  await Promise.all(
    javaFiles.map(async (abs, i) => {
      const file = repoPaths[i]!;
      let source: string;
      try {
        source = options.inputs
          ? await options.inputs.read(abs)
          : await readFile(abs, "utf8");
      } catch (err) {
        options.warnings?.record("files_unreadable", errnoOf(err), { file });
        return;
      }
      try {
        const parsed = options.inputs
          ? await options.inputs.java(abs, source)
          : await parseJavaFile({ absolutePath: abs, source });
        inputs.push({
          file,
          ...(parsed.packageName !== undefined
            ? { packageName: parsed.packageName }
            : {}),
          types: parsed.types.map((t) => ({
            name: t.name,
            ...(t.enclosingType !== undefined ? { enclosingType: t.enclosingType } : {}),
          })),
          imports: parsed.imports,
          referencedTypes: parsed.referencedTypes,
        });
      } catch {
        options.warnings?.record("files_unparsed", "language-java", { file });
      }
    }),
  );

  // `Promise.all` completion order is non-deterministic; sort so edge
  // order, and every finding that quotes it, is stable across runs.
  inputs.sort((a, b) => a.file.localeCompare(b.file));
  const index = buildJavaTypeIndex(inputs);
  const edges: ImportEdge[] = [];
  for (const input of inputs) {
    for (const e of resolveJavaReferences(index, input)) {
      edges.push({ ...e, typeOnly: false, dynamic: false });
    }
  }

  return {
    edges,
    files: repoPaths,
    limited: all.length > javaFiles.length,
    droppedFiles: all.length - javaFiles.length,
  };
}

function toRepoPath(root: string, abs: string): string {
  const rel = isAbsolute(abs) ? relative(root, abs) : abs;
  return rel.split(sep).join("/");
}
