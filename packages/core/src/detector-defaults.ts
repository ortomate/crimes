import type { Effort } from "./finding.js";

export interface DetectorDefaults {
  effort: Effort;
  fix_shape: string;
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

export function getDefaultsFor(detectorType: string): DetectorDefaults {
  return DETECTOR_DEFAULTS[detectorType] ?? GENERIC_DEFAULT;
}
