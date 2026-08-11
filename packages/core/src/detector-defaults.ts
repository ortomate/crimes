import type { Effort } from "./finding.js";

export interface DetectorDefaults {
  effort: Effort;
  fix_shape: string;
  /**
   * Declared agent-risk intrinsic, used only when the detector emits no
   * `scores.agent_risk` of its own. See {@link INTRINSIC_DEFAULTS}.
   */
  intrinsic?: number;
}

export const GENERIC_DEFAULT: DetectorDefaults = {
  effort: "medium",
  fix_shape: "refactor to remove this signal; add a test that pins the fix",
};

/**
 * Per-detector defaults applied during finalisation when a detector emits
 * a finding without setting `effort` or `fix_shape`. Detectors that want
 * per-finding overrides can set the fields directly on the emitted
 * `Finding` object — same as `severity`.
 */
export const DETECTOR_DEFAULTS: Record<string, DetectorDefaults> = {
  // Structural
  large_function: {
    effort: "small",
    fix_shape: "extract pure helpers; keep the orchestrator thin",
  },
  large_file: {
    effort: "medium",
    fix_shape: "split by responsibility; one concern per module",
  },
  todo_density: {
    effort: "small",
    fix_shape: "convert TODOs to tickets or delete; comments are not tracking",
  },
  commented_out_code: { effort: "quick", fix_shape: "delete; git history preserves it" },
  option_bag_junk_drawer: {
    effort: "small",
    fix_shape: "split the options bag into named, narrowly-typed records",
  },
  negative_flag_maze: {
    effort: "small",
    fix_shape: "invert flags to read positively; consolidate combined states",
  },
  return_shape_roulette: {
    effort: "small",
    fix_shape: "pick one return shape; use a discriminated union if you need both",
  },

  // Cross-language (0.15.0) — two languages disagreeing about the
  // same thing. Fixes are structural: align the contract, or generate
  // one side from the other so it cannot drift again.
  cross_language_route_drift: {
    effort: "small",
    fix_shape: "align the path, or generate the client from the route table",
  },
  cross_language_type_drift: {
    effort: "medium",
    fix_shape: "generate one side from the other, or share a schema",
  },
  cross_language_concept_alias_drift: {
    effort: "medium",
    fix_shape: "pick one name for the concept and rename across both languages",
  },

  // Dependency / structure
  circular_dependency: {
    effort: "medium",
    fix_shape: "extract shared types to a leaf module",
  },
  deep_import: {
    effort: "quick",
    fix_shape: "import from the package boundary, not the internals",
  },
  layer_violation: {
    effort: "medium",
    fix_shape: "route through the layer boundary or relocate the consumer",
  },
  high_fan_in_fan_out: {
    effort: "medium",
    fix_shape: "split or invert: too many consumers means too much coupling",
  },

  // Duplication
  exact_duplicate_block: {
    effort: "small",
    fix_shape: "extract the duplicated block into a shared helper",
  },
  near_duplicate_block: {
    effort: "small",
    fix_shape: "consolidate into one helper; pass the differing values as args",
  },
  duplicate_component_shape: {
    effort: "small",
    fix_shape: "extract the shared component; parameterise the differing props",
  },
  duplicated_role_status_plan_check: {
    effort: "medium",
    fix_shape: "centralise the policy check; everyone calls the one helper",
  },
  duplicated_navigation_source: {
    effort: "small",
    fix_shape: "single source of truth for nav; routes derive from it",
  },
  magic_domain_literal_scatter: {
    effort: "small",
    fix_shape: "promote the literal to a named constant in one module",
  },
  finder_duplicate_filename: {
    effort: "quick",
    fix_shape: "delete the duplicate; the canonical file already exists",
  },

  // Testability
  direct_date: {
    effort: "small",
    fix_shape: "inject a clock; pass through the domain boundary",
  },
  hardcoded_localhost: {
    effort: "quick",
    fix_shape: "lift the host to config or env; default for dev only",
  },
  hardcoded_local_path: {
    effort: "quick",
    fix_shape: "use a portable path or resolve from a configured root",
  },
  sync_io_in_hotpath: {
    effort: "small",
    fix_shape: "switch to async I/O; await at the call site",
  },
  weak_test_signal: {
    effort: "small",
    fix_shape: "assert behaviour, not implementation; remove no-op assertions",
  },

  // Information architecture
  copy_ia_drift: {
    effort: "small",
    fix_shape: "pick the canonical label; redirect copies to it",
  },
  concept_alias_drift: {
    effort: "small",
    fix_shape: "rename the alias to match the canonical term; one term per concept",
  },
  command_drift_docs_code_drift: {
    effort: "small",
    fix_shape: "regenerate command docs from code or codify them in CI",
  },
  docs_code_drift: {
    effort: "small",
    fix_shape: "sync the doc to the code, or move the assertion into a test",
  },
  action_label_drift: {
    effort: "small",
    fix_shape: "pick one verb per action; update labels uniformly",
  },
  permission_ia_drift: {
    effort: "small",
    fix_shape: "centralise the permission check; every caller goes through it",
  },
  route_metadata_drift: {
    effort: "small",
    fix_shape: "derive route metadata from one source; remove the divergent copies",
  },
  parallel_destination: {
    effort: "small",
    fix_shape: "fold the parallel destinations into one; route via a switch if necessary",
  },
  orphaned_destination: {
    effort: "quick",
    fix_shape: "delete the orphan destination or wire it up",
  },
  missing_agent_context: {
    effort: "small",
    fix_shape: "write a SKILL.md so agents discover the entry points",
  },

  // Naming
  boolean_naming_drift: {
    effort: "quick",
    fix_shape: "rename to `isX`/`hasX`/`shouldX`; consistent across the module",
  },
  name_behavior_mismatch: {
    effort: "small",
    fix_shape: "rename to match behaviour, or change the body to match the name",
  },
  singular_plural_type_mismatch: {
    effort: "quick",
    fix_shape: "make the name agree with the type — `users` for array, `user` for scalar",
  },
  logic_in_comments: {
    effort: "small",
    fix_shape: "lift the prose rule to an assert / type / test / config check",
  },

  // Time / locale
  mixed_utc_local_methods: {
    effort: "medium",
    fix_shape: "pick one time domain; convert at the boundary",
  },
  timezone_unsafe_parse: {
    effort: "small",
    fix_shape: "parse with explicit timezone; reject ambiguous inputs",
  },
  dst_naive_arithmetic: {
    effort: "medium",
    fix_shape: "use a DST-aware library; never add seconds to a wall-clock date",
  },
  date_string_concat: {
    effort: "small",
    fix_shape: "format dates via a single helper; never concatenate fragments",
  },
  locale_drift: {
    effort: "small",
    fix_shape: "centralise locale; one provider for all formatters",
  },

  // UI / interaction
  accessible_interaction_risk: {
    effort: "small",
    fix_shape: "use semantic elements; add ARIA only when semantics don't fit",
  },
  design_token_escape: {
    effort: "quick",
    fix_shape: "replace raw values with the design token",
  },
  responsive_fragility: {
    effort: "small",
    fix_shape:
      "drive layout from container queries or a fluid scale, not pixel media queries",
  },

  // Correctness risk (0.16.0). Fix shapes name the *shape* of the change,
  // never the change itself — a detector that dictates the fix stops being
  // evidence and starts being an opinion.
  swallowed_error: {
    effort: "small",
    fix_shape: "propagate, or record the error with enough context to act on",
  },
  unsafe_retry: {
    effort: "medium",
    fix_shape: "pass a stable idempotency key, or make the retry read-only",
  },
  unbounded_async_fanout: {
    effort: "small",
    fix_shape: "bound the concurrency, or page the source and process in batches",
  },
  mock_saturation: {
    effort: "medium",
    fix_shape: "add one test that asserts an outcome, not a call",
  },

  // Cross-file authority (0.16.0).
  duplicated_policy: {
    effort: "medium",
    fix_shape: "extract one authoritative policy function; every site calls it",
  },
  contract_drift: {
    effort: "medium",
    fix_shape: "derive one declaration from the other, or share one schema",
  },
  config_drift: {
    effort: "small",
    fix_shape: "parse each setting once, in one module; everyone imports it",
  },
  pass_through_abstraction: {
    effort: "medium",
    fix_shape: "collapse the empty layers; keep the one boundary that earns its place",
  },

  // Agent hygiene (0.16.0).
  dependency_provenance_gap: {
    effort: "quick",
    fix_shape: "declare each imported package in the manifest that uses it",
  },
  agent_permission_sprawl: {
    effort: "quick",
    fix_shape: "narrow each rule to the specific commands the work needs",
  },

  // Asset detectors
  oversized_raster: {
    effort: "quick",
    fix_shape: "downscale or convert to WebP/AVIF; budget the size",
  },
  raster_should_be_vector: {
    effort: "quick",
    fix_shape: "ship the SVG source; rasters lose at any scale",
  },
  svg_with_embedded_raster: {
    effort: "small",
    fix_shape: "externalise the embedded raster or replace it with vector geometry",
  },
};

