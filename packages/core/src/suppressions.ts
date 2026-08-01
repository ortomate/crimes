import { isAbsolute, resolve } from "node:path";
import type { CrimesConfig } from "./config.js";
import { resolveSuppressionsPath } from "./config.js";
import { fingerprintFinding } from "./fingerprint.js";
import type { Finding } from "./finding.js";
// Schema, types and the read path live in their own module so the write
// path can import them without cycling back through this file.
import {
  loadSuppressions,
  MalformedSuppressionsError,
  SuppressionEntrySchema,
  SuppressionsSchema,
} from "./suppressions-schema.js";
import type {
  LoadSuppressionsResult,
  SuppressionEntry,
  Suppressions,
} from "./suppressions-schema.js";
export {
  loadSuppressions,
  MalformedSuppressionsError,
  SuppressionEntrySchema,
  SuppressionsSchema,
};
export type { LoadSuppressionsResult, SuppressionEntry, Suppressions };

// The append / remove write paths live in their own module — the only
// functions in this file that touched disk. Re-exported because they
// are public @crimes/core API.
export {
  appendSuppression,
  removeSuppression,
} from "./suppressions-write.js";
export type {
  AppendSuppressionOptions,
  AppendSuppressionResult,
  RemoveSuppressionOptions,
  RemoveSuppressionResult,
} from "./suppressions-write.js";

export interface ApplySuppressionsOptions {
  showSuppressed: boolean;
  /**
   * Current crimes version (full semver or major.minor). When provided,
   * feedback-sourced suppressions with a `crimes_version_pinned` minor
   * that differs from this version's minor are *resurfaced* — kept in
   * `findings[]` and tagged `previously_suppressed: true` — instead of
   * being silenced. Manual suppressions never resurface; feedback
   * suppressions whose pin matches the current minor stay silenced as
   * usual. Suppressions whose pin is *later* than the current version
   * (downgrade scenario) are also silenced and reported in
   * `futurePinnedWarnings`.
   */
  crimesVersion?: string;
}

export interface PartitionedFindings {
  visible: Finding[];
  suppressedCount: number;
  /**
   * Number of feedback-sourced suppressions that resurfaced for
   * re-confirmation. Resurfaced entries appear in `visible` tagged
   * `previously_suppressed: true` and are *not* counted in
   * `suppressedCount`. Always 0 when `options.crimesVersion` is absent.
   */
  resurfacedCount: number;
  /**
   * Per-pinned-minor breakdown of resurfaced suppressions, e.g.
   * `{ "0.6": 5, "0.5": 1 }`. Empty when nothing resurfaced. Used by
   * the CLI breadcrumb so a single line can summarise "5 pinned to 0.6".
   */
  resurfacedByPinnedMinor: Record<string, number>;
  /**
   * One human-readable message per feedback-sourced suppression whose
   * pinned version is *later* than the current crimes version (the
   * "you downgraded crimes" edge case). The CLI emits these as
   * one-line stderr warnings.
   */
  futurePinnedWarnings: string[];
}

// Version comparison + resurface rules live in their own module — pure
// logic, no I/O, and the only part of this file with neither schema nor
// filesystem coupling. Re-exported because they are public API.
import {
  compareMinor,
  findFuturePinnedSuppressions,
  minorKey,
  shouldResurface,
} from "./suppressions-version.js";
export { compareMinor, findFuturePinnedSuppressions, minorKey, shouldResurface };

/**
 * Split a finding list into a visible set + matched count.
 *
 * - With `showSuppressed: false`, matched findings are removed entirely.
 * - With `showSuppressed: true`, matched findings stay in `visible`,
 *   annotated with `suppressed: true` and `suppression_reason`.
 * - When `options.crimesVersion` is set, feedback-sourced suppressions
 *   whose pinned minor differs from the current minor are kept in
 *   `visible` (regardless of `showSuppressed`) and tagged
 *   `previously_suppressed: true` — the 0.7.0 auto-resurface loop.
 *
 * Pure / synchronous — the engines call this after building their raw
 * findings list and use the result to assemble the final report.
 */
