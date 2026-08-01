/**
 * Ordering for `evals/results/<version>` directory names.
 *
 * Both `evals:replay` and `evals:diff` pick "the latest baseline" by
 * sorting these names, so the ordering decides which directory every
 * later comparison is made against. It had two copies of the same
 * comparator, and both were wrong in the same way:
 *
 *     "0.15.0-r2".split(".")  ->  ["0", "15", "0-r2"]
 *     Number.parseInt("0-r2") ->  0
 *
 * so `0.15.0` and `0.15.0-r2` compared **equal** and directory
 * iteration order silently decided the winner. Re-run samples are
 * exactly the directories that supersede their base, so the harness
 * could replay the first sample instead of the corrected one.
 *
 * The suffix convention (see evals/README.md § Measuring run-to-run
 * noise) is `pnpm run evals -- --label r2`, giving `<version>-r2`.
 * A suffixed sample is a *later* run of the same version, not a
 * semver prerelease, so it sorts **after** the bare name — the opposite
 * of what semver would say about `1.0.0-rc1`.
 */

/** A results directory name decomposed for ordering. */
export interface ParsedResultsVersion {
  major: number;
  minor: number;
  patch: number;
  /**
   * Which sample of that version this is.
   *
   *   bare `0.15.0`     -> 1   (the canonical first run)
   *   `0.15.0-r2`       -> 2
   *   `0.15.0-r3`       -> 3
   *   `0.7.2-judge`     -> 0   (a variant pass, not a canonical sample)
   *
   * Rank 0 keeps non-numbered variants from being chosen as the
   * baseline ahead of the real run they were derived from.
   */
  sample: number;
  name: string;
}

const RESULTS_DIR_RE = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

export function parseResultsVersion(name: string): ParsedResultsVersion | undefined {
  const m = RESULTS_DIR_RE.exec(name);
  if (!m) return undefined;
  const suffix = m[4];
  let sample = 1;
  if (suffix !== undefined) {
    const r = /^r(\d+)$/.exec(suffix);
    sample = r ? Number.parseInt(r[1]!, 10) : 0;
  }
  return {
    major: Number.parseInt(m[1]!, 10),
    minor: Number.parseInt(m[2]!, 10),
    patch: Number.parseInt(m[3]!, 10),
    sample,
    name,
  };
}

/**
 * Descending comparator: newest first. Total and deterministic — ties
 * fall through to a reverse name comparison so two directories never
 * depend on `readdir` order.
 */
export function compareResultsVersionDesc(a: string, b: string): number {
  const pa = parseResultsVersion(a);
  const pb = parseResultsVersion(b);
  if (!pa && !pb) return b.localeCompare(a);
  if (!pa) return 1;
  if (!pb) return -1;
  if (pa.major !== pb.major) return pb.major - pa.major;
  if (pa.minor !== pb.minor) return pb.minor - pa.minor;
  if (pa.patch !== pb.patch) return pb.patch - pa.patch;
  if (pa.sample !== pb.sample) return pb.sample - pa.sample;
  return b.localeCompare(a);
}

/** Directory names that name a results baseline, newest first. */
export function sortResultsVersionsDesc(names: readonly string[]): string[] {
  return names
    .filter((n) => parseResultsVersion(n) !== undefined)
    .sort(compareResultsVersionDesc);
}
