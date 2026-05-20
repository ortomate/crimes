/**
 * Public finding schema. This is part of the product API contract.
 *
 * Bumping `schema_version` is a breaking change.
 */
export const SCHEMA_VERSION = "0.2.0" as const;

import type { Tier } from "./scoring/tier.js";

export type Severity = "low" | "medium" | "high";

/**
 * Estimated effort to address a finding. Detector-supplied; defaults from
 * `core/src/detector-defaults.ts` when a detector omits it.
 *
 * - `quick`  — ≤1-line change
 * - `small`  — under 1 hour
 * - `medium` — fits within one PR
 * - `large`  — needs design
 */
export type Effort = "quick" | "small" | "medium" | "large";

export interface FindingScores {
  /** How bad the smell is in isolation (0-1). */
  severity: number;
  /** How certain the detector is (0-1). */
  confidence: number;
  /**
   * Normalised transitive-importer count (0-1). Populated by the scoring
   * context attached to every scan; absent only in direct unit-test stubs
   * that bypass scan/context wiring. Treat as ordinal — the precise scaling
   * may shift between minor releases.
   */
  blast_radius?: number;
  /**
   * Normalised commits-in-window count (0-1). Populated by the scoring
   * context; absent in stubs. Ordinal.
   */
  churn?: number;
  /**
   * Inverted test-coverage signal (0-1). 1.0 = no nearby tests; 0.0 = a
   * test file imports this file. Populated by the scoring context; absent
   * in stubs. Ordinal.
   */
  test_gap?: number;
  /**
   * Recency boost in [0,1] derived from file's most recent commit. 1.0 =
   * touched within the last 7 days; linear decay to 0 over 7→14 days; 0
   * thereafter or when git is unavailable. Used by the scan reporter to
   * compute file-level rank_score = agent_risk * (1 + recency * 0.5).
   */
  recency?: number;
  /**
   * Unified composite of severity / confidence / churn / test_gap /
   * blast_radius (0-1). Computed by core's finalisation pass after every
   * detector runs — detectors no longer set this field directly. Absent
   * only in stubs that bypass scan/context wiring.
   */
  agent_risk?: number;
}

export interface SuggestedAction {
  kind: string;
  description: string;
  risk: "low" | "medium" | "high";
}

export interface Finding {
  /** Stable per-scan id, e.g. `crime_01982`. */
  id: string;
  /** Machine-readable type, e.g. `large_function`. */
  type: string;
  /** Human-readable charge, e.g. `God Function`. */
  charge: string;
  severity: Severity;
  /** 0-1 confidence. */
  confidence: number;
  /** Repo-relative file path with forward slashes. */
  file: string;
  /** Optional symbol name (function/class). */
  symbol?: string;
  /** Inclusive [start, end] 1-based line range. */
  lines?: [number, number];
  /** One-line summary. */
  summary: string;
  /** Concrete evidence — short factual strings. */
  evidence: string[];
  /**
   * Estimated effort to address. Detector-supplied; `core` fills the
   * default from `detector-defaults.ts` if the detector omits it.
   */
  effort: Effort;
  /**
   * One-line description of the *shape* of the fix, not the fix itself.
   * Detector-supplied; ≤120 chars, single line. Defaults vary per
   * detector type — see `core/src/detector-defaults.ts`.
   */
  fix_shape: string;
  scores: FindingScores;
  suggested_actions?: SuggestedAction[];
  related_files?: string[];
  /**
   * Only set when the consumer requested `--show-suppressed`. Indicates
   * the finding matched an entry in `.crimes/suppressions.json` and would
   * normally be hidden from output. Gate evaluation always ignores
   * findings with `suppressed === true`.
   */
  suppressed?: true;
  /** Paired with `suppressed`. The reason recorded in the suppressions file. */
  suppression_reason?: string;
  /**
   * Set when the finding matched a feedback-sourced suppression whose
   * pinned minor differs from the current crimes minor — the resurface
   * loop introduced in 0.7.0. The finding is kept in `findings[]` (NOT
   * counted in `suppressed_count`) so the user can re-confirm `fp` (push
   * the pin forward) or mark `tp` (delete the suppression). Manual
   * suppressions never resurface.
   */
  previously_suppressed?: true;
  /** Paired with `previously_suppressed`. Carries the prior pin + reason. */
  previous_suppression?: {
    /** The crimes minor (or full semver) the suppression was pinned to. */
    pinned_version: string;
    /** The reason recorded on the original feedback `fp` entry. */
    reason: string;
  };
  /**
   * Set when this finding matches an entry in `.crimes/triage.json` with a
   * non-silencing disposition (`fix-now` or `fix-this-PR`). Silencing
   * dispositions (`needs-design`, `wont-fix`, `scaffolding`) hide the
   * finding by default and surface only via resurfacing or
   * `--show-triaged` — see `previous_triage` on resurfaced findings.
   */
  triaged?: {
    disposition: "fix-now" | "fix-this-PR";
    reason: string;
    owner: string;
    date: string;
  };
  /**
   * Scope tier of the finding's file, computed from
   * `config.scopeTiers.nonDomain`. Optional and additive — readers that
   * don't care can ignore it. Absent only on findings produced by tests
   * that bypass scan/context wiring.
   */
  tier?: Tier;
}

export interface ScanSummary {
  total: number;
  high: number;
  medium: number;
  low: number;
}

export interface ScanReport {
  schema_version: typeof SCHEMA_VERSION;
  /** Discriminator. Always the literal `"scan"`. */
  report_type: "scan";
  repo: {
    name: string;
    root: string;
    git_ref?: string;
  };
  summary: ScanSummary;
  findings: Finding[];
  /**
   * Severity threshold the CLI gated on. Only set when the user passed
   * `--changed --fail-on <severity>` to `crimes scan`. Absent otherwise.
   */
  fail_on?: Severity;
  /**
   * True when at least one finding in `findings` has severity ≥ `fail_on`.
   * Only set when `fail_on` is set. Drives the non-zero exit on the gate.
   */
  failed?: boolean;
  /**
   * Repo-relative POSIX paths of every file the `--changed` resolver
   * returned (working-tree + optional `<base>...HEAD`). Always present —
   * and possibly empty — when `crimes scan --changed` was used; absent
   * for plain directory scans. Includes files that produced **zero**
   * findings (e.g. a touched `README.md` or a `.json`), so an agent can
   * confirm which files it actually touched even when the diff is
   * clean. Sorted, deduplicated.
   */
  changed_files?: string[];
  /**
   * Number of findings matched by an entry in `.crimes/suppressions.json`
   * during this invocation. Only present when ≥1 suppression matched —
   * absent otherwise, which is equivalent to "no suppressions configured"
   * for downstream consumers.
   */
  suppressed_count?: number;
}
