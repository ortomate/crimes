/**
 * A JS package's own tooling exclusions: ESLint and Prettier.
 *
 * The pyproject reader's claim, carried over: a directory a package
 * excludes from its linter *and* its formatter is one it does not
 * maintain by hand. A private frontend names `js/lib/` (old third-party
 * libraries) in both `eslint.config.mjs` and
 * `.prettierignore`; it accounted for 271 of 1,596 findings, and the
 * top-ranked file in the report.
 *
 * The same three rules as `tooling-excludes.ts` hold, and two more are
 * specific to these formats:
 *
 * **Configuration is read as text, never executed.** `eslint.config.*`
 * is a JavaScript module. Running it would make discovered
 * configuration executable, which this tool never does. The reader
 * recognises one shape — an object literal whose only key is `ignores`,
 * holding string literals — and ignores everything else. That shape is
 * also the only one ESLint treats as a *global* ignore: `ignores` beside
 * `files` or `rules` only scopes that one config object.
 *
 * **A negation voids the file.** A `!pattern` re-includes something a
 * broader pattern excluded. Dropping the negation and keeping the rest
 * would exclude more than the repo does, so the whole source yields
 * nothing instead.
 */
import type { ToolingExclude } from "./tooling-excludes.js";

/** Ignore files in gitignore syntax, and the tool each speaks for. */
export const IGNORE_FILES: readonly { file: string; tool: string }[] = [
  { file: ".prettierignore", tool: "prettier" },
  { file: ".eslintignore", tool: "eslint" },
];

/** Flat-config filenames ESLint looks for, in its own lookup order. */
export const ESLINT_FLAT_CONFIGS: readonly string[] = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
];

/**
 * Read a gitignore-syntax ignore file. Returns `undefined` when it holds
 * a negation or no usable pattern.
 */
export function readIgnoreFile(
  text: string,
  source: { file: string; tool: string },
): ToolingExclude | undefined {
  const patterns: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("!")) return undefined;
    patterns.push(anchorless(line));
  }
  if (patterns.length === 0) return undefined;
  return { table: source.file, key: "patterns", tool: source.tool, patterns };
}

/**
 * Global `ignores` from an ESLint flat config's source text.
 *
 * Matches `{ ignores: [ ... ] }` with nothing else in the object. Every
 * element must be a plain string literal; one that is not (a variable,
 * a spread, a template with `${}`) drops that object.
 */
export function readEslintFlatIgnores(
  text: string,
  file: string,
): ToolingExclude | undefined {
  const objectRe = /\{\s*ignores\s*:\s*\[([^\]]*)\]\s*,?\s*\}/g;
  const patterns: string[] = [];
  for (const match of text.matchAll(objectRe)) {
    const elements = parseStringLiterals(match[1]!);
    if (elements === undefined) continue;
    if (elements.some((e) => e.startsWith("!"))) return undefined;
    patterns.push(...elements.map(anchorless));
  }
  if (patterns.length === 0) return undefined;
  return { table: file, key: "ignores", tool: "eslint", patterns };
}

/**
 * Parse a comma-separated list of string literals, or return `undefined`
 * when anything else appears in it.
 */
function parseStringLiterals(body: string): string[] | undefined {
  const out: string[] = [];
  const literal = /\s*(?:'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\$]*)`)\s*(?:,|$)/y;
  let index = 0;
  const trimmed = body.trim();
  if (trimmed === "") return undefined;
  while (index < trimmed.length) {
    literal.lastIndex = index;
    const m = literal.exec(trimmed);
    if (!m) return undefined;
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
    index = literal.lastIndex;
  }
  return out;
}

/**
 * Drop a leading `/` or `./`. Patterns are applied anchored to the
 * directory holding the config (see `scan-tooling-excludes.ts`), so the
 * prefix carries no information, and without stripping it `/js/lib/`
 * and `js/lib/*` would not corroborate.
 */
function anchorless(pattern: string): string {
  return pattern.replace(/^\.?\/+/, "");
}
