/**
 * Public finding schema. This is part of the product API contract.
 *
 * Bumping `schema_version` is a breaking change.
 */
export const SCHEMA_VERSION = "0.5.0" as const;

import type { Pack } from "./pack.js";
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
   * Normalised transitive-reach count (0-1) — see
   * `blast_radius_transitive_importers`, which is the integer this is
   * derived from. Populated by the scoring context attached to every
   * scan; absent only in direct unit-test stubs that bypass scan/context
   * wiring. Treat as ordinal — the precise scaling may shift between
   * minor releases.
   */
  blast_radius?: number;
  /**
   * Size of the file's transitive importer closure: every in-repo file
   * that reaches it through one or more import edges. The integer source
   * of `blast_radius`. Populated when the scoring context resolves an
   * import graph.
   *
   * This is a **reachability** measure, not a fan-in measure, and the two
   * diverge sharply on real repos. Because the walk follows import edges
   * without cycle-breaking, a file that sits on an import cycle counts
   * *itself*, and every member of a strongly-connected component reports
   * the same number. On the `hono` corpus `src/utils/mime.ts` has 5 direct
   * importers and a transitive closure of 240; six files in the core
   * component all report exactly 197 while their direct fan-in ranges
   * from 2 to 70.
   *
   * Renamed from `blast_radius_importers` in `schema_version` 0.5.0: the
   * old name promised a fan-in count it never delivered. Use
   * `blast_radius_direct_importers` when you want "how many files import
   * this".
   */
  blast_radius_transitive_importers?: number;
  /**
   * Number of distinct in-repo files with a **direct** import edge to the
   * finding's file — the honest "N files import this" number.
   * Deduplicated across multiple import statements from the same file
   * (a value import plus an `import type` counts once), and excluding the
   * file itself. Populated whenever
   * `blast_radius_transitive_importers` is.
   *
   * Reported alongside `blast_radius` but deliberately not an input to
   * it: the score's normalisation is a separate, calibrated decision.
   * New in `schema_version` 0.5.0.
   */
  blast_radius_direct_importers?: number;
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
  /**
   * Detector pack that produced this finding. Populated by the scan /
   * context finalisation pass (`assignPackAndDetectorId`) on every
   * finding emitted via the public APIs.
   */
  pack: Pack;
  /**
   * Qualified detector id — `<abstract-type>.<pack-suffix>` for language-
   * pack detectors (`large_function.js`), bare `<abstract-type>` for
   * universal-pack detectors. `type` keeps the abstract form for
   * grouping across packs.
   */
  detector_id: string;
  /** Human-readable charge, e.g. `God Function`. */
  charge: string;
  severity: Severity;
  /** 0-1 confidence. */
  confidence: number;
  /** Repo-relative file path with forward slashes. */
  file: string;
  /** Optional symbol name (function/class). */
  symbol?: string;
  /**
   * Optional tiebreaker for detectors that can legitimately emit more
   * than one finding for the same `(type, file, symbol)` triple — a
   * file-level detector reporting several distinct literals, or a
   * duplicate-block detector reporting several distinct duplicate
   * groups anchored on the same file.
   *
   * Folded into {@link fingerprintFinding} when present, which is the
   * whole point: without it those findings share one fingerprint, so
   * `crimes diff` conflates them and `crimes ignore <fingerprint>`
   * silently suppresses a finding the user never looked at.
   *
   * Detectors must pick a value that is **stable across scans of the
   * same code** and derived from what makes the findings different — the
   * literal for `magic_domain_literal_scatter`, the body hash for the
   * duplicate-block family. A counter or an index is not acceptable:
   * it changes when an unrelated finding appears.
   *
   * Leave it unset when `(type, file, symbol)` is already unique. Most
   * detectors should.
   */
  discriminator?: string;
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
   * `--show-triaged` — see `hidden_triage` below and `previous_triage`
   * on resurfaced findings.
   */
  triaged?: {
    disposition: "fix-now" | "fix-this-PR";
    reason: string;
    owner: string;
    date: string;
  };
  /**
   * Set when the consumer requested `--show-triaged` (or
   * `showTriaged: true` programmatically) AND this finding matched a
   * silencing triage entry. Mirrors the `suppressed` / `suppression_reason`
   * pattern: gate evaluation always ignores findings with
   * `hidden_triage !== undefined`. Absent in the default `crimes scan`
   * output.
   */
  hidden_triage?: {
    disposition: "needs-design" | "wont-fix" | "scaffolding";
    reason: string;
    owner: string;
    date: string;
  };
  /** True when this finding matches an entry in `.crimes/triage.json`. */
  previously_triaged?: true;
  previous_triage?: {
    disposition: "fix-now" | "fix-this-PR" | "needs-design" | "wont-fix" | "scaffolding";
    reason: string;
    owner: string;
    date: string;
  };

  /** True when this finding matches an entry in `.crimes/baseline.json`. */
  previously_baselined?: true;
  previous_baseline?: {
    /** ISO-8601 date the baseline was last written; best-effort. */
    date?: string;
    /** Baselines don't store per-entry reasons today; absent for now. */
    reason?: string;
  };
  /**
   * Scope tier of the finding's file, computed from
   * `config.scopeTiers.nonDomain`. Optional and additive — readers that
   * don't care can ignore it. Absent only on findings produced by tests
   * that bypass scan/context wiring.
   */
  tier?: Tier;
}

