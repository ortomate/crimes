import type { AnalysisInputs } from "../analysis-inputs.js";
/**
 * LESS contribution to the repo-wide import graph: `@import` edges, and
 * usage edges from a partial to the files defining the variables and
 * mixins it uses. The rules live in `@crimes/language-less`; see
 * `resolveLessProject` for why usage edges exist.
 */

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  findOverriddenVariables,
  type OverriddenVariable,
  type ParsedLessFile,
  parseLessFile,
  resolveLessProject,
} from "@crimes/language-less";
import { type CoverageWarningLog, errnoOf } from "../discovery/coverage-warnings.js";
import { structuredSkipFor } from "../util/structured-skip.js";
import type { ImportEdge } from "./types.js";

export interface BuildLessImportEdgesOptions {
  inputs?: AnalysisInputs;
  root: string;
  files: string[];
  maxFiles?: number;
  warnings?: CoverageWarningLog;
}

export interface LessImportEdgeResult {
  edges: ImportEdge[];
  files: string[];
  limited: boolean;
  droppedFiles: number;
  /** Variable definitions every bundle reaching them overrides. */
  overridden: OverriddenVariable[];
}

export async function buildLessImportEdges(
  options: BuildLessImportEdgesOptions,
): Promise<LessImportEdgeResult> {
  const root = resolve(options.root);
  const maxFiles = options.maxFiles ?? 5000;
  const skip = structuredSkipFor(root);
  const all = options.files.filter(
    (abs) => /\.(?:less|css)$/i.test(abs) && !skip(toRepoPath(root, abs)),
  );
  const considered = all.slice(0, maxFiles);
  if (considered.length === 0) {
    return { edges: [], files: [], limited: false, droppedFiles: 0, overridden: [] };
  }

  const files = new Map<string, ParsedLessFile>();
  await Promise.all(
    considered.map(async (abs) => {
      const file = toRepoPath(root, abs);
      try {
        const source = options.inputs
          ? await options.inputs.read(abs)
          : await readFile(abs, "utf8");
        files.set(
          file,
          options.inputs
            ? options.inputs.less(abs, source)
            : parseLessFile({ absolutePath: abs, source }),
        );
      } catch (err) {
        options.warnings?.record("files_unreadable", errnoOf(err), { file });
      }
    }),
  );

  const isFile = (path: string): boolean => {
    if (files.has(path)) return true;
    if (path.startsWith("..") || isAbsolute(path)) return false;
    try {
      return statSync(join(root, path)).isFile();
    } catch {
      return false;
    }
  };
  const { references } = resolveLessProject({ files, isFile });
  // A truncated file set would change which files are bundles, so the
  // simulation runs only on a complete one.
  const overridden =
    all.length > considered.length ? [] : findOverriddenVariables({ files, isFile });
  const edges: ImportEdge[] = references.map((r) => ({
    from: r.from,
    to: r.to,
    specifier: r.specifier,
    external: false,
    typeOnly: false,
    dynamic: false,
  }));
  return {
    edges,
    files: [...files.keys()].sort(),
    limited: all.length > considered.length,
    droppedFiles: all.length - considered.length,
    overridden,
  };
}

function toRepoPath(root: string, abs: string): string {
  const rel = isAbsolute(abs) ? relative(root, abs) : abs;
  return rel.split(sep).join("/");
}
