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
  root: string;
  files: string[];
}

const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const MIN_EXACT_DUPLICATE_TOKENS = 40;
const MIN_EXACT_DUPLICATE_LINES = 8;

export async function buildFunctionHashIndex(
  options: BuildFunctionHashIndexOptions,
): Promise<FunctionHashIndex> {
  const byExact = new Map<string, FunctionHit[]>();
  const byShape = new Map<string, FunctionHit[]>();
  const candidate = options.files.filter((f) => SOURCE_EXT_RE.test(f));

  await Promise.all(
    candidate.map(async (abs) => {
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
      const repoPath = toRepoPath(options.root, abs);
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
        push(byExact, hash.exact, hit);
        if (hash.tokens >= 40) push(byShape, hash.shape, hit);
      }
    }),
  );

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
