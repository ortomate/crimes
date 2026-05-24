import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { systemClock } from "./clock.js";
import type { CrimesConfig } from "./config.js";
import { resolveSuppressionsPath } from "./config.js";
import { fingerprintFinding } from "./fingerprint.js";
import type { Finding } from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";

/**
 * One per-finding exception, keyed by stable fingerprint. The denormalised
 * `type` / `file` / `symbol` fields exist so a reviewer scanning
 * `git diff .crimes/suppressions.json` can read the entry without parsing
 * the fingerprint — they are strictly redundant for matching.
 */
export interface SuppressionEntry {
  fingerprint: string;
  type: string;
  file?: string;
  symbol?: string;
  reason: string;
  created_at: string;
  created_by?: string;
  /**
   * Origin of this suppression. Defaults to `"manual"` when absent — the
   * shape `crimes ignore` has always written and the shape every 0.5.0 /
   * 0.6.0 file on disk uses. Entries with `source: "feedback"` are
   * managed by `crimes feedback` (0.7.0+) and participate in the
   * auto-resurface loop. Manual suppressions never resurface.
   */
  source?: "manual" | "feedback";
  /**
   * The crimes minor (or full semver — only the major.minor parts are
   * compared) this suppression was recorded against, e.g. `"0.7"` or
   * `"0.7.0"`. Only meaningful when `source === "feedback"`. On scans
   * whose minor differs from the pinned value, the matching finding
   * resurfaces tagged `previously_suppressed: true`.
   */
  crimes_version_pinned?: string;
}

/**
 * Recognised on-disk schema versions for `.crimes/suppressions.json`.
 * The loader accepts any prior version still in active migration window;
 * the writer always emits the current `SCHEMA_VERSION`. Update this union
 * each time `SCHEMA_VERSION` bumps to add the previous value.
 */
const ACCEPTED_SUPPRESSIONS_SCHEMA_VERSIONS = ["0.1.0", "0.2.0", "0.3.0"] as const;

/**
 * On-disk suppressions document. Shipped as `.crimes/suppressions.json`
 * by default; the file is intended to be committed and hand-reviewable.
 */
export interface Suppressions {
  /**
   * On-disk schema version. The loader accepts any value in
   * `ACCEPTED_SUPPRESSIONS_SCHEMA_VERSIONS` (currently `"0.1.0"`, `"0.2.0"`, or
   * `"0.3.0"`); the writer always emits the current `SCHEMA_VERSION`.
   */
  schema_version: (typeof ACCEPTED_SUPPRESSIONS_SCHEMA_VERSIONS)[number];
  report_type: "suppressions";
  created_at: string;
  updated_at: string;
  crimes_version?: string;
  suppressions: SuppressionEntry[];
}

export const SuppressionEntrySchema = z
  .object({
    fingerprint: z.string().min(1),
    type: z.string().min(1),
    file: z.string().min(1).optional(),
    symbol: z.string().min(1).optional(),
    reason: z.string().min(1),
    created_at: z.string().min(1),
    created_by: z.string().min(1).optional(),
    source: z.enum(["manual", "feedback"]).optional(),
    crimes_version_pinned: z.string().min(1).optional(),
  })
  .strict();

export const SuppressionsSchema = z
  .object({
    schema_version: z.enum(ACCEPTED_SUPPRESSIONS_SCHEMA_VERSIONS),
    report_type: z.literal("suppressions"),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    crimes_version: z.string().min(1).optional(),
    suppressions: z.array(SuppressionEntrySchema),
  })
  .strict();

export class MalformedSuppressionsError extends Error {
  path: string;
  constructor(path: string, reason: string) {
    super(`suppressions at ${path} are malformed: ${reason}`);
    this.name = "MalformedSuppressionsError";
    this.path = path;
  }
}

export interface LoadSuppressionsResult {
  /** Empty when the file does not exist. */
  entries: SuppressionEntry[];
  /** Resolved absolute path of the file (read or not). */
  path: string;
  /** True when the file existed and was read. */
  loaded: boolean;
}

/**
 * Read `.crimes/suppressions.json` (or the configured path) and return its
 * entries. A missing file is not an error — the function returns an empty
 * list. A present-but-malformed file throws {@link MalformedSuppressionsError}.
 */