/**
 * A finding as constructed by a detector — before the scan / context
 * finalisation pass (`assignPackAndDetectorId`) populates `pack` and
 * `detector_id`. The finaliser mutates the object in place and widens
 * the type to `Finding`. Detectors return `PreFinding[]` from their
 * `run()` methods; callers outside the finaliser always work with the
 * fully-formed `Finding`.
 */
export type PreFinding = Omit<Finding, "pack" | "detector_id">;

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
  /**
   * Number of findings hidden because of a silencing `.crimes/triage.json`
   * entry (`needs-design`, `wont-fix`, or `scaffolding`). Only present
   * when ≥1 silencing entry matched and `showTriaged` was false —
   * absent otherwise.
   */
  triage_hidden_count?: number;
  /**
   * Per-pack coverage breakdown. Computed once per scan; absent when
   * the scan target has zero discovered files. The shape gains a
   * `by_package` field in 0.14.0 for polyglot monorepo support; until
   * then, only the file-level rollup is populated.
   */
  coverage?: {
    /** Total files the scan touched (universal pack ran on each). */
    files_total: number;
    /**
     * Files counted by each loaded language pack. Keyed by short pack
     * id (`"js"`, `"py"`). Sum of values ≤ files_total — a file claimed
     * by no language pack appears in `files_universal_only`.
     */
    files_by_language: Record<string, number>;
    /** Files no language pack claimed (universal pack ran on them). */
    files_universal_only: number;
    /**
     * Histogram of the universal-only bucket by lower-cased file
     * extension (`{".py": 48, ".go": 3}`); extensionless files bucket
     * under `"(no extension)"`. Sums to `files_universal_only`.
     *
     * This is the demand signal for language packs: it answers "which
     * pack would buy the most coverage in this repo?" Optional — absent
     * on reports produced before 0.13.0.
     */
    universal_only_by_extension?: Record<string, number>;
    /**
     * Pack ids that ran, always led by `"universal"` — e.g.
     * `["universal", "language-js"]`. Derived from the language-pack
     * router, so this reflects what actually executed.
     */
    packs_loaded: string[];
    /**
     * Per-package breakdown, present only when the scan root looks like
     * a monorepo — two or more directories carrying a package manifest
     * (`package.json`, `pyproject.toml`, `setup.py`, `Cargo.toml`,
     * `go.mod`).
     *
     * Added in 0.15.0. The repo-wide `files_by_language` says a repo is
     * 70% TypeScript; this says *which* package is the Python one. In a
     * polyglot monorepo that is the difference between "there is some
     * Python here" and "`packages/api` is a Python service" — and the
     * latter is what decides where a change is risky.
     *
     * Sorted by path. Absent on single-package repos rather than
     * present with one entry, so consumers can treat presence as "this
     * is a monorepo".
     */
    by_package?: Array<{
      /** Repo-relative directory holding the manifest. */
      path: string;
      files_total: number;
      /** Same short-id keying as the top-level `files_by_language`. */
      files_by_language: Record<string, number>;
      /**
       * Short pack id holding a strict majority of this package's
       * claimed files, or `null` when no language reaches a majority
       * (a genuinely mixed package) or none is claimed at all.
       */
      dominant_language: string | null;
    }>;
  };
}
