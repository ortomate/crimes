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
 *
 * ## This is a defect fix, not a settled design
 *
 * The score is no longer a length ranking. What its shape *should* be
 * is an open question and the focus of the next release — including
 * whether a hard ceiling is the right mechanism (it collapses every
 * structural finding above the cap to exactly 0.3, the same plateau
 * problem `blast_radius` was just fixed for), whether per-detector
 * intrinsics are calibrated against each other at all, and whether
 * zulip's new 16-of-20 `sync_io_in_hotpath` concentration is an
 * improvement or just a different monoculture.
 *
 * `docs/calibration-followups.md` § "`agent_risk`: what we know and
 * what we believe" separates the measured facts from the assumptions.
 * Read it before retuning any number in this file.
 */

/**
 * Ceiling applied to `structural` findings' `agent_risk`.
 *
 * ## The justification this comment used to give was wrong
 *
 * It read: *"the agent-signal band runs 0.31–0.53 (`sync_io_in_hotpath`
 * 0.43–0.53, `direct_date` 0.51, `commented_out_code` 0.41,
 * `contract_drift` ~0.36) … 0.3 puts the whole structural class at or
 * below the bottom of the agent-signal band."*
 *
 * Checked in `0.23.0` by building `ce0ccab` itself — the commit that
 * introduced this constant — and scanning the exact tree it cites:
 *
 * | type | claimed | measured at `ce0ccab` |
 * |---|---|---|
 * | `sync_io_in_hotpath` | 0.43–0.53 | **0.20**–0.53 |
 * | `direct_date` | 0.51 | **0.18**–0.51 |
 * | `commented_out_code` | 0.41 | **0.14**–0.41 |
 * | `contract_drift` | ~0.36 | **0 findings — does not fire on that tree** |
 * | the band itself | "0.31–0.53" | min **0.12**, p50 0.35, max 0.53 |
 *
 * Every quoted figure is that type's *maximum*; the band was read off
 * the head of each type's distribution rather than the distribution.
 * **45% of the agent-signal population sat at or below 0.30** on the day
 * the constant was chosen, so 0.3 never put structural "below the
 * band" — it put it level with the band's median. Today it is 47–75%
 * across the corpus.
 *
 * Worse, the anchor was circular. `contract_drift` expresses no
 * intrinsic of its own, so whatever position it held came from
 * {@link NEUTRAL_INTRINSIC}, not from a judgement about contract drift.
 * `0.23.0` closed that half — see `INTRINSIC_DEFAULTS` in
 * `detector-defaults.ts`, which gives all 28 such detectors a declared,
 * peer-anchored value.
 *
 * ## What the constant is now
 *
 * **Still 0.3, and still unvalidated.** Correcting the rationale does
 * not by itself choose a different number, and `0.23.0` deliberately
 * changed the inputs rather than the mechanism so the two are not
 * confounded in one baseline. A monotonic squash (`scored * CEILING`)
 * was implemented and measured as the alternative: it moves the
 * differentiated bucket 13 up / 0 down and takes structural out of the
 * top 20 on four of five corpus repos, at the cost of the
 * length-labelled scenarios §28 has already disowned. That evidence is
 * recorded in `docs/calibration-followups.md`; the change was not taken,
 * because stacking a second compensation on top of the missing
 * intrinsics would have made either one impossible to attribute.
 *
 * Structural findings are still reported, still carry their own
 * severity, and still sort among themselves by churn and test gap.
 */
export const STRUCTURAL_CEILING = 0.3;

/**
 * Last-resort intrinsic, for a finding type nothing has declared.
 *
 * Previously this was derived from severity, which reintroduced the
 * collapse for the detectors that set no intrinsic of their own. A flat
 * value was meant to say what is actually known: nothing.
 *
 * **It did not say that.** Measured in `0.23.0`: 28 of 70 registered
 * detectors reached this fallback, and 0.30 sits *below every one of the
 * 29 expressed agent-signal bases*, which run 0.35–0.80. Silence was
 * therefore scored as "less agent-hostile than the most lenient
 * judgement anyone has made" — a verdict nobody entered, applied to
 * `contract_drift`, `swallowed_error`, `duplicated_policy` and
 * `permission_ia_drift` among others.
 *
 * Built-in detectors no longer reach it: `INTRINSIC_DEFAULTS` in
 * `detector-defaults.ts` declares a peer-anchored value for each, and a
 * gate in `detector-defaults.test.ts` fails when a new detector expresses
 * neither. **Reaching this constant now means a detector is missing from
 * that table**, which is a different thing from a considered score — so
 * the value is left where it is rather than raised to the expressed
 * median. Raising it would make the omission harder to notice.
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
