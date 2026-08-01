import { z } from "zod";
import type { SCHEMA_VERSION } from "../finding.js";

/**
 * One verdict on one finding, captured by `crimes feedback` and stored
 * as one line in `.crimes/feedback.jsonl` (or the global rollup at
 * `~/.crimes/feedback-rollup.jsonl`). Append-only — re-feedback on the
 * same fingerprint appends a new entry; read paths walk backwards and
 * use the latest-per-fingerprint entry as the current verdict.
 */
export interface FeedbackEntry {
  /** ISO 8601 timestamp of when the verdict was recorded. */
  timestamp: string;
  /** Full semver of the crimes version that produced the finding. */
  crimes_version: string;
  /** Stable `<type>::<file>::<symbol>` fingerprint — primary identity. */
  fingerprint: string;
  /** Convenience denormalisation of the detector id. */
  finding_type: string;
  /** The judgment. `fp` writes a feedback-sourced suppression too. */
  verdict: "tp" | "fp" | "known";
  /**
   * Optional reason. Required when `verdict === "fp"` because it becomes
   * the suppression's `reason`. Stored as `null` (not omitted) so the
   * JSONL line shape is stable.
   */
  note: string | null;
  /**
   * sha256 of the scan JSON when `crimes feedback ... --file <scan.json>`
   * was used. Lets readers correlate a verdict with the exact scan that
   * produced the finding.
   */
  scan_hash: string | null;
  /**
   * When the verdict re-confirms or resolves a prior `fp` from a
   * different minor (the auto-resurface path), this carries the prior
   * minor — e.g. `"0.6"`. Otherwise `null`.
   */
  resurfaced_from: string | null;
  /**
   * Only present in the global rollup (`~/.crimes/feedback-rollup.jsonl`).
   * Absolute repo path the entry originated from.
   */
  repo?: string;
}

export const FeedbackEntrySchema = z
  .object({
    timestamp: z.string().min(1),
    crimes_version: z.string().min(1),
    fingerprint: z.string().min(1),
    finding_type: z.string().min(1),
    verdict: z.enum(["tp", "fp", "known"]),
    note: z.string().nullable(),
    scan_hash: z.string().nullable(),
    resurfaced_from: z.string().nullable(),
    repo: z.string().min(1).optional(),
  })
  .strict();

export type FeedbackVerdict = FeedbackEntry["verdict"];

export interface FeedbackSummary {
  total: number;
  by_verdict: { tp: number; fp: number; known: number };
  by_detector: Record<string, { tp: number; fp: number; known: number }>;
  by_version: Record<string, number>;
  /** Only present in global-rollup summaries. */
  by_repo?: Record<string, number>;
}

/**
 * Output of `crimes feedback list / summary / recheck / export --format json`.
 */
export interface FeedbackReport {
  schema_version: typeof SCHEMA_VERSION;
  report_type: "feedback";
  scope: "repo" | "global";
  /** Absolute path of the JSONL file the entries were read from. */
  source_file: string;
  entries: FeedbackEntry[];
  summary?: FeedbackSummary;
}
