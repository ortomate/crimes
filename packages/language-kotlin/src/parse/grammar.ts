/**
 * Lazy Kotlin grammar loader.
 *
 * The runtime comes from `@crimes/language-py`'s
 * `ensureTreeSitterRuntime`, which owns the one `Parser.init` call per
 * process (see there for why a second call breaks the first pack). This
 * module only locates and loads `tree-sitter-kotlin.wasm`, and only when a
 * `.kt` or `.kts` file is actually parsed.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTreeSitterRuntime } from "@crimes/language-py";
import type { Language, Parser } from "web-tree-sitter";

const GRAMMAR_BASENAME = "tree-sitter-kotlin.wasm";

/** Escape hatch for packaging layouts the walk below does not anticipate. */
const GRAMMAR_ENV_VAR = "CRIMES_KOTLIN_GRAMMAR_WASM";

export class KotlinGrammarNotFoundError extends Error {
  constructor(searched: string[]) {
    super(
      `could not locate ${GRAMMAR_BASENAME}. Searched:\n` +
        searched.map((p) => `  - ${p}`).join("\n") +
        `\nSet ${GRAMMAR_ENV_VAR} to an explicit path to override.`,
    );
    this.name = "KotlinGrammarNotFoundError";
  }
}

/**
 * Locate the grammar by walking up from this module: the same compiled
 * code runs from `packages/cli/dist`, `packages/language-kotlin/dist` and
 * straight from source under vitest.
 */
export function resolveKotlinGrammarPath(): string {
  const override = process.env[GRAMMAR_ENV_VAR];
  if (override !== undefined && override.length > 0) {
    if (!existsSync(override)) throw new KotlinGrammarNotFoundError([override]);
    return override;
  }
  const searched: string[] = [];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 6; up += 1) {
    for (const candidate of [
      resolve(dir, GRAMMAR_BASENAME),
      resolve(dir, "vendor", GRAMMAR_BASENAME),
      resolve(dir, "dist", GRAMMAR_BASENAME),
    ]) {
      searched.push(candidate);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new KotlinGrammarNotFoundError(searched);
}

let languagePromise: Promise<Language> | undefined;

async function loadKotlinLanguage(): Promise<Language> {
  if (languagePromise === undefined) {
    languagePromise = (async () => {
      const { Language: TSLanguage } = await ensureTreeSitterRuntime();
      return TSLanguage.load(resolveKotlinGrammarPath());
    })();
  }
  return languagePromise;
}

/**
 * A fresh parser for one file; the caller deletes it. The grammar loads
 * once per process. A parser reused across files kept parse-stack
 * allocations alive between them: on 1,604 Swift files a shared parser
 * ended at 1.77 GB RSS and a per-file one at 1.06 GB, slightly faster.
 */
export async function createKotlinParser(): Promise<Parser> {
  const { Parser: TSParser } = await ensureTreeSitterRuntime();
  const parser = new TSParser();
  parser.setLanguage(await loadKotlinLanguage());
  return parser;
}

let parserPromise: Promise<Parser> | undefined;

/** A shared parser, for callers that parse one file. Prefer {@link createKotlinParser}. */
export async function ensureKotlinParser(): Promise<Parser> {
  if (parserPromise === undefined) {
    parserPromise = (async () => {
      return createKotlinParser();
    })();
  }
  return parserPromise;
}
