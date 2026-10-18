import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { CrimesConfig } from "./config.js";
import type { ToolingExclude, ToolingSkip } from "./manifest/tooling-excludes.js";
import {
  applyToolingExcludes,
  corroborate,
  readPyprojectExcludes,
} from "./manifest/tooling-excludes.js";
import {
  ESLINT_FLAT_CONFIGS,
  IGNORE_FILES,
  readEslintFlatIgnores,
  readIgnoreFile,
} from "./manifest/js-tooling-excludes.js";

/**
 * Drop files the repo's own tooling excludes, and say which they were.
 *
 * Two independent sources, each corroborated on its own:
 *
 * - `pyproject.toml` at the scan root only — a nested package's config
 *   governs its own tree and following those is a separate decision.
 * - ESLint and Prettier configs in any directory that holds discovered
 *   files. A JS package is routinely nested (`apps/web/frontend`),
 *   and its configs speak for that directory: their patterns are applied
 *   anchored to it.
 *
 * Returns everything untouched when nothing corroborates, or when the
 * user has set `honourToolingExcludes: false`.
 */
export function applyRepoToolingExcludes(
  root: string,
  discovered: string[],
  config: CrimesConfig,
): { allFiles: string[]; toolingSkips: ToolingSkip[] } {
  if (config.honourToolingExcludes === false) {
    return { allFiles: discovered, toolingSkips: [] };
  }
  const toolingSkips: ToolingSkip[] = [];
  let kept = discovered;

  const pyproject = readText(resolve(root, "pyproject.toml"));
  if (pyproject !== undefined) {
    const corroborated = corroborate(readPyprojectExcludes(pyproject));
    if (corroborated.length > 0) {
      const result = applyToolingExcludes(
        kept,
        (absolute) => toPosix(relative(root, absolute)),
        corroborated,
      );
      kept = result.kept;
      toolingSkips.push(...result.skipped);
    }
  }

  for (const dir of candidateDirectories(root, kept)) {
    const entries = readJsToolingExcludes(dir);
    const corroborated = corroborate(entries).map((e) => ({
      ...e,
      // Anchored: ESLint resolves patterns against the config's
      // directory, and an unanchored Prettier entry matching at any depth
      // is the broader reading. Where they differ, take the narrower.
      pattern: `/${e.pattern}`,
    }));
    if (corroborated.length === 0) continue;
    const prefix = toPosix(relative(root, dir));
    const result = applyToolingExcludes(
      kept,
      (absolute) => toPosix(relative(dir, absolute)),
      corroborated,
    );
    kept = result.kept;
    for (const skip of result.skipped) {
      const pattern = skip.pattern.slice(1);
      toolingSkips.push({
        ...skip,
        file: prefix === "" ? skip.file : `${prefix}/${skip.file}`,
        pattern: prefix === "" ? pattern : `${prefix}/${pattern}`,
        authorities: skip.authorities.map((a) => (prefix === "" ? a : `${prefix}/${a}`)),
      });
    }
  }

  return { allFiles: kept, toolingSkips };
}

function readJsToolingExcludes(dir: string): ToolingExclude[] {
  const entries: ToolingExclude[] = [];
  for (const source of IGNORE_FILES) {
    const text = readText(join(dir, source.file));
    const entry = text === undefined ? undefined : readIgnoreFile(text, source);
    if (entry) entries.push(entry);
  }
  // ESLint uses the first flat config it finds; so does this.
  for (const file of ESLINT_FLAT_CONFIGS) {
    const text = readText(join(dir, file));
    if (text === undefined) continue;
    const entry = readEslintFlatIgnores(text, file);
    if (entry) entries.push(entry);
    break;
  }
  return entries;
}

/**
 * Every directory from the root down to each discovered file's parent,
 * deepest last so a root-level config is applied first. Only these can
 * hold a config that governs a scanned file, and checking them costs a
 * handful of `stat`s per directory rather than a second tree walk.
 */
function candidateDirectories(root: string, files: readonly string[]): string[] {
  const dirs = new Set<string>();
  const resolvedRoot = resolve(root);
  for (const file of files) {
    let dir = dirname(file);
    while (dir.startsWith(resolvedRoot) && !dirs.has(dir)) {
      dirs.add(dir);
      if (dir === resolvedRoot) break;
      dir = dirname(dir);
    }
  }
  return [...dirs]
    .filter((dir) => hasAnyConfig(dir))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

function hasAnyConfig(dir: string): boolean {
  return (
    IGNORE_FILES.some((s) => existsSync(join(dir, s.file))) ||
    ESLINT_FLAT_CONFIGS.some((f) => existsSync(join(dir, f)))
  );
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}
