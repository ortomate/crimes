import type { AnalysisInputs } from "../analysis-inputs.js";
/**
 * JVM (Java and Kotlin) contribution to the repo-wide import graph.
 *
 * Same contract as `python.ts`: resolution lives in
 * `@crimes/language-java`, core only assembles edges into the one shared
 * graph. What the JVM adds is the implicit same-package edge — see that
 * package's `imports/resolve.ts` — without which a class used across its
 * package scored a blast radius of zero.
 *
 * Java and Kotlin go into **one** index. They share packages, and a
 * Kotlin file uses a Java class in its package (or the reverse) with no
 * import, so resolving them separately would drop exactly the edges an
 * Android codebase mid-migration is made of. A Kotlin file's top-level
 * functions, properties and type aliases are indexed beside its types:
 * they are imported by name and used unimported within the package.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  buildJavaTypeIndex,
  parseJavaFile,
  resolveJavaReferences,
  type JavaFileTypesInput,
} from "@crimes/language-java";
import { parseKotlinFile } from "@crimes/language-kotlin";
import { type CoverageWarningLog, errnoOf } from "../discovery/coverage-warnings.js";
import { structuredSkipFor } from "../util/structured-skip.js";
import type { ImportEdge } from "./types.js";

export interface BuildJvmImportEdgesOptions {
  inputs?: AnalysisInputs;
  root: string;
  files: string[];
  maxFiles?: number;
  warnings?: CoverageWarningLog;
}

export interface JvmImportEdgeResult {
  edges: ImportEdge[];
  /** Every JVM file considered, repo-relative, so leaves are graph nodes. */
  files: string[];
  limited: boolean;
  droppedFiles: number;
}

/**
 * Parse every discovered Java and Kotlin file and resolve its imports and type
 * references. Best-effort per file: one that fails to read or parse
 * contributes no edges and is recorded, rather than failing the scan.
 */
export async function buildJvmImportEdges(
  options: BuildJvmImportEdgesOptions,
): Promise<JvmImportEdgeResult> {
  const root = resolve(options.root);
  const maxFiles = options.maxFiles ?? 5000;
  // Generated and vendored files are never reported; see structured-skip.
  const skip = structuredSkipFor(root);
  const all = options.files.filter(
    (abs) => JVM_FILE_RE.test(abs) && !skip(toRepoPath(root, abs)),
  );
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
      if (!abs.endsWith(".java")) {
        try {
          const parsed = options.inputs
            ? await options.inputs.kotlin(abs, source)
            : await parseKotlinFile({ absolutePath: abs, source });
          inputs.push({
            file,
            ...(parsed.packageName !== undefined
              ? { packageName: parsed.packageName }
              : {}),
            types: [
              ...parsed.types.map((t) => ({
                name: t.name,
                ...(t.enclosingType !== undefined
                  ? { enclosingType: t.enclosingType }
                  : {}),
              })),
              ...parsed.topLevelDeclarations.map((name) => ({ name })),
            ],
            imports: parsed.imports,
            referencedTypes: parsed.referencedNames,
          });
        } catch {
          options.warnings?.record("files_unparsed", "language-kotlin", { file });
        }
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

const JVM_FILE_RE = /\.(?:java|kts?)$/;

function toRepoPath(root: string, abs: string): string {
  const rel = isAbsolute(abs) ? relative(root, abs) : abs;
  return rel.split(sep).join("/");
}
