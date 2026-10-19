/**
 * Lazy Java grammar loader.
 *
 * The runtime comes from `@crimes/language-py`'s
 * `ensureTreeSitterRuntime`, which owns the one `Parser.init` call per
 * process (see there for why a second call breaks the first pack). This
 * module only locates and loads `tree-sitter-java.wasm`, and only when a
 * `.java` file is actually parsed.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTreeSitterRuntime } from "@crimes/language-py";
import type { Parser } from "web-tree-sitter";

const GRAMMAR_BASENAME = "tree-sitter-java.wasm";

/** Escape hatch for packaging layouts the walk below does not anticipate. */
const GRAMMAR_ENV_VAR = "CRIMES_JAVA_GRAMMAR_WASM";

export class JavaGrammarNotFoundError extends Error {
  constructor(searched: string[]) {
    super(
      `could not locate ${GRAMMAR_BASENAME}. Searched:\n` +
        searched.map((p) => `  - ${p}`).join("\n") +
        `\nSet ${GRAMMAR_ENV_VAR} to an explicit path to override.`,
    );
    this.name = "JavaGrammarNotFoundError";
  }
}

/**
 * Locate the grammar by walking up from this module: the same compiled
 * code runs from `packages/cli/dist`, `packages/language-java/dist` and
 * straight from source under vitest.
 */
export function resolveJavaGrammarPath(): string {
  const override = process.env[GRAMMAR_ENV_VAR];
  if (override !== undefined && override.length > 0) {
    if (!existsSync(override)) throw new JavaGrammarNotFoundError([override]);
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
  throw new JavaGrammarNotFoundError(searched);
}

let parserPromise: Promise<Parser> | undefined;

/** The shared, initialised Java parser. Loaded once per process. */
export async function ensureJavaParser(): Promise<Parser> {
  if (parserPromise === undefined) {
    parserPromise = (async () => {
      const { Language, Parser: TSParser } = await ensureTreeSitterRuntime();
      const language = await Language.load(resolveJavaGrammarPath());
      const parser = new TSParser();
      parser.setLanguage(language);
      return parser;
    })();
  }
  return parserPromise;
}
