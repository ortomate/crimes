import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

/**
 * The on-disk shape of `.crimes/suppressions.json` — types, zod schemas,
 * and the read path.
 *
 * Extracted from suppressions.ts in 0.12.2. It has to be its own module
 * rather than living alongside the write path: suppressions.ts
 * re-exports the write functions for API compatibility, so if
 * suppressions-write.ts value-imported the schema from suppressions.ts
 * the two would form a runtime cycle. crimes' own circular_dependency
 * detector caught exactly that during this refactor.
 */

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
const ACCEPTED_SUPPRESSIONS_SCHEMA_VERSIONS = [
  "0.1.0",
  "0.2.0",
  "0.3.0",
  "0.4.0",
  "0.5.0",
] as const;

/**
 * On-disk suppressions document. Shipped as `.crimes/suppressions.json`
 * by default; the file is intended to be committed and hand-reviewable.
 */
export interface Suppressions {
  /**
   * On-disk schema version. The loader accepts any value in
   * `ACCEPTED_SUPPRESSIONS_SCHEMA_VERSIONS` (currently `"0.1.0"` through
   * `"0.5.0"`); the writer always emits the current `SCHEMA_VERSION`.
   *
   * `schema_version` 0.4.0 added the fingerprint discriminator. Entries
   * pinned to a `magic_domain_literal_scatter`, `exact_duplicate_block`,
   * or `near_duplicate_block` fingerprint written before 0.4.0 stop
   * matching and need to be re-recorded — which is the intent, since
   * before 0.4.0 one such entry could be suppressing more findings than
   * its author saw.
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
    throw new MalformedSuppressionsError(path, `unable to read file — ${message}`);
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
    throw new MalformedSuppressionsError(path, formatZodIssues(result.error.issues));
  }

  return { entries: result.data.suppressions, path, loaded: true };
}

function formatZodIssues(issues: z.core.$ZodIssue[]): string {
  const first = issues[0];
  if (!first) return "validation failed";
  const path = first.path.length > 0 ? first.path.join(".") : "(root)";
  return `${path}: ${first.message}`;
}