/**
 * Declared agent-risk intrinsics for the detectors that express none of
 * their own.
 *
 * ## The defect this closes
 *
 * `agent_risk = 0.40*intrinsic + 0.20*churn + 0.20*test_gap +
 * 0.20*blast_radius`, and the intrinsic is the only genuinely
 * agent-specific term in it. **28 of 70 registered detectors set no
 * `scores.agent_risk`**, so they fell through to `NEUTRAL_INTRINSIC`
 * (0.30) — described in `scoring/agent-risk-class.ts` as a value that
 * "says what is actually known: nothing".
 *
 * Measured across the corpus at `0.22.0`, that is not what it says. The
 * 29 *expressed* agent-signal bases run **0.35 to 0.80**:
 *
 * ```
 * 0.80 missing_agent_context          0.52 magic_domain_literal_scatter
 * 0.70 concept_alias_drift            0.52 option_bag_junk_drawer
 * 0.70 duplicated_navigation_source   0.50 dst_naive_arithmetic
 * 0.65 mixed_utc_local_methods        0.50 hardcoded_local_path
 * 0.65 route_metadata_drift           0.50 hardcoded_localhost
 * 0.65 cross_language_type_drift      0.50 negative_flag_maze
 * 0.60 name_behavior_mismatch         0.45 commented_out_code
 * 0.60 docs_code_drift                0.45 direct_date
 * 0.60 cross_language_route_drift     0.40 date_string_concat
 * 0.58 weak_test_signal               0.40 locale_drift
 * 0.56 return_shape_roulette          0.40 singular_plural_type_mismatch
 * 0.55 sync_io_in_hotpath              0.35 boolean_naming_drift
 * 0.55 timezone_unsafe_parse
 * 0.55 logic_in_comments
 * ```
 *
 * **This list is load-bearing, and that is what settled the cross-pack
 * constant gaps in `0.25.5`.** Every entry in the table below was
 * anchored against a value in it, so a charge implemented in both packs
 * cannot have its published number changed without silently invalidating
 * the peers calibrated against it. The Python bases that disagreed —
 * `boolean_naming_drift` 0.30, `sync_io_in_hotpath` 0.50,
 * `mixed_utc_local_methods` 0.62 — never appeared here and nothing was
 * calibrated against them, so they moved to match rather than the other
 * way round. Not a preference for the universal pack: a preference for
 * the number that has dependents. The `(js)` qualifier on
 * `sync_io_in_hotpath` is gone because there is now one value.
 *
 * **`commented_out_code`'s two rows were also one value pretending to be
 * two, and both were wrong.** The list published 0.48 for the js twin
 * and 0.35 for the universal one. The js twin gated on a composite
 * `statementCount >= 5` and then scored `0.48 + statementCount * 0.04`,
 * so 0.48 was **unreachable**: all 463 of its corpus findings carried
 * exactly 0.68 or 0.72. Every peer anchored against "0.48
 * commented_out_code (js)" was anchored against a number no report ever
 * contained. `0.25.9` put both twins on one ladder over one unit — see
 * `COMMENTED_OUT_CODE_LADDER` — with 0.45 as the base the table already
 * implied, since `exact_duplicate_block` is 0.45 "near
 * commented_out_code".
 *
 * 0.30 sits **below every one of them**. A detector that declined to
 * score itself was therefore ranked below the most lenient deliberate
 * judgement any author has made — and the group that declined includes
 * `contract_drift`, `swallowed_error`, `duplicated_policy` and
 * `permission_ia_drift`, which are among the most agent-hostile charges
 * the tool makes.
 *
 * The inversion is documented in the codebase itself.
 * {@link STRUCTURAL_CEILING}'s comment justifies 0.3 by saying a ceiling
 * of 0.4 left "a `large_file` still outranking a genuine contract
 * drift". `contract_drift` sets no intrinsic, so its position in that
 * comparison was the fallback, not a judgement about contract drift.
 *
 * ## How these values were chosen
 *
 * Each is anchored to a *named expressed peer* rather than picked. The
 * anchor is given per entry so the reasoning can be argued with. This is
 * the point of a single table: intrinsics can only be calibrated against
 * each other where they can be seen next to each other.
 *
 * Structural entries matter less than they look — those findings are
 * capped by {@link STRUCTURAL_CEILING} — but they still order the class
 * internally, which is the half of the ranking the cap does not decide.
 */
