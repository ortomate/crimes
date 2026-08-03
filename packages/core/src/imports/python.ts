/**
 * Python contribution to the repo-wide import graph.
 *
 * The graph itself is language-agnostic: `ImportEdge` says nothing about
 * TypeScript, and the consumers (`circular_dependency`, `deep_import`,
 * `high_fan_in_fan_out`, and `buildBlastRadiusIndex`) only ever ask
 * "which files reach this one". So Python edges are merged into the same
 * graph rather than given a parallel one — a repo with a Python module
 * imported by 30 other Python modules gets a real `blast_radius` from
 * the same code path a TS module does.
 *
 * Module *resolution* stays in `@crimes/language-py`, because
 * `__init__.py` packaging and relative-dot levels are Python semantics
 * and have no business in core. Core only assembles.
 */

import { readFile } from "node:fs/promises";
import { type CoverageWarningLog, errnoOf } from "../discovery/coverage-warnings.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  buildPyModuleIndex,
  parsePyFile,
  resolvePyImports,
  type PyImportSpecifierInput,
} from "@crimes/language-py";
import type { ImportEdge } from "./types.js";

const PY_FILE_RE = /\.pyi?$/;

export interface BuildPythonImportEdgesOptions {
  /** Absolute repo root. */
  root: string;
  /** Absolute paths the scan discovered. */
  files: string[];
  /** Maximum Python files to parse before truncating. */
  maxFiles?: number;
  /** Where read / parse failures get recorded instead of vanishing. */
  warnings?: CoverageWarningLog;
}

export interface PythonImportEdgeResult {
  edges: ImportEdge[];
  /** True when the Python file set exceeded `maxFiles`. */
  limited: boolean;
  /** How many Python files fell outside `maxFiles`. */
  droppedFiles: number;
  /**
   * How many resolvable in-repo edges were produced, and how many
   * specifiers were seen in total. Surfaced so we can report Python
   * import coverage honestly rather than assuming resolution succeeded.
   */
  resolvedCount: number;
  specifierCount: number;
}

/**
 * Parse every discovered Python file and resolve its imports into
 * `ImportEdge`s.
 *
 * Best-effort per file, mirroring the JS builder: a file that fails to
 * read or parse contributes no edges rather than failing the scan.
 */
export async function buildPythonImportEdges(
  options: BuildPythonImportEdgesOptions,
): Promise<PythonImportEdgeResult> {
  const root = resolve(options.root);
  const maxFiles = options.maxFiles ?? 5000;

  const allPy = options.files.filter((abs) => PY_FILE_RE.test(abs));
  const pyFiles = allPy.slice(0, maxFiles);
  const limited = allPy.length > pyFiles.length;

  if (pyFiles.length === 0) {
    return {
      edges: [],
      limited: false,
      droppedFiles: 0,
      resolvedCount: 0,
      specifierCount: 0,
    };
  }

  const repoPaths = pyFiles.map((abs) => toRepoPath(root, abs));
  const index = buildPyModuleIndex(repoPaths);

  const specifiers: PyImportSpecifierInput[] = [];
  await Promise.all(
    pyFiles.map(async (abs, i) => {
      const from = repoPaths[i]!;
      let source: string;
      try {
        source = await readFile(abs, "utf8");
      } catch (err) {
        options.warnings?.record("files_unreadable", errnoOf(err), { file: from });
        return;
      }
      let parsed: Awaited<ReturnType<typeof parsePyFile>>;
      try {
        parsed = await parsePyFile({ absolutePath: abs, source });
      } catch {
        options.warnings?.record("files_unparsed", "language-py", { file: from });
        return;
      }
      for (const imp of parsed.imports) {
        specifiers.push({
          from,
          module: imp.module,
          relativeLevel: imp.relativeLevel,
          names: imp.names,
          kind: imp.kind,
        });
      }
    }),
  );

  // `Promise.all` completion order is non-deterministic, so sort before
  // resolving to keep edge order stable across runs. Findings quote
  // graph members into evidence; unstable order would churn fingerprints.
  specifiers.sort((a, b) => {
    if (a.from !== b.from) return a.from.localeCompare(b.from);
    if (a.relativeLevel !== b.relativeLevel) {
      return a.relativeLevel - b.relativeLevel;
    }
    return a.module.localeCompare(b.module);
  });

  const resolved = resolvePyImports({ index, specifiers });
  const edges: ImportEdge[] = resolved.map((e) => ({
    from: e.from,
    to: e.to,
    specifier: e.specifier,
    external: e.external,
    // Python has no `import type` and no dynamic-import expression that
    // the static resolver follows, so both flags are always false. They
    // exist on the shared edge shape; Python simply never sets them.
    typeOnly: false,
    dynamic: false,
  }));

  return {
    edges,
    limited,
    droppedFiles: allPy.length - pyFiles.length,
    resolvedCount: edges.filter((e) => e.to.length > 0).length,
    specifierCount: specifiers.length,
  };
}

function toRepoPath(root: string, abs: string): string {
  const rel = isAbsolute(abs) ? relative(root, abs) : abs;
  return rel.split(sep).join("/");
}
