import { readFile } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import fg from "fast-glob";
import ignore, { type Ignore } from "ignore";

export interface DiscoverOptions {
  root: string;
  include: string[];
  exclude: string[];
  /**
   * Apply the repository's `.gitignore` files. Defaults to true —
   * `CLAUDE.md` has listed this as a locked stack decision since v0, and
   * without it a scan charges you for your own build output. On
   * `buildfest` a gitignored `migrate-output/` was 20.8% of the report
   * and 86% of all duplicate-block findings.
   */
  respectGitignore?: boolean;
}

/**
 * Directories that are never source, whatever the user's `exclude` says.
 * These are structural rather than configurable: `exclude` can be
 * replaced wholesale by a user config, and walking `.git` or a vendored
 * virtualenv is never what anyone meant.
 */
const NEVER_WALK = [
  "**/.git/**",
  "**/.hg/**",
  "**/.svn/**",
  "**/.venv/**",
  "**/venv/**",
  "**/.tox/**",
  "**/.mypy_cache/**",
  "**/.pytest_cache/**",
  "**/.ruff_cache/**",
  "**/.turbo/**",
  "**/.gradle/**",
  "**/node_modules/**",
];

/**
 * Walk the given root directory and return absolute paths to all source
 * files matching `include` minus those matching `exclude`, minus
 * anything the repository's `.gitignore` files exclude.
 *
 * Dot-directories ARE walked. They were skipped until 0.18.0, which
 * meant a repo keeping its source under `.agents/` or `.server/`
 * received "No crimes detected. Suspiciously clean." and a zero exit
 * code for code that was never opened.
 *
 * Moved from `@crimes/language-js` in 0.12.0 — file discovery is
 * universal-pack infrastructure and no longer depends on the JS pack.
 */
export async function discoverFiles(options: DiscoverOptions): Promise<string[]> {
  const entries = await fg(options.include, {
    cwd: options.root,
    ignore: [...options.exclude, ...NEVER_WALK],
    absolute: true,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    suppressErrors: true,
  });
  const sorted = entries.sort();
  if (options.respectGitignore === false) return sorted;
  return applyGitignore(options.root, sorted);
}

/**
 * Filter `files` through every `.gitignore` between the repo root and
 * each file. Git's precedence rules apply: a deeper `.gitignore`
 * overrides a shallower one, so the deepest explicit decision wins.
 */
async function applyGitignore(root: string, files: string[]): Promise<string[]> {
  const gitignores = await fg([".gitignore", "**/.gitignore"], {
    cwd: root,
    ignore: NEVER_WALK,
    absolute: true,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    suppressErrors: true,
  });
  if (gitignores.length === 0) return files;

  // dir -> matcher, shallowest first so deeper rules are applied last.
  const matchers: Array<{ dir: string; ig: Ignore }> = [];
  for (const path of gitignores.sort()) {
    let body: string;
    try {
      body = await readFile(path, "utf8");
    } catch {
      continue;
    }
    matchers.push({ dir: dirname(path), ig: ignore().add(body) });
  }
  matchers.sort((a, b) => a.dir.length - b.dir.length);

  return files.filter((file) => {
    let ignored = false;
    for (const { dir, ig } of matchers) {
      const rel = relative(dir, file);
      // Only applies to files at or below the .gitignore's directory.
      if (rel.startsWith("..") || rel === "") continue;
      const result = ig.test(rel.split(sep).join("/"));
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return !ignored;
  });
}