export const INTRINSIC_DEFAULTS: Record<string, number> = {
  // ── Multiple sources of truth that can disagree ──
  // Anchors: duplicated_navigation_source 0.70, magic_domain_literal_scatter 0.52.
  /** Two places that must agree about authorisation. Just under nav-source. */
  duplicated_policy: 0.65,
  /** Same charge, scoped to role/status/plan gates. */
  duplicated_role_status_plan_check: 0.65,
  /** One key, two values. The classic thing an agent reads once and trusts. */
  config_drift: 0.6,
  /** Two routes to one destination. Below policy: wrong, not unsafe. */
  parallel_destination: 0.55,
  /** Copies that differ *subtly* mislead more than copies that don't. */
  near_duplicate_block: 0.5,
  /** Literal duplication. Common and often benign; near commented_out_code. */
  exact_duplicate_block: 0.45,
  /** Two components with one shape — a fork waiting to happen. */
  duplicate_component_shape: 0.45,

  // ── Names and docs that misdescribe behaviour ──
  // Anchors: name_behavior_mismatch 0.60, docs_code_drift 0.60, boolean_naming_drift 0.35.
  /** A documented command that no longer matches the code. Peer of docs_code_drift. */
  command_drift_docs_code_drift: 0.6,
  /** Permission names that drift are read as authorisation facts. */
  permission_ia_drift: 0.6,
  /** One action, several labels. Below name_behavior_mismatch: cosmetic surface. */
  action_label_drift: 0.5,
  /** Copy/IA inconsistency — misleading, rarely load-bearing. */
  copy_ia_drift: 0.45,
  /** A destination nothing reaches. Misleads about reachability, not behaviour. */
  orphaned_destination: 0.45,

  // ── Contracts whose two halves can drift apart ──
  // Anchors: cross_language_type_drift 0.65, return_shape_roulette 0.56.
  /** The same charge as cross_language_type_drift, within one language. */
  contract_drift: 0.65,
  /** Agent-specific by construction; below missing_agent_context 0.80. */
  agent_permission_sprawl: 0.6,
  /** An import the manifest does not declare. An agent assumes it resolves. */
  dependency_provenance_gap: 0.55,

  // ── Tests that do not protect what they appear to ──
  // Anchor: weak_test_signal 0.58.
  /** A test that mocks its subject proves nothing, and looks like coverage. */
  mock_saturation: 0.6,

  // ── Side effects and failure modes that are not where you would look ──
  // Anchor: sync_io_in_hotpath 0.55.
  /** A discarded error is invisible: the agent reads the call as safe. */
  swallowed_error: 0.65,
  /** Retrying a non-idempotent operation. Correct-looking, wrong. */
  unsafe_retry: 0.6,
  /** Unbounded concurrency — fine until the input grows. */
  unbounded_async_fanout: 0.55,
  /** A layer that only forwards. Tightened hard in 0.18.1, so kept modest. */
  pass_through_abstraction: 0.45,

  // ── Structural (capped by STRUCTURAL_CEILING; orders the class internally) ──
  // Anchors: large_function 0.55, large_file 0.45, todo_density 0.20.
  /** A cycle is genuinely hard to reason about a piece at a time. */
  circular_dependency: 0.45,
  /** A crossed boundary misleads about what may depend on what. */
  layer_violation: 0.45,
  /** Fan-out says "this file knows too much", but says nothing false. */
  high_fan_in_fan_out: 0.35,
  /** Interaction risk is real but local and visible. */
  accessible_interaction_risk: 0.35,
  /** Reaching past a package boundary. Mechanical. */
  deep_import: 0.3,
  /** An escaped design token. Cosmetic drift. */
  design_token_escape: 0.3,
  /** Layout fragility. Visible on sight, unlike the agent-signal charges. */
  responsive_fragility: 0.3,
  /** Two files with one name. Confusing to navigate, near todo_density. */
  finder_duplicate_filename: 0.25,
};

export function getDefaultsFor(detectorType: string): DetectorDefaults {
  const base = DETECTOR_DEFAULTS[detectorType] ?? GENERIC_DEFAULT;
  const intrinsic = INTRINSIC_DEFAULTS[detectorType];
  return intrinsic === undefined ? base : { ...base, intrinsic };
}
