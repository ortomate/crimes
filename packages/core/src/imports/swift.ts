import type { AnalysisInputs } from "../analysis-inputs.js";
/**
 * Swift contribution to the repo-wide import graph.
 *
 * A Swift `import` names a module, and every type in a module is visible
 * to every file in it, so import statements say nothing about which file
 * depends on which. Edges are drawn instead from each file's referenced
 * types to the files that declare them, repo-wide. An `extension Film`
 * is a reference to `Film`, so a file of extensions depends on the type
 * it extends, as it does.
 *
 * Module boundaries (Xcode targets, Swift packages) are not modelled: an
 * app and its widget extension can each declare a `Theme`. A name
 * declared in more than {@link MAX_DECLARERS} files is ambiguous enough
 * that drawing an edge to every declarer would invent coupling, so none
 * is drawn. Up to that many, each declarer gets the edge — a duplicated
 * declaration in two targets is still a file an edit has to consider.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseSwiftFile } from "@crimes/language-swift";
import { type CoverageWarningLog, errnoOf } from "../discovery/coverage-warnings.js";
import { structuredSkipFor } from "../util/structured-skip.js";
import type { ImportEdge } from "./types.js";

const MAX_DECLARERS = 3;

export interface BuildSwiftImportEdgesOptions {
  inputs?: AnalysisInputs;
  root: string;
  files: string[];
  maxFiles?: number;
  warnings?: CoverageWarningLog;
}

export interface SwiftImportEdgeResult {
  edges: ImportEdge[];
  files: string[];
  limited: boolean;
  droppedFiles: number;
}

export async function buildSwiftImportEdges(
  options: BuildSwiftImportEdgesOptions,
): Promise<SwiftImportEdgeResult> {
  const root = resolve(options.root);
  const maxFiles = options.maxFiles ?? 5000;
  // Generated and vendored files are never reported; see structured-skip.
  const skip = structuredSkipFor(root);
  const all = options.files.filter(
    (abs) => abs.endsWith(".swift") && !skip(toRepoPath(root, abs)),
  );
  const swiftFiles = all.slice(0, maxFiles);
  const repoPaths = swiftFiles.map((abs) => toRepoPath(root, abs));
  if (swiftFiles.length === 0) {
    return { edges: [], files: [], limited: false, droppedFiles: 0 };
  }

  const facts: { file: string; declared: string[]; referenced: string[] }[] = [];
  await Promise.all(
    swiftFiles.map(async (abs, i) => {
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
          ? await options.inputs.swift(abs, source)
          : await parseSwiftFile({ absolutePath: abs, source });
        facts.push({
          file,
          declared: parsed.declaredTypes,
          referenced: parsed.referencedTypes,
        });
      } catch {
        options.warnings?.record("files_unparsed", "language-swift", { file });
      }
    }),
  );
  facts.sort((a, b) => a.file.localeCompare(b.file));

  const declarers = new Map<string, string[]>();
  for (const f of facts) {
    for (const name of f.declared) {
      const list = declarers.get(name) ?? [];
      list.push(f.file);
      declarers.set(name, list);
    }
  }

  const edges: ImportEdge[] = [];
  for (const f of facts) {
    const targets = new Map<string, string>();
    for (const name of f.referenced) {
      const files = declarers.get(name);
      if (!files || files.length > MAX_DECLARERS) continue;
      for (const to of files) {
        if (to !== f.file && !targets.has(to)) targets.set(to, name);
      }
    }
    for (const [to, name] of [...targets].sort((a, b) => a[0].localeCompare(b[0]))) {
      edges.push({
        from: f.file,
        to,
        specifier: name,
        external: false,
        typeOnly: false,
        dynamic: false,
      });
    }
  }

  return {
    edges,
    files: repoPaths,
    limited: all.length > swiftFiles.length,
    droppedFiles: all.length - swiftFiles.length,
  };
}

function toRepoPath(root: string, abs: string): string {
  const rel = isAbsolute(abs) ? relative(root, abs) : abs;
  return rel.split(sep).join("/");
}
