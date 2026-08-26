import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { systemClock } from "./clock.js";
import { SCHEMA_VERSION } from "./finding.js";
import { loadSuppressions, SuppressionsSchema } from "./suppressions-schema.js";
import type { SuppressionEntry, Suppressions } from "./suppressions-schema.js";

/**
 * The two write paths for `.crimes/suppressions.json`.
 *
 * Extracted from suppressions.ts in 0.12.2, which mixed zod schemas,
 * filesystem writes, version comparison and finding partitioning in one
 * 669-line module. These are the only functions in that group that
 * touch disk, which makes them the natural second seam after the pure
 * version logic.
 */

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
    if (entry.claim !== undefined) next.claim = entry.claim;
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
    if (entry.claim !== undefined) next.claim = entry.claim;
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
