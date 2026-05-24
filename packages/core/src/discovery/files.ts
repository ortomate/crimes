import fg from "fast-glob";

export interface DiscoverOptions {
  root: string;
  include: string[];
  exclude: string[];
}

/**
 * Walk the given root directory and return absolute paths to all source
 * files matching `include` minus those matching `exclude`. Honours
 * symlinks conservatively and skips hidden directories by default.
 *
 * Moved from `@crimes/language-js` in 0.12.0 — file discovery is
 * universal-pack infrastructure and no longer depends on the JS pack.
 * `@crimes/language-js` still re-exports this function for one minor
 * cycle of back-compat (Task 1.2).
 */
export async function discoverFiles(options: DiscoverOptions): Promise<string[]> {
  const entries = await fg(options.include, {
    cwd: options.root,
    ignore: options.exclude,
    absolute: true,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    suppressErrors: true,
  });
  return entries.sort();
}
