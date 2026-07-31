/**
 * Lazy tree-sitter runtime + Python grammar loader.
 *
 * Three properties matter here:
 *
 *  1. **Lazy.** A JS-only repo must pay nothing for the Python pack
 *     existing. `packages/core` imports this package eagerly to read
 *     `PY_EXTENSIONS` for the pack router, so `web-tree-sitter` is
 *     behind a dynamic import — nothing loads until the first `.py`
 *     file is actually parsed.
 *  2. **No native code.** `web-tree-sitter` is pure JS + WASM and the
 *     grammar is a vendored `.wasm` blob, so there is no addon to build
 *     and no install script to run. See `vendor/ATTRIBUTION.md`.
 *  3. **Bundler-independent asset resolution.** `packages/cli` bundles
 *     this code into a single `dist/index.js`, which moves it away from
 *     its own `node_modules`. Emscripten's default behaviour is to
 *     resolve `web-tree-sitter.wasm` against `import.meta.url`, which is
 *     the *bundle's* location — so both WASM files are resolved through
 *     one explicit walk below and handed to the runtime via
 *     `locateFile`, rather than left to the bundler's layout.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Parser } from "web-tree-sitter";

const GRAMMAR_BASENAME = "tree-sitter-python.wasm";
const RUNTIME_BASENAME = "web-tree-sitter.wasm";

/**
 * Escape hatch for packaging layouts the candidate walk doesn't
 * anticipate. Documented in `docs/packs.md`.
 */
const GRAMMAR_ENV_VAR = "CRIMES_PY_GRAMMAR_WASM";

export class PythonGrammarNotFoundError extends Error {
  constructor(basename: string, searched: string[]) {
    super(
      `could not locate ${basename}. Searched:\n` +
        searched.map((p) => `  - ${p}`).join("\n") +
        (basename === GRAMMAR_BASENAME
          ? `\nSet ${GRAMMAR_ENV_VAR} to an explicit path to override.`
          : ""),
    );
    this.name = "PythonGrammarNotFoundError";
  }
}

/**
 * Locate a WASM asset that ships alongside this code.
 *
 * The same built output runs from several different directory layouts:
 *
 *  - `packages/cli/dist/index.js`         (published bundle; assets copied alongside)
 *  - `packages/language-py/dist/index.js` (workspace build; assets copied alongside)
 *  - `packages/language-py/src/parse/`    (vitest, straight from source)
 *
 * Rather than hard-code three relative paths that silently rot, walk up
 * from this module looking for the asset either directly in a directory
 * or under a `vendor/` child of it.
 */
export function resolveWasmAsset(basename: string): string {
  const searched: string[] = [];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 6; up += 1) {
    for (const candidate of [
      resolve(dir, basename),
      resolve(dir, "vendor", basename),
      resolve(dir, "dist", basename),
    ]) {
      searched.push(candidate);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new PythonGrammarNotFoundError(basename, searched);
}

/** Path to the vendored Python grammar, honouring the env override. */
export function resolveGrammarPath(): string {
  const override = process.env[GRAMMAR_ENV_VAR];
  if (override !== undefined && override.length > 0) {
    if (!existsSync(override)) {
      throw new PythonGrammarNotFoundError(GRAMMAR_BASENAME, [override]);
    }
    return override;
  }
  return resolveWasmAsset(GRAMMAR_BASENAME);
}

let parserPromise: Promise<Parser> | undefined;

/**
 * Return the shared, initialised Python parser. The WASM runtime and
 * grammar are loaded exactly once per process; concurrent callers await
 * the same promise rather than racing two initialisations.
 */
export async function ensurePythonParser(): Promise<Parser> {
  if (parserPromise === undefined) {
    parserPromise = (async () => {
      const { Language, Parser: TSParser } = await import("web-tree-sitter");
      await TSParser.init({
        locateFile(path: string) {
          // Only the runtime's own blob comes through here; anything
          // else we don't recognise is passed straight back so the
          // runtime's default handling still applies.
          if (path.endsWith(RUNTIME_BASENAME)) {
            return resolveWasmAsset(RUNTIME_BASENAME);
          }
          return path;
        },
      } as Parameters<typeof TSParser.init>[0]);
      const language = await Language.load(resolveGrammarPath());
      const parser = new TSParser();
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
