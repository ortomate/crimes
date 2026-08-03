/**
 * How much a finding of a given type tells you about **agent** risk, as
 * opposed to how big or how bad the code is.
 *
 * ## Why this table exists
 *
 * `agent_risk` had collapsed into a length ranking. Measured before this
 * change: 15 of the top 20 findings on `ebg` were `large_function` or
 * `large_file`; on zulip it was 18 of 20, with **zero Python findings in
 * the top 20 of a repo that is 71% Python**. `CLAUDE.md` says
 * `agent_risk` "is the differentiator and must not be collapsed into
 * severity", and PRD §10 says the same. It had been.
 *
 * The cause was structural rather than a bad constant. Length detectors
 * fire on almost every large file, they scale their own intrinsic score
 * with line count, and length correlates with everything else — so they
 * won on volume and on score at the same time. The differentiated 0.16
 * detectors, which are the reason to run this tool rather than a linter,
 * sat underneath them.
 *
 * ## What the classes mean
 *
 * - **`structural`** — the finding says the code is *big* or *tangled*.
 *   Real, worth reporting, and largely orthogonal to whether an agent
 *   will get it wrong: a 400-line function is tedious to edit, not
 *   deceptive. Capped at {@link STRUCTURAL_CEILING} so it can never
 *   outrank a genuine agent-risk signal.
 *
 * - **`agent_signal`** — the finding says something an agent will
 *   actively be *misled* by: two sources of truth that can disagree, a
 *   name that lies about what the code does, a test that proves nothing,
 *   a side effect that is not where you would look for it, two halves of
 *   a contract that have drifted. These are the cases where an agent
 *   reads the code, forms a correct-looking belief, and is wrong.
 *
 * - **`standard`** — everything else. No adjustment.
 *
 * Severity is deliberately *not* an input to any of this. A finding's
 * local badness and its agent risk are different questions, and
 * answering the second with the first is exactly the collapse being
 * fixed.
 */

/**
 * Ceiling applied to `structural` findings' `agent_risk`.
 *
 * Chosen from the measured distribution rather than by taste. On zulip's
 * `zerver` tree the agent-signal band runs 0.31–0.53
 * (`sync_io_in_hotpath` 0.43–0.53, `direct_date` 0.51,
 * `commented_out_code` 0.41, `contract_drift` ~0.36). A ceiling of 0.4
 * sat *inside* that band, so a `large_file` still outranked a genuine
 * contract drift — the exact inversion this change exists to remove.
 *
 * 0.3 puts the whole structural class at or below the bottom of the
 * agent-signal band, which is what "length detectors get a low floor"
 * has to mean if it means anything. Structural findings are still
 * reported, still carry their own severity, and still sort among
 * themselves by churn and test gap.
 */
export const STRUCTURAL_CEILING = 0.3;

/**
 * Intrinsic used for a detector that supplies none.
 *
 * Previously this was derived from severity, which reintroduced the
 * collapse for the ~18 detectors that set no intrinsic of their own. A
 * flat neutral value says what is actually known: nothing.
 */
export const NEUTRAL_INTRINSIC = 0.3;

/**
 * Types whose charge is size or shape. Note both the bare and
 * pack-qualified ids — `finding.type` carries the abstract form, but a
 * caller holding `detector_id` should get the same answer.
 */
const STRUCTURAL_TYPES = new Set([
  "large_file",
  "large_function",
  "todo_density",
  "high_fan_in_fan_out",
  "deep_import",
  "circular_dependency",
  "layer_violation",
  "finder_duplicate_filename",
  "oversized_raster",
  "raster_should_be_vector",
  "svg_with_embedded_raster",
  "responsive_fragility",
  "design_token_escape",
  "accessible_interaction_risk",
]);

/**
 * Types whose charge is "an agent will believe something untrue".
 *
 * Grouped by the failure they describe, which is the test for adding
 * one: does a competent reader form a *wrong belief* from this code?
 */
const AGENT_SIGNAL_TYPES = new Set([
  // Multiple sources of truth that can disagree.
  "duplicated_policy",
  "duplicated_role_status_plan_check",
  "duplicated_navigation_source",
  "parallel_destination",
  "config_drift",
  "magic_domain_literal_scatter",
  "exact_duplicate_block",
  "near_duplicate_block",
  "duplicate_component_shape",
  // Names and docs that misdescribe behaviour.
  "name_behavior_mismatch",
  "boolean_naming_drift",
  "singular_plural_type_mismatch",
  "logic_in_comments",
  "commented_out_code",
  "docs_code_drift",
  "command_drift_docs_code_drift",
  "concept_alias_drift",
  "cross_language_concept_alias_drift",
  "action_label_drift",
  "copy_ia_drift",
  "route_metadata_drift",
  "orphaned_destination",
  "permission_ia_drift",
  // Contracts whose two halves can drift apart.
  "contract_drift",
  "cross_language_type_drift",
  "cross_language_route_drift",
  "return_shape_roulette",
  "option_bag_junk_drawer",
  "negative_flag_maze",
  "dependency_provenance_gap",
  "agent_permission_sprawl",
  "missing_agent_context",
  // Tests that do not protect what they appear to.
  "weak_test_signal",
  "mock_saturation",
  // Side effects and failure modes that are not where you would look.
  "swallowed_error",
  "sync_io_in_hotpath",
  "unbounded_async_fanout",
  "unsafe_retry",
  "pass_through_abstraction",
  "hardcoded_local_path",
  "hardcoded_localhost",
  // Time and locale: correct-looking code that is wrong by an offset.
  "direct_date",
  "mixed_utc_local_methods",
  "timezone_unsafe_parse",
  "dst_naive_arithmetic",
  "date_string_concat",
  "locale_drift",
]);

export type AgentRiskClass = "structural" | "standard" | "agent_signal";

/**
 * Classify a finding type. Accepts both `finding.type` (abstract) and
 * `finding.detector_id` (pack-qualified, e.g. `large_function.py`) so
 * callers do not have to normalise first.
 */
export function agentRiskClassOf(type: string | undefined): AgentRiskClass {
  if (typeof type !== "string" || type.length === 0) return "standard";
  const bare = type.replace(/\.(js|py|x)$/, "");
  if (STRUCTURAL_TYPES.has(bare)) return "structural";
  if (AGENT_SIGNAL_TYPES.has(bare)) return "agent_signal";
  return "standard";
}
