import type { AnalysisInputs } from "../analysis-inputs.js";
/**
 * Repo-wide JSX shape index for the duplicate-component-shape detector.
 *
 * Built once per scan, attached to `DetectorContext.jsxShapeIndex`,
 * consumed only by `duplicate_component_shape`. The index groups
 * "interesting" JSX subtrees by their structural shape hash so the
 * detector can answer "does this subtree appear in ≥3 distinct files?"
 * in one lookup rather than re-hashing per file.
 */

import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { parseFile } from "@crimes/language-js";
import type { JsxElementInfo } from "@crimes/language-js";
import { hashJsxSubtree } from "../ast-hash/hash.js";
import { mapWithConcurrency } from "../util/concurrency.js";
import { type CoverageWarningLog, errnoOf } from "../discovery/coverage-warnings.js";

export interface JsxShapeHit {
  file: string;
  lines: [number, number];
  rootName: string;
}

export interface JsxShapeIndex {
  /** shape hash → every site that produced that hash. */
  byShape: Map<string, JsxShapeHit[]>;
}

export interface BuildJsxShapeIndexOptions {
  inputs?: AnalysisInputs;
  /** Absolute repo root. */
  root: string;
  /** Absolute paths discovered by the scan. */
  files: string[];
  /** Where read / parse failures get recorded instead of vanishing. */
  warnings?: CoverageWarningLog;
}

/**
 * Minimum subtree size before it counts as a duplication candidate.
 * Below this, shape collisions are noise (empty divs, single text
 * leaves, etc.).
 */
const MIN_SUBTREE_NODES = 4;
const SOURCE_EXT_RE = /\.(tsx|jsx)$/;

/**
 * Build the JSX shape index. Always returns an index; files that fail
 * to read or parse contribute nothing and are recorded on `warnings`
 * so the absence is reported rather than read as "no duplicates here". Performance budget: a parsed
 * JSX tree is walked once per "interesting" element; hashing reuses the
 * same source slice the existing AST walker already produced.
 *
 * Files are read through {@link mapWithConcurrency} rather than
 * `Promise.all` so the in-flight descriptor count stays bounded on large
 * repos, and their hits are inserted in sorted file order so map order
 * does not depend on which read finished first.
 */
export async function buildJsxShapeIndex(
  options: BuildJsxShapeIndexOptions,
): Promise<JsxShapeIndex> {
  const byShape = new Map<string, JsxShapeHit[]>();
  const candidateFiles = options.files.filter((f) => SOURCE_EXT_RE.test(f)).sort();

  const perFile = await mapWithConcurrency(candidateFiles, async (abs) => {
    const hits: Array<{ hash: string; hit: JsxShapeHit }> = [];
    const repoPath = toRepoPath(options.root, abs);
    let source: string;
    try {
      source = options.inputs
        ? await options.inputs.read(abs)
        : await readFile(abs, "utf8");
    } catch (err) {
      options.warnings?.record("files_unreadable", errnoOf(err), { file: repoPath });
      return hits;
    }
    let parsed: ReturnType<typeof parseFile>;
    try {
      parsed = options.inputs
        ? options.inputs.js(abs, source)
        : parseFile({ absolutePath: abs, source });
    } catch {
      options.warnings?.record("files_unparsed", "language-js", { file: repoPath });
      return hits;
    }
    const roots = parsed.jsxElements;
    if (!roots || roots.length === 0) return hits;

    const visit = (el: JsxElementInfo): void => {
      if (countNodes(el) >= MIN_SUBTREE_NODES) {
        const hash = hashJsxSubtree(el, source);
        if (hash.tokens >= 8) {
          hits.push({
            hash: hash.shape,
            hit: {
              file: repoPath,
              lines: [el.lines[0], el.lines[1]],
              rootName: el.name,
            },
          });
        }
      }
      for (const child of el.children) {
        if (child.kind === "element") visit(child.element);
      }
    };
    for (const root of roots) visit(root);
    return hits;
  });

  for (const hits of perFile) {
    for (const { hash, hit } of hits) push(byShape, hash, hit);
  }

  return { byShape };
}

function countNodes(el: JsxElementInfo): number {
  let n = 1;
  for (const child of el.children) {
    if (child.kind === "element") n += countNodes(child.element);
    else n += 1;
  }
  return n;
}

function push(map: Map<string, JsxShapeHit[]>, key: string, hit: JsxShapeHit): void {
  const list = map.get(key);
  if (list) list.push(hit);
  else map.set(key, [hit]);
}

function toRepoPath(root: string, abs: string): string {
  const rel = abs.startsWith(root) ? relative(root, abs) : abs;
  return rel.split(sep).join("/");
}
