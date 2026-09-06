import type { AnalysisInputs } from "../analysis-inputs.js";
/**
 * Repo-wide function hash index for the duplication detectors.
 *
 * Built once per scan and attached to `DetectorContext.functionHashIndex`.
 * Two views: `byExact` for `exact_duplicate_block` (verbatim function
 * bodies modulo whitespace/comments) and `byShape` for
 * `near_duplicate_block` (same shape, possibly renamed identifiers).
 */

import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { parseFile } from "@crimes/language-js";
import type { ParsedFunction } from "@crimes/language-js";
import { mapWithConcurrency } from "../util/concurrency.js";
import { type CoverageWarningLog, errnoOf } from "../discovery/coverage-warnings.js";
import { hashFunction } from "./hash.js";

export interface FunctionHit {
  file: string;
  symbol: string | undefined;
  lines: [number, number];
  tokens: number;
}

export interface FunctionHashIndex {
  byExact: Map<string, FunctionHit[]>;
  byShape: Map<string, FunctionHit[]>;
}

export interface BuildFunctionHashIndexOptions {
  inputs?: AnalysisInputs;
  root: string;
  files: string[];
  /**
   * Where files this builder could not read or parse get recorded. A
   * file that fails here contributes no duplicate hits, which is
   * indistinguishable from "this file has no duplicated functions" —
   * so the skip has to be reported or the absence reads as a clean bill
   * of health.
   */
  warnings?: CoverageWarningLog;
}

const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const MIN_EXACT_DUPLICATE_TOKENS = 40;
const MIN_EXACT_DUPLICATE_LINES = 8;

/**
 * One file's contribution to the index, held until every file has been
 * read. Insertion into the shared maps is deferred so that map order is
 * a function of the file list rather than of which `readFile` finished
 * first — see the note on determinism below.
 */
interface FileHits {
  exact: Array<{ hash: string; hit: FunctionHit }>;
  shape: Array<{ hash: string; hit: FunctionHit }>;
}

/**
 * Build the repo-wide function hash index.
 *
 * Two properties this function owes its callers:
 *
 * - **Bounded IO.** Candidate files are read through
 *   {@link mapWithConcurrency}, not `Promise.all`, so the descriptor
 *   count stays flat as the repo grows.
 * - **Deterministic map order.** `exact_duplicate_block` anchors a
 *   finding on the lex-first file of a duplicate set, and a function
 *   that belongs to more than one duplicate group would otherwise pick
 *   its group by map insertion order — which tracked `readFile`
 *   completion order, so the evidence string a user read changed run to
 *   run on an unchanged tree. Files are sorted and their hits inserted
 *   in that order, so the same tree produces the same index.
 */
export async function buildFunctionHashIndex(
  options: BuildFunctionHashIndexOptions,
): Promise<FunctionHashIndex> {
  const byExact = new Map<string, FunctionHit[]>();
  const byShape = new Map<string, FunctionHit[]>();
  const candidate = options.files.filter((f) => SOURCE_EXT_RE.test(f)).sort();

  const perFile = await mapWithConcurrency(candidate, async (abs) => {
    const hits: FileHits = { exact: [], shape: [] };
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
    for (const fn of parsed.functions) {
      if (skipFunction(fn)) continue;
      const hash = hashFunction(fn, source);
      if (
        hash.tokens < MIN_EXACT_DUPLICATE_TOKENS ||
        lineSpan(fn) < MIN_EXACT_DUPLICATE_LINES
      ) {
        continue;
      }
      const hit: FunctionHit = {
        file: repoPath,
        symbol: fn.name,
        lines: [fn.startLine, fn.endLine],
        tokens: hash.tokens,
      };
      hits.exact.push({ hash: hash.exact, hit });
      if (hash.tokens >= 40) hits.shape.push({ hash: hash.shape, hit });
    }
    return hits;
  });

  for (const hits of perFile) {
    for (const { hash, hit } of hits.exact) push(byExact, hash, hit);
    for (const { hash, hit } of hits.shape) push(byShape, hash, hit);
  }

  return { byExact, byShape };
}

function skipFunction(fn: ParsedFunction): boolean {
  // Test callbacks are intentionally repetitive and skew the duplicate
  // signal. Defer to the existing shape classification.
  return fn.shape === "test_callback";
}

function lineSpan(fn: ParsedFunction): number {
  return fn.endLine - fn.startLine + 1;
}

function push(map: Map<string, FunctionHit[]>, key: string, hit: FunctionHit): void {
  const list = map.get(key);
  if (list) list.push(hit);
  else map.set(key, [hit]);
}

function toRepoPath(root: string, abs: string): string {
  const rel = abs.startsWith(root) ? relative(root, abs) : abs;
  return rel.split(sep).join("/");
}
