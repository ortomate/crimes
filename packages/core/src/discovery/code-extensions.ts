import { extname } from "node:path";

/**
 * Extensions of programming languages crimes has no language pack for.
 *
 * A file with one of these extensions is still read by the universal
 * pack (size, comments, TODOs), so it is counted as scanned. What it does
 * not get is everything a parser buys: functions, imports, tests, and the
 * blast radius and test gap derived from them. That difference is easy to
 * miss — a Java repository scanned before 0.29.4 reported "complete" for
 * every `.java` file — so these files get their own coverage warning.
 *
 * Deliberately limited to source languages. Markup, data and config files
 * (`.md`, `.json`, `.yaml`) are fully served by the universal pack, and
 * shell scripts are glue rather than application code; warning about them
 * would bury the gap that matters.
 *
 * An extension stops appearing here in practice once a pack claims it:
 * callers check the router first.
 */
const UNSUPPORTED_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".m",
  ".mm",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".cs",
  ".fs",
  ".scala",
  ".groovy",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cxx",
  ".hpp",
  ".dart",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
  ".clj",
  ".lua",
  ".vue",
  ".svelte",
]);

/** True when `path` is source code in a language no pack parses. */
export function isUnsupportedCodeFile(path: string): boolean {
  return UNSUPPORTED_CODE_EXTENSIONS.has(extname(path).toLowerCase());
}
