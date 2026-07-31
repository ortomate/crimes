/**
 * Lazy tree-sitter runtime + Python grammar loader.
 *
 * Two properties matter here:
 *
 *  1. **Lazy.** A JS-only repo must pay nothing for the Python pack
 *     existing. Nothing is loaded until the first `.py` file is parsed.
 *  2. **No native code.** `web-tree-sitter` is pure JS + WASM and the
 *     grammar is a vendored `.wasm` blob, so there is no addon to build
 *     and no install script to run. See `vendor/ATTRIBUTION.md`.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";

const GRAMMAR_BASENAME = "tree-sitter-python.wasm";

/**
 * Escape hatch for packaging layouts the candidate walk below doesn't
 * anticipate. Documented in `docs/packs.md`.
 */
const GRAMMAR_ENV_VAR = "CRIMES_PY_GRAMMAR_WASM";

export class PythonGrammarNotFoundError extends Error {
  constructor(searched: string[]) {
    super(
      `could not locate ${GRAMMAR_BASENAME}. Searched:\n` +
        searched.map((p) => `  - ${p}`).join("\n") +
        `\nSet ${GRAMMAR_ENV_VAR} to an explicit path to override.`,
    );
    this.name = "PythonGrammarNotFoundError";
  }
}

/**
 * Locate the vendored grammar.
 *
 * The same built code runs from three different directory layouts:
 *
 *  - `packages/cli/dist/index.js`      (published bundle; grammar copied alongside)
 *  - `packages/language-py/dist/index.js` (workspace build; grammar copied alongside)
 *  - `packages/language-py/src/parse/grammar.ts` (vitest, straight from source)
 *
 * Rather than hard-code three relative paths that silently rot, walk up
 * from this module looking for the grammar either directly in a
 * directory or under a `vendor/` child of it.
 */
export function resolveGrammarPath(): string {
  const override = process.env[GRAMMAR_ENV_VAR];
  if (override !== undefined && override.length > 0) {
    if (!existsSync(override)) {
      throw new PythonGrammarNotFoundError([override]);
    }
    return override;
  }

  const searched: string[] = [];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 6; up += 1) {
    for (const candidate of [
      resolve(dir, GRAMMAR_BASENAME),
      resolve(dir, "vendor", GRAMMAR_BASENAME),
    ]) {
      searched.push(candidate);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new PythonGrammarNotFoundError(searched);
}

let parserPromise: Promise<Parser> | undefined;

/**
 * Return the shared, initialised Python parser. The WASM runtime and
 * grammar are loaded exactly once per process; concurrent callers await
 * the same promise rather than racing two initialisations.
 */
export async function getPythonParser(): Promise<Parser> {
  if (parserPromise === undefined) {
    parserPromise = (async () => {
      await Parser.init();
      const language = await Language.load(resolveGrammarPath());
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })();
  }
  return parserPromise;
}

/**
 * Drop the cached parser. Test-only — lets a test assert the lazy-load
 * path more than once in a single process.
 */
export function resetPythonParserForTests(): void {
  parserPromise = undefined;
}
