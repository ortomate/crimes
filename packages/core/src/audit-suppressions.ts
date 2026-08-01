import { resolve } from "node:path";
import { systemClock } from "./clock.js";
import type { CrimesConfig } from "./config.js";
import { loadConfig, resolveSuppressionsPath } from "./config.js";
import { SCHEMA_VERSION } from "./finding.js";
import { loadSuppressions, type SuppressionEntry } from "./suppressions.js";

/**
 * Days after which a suppression is flagged as stale. Aligned with the
 * suppressions guidance ("revisit periodically") — long enough that a
 * normal suppression backlog stays clean, short enough that genuinely
 * forgotten exceptions surface.
 */
export const SUPPRESSION_STALE_AGE_DAYS = 180;

/**
 * Minimum reason length below which the audit flags the entry. A real
 * justification (issue link, short sentence) clears 16 characters easily;
 * anything shorter is almost certainly placeholder text.
 */
export const SUPPRESSION_MIN_REASON_LENGTH = 16;

/**
 * First-word tokens that read as deferral noise rather than a real reason.
 * Matched against the trimmed lowercased reason; whole-word, anchored to
 * the start so longer sentences that happen to contain the word ("the
 * legacy module …") are not flagged.
 */
const LAZY_FIRST_WORDS = new Set([
  "tmp",
  "temp",
  "temporary",
  "todo",
  "wip",
  "fixme",
  "later",
  "noisy",
  "legacy",
  "skip",
  "ignore",
]);

const LAZY_PHRASES: RegExp[] = [/^too\s+noisy\b/, /^we\s+know\b/];

export type AuditConcern = "stale" | "short_reason" | "vague_reason";

export interface AuditSuppressionEntry extends SuppressionEntry {
  /** Whole-number days between `created_at` and `generated_at`. */
  age_days: number;
  /** Empty for clean entries; lists the issues that triggered for this row. */
  concerns: AuditConcern[];
}

export interface AuditSuppressionsReport {
  schema_version: typeof SCHEMA_VERSION;
  report_type: "audit_suppressions";
  /** Absolute path of the suppressions file (read or not). */
  suppressions_path: string;
  /** True when the file existed and was read; false on an empty/missing file. */
  loaded: boolean;
  /** ISO-8601 timestamp the audit ran. Used to compute ages. */
  generated_at: string;
  /** Total entries (clean + flagged). */
  total: number;
  /** Number of entries with at least one concern. */
  flagged_count: number;
  /** Every entry, sorted oldest first. */
  entries: AuditSuppressionEntry[];
}

export interface AuditSuppressionsOptions {
  /** Repo root to resolve `<root>/.crimes/suppressions.json` from. */
  root?: string;
  /** Override config explicitly. */
  config?: CrimesConfig;
  /** Override the suppressions file path verbatim (absolute or root-relative). */
  path?: string;
  /** Injected for tests so `generated_at` is deterministic. */
  now?: () => Date;
}

/**
 * Audit `.crimes/suppressions.json`. Reads the file, computes per-entry
 * `age_days` against the resolved `generated_at`, and labels each entry
 * with zero or more {@link AuditConcern} values:
 *
 * - `"stale"` — older than {@link SUPPRESSION_STALE_AGE_DAYS} days.
 * - `"short_reason"` — `reason.trim().length < {@link SUPPRESSION_MIN_REASON_LENGTH}`.
 * - `"vague_reason"` — the reason reads as deferral noise (`tmp`, `todo`,
 *   `wip`, `too noisy`, `we know …`, etc.).
 *
 * A missing file is not an error — the report sets `loaded: false` and
 * `entries: []`. A present-but-malformed file throws
 * {@link MalformedSuppressionsError} (re-raised from `loadSuppressions`).
 */
export function auditSuppressions(
  options: AuditSuppressionsOptions = {},
): AuditSuppressionsReport {
  const root = resolve(options.root ?? process.cwd());
  const config = options.config ?? loadConfig(root);
  const path = options.path
    ? resolve(root, options.path)
    : resolveSuppressionsPath(root, config);

  const generated = (options.now ?? systemClock)();
  const generatedMs = generated.getTime();

  const loaded = loadSuppressions(path);

  const entries: AuditSuppressionEntry[] = loaded.entries.map((entry) =>
    classifyEntry(entry, generatedMs),
  );
  entries.sort((a, b) => b.age_days - a.age_days);

  const flagged_count = entries.reduce((n, e) => (e.concerns.length > 0 ? n + 1 : n), 0);

  return {
    schema_version: SCHEMA_VERSION,
    report_type: "audit_suppressions",
    suppressions_path: path,
    loaded: loaded.loaded,
    generated_at: generated.toISOString(),
    total: entries.length,
    flagged_count,
    entries,
  };
}

function classifyEntry(
  entry: SuppressionEntry,
  generatedMs: number,
): AuditSuppressionEntry {
  const createdMs = Date.parse(entry.created_at);
  const ageMs = Number.isFinite(createdMs) ? Math.max(0, generatedMs - createdMs) : 0;
  const ageDays = Math.floor(ageMs / DAY_MS);

  const concerns: AuditConcern[] = [];
  if (ageDays > SUPPRESSION_STALE_AGE_DAYS) concerns.push("stale");
  if (entry.reason.trim().length < SUPPRESSION_MIN_REASON_LENGTH) {
    concerns.push("short_reason");
  } else if (looksVague(entry.reason)) {
    concerns.push("vague_reason");
  }

  return { ...entry, age_days: ageDays, concerns };
}

function looksVague(reason: string): boolean {
  const trimmed = reason.trim().toLowerCase();
  if (trimmed.length === 0) return true;
  const firstToken = trimmed.split(/[\s.,;:!?]+/, 1)[0] ?? "";
  if (LAZY_FIRST_WORDS.has(firstToken)) return true;
  return LAZY_PHRASES.some((re) => re.test(trimmed));
}

const DAY_MS = 24 * 60 * 60 * 1000;
