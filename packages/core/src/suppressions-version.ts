import type { SuppressionEntry } from "./suppressions-schema.js";

/**
 * Version comparison and the resurface rules built on it.
 *
 * Extracted from suppressions.ts in 0.12.2. Entirely pure — no I/O, no
 * schema, no filesystem — which is what made it the cleanest seam in a
 * 670-line module that otherwise mixes zod schemas, file writes, and
 * finding partitioning.
 */

/**
 * Extract the major.minor of a semver-shaped string. Accepts `"0.7"`,
 * `"0.7.0"`, `"1.2.3-beta"` — returns `"0.7"`, `"0.7"`, `"1.2"`. Returns
 * the input unchanged when it doesn't start with `digits.digits`, so
 * malformed pins fall back to literal equality (and almost certainly
 * resurface, which is the conservative default).
 */
export function minorKey(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : version;
}

interface SemverParts {
  major: number;
  minor: number;
}

function parseSemver(version: string): SemverParts | undefined {
  const match = version.match(/^(\d+)\.(\d+)/);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Compare two version strings by major.minor. Returns -1 when `a < b`,
 * `1` when `a > b`, `0` when equal. Falls back to `0` when either side
 * is unparseable (treat unknowns as same-minor so we don't silently
 * resurface every suppression on a junk version string).
 */
export function compareMinor(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  return 0;
}

/**
 * Return `true` when a suppression should resurface for re-confirmation.
 * Manual suppressions never resurface; feedback suppressions resurface
 * when their pinned minor is *older* than the current crimes minor.
 * Future-pinned entries (downgrade scenario) are NOT resurfaced — the
 * caller handles them via {@link findFuturePinnedSuppressions}.
 */
export function shouldResurface(
  entry: SuppressionEntry,
  currentVersion: string,
): boolean {
  if (entry.source !== "feedback") return false;
  if (!entry.crimes_version_pinned) return false;
  return compareMinor(entry.crimes_version_pinned, currentVersion) < 0;
}

/**
 * Return every feedback-sourced suppression whose pinned minor is
 * *later* than the current crimes version — i.e. the user downgraded.
 * The CLI emits a one-line stderr warning per entry; the entry stays
 * silenced (treated as quiet) regardless.
 */
export function findFuturePinnedSuppressions(
  entries: SuppressionEntry[],
  currentVersion: string,
): SuppressionEntry[] {
  return entries.filter(
    (e) =>
      e.source === "feedback" &&
      e.crimes_version_pinned !== undefined &&
      compareMinor(e.crimes_version_pinned, currentVersion) > 0,
  );
}