export function loadSuppressions(path: string): LoadSuppressionsResult {
  if (!existsSync(path)) return { entries: [], path, loaded: false };

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MalformedSuppressionsError(
      path,
      `unable to read file — ${message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MalformedSuppressionsError(path, `invalid JSON — ${message}`);
  }

  const result = SuppressionsSchema.safeParse(parsed);
  if (!result.success) {
    throw new MalformedSuppressionsError(
      path,
      formatZodIssues(result.error.issues),
    );
  }

  return { entries: result.data.suppressions, path, loaded: true };
}

function formatZodIssues(issues: z.core.$ZodIssue[]): string {
  const first = issues[0];
  if (!first) return "validation failed";
  const path = first.path.length > 0 ? first.path.join(".") : "(root)";
  return `${path}: ${first.message}`;
}

export interface AppendSuppressionOptions {
  /** Override the timestamp source for tests. */
  now?: () => Date;
  /** Crimes version string, recorded on every write. */
  crimesVersion?: string;
}

export interface AppendSuppressionResult {
  /** Final document written to disk. */
  document: Suppressions;
  /** Absolute path the file was written to. */
  path: string;
  /** True when the entry already existed (its reason / updated_at were updated). */
  updated: boolean;
}

/**
 * Append or update a suppression entry, writing the file back out
 * pretty-printed (2-space indent + trailing newline) so the diff is
 * reviewable.
 *
 * - A new fingerprint appends.
 * - An existing fingerprint updates `reason` and the document's top-level
 *   `updated_at`. The entry's `created_at` is preserved.
 */
export async function appendSuppression(
  path: string,
  entry: Omit<SuppressionEntry, "created_at">,
  options: AppendSuppressionOptions = {},
): Promise<AppendSuppressionResult> {
  const now = (options.now ?? systemClock)();
  const iso = now.toISOString();

  let doc: Suppressions;
  let existed = false;
  if (existsSync(path)) {
    const loaded = loadSuppressions(path);
    doc = {
      schema_version: SCHEMA_VERSION,
      report_type: "suppressions",
      // Preserve created_at from disk; only update updated_at.
      created_at: readCreatedAt(path) ?? iso,
      updated_at: iso,
      suppressions: loaded.entries,
    };
    if (options.crimesVersion) doc.crimes_version = options.crimesVersion;
  } else {
    doc = {
      schema_version: SCHEMA_VERSION,
      report_type: "suppressions",
      created_at: iso,
      updated_at: iso,
      suppressions: [],
    };
    if (options.crimesVersion) doc.crimes_version = options.crimesVersion;
  }

  const existingIdx = doc.suppressions.findIndex(
    (s) => s.fingerprint === entry.fingerprint,
  );
  if (existingIdx >= 0) {
    existed = true;
    const prior = doc.suppressions[existingIdx]!;
    const next: SuppressionEntry = {
      ...prior,
      reason: entry.reason,
    };
    if (entry.type) next.type = entry.type;
    if (entry.file !== undefined) next.file = entry.file;
    if (entry.symbol !== undefined) next.symbol = entry.symbol;
    if (entry.created_by !== undefined) next.created_by = entry.created_by;
    if (entry.source !== undefined) next.source = entry.source;
    if (entry.crimes_version_pinned !== undefined) {
      next.crimes_version_pinned = entry.crimes_version_pinned;
    }
    doc.suppressions[existingIdx] = next;
  } else {
    const next: SuppressionEntry = {
      fingerprint: entry.fingerprint,
      type: entry.type,
      reason: entry.reason,
      created_at: iso,
    };
    if (entry.file !== undefined) next.file = entry.file;
    if (entry.symbol !== undefined) next.symbol = entry.symbol;
    if (entry.created_by !== undefined) next.created_by = entry.created_by;
    if (entry.source !== undefined) next.source = entry.source;
    if (entry.crimes_version_pinned !== undefined) {
      next.crimes_version_pinned = entry.crimes_version_pinned;
    }
    doc.suppressions.push(next);
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(doc, null, 2) + "\n", "utf8");

  return { document: doc, path, updated: existed };
}

export interface RemoveSuppressionOptions {
  /** Override the timestamp source for tests. */
  now?: () => Date;
  /** Crimes version string, recorded on the document. */
  crimesVersion?: string;
}

export interface RemoveSuppressionResult {
  /** Final document state. `undefined` when the file did not exist. */
  document?: Suppressions;
  /** Absolute path of the file. */
  path: string;
  /** True when an entry was removed; false when no matching fingerprint. */
  removed: boolean;
  /** The entry that was removed (only set when `removed: true`). */
  entry?: SuppressionEntry;
}

/**
 * Remove a suppression entry by stable fingerprint. Returns
 * `{ removed: false }` when the file is absent or the fingerprint isn't
 * present — the caller decides how to surface that.
 *
 * The document frame (top-level `schema_version`, `created_at`, etc.) is
 * preserved when entries remain or when the file becomes empty;
 * `updated_at` is bumped on a successful removal. The file is never
 * deleted — an empty `suppressions: []` array stays so reviewers can
 * see the file exists and has been intentionally cleared.
 */
export async function removeSuppression(
  path: string,
  fingerprint: string,
  options: RemoveSuppressionOptions = {},
): Promise<RemoveSuppressionResult> {
  if (!existsSync(path)) {
    return { path, removed: false };
  }

  const loaded = loadSuppressions(path);
  const idx = loaded.entries.findIndex((s) => s.fingerprint === fingerprint);
  if (idx < 0) {
    const doc = readFullDocument(path);
    return { document: doc, path, removed: false };
  }

  const removedEntry = loaded.entries[idx]!;
  const remaining = loaded.entries.filter((_, i) => i !== idx);

  const now = (options.now ?? systemClock)();
  const iso = now.toISOString();
  const priorCreated = readCreatedAt(path) ?? iso;

  const doc: Suppressions = {
    schema_version: SCHEMA_VERSION,
    report_type: "suppressions",
    created_at: priorCreated,
    updated_at: iso,
    suppressions: remaining,
  };
  if (options.crimesVersion) doc.crimes_version = options.crimesVersion;

  await writeFile(path, JSON.stringify(doc, null, 2) + "\n", "utf8");

  return { document: doc, path, removed: true, entry: removedEntry };
}

/** Best-effort read of the full document for the "not found" case. */
function readFullDocument(path: string): Suppressions | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    const result = SuppressionsSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function readCreatedAt(path: string): string | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { created_at?: unknown }).created_at === "string"
    ) {
      return (parsed as { created_at: string }).created_at;
    }
  } catch {
    // fall through
  }
  return undefined;
}

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
      resurfacedByPinnedMinor[key] =
        (resurfacedByPinnedMinor[key] ?? 0) + 1;
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
  const currentPrints = new Set(
    currentFindings.map((f) => fingerprintFinding(f)),
  );

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
