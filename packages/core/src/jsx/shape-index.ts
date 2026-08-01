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
  /** Absolute repo root. */
  root: string;
  /** Absolute paths discovered by the scan. */
  files: string[];
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
 * to read or parse are skipped silently. Performance budget: a parsed
 * JSX tree is walked once per "interesting" element; hashing reuses the
 * same source slice the existing AST walker already produced.
 */
export async function buildJsxShapeIndex(
  options: BuildJsxShapeIndexOptions,
): Promise<JsxShapeIndex> {
  const byShape = new Map<string, JsxShapeHit[]>();
  const candidateFiles = options.files.filter((f) => SOURCE_EXT_RE.test(f));

  await Promise.all(
    candidateFiles.map(async (abs) => {
      let source: string;
      try {
        source = await readFile(abs, "utf8");
      } catch {
        return;
      }
      let parsed: ReturnType<typeof parseFile>;
      try {
        parsed = parseFile({ absolutePath: abs, source });
      } catch {
        return;
      }
      const roots = parsed.jsxElements;
      if (!roots || roots.length === 0) return;
      const repoPath = toRepoPath(options.root, abs);

      const visit = (el: JsxElementInfo): void => {
        if (countNodes(el) >= MIN_SUBTREE_NODES) {
          const hash = hashJsxSubtree(el, source);
          if (hash.tokens >= 8) {
            push(byShape, hash.shape, {
              file: repoPath,
              lines: [el.lines[0], el.lines[1]],
              rootName: el.name,
            });
          }
        }
        for (const child of el.children) {
          if (child.kind === "element") visit(child.element);
        }
      };
      for (const root of roots) visit(root);
    }),
  );

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
