import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { CrimesConfig } from "./config.js";
import type { ToolingSkip } from "./manifest/tooling-excludes.js";
import {
  applyToolingExcludes,
  corroborate,
  readPyprojectExcludes,
} from "./manifest/tooling-excludes.js";

/**
 * Drop files the repo's own tooling excludes, and say which they were.
 *
 * Reads `pyproject.toml` at the scan root only — a nested package's
 * config governs its own tree and following those is a separate
 * decision. Returns everything untouched when the file is absent,
 * unreadable, or the user has set `honourToolingExcludes: false`.
 */
export function applyRepoToolingExcludes(
  root: string,
  discovered: string[],
  config: CrimesConfig,
): { allFiles: string[]; toolingSkips: ToolingSkip[] } {
  if (config.honourToolingExcludes === false) {
    return { allFiles: discovered, toolingSkips: [] };
  }
  let toml: string;
  try {
    toml = readFileSync(resolve(root, "pyproject.toml"), "utf8");
  } catch {
    return { allFiles: discovered, toolingSkips: [] };
  }
  const corroborated = corroborate(readPyprojectExcludes(toml));
  if (corroborated.length === 0) {
    return { allFiles: discovered, toolingSkips: [] };
  }
  const result = applyToolingExcludes(
    discovered,
    (absolute) => relative(root, absolute).split(sep).join("/"),
    corroborated,
  );
  return { allFiles: result.kept, toolingSkips: result.skipped };
}
