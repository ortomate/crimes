import { readFile } from "node:fs/promises";
import { basename, dirname, relative, sep } from "node:path";
import {
  TEST_DIR_RE,
  isTestFile as isTestPath,
  testBaseCovers,
} from "./util/test-files.js";

/**
 * Matches the JS test-file naming conventions.
 *
 * Retained as an export for back-compat; new code should reach for
 * `isTestFile` / `testBaseCovers` in `util/test-files.js`, which know
 * every supported language's convention rather than only this one.
 */
export const TEST_EXT =
  /(?:\.(?:test|spec)|_(?:test|spec))\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Source extensions `likely_tests` reasons about. Python joined in
 * 0.14.0 — before that a `.py` target stripped to nothing here, matched
 * nothing, and `crimes context` reported "no likely tests" for a fully
 * covered module.
 */
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|cts|mts|py|pyi)$/;
const JS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|cts|mts)$/;
const PY_EXT = /\.(py|pyi)$/;

/**
 * Discover the test files that likely cover `targetAbs`. Two passes:
 *
 *  1. **By name.** A sibling test file, or one under a `__tests__/` or
 *     `tests/` directory, whose basename indicates it covers the
 *     target. The naming conventions live in `util/test-files.ts` —
 *     including Python's `test_<name>.py`, a prefix where every other
 *     supported convention is a suffix.
 *  2. **By import.** Test files that reference the target. Restricted
 *     to test files so `likely_tests` doesn't list arbitrary consumers.
 */
export async function findLikelyTests(args: {
  root: string;
  fileRel: string;
  targetAbs: string;
  allFiles: string[];
}): Promise<string[]> {
  const { root, fileRel, targetAbs, allFiles } = args;
  const targetBaseNoExt = basename(fileRel).replace(SOURCE_EXT, "");
  const targetDir = toRepoPath(dirname(fileRel));
  const result = new Set<string>();

  for (const abs of allFiles) {
    if (abs === targetAbs) continue;
    const rel = toRepoPath(relative(root, abs));
    if (!isTestPath(rel)) continue;

    const candidateBase = basename(rel).replace(SOURCE_EXT, "");
    if (!testBaseCovers(candidateBase, targetBaseNoExt)) continue;

    // A basename match counts when the test sits beside the target, or
    // inside a directory that exists to hold tests. Without the second
    // condition an unrelated `pkg/other/rates.py` would be offered as
    // coverage purely for sharing a name.
    if (toRepoPath(dirname(rel)) === targetDir || TEST_DIR_RE.test(rel)) {
      result.add(rel);
    }
  }

  for (const abs of allFiles) {
    if (abs === targetAbs) continue;
    const rel = toRepoPath(relative(root, abs));
    if (result.has(rel)) continue;
    if (!isTestPath(rel)) continue;

    let source: string;
    try {
      source = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (importsTarget({ source, fromAbs: abs, targetAbs, root })) {
      result.add(rel);
    }
  }

  return [...result].sort();
}

/** @deprecated Prefer `isTestFile` from `util/test-files.js`. */
export function isTestFile(rel: string): boolean {
  return isTestPath(rel);
}

function importsTarget(args: {
  source: string;
  fromAbs: string;
  targetAbs: string;
  root: string;
}): boolean {
  const { source, fromAbs, targetAbs, root } = args;
  if (PY_EXT.test(targetAbs)) {
    return pythonImportsTarget({ source, targetAbs, root });
  }
  if (JS_EXT.test(targetAbs)) {
    return jsImportsTarget({ source, fromAbs, targetAbs });
  }
  return false;
}

/**
 * Python has no relative *path* imports, so the JS branch's `./foo`
 * specifier matching finds nothing. What a Python test actually writes
 * is a dotted module path (`from billing.rates import rate_for`) or a
 * relative-dot one (`from .rates import rate_for`).
 *
 * Matches progressively shorter dotted suffixes rather than resolving
 * the module path exactly. `likely_tests` is a discovery hint for a
 * human or agent, not a scoring input, so a slightly generous match is
 * the right trade — exact resolution lives in the import graph, which
 * is what `test_gap` and `blast_radius` read.
 */
function pythonImportsTarget(args: {
  source: string;
  targetAbs: string;
  root: string;
}): boolean {
  const { source, targetAbs, root } = args;
  const rel = toRepoPath(relative(root, targetAbs)).replace(PY_EXT, "");
  const segments = rel.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return false;

  // `__init__` names its package rather than a module inside it.
  const last = segments[segments.length - 1]!;
  const moduleTail = last === "__init__" ? segments.slice(0, -1) : segments;
  if (moduleTail.length === 0) return false;

  const leaf = moduleTail[moduleTail.length - 1]!;
  const parent = moduleTail.slice(0, -1).join(".");

  for (let i = 0; i < moduleTail.length; i += 1) {
    const dotted = escapeRegExp(moduleTail.slice(i).join("."));
    // `from <mod> import ...` / `import <mod>`, allowing relative dots.
    if (new RegExp(`\\bfrom\\s+\\.*${dotted}\\s+import\\b`).test(source)) return true;
    if (new RegExp(`\\bimport\\s+${dotted}\\b`).test(source)) return true;
  }

  // `from <parent> import <leaf>` — the module imported as a name.
  if (
    parent.length > 0 &&
    new RegExp(
      `\\bfrom\\s+\\.*${escapeRegExp(parent)}\\s+import\\s+[^\\n]*\\b${escapeRegExp(leaf)}\\b`,
    ).test(source)
  ) {
    return true;
  }

  // `from . import <leaf>` — sibling module in the same package.
  return new RegExp(
    `\\bfrom\\s+\\.+\\s+import\\s+[^\\n]*\\b${escapeRegExp(leaf)}\\b`,
  ).test(source);
}

function jsImportsTarget(args: {
  source: string;
  fromAbs: string;
  targetAbs: string;
}): boolean {
  const { source, fromAbs, targetAbs } = args;
  const fromDir = dirname(fromAbs);

  const targetNoExt = targetAbs.replace(JS_EXT, "");
  let rel = relative(fromDir, targetNoExt);
  rel = rel.split(sep).join("/");
  if (!rel.startsWith(".")) rel = "./" + rel;

  const candidates = new Set<string>([
    rel,
    `${rel}.ts`,
    `${rel}.tsx`,
    `${rel}.js`,
    `${rel}.jsx`,
    `${rel}.mjs`,
    `${rel}.cjs`,
  ]);

  if (basename(targetNoExt) === "index") {
    candidates.add(rel.replace(/\/index$/, ""));
  }

  for (const c of candidates) {
    const re = new RegExp(
      `(?:from|require|import)\\s*\\(?\\s*["']${escapeRegExp(c)}["']`,
    );
    if (re.test(source)) return true;
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toRepoPath(p: string): string {
  return p.split(sep).join("/");
}
