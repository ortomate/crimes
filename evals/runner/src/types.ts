/**
 * Shape of `evals/fixtures/fixtures.meta.json`. The registry holds
 * one entry per fixture; runner walks it to enumerate the universe of
 * fixtures available for a given run.
 */
export interface FixturesRegistry {
  schema_version: "0.1.0";
  fixtures: FixtureRegistryEntry[];
}

export interface FixtureRegistryEntry {
  /** Numeric prefix used in the directory name (`01-messy-ts-app`). */
  id: string;
  /** Repo-relative path to the fixture directory. */
  path: string;
  /** Free-form human label shown in the runner's progress output. */
  name: string;
  /** Origin of the fixture body — drives setup behaviour. */
  kind: "symlink" | "oss-clone" | "hand-crafted";
  /** One-line purpose statement (which detectors / behaviours it exercises). */
  purpose: string;
}

/**
 * Per-OSS-clone meta file. Lives at
 * `evals/fixtures/<NN>-<name>/.crimes-eval-meta.json`. The setup
 * script reads this and clones the upstream at the pinned SHA.
 */
export interface OssFixtureMeta {
  upstream: string;
  sha: string;
  license: string;
  purpose: string;
  /** Set to true to skip cloning (e.g. upstream disappeared). */
  archived?: boolean;
}

export type ScenarioKind = "refactor" | "bugfix" | "review" | "context" | "plan";

export interface ExpectedArtifacts {
  referenced_findings?: string[];
  referenced_files?: string[];
  forbidden_actions?: string[];
  expected_priority?: string;
}

export interface Scenario {
  /** Stable id, e.g. `"refactor-01-messy-ts-app"`. */
  id: string;
  /** Fixture id this scenario runs against. */
  fixture: string;
  kind: ScenarioKind;
  /** Verbatim agent prompt — multi-line strings supported in JSON via `\n`. */
  prompt: string;
  expected_artifacts: ExpectedArtifacts;
  /** Open-ended questions for the opt-in judge-model pass. */
  judge_questions?: string[];
}

export interface ScoreDetail {
  check:
    | "referenced_findings"
    | "referenced_files"
    | "forbidden_actions"
    | "expected_priority";
  expected: unknown;
  observed: unknown;
  passed: boolean;
  /**
   * Set when the check was recorded for transparency but deliberately
   * excluded from the pass/fail counts — currently only
   * `referenced_files` entries whose path the scenario prompt already
   * handed the agent. Carries the reason. Absent on scored details.
   */
  skipped?: string;
}

export interface JudgeQuestionScore {
  question: string;
  score: number;
  reasoning: string;
}

export interface ScoreResult {
  scenario: string;
  agent: string;
  crimes_version: string;
  timestamp: string;
  run_id: string;
  /**
   * The agent's response text — preserved so `pnpm run evals:replay`
   * can re-score it against a newer crimes build without re-invoking
   * the agent.
   */
  response: string;
  /**
   * Derived from the scan JSON the agent was prompted with. Lets the
   * scorer recognise findings referenced by `crime_NNNNN` id or by
   * human charge name, not just by detector slug. Optional for
   * backwards compatibility with pre-0.8 result files; replay
   * re-derives by re-scanning the fixture when missing.
   */
  scan_context?: ScanContext;
  structural_score: {
    passed: number;
    failed: number;
    details: ScoreDetail[];
  };
  judge_score?: {
    overall: number;
    per_question: JudgeQuestionScore[];
    model: string;
  };
}

/**
 * Lookup maps the scorer uses to translate user-facing references
 * (finding ids like `crime_00004`, charge names like
 * `"Temporal Recklessness"`) back into the canonical detector slug
 * (`direct_date`). Built from the same scan JSON the agent saw.
 */
export interface ScanContext {
  /** `crime_00004` → `direct_date`. */
  detector_id_by_finding_id: Record<string, string>;
  /** `Temporal Recklessness` → `direct_date`. */
  detector_id_by_charge: Record<string, string>;
}