export function partitionFindings(
  findings: Finding[],
  suppressions: SuppressionEntry[],
  options: ApplySuppressionsOptions,
): PartitionedFindings {
  if (suppressions.length === 0) {
    return {
      visible: findings,
      suppressedCount: 0,
      resurfacedCount: 0,
      resurfacedByPinnedMinor: {},
      futurePinnedWarnings: [],
    };
  }
  const byPrint = new Map<string, SuppressionEntry>();
  for (const s of suppressions) byPrint.set(s.fingerprint, s);

  let suppressedCount = 0;
  let resurfacedCount = 0;
  const resurfacedByPinnedMinor: Record<string, number> = {};
  const futurePinnedWarnings: string[] = [];
  const visible: Finding[] = [];

  for (const f of findings) {
    const entry = byPrint.get(fingerprintFinding(f));
    if (!entry) {
      visible.push(f);
      continue;
    }

    // Resurface check first — only fires when the caller passed
    // crimesVersion. Manual suppressions short-circuit `shouldResurface`.
    if (
      options.crimesVersion !== undefined &&
      shouldResurface(entry, options.crimesVersion)
    ) {
      resurfacedCount += 1;
      const pin = entry.crimes_version_pinned!;
      const key = minorKey(pin);
      resurfacedByPinnedMinor[key] = (resurfacedByPinnedMinor[key] ?? 0) + 1;
      visible.push({
        ...f,
        previously_suppressed: true,
        previous_suppression: {
          pinned_version: pin,
          reason: entry.reason,
        },
      });
      continue;
    }

    // Future-pinned: silence as usual + record a warning. Manual
    // suppressions and current-minor feedback fall through here too,
    // but the warning only fires for future-pinned feedback entries.
    if (
      options.crimesVersion !== undefined &&
      entry.source === "feedback" &&
      entry.crimes_version_pinned !== undefined &&
      compareMinor(entry.crimes_version_pinned, options.crimesVersion) > 0
    ) {
      futurePinnedWarnings.push(
        `suppression ${entry.fingerprint} is pinned to ${entry.crimes_version_pinned}, ` +
          `which is later than the current crimes version ${options.crimesVersion} — ` +
          "leaving silenced (downgrade scenario).",
      );
    }

    suppressedCount += 1;
    if (options.showSuppressed) {
      visible.push({
        ...f,
        suppressed: true,
        suppression_reason: entry.reason,
      });
    }
  }

  return {
    visible,
    suppressedCount,
    resurfacedCount,
    resurfacedByPinnedMinor,
    futurePinnedWarnings,
  };
}

/**
 * Walk a partitioned findings list (or any list of resurfaced findings)
 * and return a per-pinned-minor count, e.g. `{ "0.6": 5, "0.5": 1 }`.
 * Used by the CLI breadcrumb so a single stderr line can summarise
 * "5 feedback-sourced suppressions resurface (pinned to 0.6)".
 */
export function countResurfacedByPinnedMinor(
  findings: Finding[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    if (!f.previously_suppressed || !f.previous_suppression) continue;
    const key = minorKey(f.previous_suppression.pinned_version);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Resolve and load suppressions for a given root + config. Returns an
 * empty list when the file is absent. Throws {@link MalformedSuppressionsError}
 * on a present-but-invalid file.
 */
export function loadSuppressionsForRoot(
  root: string,
  config: CrimesConfig,
): LoadSuppressionsResult {
  const path = resolveSuppressionsPath(root, config);
  return loadSuppressions(path);
}

/**
 * Resolve a file path against a repo root. Mirrors
 * {@link resolveSuppressionsPath}'s rule for `--file` overrides: absolute
 * paths win, relative paths resolve against the root.
 */
export function resolveOverridePath(root: string, override: string): string {
  return isAbsolute(override) ? override : resolve(root, override);
}

/**
 * Shape of a single suppression as surfaced in `ContextReport.clues.suppressions`.
 * Frozen contract for Release B — do not change field names or types.
 */
export interface SuppressionForFile {
  fingerprint: string;
  detector: string;
  reason: string;
  pinned_version: string;
  matches_current_finding: boolean;
}

/**
 * Return every suppression entry scoped to this file (by file path or by
 * fingerprint), with a flag indicating whether at least one current
 * finding matched.
 *
 * An entry is considered "scoped to this file" when:
 *   1. Its `file` field equals `repoRelPath` (explicit file-scoped entry), OR
 *   2. Its fingerprint matches the fingerprint of at least one finding in
 *      `currentFindings` (fingerprint-scoped — no `file` field, but the
 *      finding lives on this file).
 *
 * `matches_current_finding` is `true` when the entry's fingerprint matches
 * at least one finding in `currentFindings` (regardless of how the entry
 * was scoped to this file).
 *
 * Output is sorted by fingerprint ascending so JSON output is stable.
 */
export function suppressionsForFile(
  entries: SuppressionEntry[],
  repoRelPath: string,
  currentFindings: Finding[],
): SuppressionForFile[] {
  // Build a set of fingerprints present in currentFindings for O(1) lookup.
  const currentPrints = new Set(currentFindings.map((f) => fingerprintFinding(f)));

  const results: SuppressionForFile[] = [];
  for (const entry of entries) {
    const matchesCurrentFinding = currentPrints.has(entry.fingerprint);

    // Determine whether this entry is scoped to this file:
    //   1. Explicit file field pointing at this file.
    const fileScoped = entry.file === repoRelPath;
    //   2. No file field, but the fingerprint matches a finding on this file.
    const printScoped = !entry.file && matchesCurrentFinding;

    if (!fileScoped && !printScoped) continue;

    results.push({
      fingerprint: entry.fingerprint,
      detector: entry.type,
      reason: entry.reason,
      pinned_version: entry.crimes_version_pinned ?? "",
      matches_current_finding: matchesCurrentFinding,
    });
  }

  // Deterministic order: fingerprint ascending.
  results.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  return results;
}
