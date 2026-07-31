# `crimes` JSON output schema

Every `crimes` command that supports `--format json` emits a single JSON
document. The shape varies per command, but every document carries the
same two top-level discriminator keys — **`schema_version`** and
**`report_type`** — so consumers can route on a single field.

This page is the **stable product API**. Treat it as a public contract:
any breaking change to a field name, type, or required-ness will bump
`schema_version`.

Documented as of `schema_version: "0.3.0"`. The source of truth in code
is [`packages/core/src/finding.ts`](../packages/core/src/finding.ts).

For how an agent should _use_ this output, see
[`agent-usage.md`](./agent-usage.md).

## Migrating from `0.2.0` to `0.3.0`

`crimes@0.12.0` bumps the schema:

- **New required field on `Finding`:** `pack: "universal" | "language-js" | "language-py" | "cross-language"`. Tells you which detector pack produced the finding. The existing `tier?` field (scope tier — `domain`/`nonDomain`) is unrelated and unchanged.
- **New required field on `Finding`:** `detector_id`. Qualified detector id (`large_function.js`, `large_function.py`); the bare `type` field is unchanged and stays the canonical grouping key.
- **New optional field on `ScanReport`:** `coverage`. Per-pack file-count breakdown. Absent when scanning a path with zero discovered files.

Consumers that hard-checked `schema_version === "0.2.0"` must accept `"0.3.0"`. Grouping by `type` keeps working — `detector_id` only matters when you need to disambiguate "JS large_function" from "Python large_function" (lands in 0.13.0).

## Migration note: schema_version 0.1.0 → 0.2.0

`crimes@0.11.0` bumps the finding schema. Every `Finding` now carries
two new required fields:

| Field      | Type                                        | Description                                |
| ---------- | ------------------------------------------- | ------------------------------------------ |
| `effort`   | `"quick" \| "small" \| "medium" \| "large"` | Estimated effort to address.               |
| `fix_shape`| `string` (≤120 chars, single line)          | The shape of the fix, not the fix itself.  |

Consumers that hard-checked `schema_version === "0.1.0"` must accept
`"0.2.0"` as well. No existing field changed shape, name, or semantics.

Effort ladder:

- `quick` — ≤1-line change.
- `small` — under one hour of work.
- `medium` — fits within one PR.
- `large` — needs design.

`fix_shape` is a one-line description of the *shape* of the fix
(e.g. `"extract orchestration; move pure helpers to a sibling module"`),
not a complete patch. Detector-supplied; per-detector defaults live in
[`packages/core/src/detector-defaults.ts`](../packages/core/src/detector-defaults.ts).
The fallback for detectors that supply neither is `medium` +
`"refactor to remove this signal; add a test that pins the fix"`.

This release also adds several **optional** annotation fields on
`Finding` for the `crimes triage` workflow and the resurfacing pipeline.
See [Triage fields](#triage-and-resurface-fields) and
[`.crimes/triage.json`](#triage-on-disk-shape-of-crimestriagejson).

## Contents

| Report                                                            | `report_type`     | Emitted by                                            |
| ----------------------------------------------------------------- | ----------------- | ----------------------------------------------------- |
| [`ScanReport`](#scanreport-output-of-crimes-scan)                 | `"scan"`          | `crimes scan`, `crimes scan --changed [--fail-on]`    |
| [`Finding`](#finding)                                             | _(embedded)_      | every report that lists findings                      |
| [`ContextReport`](#contextreport-output-of-crimes-context-file)   | `"context"`       | `crimes context <file>`                               |
| [`HotspotsReport`](#hotspotsreport-output-of-crimes-hotspots)     | `"hotspots"`      | `crimes hotspots`                                     |
| [`DiffReport`](#diffreport-output-of-crimes-diff-basehead)        | `"diff"`          | `crimes diff <base...head>`                           |
| [`Baseline`](#baseline-on-disk-shape-of-crimesbaselinejson)       | `"baseline"`      | `crimes baseline save` (on-disk file)                 |
| [`BaselineCheckReport`](#baselinecheckreport-output-of-crimes-baseline-check) | `"baseline_check"` | `crimes baseline check`                       |
| [`VerdictReport`](#verdictreport-output-of-crimes-verdict)        | `"verdict"`       | `crimes verdict`                                      |
| [`ExplainReport`](#explainreport-output-of-crimes-explain)        | `"explain"`       | `crimes explain <id-or-fingerprint>`                  |
| [`Suppressions`](#suppressions-on-disk-shape-of-crimessuppressionsjson) | `"suppressions"` | `crimes ignore` / `crimes unignore` (on-disk file)   |
| [`Triage`](#triage-on-disk-shape-of-crimestriagejson)             | `"triage"`        | `crimes triage` (on-disk file, since `0.11.0`)        |
| [`AuditSuppressionsReport`](#auditsuppressionsreport-output-of-crimes-audit-suppressions) | `"audit_suppressions"` | `crimes audit-suppressions`            |
| [`FeedbackReport`](#feedbackreport-output-of-crimes-feedback-list--summary--export)       | `"feedback"`           | `crimes feedback list / summary / export`             |
| [Gate fields](#scan---changed---fail-on-gate-fields)              | _(optional)_      | `crimes scan --changed --fail-on …`                   |
| [Suppression fields](#suppression-fields)                         | _(optional)_      | every report that lists findings                      |
| [Triage and resurface fields](#triage-and-resurface-fields)       | _(optional)_      | every report that lists findings (0.7.0+ resurface, 0.11.0+ triage) |
| [Stability guarantees](#stability-guarantees)                     |                   |                                                       |

---

## `ScanReport` (output of `crimes scan`)

The default report. Emitted by every form of `crimes scan` — directory
scans, `--changed`, and the `--changed --fail-on` gate (which adds
two extra top-level fields documented below).

```ts
interface ScanReport {
  schema_version: "0.3.0";
  /** Discriminator. Always the literal `"scan"`. */
  report_type: "scan";
  repo: RepoInfo;
  summary: ScanSummary;
  findings: Finding[];
  /** Set only when `crimes scan --changed --fail-on <severity>` is used. */
  fail_on?: "low" | "medium" | "high";
  /** Set only when `fail_on` is set. True when ≥1 finding meets `fail_on`. */
  failed?: boolean;
  /** Set only when `crimes scan --changed` was used. See below. */
  changed_files?: string[];
  /**
   * Number of findings hidden because of a silencing `.crimes/triage.json`
   * entry (`needs-design`, `wont-fix`, or `scaffolding`). Only present
   * when ≥1 silencing entry matched and `--show-triaged` was off —
   * absent otherwise, which downstream consumers should treat as "no
   * triaged findings hidden in this invocation". Mirrors the
   * `suppressed_count` convention.
   */
  triage_hidden_count?: number;
  /**
   * Per-pack file-count breakdown. Absent when scanning a path with zero
   * discovered files. Added in `schema_version: "0.3.0"`.
   */
  coverage?: ScanCoverage;
}
```

### `schema_version`

The wire format version. Always present, always a string. Bumped on any
breaking change to the shape of `Finding`, `ScanSummary`, or `RepoInfo`.

Consumers should refuse to parse a report whose `schema_version` they do not
recognise.

### `report_type`

Discriminator literal. Always `"scan"` for `crimes scan` output. Every
report type that `crimes` emits carries one — `"scan"`, `"context"`,
`"hotspots"`, `"diff"`, `"baseline"`, `"baseline_check"`, `"verdict"` —
so consumers can route on a single field instead of pattern-matching on
the body. Always present, always a string literal.

### `repo`

```ts
interface RepoInfo {
  /** Basename of the scanned root directory. */
  name: string;
  /** Absolute path to the scanned root, machine-specific. */
  root: string;
  /** Optional git ref the scan ran against. Not yet populated. */
  git_ref?: string;
}
```

`root` is an absolute filesystem path on the machine that ran the scan. Useful
to anchor `findings[].file` (which is repo-relative), but not stable across
machines or containers.

`git_ref` is reserved for a future milestone that wires up git history.

### `summary`

```ts
interface ScanSummary {
  total: number;
  high: number;
  medium: number;
  low: number;
}
```

Counts by severity. `total` equals the sum of the three buckets.

### `coverage`

Optional. Present when the scan discovered at least one file. Documents how
many files each pack claimed, so consumers can understand what evidence was
available. See [`docs/packs.md`](./packs.md) for the pack model.

```ts
interface ScanCoverage {
  /** Total source files discovered (after exclude rules). */
  files_total: number;
  /** Count by file extension group. Keys are short language tags ("js", "py", etc.). */
  files_by_language: Record<string, number>;
  /** Files that no language pack claimed (universal-pack coverage only). */
  files_universal_only: number;
  /**
   * Histogram of the universal-only bucket by lower-cased extension,
   * e.g. `{ ".py": 48, ".go": 3, "(no extension)": 1 }`. Sums to
   * `files_universal_only`. This is the language-pack demand signal —
   * it answers which pack would buy the most coverage in this repo.
   * Optional; absent on reports produced before 0.13.0.
   */
  universal_only_by_extension?: Record<string, number>;
  /**
   * Pack IDs that ran this scan, always led by `"universal"` — e.g.
   * `["universal", "language-js"]`. Derived from the language-pack
   * router, so it reflects what actually executed rather than what was
   * configured. The universal pack claims every file, so a repo with no
   * matching language pack still reports `["universal"]`.
   */
  packs_loaded: string[];
}
```

The human reporter prints a one-line coverage banner when >50% of discovered
files were universal-only. Pass `--explain-coverage` to print the full
breakdown after scan output.

### `scan --changed --fail-on` gate fields

`fail_on` and `failed` are **optional**, top-level, and **only set when the
CLI runs `crimes scan --changed --fail-on <severity>`**. Both fields are
absent from every other invocation of `crimes scan` — including
`crimes scan` without `--changed` and `crimes scan --changed` without
`--fail-on`. Adding optional fields is non-breaking under the
[stability guarantees](#stability-guarantees) below, so the existing
`ScanReport` contract is unchanged.

```ts
fail_on?: "low" | "medium" | "high";
failed?: boolean;
```

- `fail_on` — the threshold the CLI gated on, echoed back verbatim. Use
  this to confirm what the run was actually checking against.
- `failed` — `true` when at least one `Finding` in `findings` has
  `severity ≥ fail_on`, using the same `low < medium < high` ordering
  as `crimes baseline check`. `false` otherwise (including when
  `findings` is empty).

The corresponding CLI behaviour:

- `--fail-on` is **only valid** in combination with `--changed`. Passing
  it on a plain `crimes scan` exits `2` (usage error). Pass `--changed
  --fail-on <severity>` to opt into the gate.
- `--fail-on` accepts `low | medium | high`. `low` fails on any
  finding; `medium` fails on medium or high; `high` fails on high only
  — same semantics as `crimes baseline check --fail-on`.
- Exit `1` when `failed === true`; exit `0` when `failed === false`;
  exit `2` for usage / environment errors (unknown threshold, not a
  git repo, etc.).
- The default `crimes scan` exit-code behaviour is **unchanged** when
  `--fail-on` is not passed — it still always exits `0`.

See [`docs/ci.md`](./ci.md) for the recommended CI integration.

### `scan --changed` `changed_files` field

`changed_files` is **optional**, top-level, and **only set when the CLI
runs `crimes scan --changed`** (with or without `--base`, with or
without `--fail-on`). Plain `crimes scan` omits the field. Adding an
optional field is non-breaking under the
[stability guarantees](#stability-guarantees).

```ts
changed_files?: string[];
```

- Lists **every** file the `--changed` resolver returned — including
  files that produced **zero** findings (e.g. a touched `README.md`,
  `package.json`, or a `.ts` file the detectors had nothing to say
  about). The point is that an agent re-running `crimes scan --changed`
  after an edit can confirm which files it actually touched even when
  the diff is clean.
- Paths are **repo-relative POSIX** (`/`-separated). Sorted
  alphabetically and deduplicated.
- When the working tree has no changes, the array is **present and
  empty** — that's "we looked and found nothing", not "we didn't look".
- The set is the same one `crimes scan --changed` resolves to drive
  the scan — staged + unstaged + untracked working-tree changes, plus
  `<base>...HEAD` when `--base` is set. Deletions are skipped (git
  reports them but the path no longer exists on disk).

### `findings`

Array of `Finding` objects, sorted:

1. By severity (`high → medium → low`)
2. Then by `confidence` descending
3. Then by `file` ascending
4. Then by `lines[0]` ascending

IDs (`crime_00001`, `crime_00002`, …) are assigned in this sort order, so they
are stable as long as the underlying detector results are stable.

---

## `Finding`

```ts
interface Finding {
  /** Stable per-scan id, e.g. "crime_00001". */
  id: string;
  /** Machine-readable detector type, e.g. "large_function". */
  type: string;
  /**
   * Qualified detector id including language suffix, e.g. "large_function.js".
   * Use `type` for grouping across packs; use `detector_id` to disambiguate
   * "JS large_function" from "Python large_function" (0.13.0+).
   * Required since `schema_version: "0.3.0"`.
   */
  detector_id: string;
  /**
   * The pack that produced this finding. Distinct from `tier` (scope tier).
   * Required since `schema_version: "0.3.0"`.
   */
  pack: "universal" | "language-js" | "language-py" | "cross-language";
  /** Human-readable charge, e.g. "God Function". */
  charge: string;
  severity: "low" | "medium" | "high";
  /** 0–1 confidence. */
  confidence: number;
  /** Repo-relative path with forward slashes. */
  file: string;
  /** Function/class/method name when applicable. */
  symbol?: string;
  /** Inclusive [start, end] 1-based line range. */
  lines?: [number, number];
  /** One-line natural-language summary. */
  summary: string;
  /** Concrete evidence — short factual strings, deterministic. */
  evidence: string[];
  scores: FindingScores;
  suggested_actions?: SuggestedAction[];
  /**
   * Other repo-relative files that contributed evidence to this finding.
   * Populated by cross-file detectors (`missing_agent_context`,
   * `route_metadata_drift`, `duplicated_navigation_source`,
   * `concept_alias_drift`, `docs_code_drift`,
   * `magic_domain_literal_scatter`). Absent on file-local findings.
   */
  related_files?: string[];
  /**
   * Only set when the consumer requested `--show-suppressed`. Indicates
   * the finding matched an entry in `.crimes/suppressions.json` and would
   * normally be hidden. Gate evaluation always ignores findings with
   * `suppressed === true` regardless of display.
   */
  suppressed?: true;
  /** Paired with `suppressed`. The reason recorded in the suppressions file. */
  suppression_reason?: string;
  /**
   * Set when the finding matched a feedback-sourced suppression whose
   * pinned minor differs from the current crimes minor — the 0.7.0
   * auto-resurface loop. The finding is kept in `findings[]` (NOT
   * counted in `suppressed_count`) so the user can re-confirm `fp` or
   * mark `tp`. Manual suppressions never resurface.
   */
  previously_suppressed?: true;
  /** Paired with `previously_suppressed`. Carries the prior pin + reason. */
  previous_suppression?: {
    pinned_version: string;
    reason: string;
  };
  /**
   * Estimated effort to address. Detector-supplied; defaults vary per
   * detector type and fall back to `"medium"`. Required since 0.2.0.
   */
  effort: "quick" | "small" | "medium" | "large";
  /**
   * One-line description of the *shape* of the fix, not the fix itself.
   * Detector-supplied; ≤120 chars, single line, non-empty. Defaults vary
   * per detector type — see `packages/core/src/detector-defaults.ts`.
   * Required since 0.2.0.
   */
  fix_shape: string;
  /**
   * Set when this finding matches an entry in `.crimes/triage.json` with
   * a non-silencing disposition (`fix-now` or `fix-this-PR`). Silencing
   * dispositions hide the finding by default and only surface via the
   * resurfacing pipeline or `--show-triaged` (see `hidden_triage`).
   */
  triaged?: {
    disposition: "fix-now" | "fix-this-PR";
    reason: string;
    owner: string;
    /** YYYY-MM-DD */
    date: string;
  };
  /**
   * Set only when the consumer requested `--show-triaged` AND this
   * finding matched a silencing triage disposition. Gate evaluation
   * always ignores findings with `hidden_triage !== undefined`,
   * regardless of `--show-triaged`.
   */
  hidden_triage?: {
    disposition: "needs-design" | "wont-fix" | "scaffolding";
    reason: string;
    owner: string;
    date: string;
  };
  /**
   * Set when this finding resurfaced because it matched an entry in
   * `.crimes/triage.json` and its file is in the branch diff against
   * `config.triage.resurfaceBase`. The finding is kept in `findings[]`
   * with this annotation; consumers can detect resurfaced entries by
   * filtering on `previously_triaged === true`.
   */
  previously_triaged?: true;
  /** Paired with `previously_triaged`. The original disposition + receipts. */
  previous_triage?: {
    disposition: "fix-now" | "fix-this-PR" | "needs-design" | "wont-fix" | "scaffolding";
    reason: string;
    owner: string;
    /** YYYY-MM-DD */
    date: string;
  };
  /**
   * Set when this finding resurfaced because it matched an entry in
   * `.crimes/baseline.json` and its file is in the branch diff against
   * `config.triage.resurfaceBase`. Mutually exclusive with
   * `previously_triaged` in practice — a finding with both possible
   * matches gets `previously_triaged` (triage wins, more specific).
   */
  previously_baselined?: true;
  /** Paired with `previously_baselined`. Best-effort metadata from the baseline file. */
  previous_baseline?: {
    /** ISO-8601 date the baseline was last written; absent if unknown. */
    date?: string;
    /** Baselines don't store per-entry reasons today; absent. */
    reason?: string;
  };
}
```

### Required vs optional

Always present on every finding:

- `id`, `type`, `charge`, `severity`, `confidence`, `file`, `summary`,
  `evidence`, `scores`
- `effort` and `fix_shape` since `schema_version: "0.2.0"`
  (`crimes@0.11.0`). Detector-supplied with defaults — see
  [Migration note](#migration-note-schema_version-010--020).
- `pack` and `detector_id` since `schema_version: "0.3.0"`
  (`crimes@0.12.0`). See [Migrating from 0.2.0 to 0.3.0](#migrating-from-020-to-030).

Populated when the detector has the data:

- `symbol` — set for findings that name a specific function/class/method
  (e.g. `large_function`). Absent for file-level findings.
- `lines` — set for any finding with a meaningful line range. All built-in
  detectors populate this in v0.1.0.
- `suggested_actions` — set for every built-in detector in v0.1.0, but
  optional in the schema.

Populated on cross-file findings:

- `related_files` — populated by the five IA detectors and the
  cross-file petty literal detector
  (`missing_agent_context`, `route_metadata_drift`,
  `duplicated_navigation_source`, `concept_alias_drift`,
  `docs_code_drift`, `magic_domain_literal_scatter`). Absent on
  structural and file-local petty findings.

Reserved (declared in the schema, deferred to later milestones):

- `scores.blast_radius`, `scores.churn`, `scores.test_gap` — see below

### `id`

A scan-local identifier in the form `crime_NNNNN` (5-digit zero-padded). IDs
are assigned after sorting, so a given finding may get a different id between
runs if the set of findings changes. Use `id` for citing within a single
report; do not persist it across scans.

### `type`

Machine identifier for the detector that produced the finding. Stable. New
`type` values may be added without bumping `schema_version`; consumers
should treat unknown values defensively. The currently shipped values are:

| `type`                          | Charge                       | Symbol set? | What it flags                                                                                  |
| ------------------------------- | ---------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| `large_file`                    | `God File`                   | no          | Files over `thresholds.largeFileLines` (default 300)                                            |
| `large_function`                | `God Function`               | yes         | Functions/methods/arrows over `thresholds.largeFunctionLines` (60)                              |
| `todo_density`                  | `Unfinished Business`        | no          | High `TODO/FIXME/XXX/HACK` density vs `thresholds.todoDensityPerKLoc`                            |
| `direct_date`                   | `Temporal Recklessness`      | no          | Direct `Date.now()` or `new Date()` usage                                                       |
| `commented_out_code`            | `Commented-Out Corpse`       | no          | Comment blocks or consecutive line comments that appear to contain disabled source code          |
| `logic_in_comments`             | `Logic in the Alibi`         | no          | Comments that appear to carry business rules or safety constraints not represented nearby        |
| `name_behavior_mismatch`        | `False Identity`             | yes         | Safe-sounding function names whose bodies appear to perform side effects                         |
| `magic_domain_literal_scatter`  | `String Sprinkles`           | no          | Repeated domain-looking literals spread across production files                                  |
| `weak_test_signal`              | `Test That Proves Nothing`   | no          | Tests with no assertions or only weak assertion matchers                                         |
| `option_bag_junk_drawer`        | `Option Bag Junk Drawer`     | yes         | Generic object bags with large implicit shapes                                                   |
| `return_shape_roulette`         | `Return Shape Roulette`      | yes         | Functions returning divergent object shapes without an explicit return type                      |
| `negative_flag_maze`            | `Negative Flag Maze`         | no          | Conditionals that combine multiple negative flag names                                           |
| `missing_agent_context`         | `Missing Agent Context`      | no          | Repo declares a `bin` but ships no `AGENTS.md` / `CLAUDE.md` / `.claude/skills/*/SKILL.md` / `.agents/skills/*/SKILL.md`      |
| `route_metadata_drift`          | `Route Metadata Drift`       | no          | One route's path, file, component name, page title, and nav labels appear to use competing names |
| `duplicated_navigation_source`  | `Duplicated Navigation Source` | no        | Same destination declared in multiple nav-like source files with different labels                |
| `concept_alias_drift`           | `Concept Alias Drift`        | no          | A seeded alias group (e.g. `team` / `workspace` / `organisation`) spans multiple directories on product surface |
| `docs_code_drift`               | `Docs-Code Drift`            | no          | Markdown document references a local file that does not exist on disk                            |
| `orphaned_destination`          | `Orphaned Destination`       | no          | Route declared in nav / IA index but no source file or route file resolves the destination       |
| `parallel_destination`          | `Parallel Destination`       | no          | Two nav-like surfaces declare different routes for the same canonical destination                |
| `permission_ia_drift`           | `Permission IA Drift`        | no          | The same role / permission identifier appears with different IA categorisation across surfaces   |
| `action_label_drift`            | `Action Label Drift`         | no          | Two surfaces label the same domain action differently ("Delete" vs "Remove")                     |
| `command_drift_docs_code_drift` | `Command Docs / Code Drift`  | no          | Markdown references a `bin` subcommand the CLI no longer implements                              |
| `layer_violation`               | `Layer Border Crossing`      | no          | An import crosses a forbidden boundary defined by `architecture.layers` + `architecture.rules`   |
| `circular_dependency`           | `Tangled Imports`            | no          | Two or more files form an import cycle                                                           |
| `deep_import`                   | `Deep Import Abuse`          | no          | An import reaches more than `n` segments deep into another package's source tree                 |
| `high_fan_in_fan_out`           | `Crowded Module`             | no          | A file has unusually high import fan-in and/or fan-out                                           |
| `design_token_escape`           | `Design Token Escape`        | no          | Hard-coded colours / spacings / font sizes in JSX where the repo has a design-token system       |
| `accessible_interaction_risk`   | `Hidden Interaction`         | no          | A JSX element handles pointer events but has no accessible label                                 |
| `duplicate_component_shape`     | `Duplicate Component Shape`  | yes         | Two or more components share an identical JSX shape (AST-hash equivalent)                        |
| `responsive_fragility`          | `Responsive Fragility`       | no          | A component mixes many breakpoint-specific utilities or hard-pixel widths                        |
| `copy_ia_drift`                 | `Copy / IA Drift (frontend)` | no          | A nav label and a breadcrumb / page-title disagree on the canonical name for the same destination |
| `exact_duplicate_block`         | `Exact Duplicate Block`      | yes         | Two or more function bodies / statement blocks share an identical AST hash                       |
| `near_duplicate_block`          | `Near-Duplicate Block`       | yes         | Two function bodies share a high-similarity AST-hash bag with a small delta                      |
| `duplicated_role_status_plan_check` | `Duplicated Policy Logic` | no         | The same domain concept (role, status, plan tier) is checked in multiple files with different shapes |

Information-architecture findings (`missing_agent_context`,
`route_metadata_drift`, `duplicated_navigation_source`,
`concept_alias_drift`, `docs_code_drift`, `orphaned_destination`,
`parallel_destination`, `permission_ia_drift`, `action_label_drift`,
`command_drift_docs_code_drift`, `copy_ia_drift`) are cross-file:
their `file` field anchors the finding on the most useful single
path, and `related_files` lists the other files involved.
`magic_domain_literal_scatter`, the duplication detectors, the
dependency-graph detectors, and the frontend duplicate-component
detector follow the same cross-file pattern.

### `detector_id`

Qualified detector identifier including a language suffix, e.g.
`"large_function.js"`. Stable for a given detector × language pair. The
language suffix is `".js"` for `language-js` pack findings and `""` (the
bare `type`) for `universal` pack findings. Required since
`schema_version: "0.3.0"`.

Use `type` for grouping — `type === "large_function"` matches every
large-function finding regardless of language. Use `detector_id` only when
you need to distinguish "JS large_function" from "Python large_function",
which is relevant starting with the `language-py` pack in 0.14.0.
Python detector *ids* are qualified (`large_function.py`) so each
language's detector is separately addressable in config; the
`type` they emit stays abstract. See [`docs/packs.md`](./packs.md).

### `pack`

Which detector pack produced this finding. One of:

- `"universal"` — file-level evidence only (bytes, git, IA index); no AST
  required. Runs on every discovered file.
- `"language-js"` — AST evidence via `@crimes/language-js`. Runs only on
  `.ts/.tsx/.js/.jsx/.mjs/.cjs/.cts/.mts` files.
- `"language-py"` — AST evidence via `@crimes/language-py` (0.14.0+).
  Runs only on `.py/.pyi` files.
- `"cross-language"` — aligns artefacts from ≥2 language packs (0.15.0+).

Required since `schema_version: "0.3.0"`. Distinct from `tier` (the
scope-tier `"domain" | "nonDomain"` field): `pack` answers "what kind of
evidence produced this finding"; `tier` answers "was the file in the
domain-code scope or the non-domain scope".

### `charge`

Human-readable label for `type`. Stable for a given `type`. Use this in
user-facing summaries; use `type` in code that branches on detector kind.

### `severity` and `confidence`

`severity` is one of `"low" | "medium" | "high"`. It's the headline triage
signal: how bad this looks in isolation, ignoring blast radius and churn.

`confidence` is `0–1`. It reflects how sure the detector is that the smell is
real (e.g. a function that's 2× the line threshold has higher confidence than
one just barely over). Rounded to two decimals.

### `file` and `lines`

`file` is always **repo-relative**, with forward slashes regardless of OS.
Resolve against `repo.root` if you need an absolute path.

`lines` is `[startLine, endLine]`, both inclusive, both 1-based. When a
detector reports on the whole file, `lines` is `[1, lineCount]`. For
`todo_density`, `lines` spans from the first marker to the last marker.

### `symbol`

The function, method, or accessor name when the detector pinpoints a specific
declaration. May be `"<anonymous>"` when the detector found a function but
couldn't infer its name.

### `evidence`

An array of short factual strings (typically 2–4 items). Every item is
generated deterministically from the file/AST — no LLM. Quote evidence
verbatim when explaining a finding to a user. Examples:

```
"lines 37–240 (204 lines)"
"3.4× the configured 60-line threshold"
"function declaration"
"5× Date.now(), 2× new Date()"
"lines: 44, 50, 79, 185, 225, 237, 260"
"6× TODO, 4× FIXME, 2× HACK, 2× XXX"
"424.2 markers per 1k LOC (threshold 10)"
```

### `scores`

```ts
interface FindingScores {
  /** How bad the smell is in isolation (0–1). Always present. */
  severity: number;
  /** Detector certainty (0–1). Always present. */
  confidence: number;
  /**
   * Normalised transitive-importer count (0–1). Populated by every scan
   * since 0.6.0 from the repo's import graph. Ordinal — the precise
   * scaling may shift between minor releases. See `docs/scoring.md`.
   */
  blast_radius?: number;
  /**
   * Normalised commits-in-window count (0–1). Populated by every scan
   * since 0.6.0 from `git log --since=90d`. Same saturation curve as
   * `crimes hotspots`. Ordinal — see `docs/scoring.md`.
   */
  churn?: number;
  /**
   * Inverted test-coverage signal (0–1). 1.0 = no nearby tests; 0.0 = a
   * test file imports this file. Populated by every scan since 0.6.0.
   * Ordinal — see `docs/scoring.md`.
   */
  test_gap?: number;
  /**
   * Unified composite of severity / confidence / churn / test_gap /
   * blast_radius (0–1). Computed by core's finalisation pass on every
   * scan since 0.6.0; detectors no longer set this directly. The
   * weighting formula is documented in `docs/scoring.md`.
   */
  agent_risk?: number;
}
```

The `severity` / `confidence` here are the numeric versions of the top-level
fields. `agent_risk` is the differentiating signal vs other tools: rank by
`agent_risk` when your goal is "which areas are dangerous for me to edit",
not "which areas have the worst static smell".

`blast_radius`, `churn`, and `test_gap` are populated by every scan from
0.6.0 onward. They were "reserved" in 0.1.0–0.5.0; consumers that fell
back to "not computed" for absent values now see real numbers. The fields
remain optional in the schema so consumers can keep tolerating absence in
mixed-version environments (a `crimes scan` from a fixture saved before
0.6.0 still parses cleanly).

All score fields are rounded to two decimals when present.

### `suggested_actions`

```ts
interface SuggestedAction {
  /** Stable machine-readable action id, e.g. "extract_function". */
  kind: string;
  /** Human-readable suggestion. */
  description: string;
  /** Estimated risk of doing this action: "low" | "medium" | "high". */
  risk: "low" | "medium" | "high";
}
```

Currently shipped `kind` values (additive; new kinds may appear without
bumping `schema_version`):

- `extract_function` — break up a large function into named helpers
- `split_file` — split a large file along responsibility boundaries
- `triage_todos` — convert TODO markers into tracked issues or remove them
- `inject_clock` — replace direct `Date` usage with an injected clock
- `centralise_domain_literal` — move a repeated domain literal to a named source of truth
- `assert_observable_behaviour` — replace weak/no-op tests with assertions against observable behaviour
- `name_option_shape` — replace a generic object bag with a named shape or owned destructuring
- `name_return_shape` — add an explicit return type or named result variants
- `rename_or_simplify_flags` — prefer positive flag names or extract a readable predicate
- `add_agent_context` — add `AGENTS.md` or a Claude skill so agents can discover repo conventions
- `align_route_metadata` — align route path, file/component name, page title, and nav labels around one canonical name
- `consolidate_nav_source` — make one nav file the canonical source of truth for a destination
- `consolidate_concept` — pick or document the canonical term, and use aliases deliberately rather than accidentally
- `fix_doc_link` — update the docs or restore the referenced file so agents do not follow stale instructions

These are deterministic — typically one per detector kind. They are
**suggestions**, not instructions; pick the ones that match the user's
request.

### `related_files`

Populated by cross-file detectors: the information-architecture detectors
listed above and `magic_domain_literal_scatter`. For each cross-file
finding, `file` is the canonical anchor (route file, nav source, doc,
alias-group anchor, or first literal occurrence) and `related_files` lists
the other repo-relative paths that contributed evidence. Paths are
repo-relative POSIX strings, deduped, and sorted deterministically.

The human reporter renders `related_files` as an "Also touches:" block
under each finding (capped at 5 entries with the rest summarised), so
JSON consumers and human readers see the same set of paths without the
JSON contract changing. Treat each entry as "also read this before
editing" — same scope as the finding itself.

Reserved by the file-local detectors. They do not populate it today; treat
absence as "no cross-file context for this finding".

---

---

## `ContextReport` (output of `crimes context <file>`)

`crimes context <file> --format json` emits a single JSON document — the
`ContextReport`. It shares `schema_version` and the `Finding` shape with
`ScanReport`, but is keyed to one file:

```ts
interface ContextReport {
  schema_version: "0.3.0";
  /** Discriminator. Always the literal `"context"`. */
  report_type: "context";
  repo: { name: string; root: string; git_ref?: string };
  /** Repo-relative path of the inspected file. */
  file: string;
  risk: ContextRisk;
  /** One short line per finding type that fired, deduped. Stable order. */
  agent_guidance: string[];
  /** Other files an agent should read before editing the target. */
  related_files: ContextRelatedFile[];
  /** Repo-relative paths of test files likely covering `file`. Sorted. */
  likely_tests: string[];
  /** Same Finding shape as ScanReport, filtered to `file`. */
  findings: Finding[];
  /** Present only when `agent_guidance` is empty. */
  agent_guidance_reason?: string;
  /** Present only when `related_files` is empty. */
  related_files_reason?: string;
  /** Present only when `likely_tests` is empty. */
  likely_tests_reason?: string;
}

interface ContextRisk {
  /** Worst severity present in `findings`. `"none"` when there are none. */
  level: "none" | "low" | "medium" | "high";
  high: number;
  medium: number;
  low: number;
  /** findings.length */
  total: number;
}

interface ContextRelatedFile {
  /** Repo-relative POSIX path. Never the target file itself. */
  file: string;
  /** Short, human-readable rationale. Multiple reasons joined with "; ". */
  reason: string;
  /** Ordinal 0–1 weight used for sorting. May change between minor releases. */
  score?: number;
}
```

### Field order

`JSON.stringify` preserves insertion order, and the report is built with
`agent_guidance` ahead of `findings` so agents reading the JSON top to
bottom see the actionable summary before the more verbose finding
bodies. The canonical order is:

```
schema_version → report_type → repo → file → risk
  → agent_guidance → related_files → likely_tests → findings
  → agent_guidance_reason? → related_files_reason? → likely_tests_reason?
```

Object-key order is **not** part of the schema contract — consumers
should read by key, not by position — but the test fixtures and the CLI
output follow this order so copy-paste examples stay consistent.

### `related_files`

A ranked, capped list (max 10 entries) of repo-relative files an agent
should probably read before editing the target. Discovered
deterministically — no LLM, no git history. Heuristics:

- **IA finding passthrough.** When a finding on the target carries
  `related_files` (the IA detectors do this — `route_metadata_drift`,
  `duplicated_navigation_source`, `concept_alias_drift`,
  `docs_code_drift`), each of those paths surfaces with reason
  `related to <charge>`.
- **Shared IA path tokens.** Files whose path tokens overlap with the
  target's after stop-word filtering and singularisation (using the same
  tokeniser the IA index uses). Generic tokens like `api`, `route`,
  `service` don't anchor a match. Reason: `shares domain token "<token>"`.
- **Domain-prefix filename match.** Files whose basename starts with
  `<dominant-token>-` / `<dominant-token>_` / `<dominant-token>.`, ends
  with `-<dominant-token>` / `_<dominant-token>` (before the
  extension), or contains a path segment equal to the dominant token.
  Reason: `matches domain "<token>"`.
- **Same-directory siblings.** Other source files in the same directory
  as the target. Reason: `same directory`.

Per-entry rules:

- The target file itself is never included.
- Files already surfaced in `likely_tests` are excluded (tests live in
  their own block).
- Multiple heuristic hits on the same file compound — reasons are joined
  with `; ` and scores add (capped at `1.0`).
- Sorted by `score` descending, then by `file` ascending — deterministic
  across runs.
- The cap (`10`) is **not** part of the schema contract; treat it as a
  hint, not a guarantee.

`related_files_reason` is set instead of (or in addition to, when the
array is empty) the array — see [Empty-field reasons](#empty-field-reasons).

### `likely_tests`

Discovered by four deterministic conventions, in this order:

1. Sibling files with the same basename and a `.test.{ts,tsx,js,jsx,mjs,cjs}`
   or `.spec.{...}` extension (Jest / Vitest infix).
2. Sibling files matching the Go-style `_test.{ts,tsx,…}` / `_spec.{…}`
   suffix.
3. Files under any `__tests__/` directory whose basename (with any
   `.test` / `.spec` / `_test` / `_spec` suffix stripped) matches the
   target's basename.
4. Test files (matching one of the above conventions) whose source
   contains a relative-path import that resolves to the target file.

The result is deduped and lexically sorted. No git history, no symbol
resolution beyond a textual import-path match.

### Empty-field reasons

When `agent_guidance`, `related_files`, or `likely_tests` is the empty
array, the corresponding `*_reason` field is set to a short string
explaining why. The reason is **omitted** when the array is non-empty.
Standard wordings:

| Field | Wording (when empty) |
| ----- | -------------------- |
| `agent_guidance_reason` | `no findings on this file and no deterministic related files` or `findings on this file did not match any keyed guidance line` |
| `related_files_reason` | `no neighbourhood signal: no IA finding related_files, no shared domain tokens, no domain-prefix filenames, no same-directory siblings` |
| `likely_tests_reason` | `no sibling, __tests__, .test, .spec, _test, or _spec files matched the target basename` |

The exact wording is **advisory copy** — match on the array being empty
or the reason field being present, not on the string itself.

### `agent_guidance`

Static lookup keyed on `Finding.type`. One line per type that appears in
`findings`, in the order they first appear. Current keys:

| `Finding.type`                  | Guidance                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `large_function`                | Prefer extracting pure helpers before adding more branches.                                                |
| `large_file`                    | Read the whole file before editing — propose splits in their own change.                                   |
| `direct_date`                   | Avoid adding more direct clock access; inject time where possible.                                         |
| `todo_density`                  | Review TODOs before relying on comments as current intent.                                                 |
| `commented_out_code`            | Do not copy disabled code from comments; verify whether it should be deleted or explained as rationale.    |
| `logic_in_comments`             | Treat prose-only rules as suspect; encode them in guards, tests, config, or types before relying on them.  |
| `name_behavior_mismatch`        | Safe-sounding names may hide side effects — inspect callers before moving, caching, or duplicating them.   |
| `magic_domain_literal_scatter`  | Repeated domain strings can be duplicated policy — find or create the source of truth before adding another copy. |
| `weak_test_signal`              | Treat weak tests as low confidence; assert observable behaviour before relying on them as safety net.       |
| `option_bag_junk_drawer`        | Generic bags hide required fields — identify the owned shape before threading more data through.            |
| `return_shape_roulette`         | Divergent return shapes need an explicit contract before callers or agents infer a branch-specific shape.   |
| `negative_flag_maze`            | Simplify negative flags before extending the condition; double negatives are easy to invert.                |
| `missing_agent_context`         | Agents may miss project-specific commands, architecture rules, and safety checks.                          |
| `route_metadata_drift`          | The route path, title, breadcrumb, and component name appear to disagree — verify each before changing labels. |
| `duplicated_navigation_source`  | Multiple files declare this destination; updating only one will leave the others stale.                    |
| `concept_alias_drift`           | Other files describe this concept under a different name; read them before renaming or extending.          |
| `docs_code_drift`               | Docs reference local files that no longer exist — update the docs in the same PR.                          |

When the target file has no findings but `related_files` is non-empty,
`agent_guidance` instead contains a single neighbourhood line:

> Review related files before editing — they share domain tokens or
> route/navigation evidence with this target.

New detector `type`s may add new guidance lines without bumping
`schema_version`. The **wording** of any guidance line is not part of
the schema contract — treat it as advisory copy, not a stable string to
match on.

---

## `HotspotsReport` (from `crimes hotspots --format json`)

```ts
interface HotspotsReport {
  schema_version: "0.3.0";
  /** Discriminator. Always the literal `"hotspots"`. */
  report_type: "hotspots";
  repo: RepoInfo;
  /** Echo of the `--since` value the user passed (e.g. "90d"). */
  since: string;
  /** False when the directory is not a git repository or `git` is unavailable. */
  git_available: boolean;
  /** True when commit history is truncated (e.g. shallow clone). See below. */
  history_limited?: boolean;
  /** Short reason string. Only set when `history_limited` is true. */
  history_limited_reason?: string;
  /** Total rows available before the CLI's default top-20 cap. */
  total_files?: number;
  /** Rows included in this payload. Equals `hotspots.length`. */
  shown_count?: number;
  /** Rows omitted by the default cap. Zero when `--all` is passed. */
  hidden_count?: number;
  hotspots: Hotspot[];
}

interface Hotspot {
  /** Repo-relative path with forward slashes. */
  file: string;
  /** Commits in the `--since` window that touched this file. */
  change_count: number;
  /** ISO-8601 timestamp of the most recent commit. Absent when change_count is 0. */
  latest_change?: string;
  /** Number of `crimes scan` findings on this file. */
  finding_count: number;
  /** Worst severity present in findings. `"none"` when finding_count is 0. */
  highest_severity: "none" | "low" | "medium" | "high";
  /** Aggregate 0–1 change-risk score, rounded to 2 dp. */
  risk: number;
}
```

By default, `crimes hotspots --format json` returns the same top 20
rows as the human report and includes `total_files`, `shown_count`,
and `hidden_count` when the CLI applies that presentation cap. Pass
`--all --format json` to return every hotspot; `hidden_count` is then
`0`.

### Sorting

`hotspots` is sorted:

1. By `risk` descending
2. Then `change_count` descending
3. Then `highest_severity` descending (`high → medium → low → none`)
4. Then `file` ascending — as a stable tie-breaker

### `risk` formula (v0.1.0)

```text
risk = 0.6 × min(change_count / 20, 1)
     + 0.4 × { high: 1.0, medium: 0.6, low: 0.3, none: 0 }[highest_severity]
```

Rounded to 2 decimal places. The 20-commit cap and the 0.6 / 0.4 weights are
the **numeric formula** — they may change between minor releases. Treat
`risk` as an **ordinal** signal for ranking, not an exact measurement (same
contract as the per-finding `scores.*` fields).

### Non-git directories

When `git_available` is `false`, every row has `change_count: 0` and no
`latest_change`. `risk` then collapses to the severity component only and is
capped at `0.4`. The command does not fail — it degrades.

### Shallow clones (`history_limited`)

When the working tree is a shallow clone (`git rev-parse
--is-shallow-repository` returns `true`), older commits aren't present
locally — `git log` only sees the slice the clone fetched. Hotspot
counts under-report churn in that case. `crimes hotspots` annotates
this with two optional top-level fields:

```ts
history_limited?: boolean;
history_limited_reason?: string;
```

- **Only set when `git_available` is `true` AND the shallow probe
  returned `true`.** Plain non-git directories already surface via
  `git_available: false`; the two flags are mutually exclusive in
  practice.
- **`history_limited_reason`** is short, human-readable advisory copy
  (e.g. `"repository is a shallow clone; older commits are
  unavailable, so churn counts only reflect history present locally"`).
  Treat the wording as advisory — match on the boolean flag, not the
  string.
- Common in CI runners that default to `--depth=1` clones. Pass
  `fetch-depth: 0` (or equivalent) in your workflow to deepen the
  clone and clear the flag.

The human report prints the same notice on its second line, alongside
the existing "not a git repo" warning. JSON consumers should branch on
`history_limited` and downweight the ranking accordingly.

---

## `DiffReport` (output of `crimes diff <base...head>`)

`crimes diff <base...head> --format json` emits a single JSON document — the
`DiffReport`. It shares `schema_version` and the `Finding` shape with
`ScanReport`, but the body is grouped by what changed between the two refs
rather than listed flat.

```ts
interface DiffReport {
  schema_version: "0.3.0";
  /** Discriminator. Always the literal "diff". */
  report_type: "diff";
  repo: { name: string; root: string };
  /** Base ref the user passed (e.g. "main", "origin/main", a SHA). */
  base: string;
  /** Head ref the user passed (typically "HEAD"). */
  head: string;
  summary: DiffSummary;
  /** Findings present at `head` but not at `base`. */
  new_findings: Finding[];
  /** Findings present at `base` but not at `head`. */
  fixed_findings: Finding[];
  /**
   * Findings present at both refs (matched by fingerprint).
   * The Finding object comes from the `head` scan, so its
   * `lines`, `evidence`, and per-scan `id` reflect HEAD.
   */
  unchanged_findings: Finding[];
  /**
   * Set only when `crimes diff --fail-on <threshold>` is used. Mirrors
   * `ScanReport.fail_on` / `failed` — see the
   * [Suppression fields](#suppression-fields) and
   * [Stability guarantees](#stability-guarantees) sections.
   */
  fail_on?: "new-high" | "new-medium";
  failed?: boolean;
  /**
   * See [Suppression fields](#suppression-fields). Only set when ≥1
   * suppression matched on the new set.
   */
  suppressed_count?: number;
}

interface DiffSummary {
  new: number;
  fixed: number;
  unchanged: number;
}
```

### `report_type`

A discriminator literal so consumers can route on the report kind when
multiple shapes are piped together. Always `"diff"` for `crimes diff`
output. Every `crimes` report carries one (`"scan"`, `"context"`,
`"hotspots"`, `"diff"`, `"baseline"`, `"baseline_check"`, `"verdict"`) —
see the [Contents](#contents) table for the full mapping.

### How findings are matched (fingerprinting)

Findings are classified as `new` / `fixed` / `unchanged` by a stable
fingerprint, **not** by the per-scan `id`. The fingerprint is:

```
<type>::<file>::<symbol-or-empty>
```

- `type` — detector identity (`large_function`, `large_file`, …)
- `file` — repo-relative POSIX path
- `symbol` — function/method name when the detector pinpoints a
  declaration (e.g. `large_function`); empty for file-level detectors

The fingerprint deliberately excludes `lines`, `evidence`, `summary`, and
the per-scan `id`. That means a function shifting from lines 37–240 to
lines 42–246 after an unrelated edit above it is classified as
`unchanged`, not as a fix + new pair.

Source of truth: [`packages/core/src/fingerprint.ts`](../packages/core/src/fingerprint.ts).

### Sort order within each group

`new_findings`, `fixed_findings`, and `unchanged_findings` each preserve
the order their underlying scan produced — i.e. the same severity-first
order documented for [`ScanReport.findings`](#findings):

1. By severity (`high → medium → low`)
2. Then by `confidence` descending
3. Then by `file` ascending
4. Then by `lines[0]` ascending

### How the refs are scanned

`crimes diff` exports each ref into a fresh temporary directory via
`git archive <ref> | tar -x` and scans it there. The working tree is
**never** touched: no checkout, no stash, no temporary commits. Both
temp directories are cleaned up before the report is returned.

### Known limitations

- **File renames register as a fix + new pair.** A file moved from
  `src/a.ts` to `src/b.ts` between `base` and `head` will produce both
  fixed findings (from `a.ts`) and new findings (in `b.ts`), even if the
  underlying detector results are identical. This matches the default
  behaviour of `git diff` (without `--find-renames`).
- **Two findings with identical `(type, file, symbol)` collide on one
  fingerprint.** Nested helpers or overloaded function declarations with
  the same name in the same file deduplicate to a single logical
  finding. Rare in practice; a future schema version may add a
  disambiguator if it becomes a problem.

### Exit codes

By default, `crimes diff` is **advisory** — it exits `0` regardless of
how many new findings appear. Pass `--fail-on new-high | new-medium` to
turn the command into a hard CI gate (added in `0.5.0`); the threshold
matches `crimes verdict`'s thresholds. `--fail-on new-high` exits `1`
when any new finding has `severity: "high"`; `--fail-on new-medium`
exits `1` when any new finding is `"medium"` or `"high"`. Suppressed
entries never trip the gate, regardless of `--show-suppressed`.

For a hard CI gate you have four equivalent options sharing the same
`0` pass / `1` blocked / `2` usage exit contract:

- `crimes scan --changed --fail-on <severity>` (changed-set advisory)
- `crimes diff <base...head> --fail-on new-high | new-medium`
- `crimes baseline check --fail-on …`
- `crimes verdict --fail-on worse | new-high | new-medium`

Or gate on the JSON yourself:

```bash
crimes diff origin/main...HEAD --format json \
  | jq -e '.summary.new == 0' >/dev/null
```

---

## `Baseline` (on-disk shape of `.crimes/baseline.json`)

`crimes baseline save` writes a single JSON document to
`<root>/.crimes/baseline.json`. The file is **intended to be committed** — it
pins the set of pre-existing findings that future `crimes baseline check`
runs should ignore. The schema is versioned by the same `schema_version` as
`ScanReport`.

```ts
interface Baseline {
  schema_version: "0.3.0";
  /** Discriminator. Always the literal "baseline". */
  report_type: "baseline";
  /** ISO-8601 timestamp at which the baseline was written. */
  created_at: string;
  /** Version of `crimes` that wrote the file. Optional. */
  crimes_version?: string;
  /** Best-effort repo identity. `root` is machine-specific — informational only. */
  repo?: { name: string; root: string };
  /** Severity counts at the moment the baseline was written. */
  summary: ScanSummary;
  /** Every finding present at capture time, trimmed to identity-only fields. */
  findings: BaselineEntry[];
}

interface BaselineEntry {
  /** Same `<type>::<file>::<symbol-or-empty>` as `fingerprintFinding`. */
  fingerprint: string;
  type: string;
  charge: string;
  severity: "low" | "medium" | "high";
  file: string;
  symbol?: string;
}
```

### Why this shape

The baseline only needs enough per-finding data to (a) match a future scan
via the same fingerprint logic `crimes diff` uses, and (b) render a useful
`fixed_findings` list when the offending file no longer exists. Concretely
this means **no** `lines`, `evidence`, `summary`, `scores`,
`suggested_actions`, or per-scan `id` is persisted — those drift between
scans or become meaningless after the underlying code is gone.

### How `crimes baseline check` matches findings

By the exact same fingerprint logic as
[`crimes diff`](#diffreport-output-of-crimes-diff-basehead): the stable
`<type>::<file>::<symbol-or-empty>` identity. Small line shifts from
unrelated edits do not register as fix + new. The known limitations are
the same too: file renames register as a fix + new pair, and two findings
with identical `(type, file, symbol)` collide on one fingerprint.

---

## `BaselineCheckReport` (output of `crimes baseline check`)

```ts
interface BaselineCheckReport {
  schema_version: "0.3.0";
  /** Discriminator. Always the literal "baseline_check". */
  report_type: "baseline_check";
  repo: { name: string; root: string };
  /** Absolute path to the baseline file that was loaded. */
  baseline_path: string;
  /** Threshold the run used to decide `failed`. */
  fail_on: "low" | "medium" | "high";
  /** True when at least one new finding has severity ≥ `fail_on`. */
  failed: boolean;
  summary: BaselineCheckSummary;
  /** Full `Finding` objects from the current scan not present in the baseline. */
  new_findings: Finding[];
  /** Baseline entries with no matching fingerprint in the current scan. */
  fixed_findings: BaselineEntry[];
  /** Current-scan findings matched by fingerprint to a baseline entry. */
  unchanged_findings: Finding[];
}

interface BaselineCheckSummary {
  total_baseline: number;
  total_current: number;
  new: number;
  fixed: number;
  unchanged: number;
  new_by_severity: { high: number; medium: number; low: number };
}
```

### `fail_on` semantics

| Value      | A new finding fails when its severity is …       |
| ---------- | ------------------------------------------------ |
| `"low"`    | low, medium, or high                             |
| `"medium"` | medium or high _(default)_                       |
| `"high"`   | high only                                        |

`failed` is the AND of "at least one new finding" and "the worst new
severity meets the threshold". `fixed_findings` and `unchanged_findings`
never influence `failed` — only forward debt blocks CI.

### Exit codes

| Exit | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| `0`  | `failed: false` — no new findings at or above `fail_on`.                      |
| `1`  | `failed: true` — at least one new finding at or above `fail_on`.              |
| `2`  | Usage / environment error — missing baseline, malformed baseline, bad flags.  |

The JSON output is produced on stdout for exit `0` and `1`. Exit `2`
writes a single human-readable error line to stderr and emits no JSON.

### Why `fixed_findings` is `BaselineEntry[]`, not `Finding[]`

Unlike `DiffReport`, where both refs are scanned and the full `Finding`
shape is available on both sides, the baseline file only stores the
trimmed `BaselineEntry` per finding. A finding can be reported as "fixed"
even when the offending code has been deleted entirely — at which point
the original `lines`, `evidence`, and `scores` no longer make sense to
serialise.

---

## `VerdictReport` (output of `crimes verdict`)

`crimes verdict --format json` emits a single JSON document — the
`VerdictReport`. It is built on top of `crimes diff` (same archive-into-temp
machinery, same fingerprint-based matching) and adds a single headline
`verdict` plus `reasons` / `recommended_actions` strings on top.

```ts
interface VerdictReport {
  schema_version: "0.3.0";
  /** Discriminator. Always the literal "verdict". */
  report_type: "verdict";
  repo: { name: string; root: string };
  /** Base ref the verdict resolved (explicit `--base`, else default). */
  base: string;
  /** Head ref the verdict resolved (typically "HEAD"). */
  head: string;
  /** Headline judgement — one of four enum values. */
  verdict: "cleaner" | "worse" | "unchanged" | "mixed";
  summary: VerdictSummary;
  /** Short, machine-friendly reasons that drove the verdict. */
  reasons: string[];
  /** Short, human-readable next-step suggestions. */
  recommended_actions: string[];
  /** Findings present at `head` but not at `base`. Same shape as ScanReport. */
  new_findings: Finding[];
  /** Findings present at `base` but not at `head`. Same shape as ScanReport. */
  fixed_findings: Finding[];
}

interface VerdictSummary {
  new: number;
  fixed: number;
  /** Findings present at both refs. Carried through from the underlying diff. */
  unchanged: number;
  new_by_severity:   { high: number; medium: number; low: number };
  fixed_by_severity: { high: number; medium: number; low: number };
  /** Σ SEVERITY_WEIGHT over `new_findings`. */
  new_weighted: number;
  /** Σ SEVERITY_WEIGHT over `fixed_findings`. */
  fixed_weighted: number;
}
```

### Default base selection

When `--base` is omitted, `crimes verdict` picks the first of these refs
that resolves:

1. `origin/main`
2. `main`

If neither resolves, the command exits `2` with a "no default base" error
on stderr asking the user to pass `--base <ref>` explicitly. No JSON is
emitted.

### `verdict` semantics

Severity weights: `high = 3`, `medium = 2`, `low = 1`. Treat the verdict
as an ordinal signal — the weights may change between minor releases
(same contract as the per-finding `scores.*` fields).

Judgement rules, in order:

1. **`unchanged`** — no new findings AND no fixed findings.
2. **`worse`** — any new finding has `severity: "high"`. (A new high is
   not offset by fixing other highs — it still flips the verdict.)
3. **`worse`** — `summary.new_weighted > summary.fixed_weighted` (no new
   high required).
4. **`cleaner`** — `summary.fixed_weighted > summary.new_weighted` AND no
   new high findings.
5. **`mixed`** — both sides have at least one finding and weighted scores
   are equal.

`reasons` is a short array of human-readable strings — same content the
human renderer prints on the `Reason:` line. `recommended_actions` is
deterministic and keyed off the verdict (e.g. "fix new high-severity
findings before merging.", "ship it — this branch removes more crime
weight than it adds."). Treat both as **advisory copy** — wording may
shift across minor releases.

### How findings are matched

Same stable `<type>::<file>::<symbol-or-empty>` fingerprint as
[`crimes diff`](#diffreport-output-of-crimes-diff-basehead). Same known
limitations apply — file renames register as a fix + new pair,
identical-name nested helpers collide on one fingerprint.

### Exit codes

`crimes verdict` is **advisory by default** — it always exits `0`
regardless of the verdict, so agents and humans can read it without
breaking automation. Opt into a blocking gate with `--fail-on`:

| `--fail-on`    | Exit `1` when …                                                  |
| -------------- | ---------------------------------------------------------------- |
| _(omitted)_    | Never. Always exit `0`.                                          |
| `worse`        | `verdict === "worse"`.                                           |
| `new-high`     | Any new finding has `severity: "high"`.                          |
| `new-medium`   | Any new finding has `severity: "medium"` or `"high"`.            |

Exit `2` is reserved for usage / environment errors:

- Not a git repository.
- No default base resolves and no `--base` was passed.
- An explicit `--base <ref>` cannot be resolved.
- A bad `--format` or `--fail-on` flag.

The JSON output is produced on stdout for exit `0` and `1`. Exit `2`
writes a single human-readable error line to stderr and emits no JSON.

---

## `ExplainReport` (output of `crimes explain`)

Long-form rationale for a single finding. Resolves either a per-scan id
(`crime_00005`) or a stable fingerprint
(`<type>::<file>::<symbol>`). Deterministic — same paragraph per
detector type, no LLM, no per-finding tailoring.

```ts
interface ExplainReport {
  schema_version: "0.3.0";
  /** Discriminator. Always the literal `"explain"`. */
  report_type: "explain";
  /** The matched finding, verbatim from the scan it came from. */
  finding: Finding;
  detector: {
    /** Same string as `finding.type`. */
    type: string;
    /** Same string as `finding.charge`. */
    charge: string;
    /** One-line description of what the detector looks for. */
    description: string;
  };
  /** One-paragraph rationale for why this kind of finding matters. */
  why_it_matters: string;
  /** Ranked, human-readable remediation paths for this finding. */
  likely_remedies: string[];
  /**
   * Verbatim shell line that would suppress this finding. Always
   * starts with `crimes ignore <fingerprint> --reason ` and ends with
   * the placeholder `"<one-sentence justification>"`.
   */
  suggested_suppression_command: string;
}
```

`crimes explain` does not exit non-zero unless the input id/fingerprint
fails to resolve (exit `2`).

---

## `Suppressions` (on-disk shape of `.crimes/suppressions.json`)

Hand-reviewable list of per-finding exceptions. Written by `crimes
ignore`, intended to be committed. Matched findings are filtered out
of every report's default view; `--show-suppressed` re-surfaces them
annotated.

```ts
interface Suppressions {
  schema_version: "0.3.0";
  /** Discriminator. Always the literal `"suppressions"`. */
  report_type: "suppressions";
  /** ISO-8601 timestamp at which the file was first written. */
  created_at: string;
  /** ISO-8601 timestamp at which the file was last modified. */
  updated_at: string;
  /** Version of `crimes` that wrote the file last. Informational. */
  crimes_version?: string;
  suppressions: SuppressionEntry[];
}

interface SuppressionEntry {
  /** Stable `<type>::<file>::<symbol>` identity. Required. */
  fingerprint: string;
  /** Denormalised — same as the type segment of `fingerprint`. */
  type: string;
  /** Denormalised — same as the file segment of `fingerprint`. */
  file?: string;
  /** Denormalised — same as the symbol segment of `fingerprint`. */
  symbol?: string;
  /** Required, non-empty. The team's justification. */
  reason: string;
  /** ISO-8601 timestamp at which this entry was first written. */
  created_at: string;
  /** Optional. Default from `git config user.email` when available. */
  created_by?: string;
  /**
   * Origin of this suppression. Defaults to `"manual"` when absent
   * (i.e. the 0.5.0 / 0.6.0 file shape). Feedback entries participate
   * in the 0.7.0 auto-resurface loop; manual entries never resurface.
   */
  source?: "manual" | "feedback";
  /**
   * The crimes minor this suppression was recorded against, e.g.
   * `"0.7"`. Only meaningful when `source === "feedback"`. On scans
   * whose minor differs from the pinned value, the matching finding
   * resurfaces tagged `previously_suppressed: true`.
   */
  crimes_version_pinned?: string;
}
```

The denormalised `type` / `file` / `symbol` fields are redundant for
matching (only `fingerprint` drives it) but are load-bearing for human
review: a reviewer scanning `git diff .crimes/suppressions.json` reads
the entry without parsing the fingerprint.

The file is rewritten in full by `crimes ignore` — pretty-printed with
2-space indent and a trailing newline so the diff is reviewable.
Re-suppressing the same fingerprint updates `reason` and the top-level
`updated_at`; the entry's `created_at` is preserved. `crimes unignore`
removes an entry by fingerprint and bumps `updated_at`; the file is
never deleted (an empty `suppressions: []` stays so the frame is
visible).

---

## `Triage` (on-disk shape of `.crimes/triage.json`)

Hand-reviewable list of per-finding dispositions. Written by `crimes
triage` (interactive or `--apply`), intended to be committed.
Dispositions other than `fix-now` / `fix-this-PR` hide the finding from
the default `crimes scan` view; silenced findings resurface
automatically when the file appears in the branch diff against
`config.triage.resurfaceBase` (default `"main"`). New in `0.11.0`.

```ts
interface Triage {
  schema_version: "0.3.0";
  /** Discriminator. Always the literal `"triage"`. */
  report_type: "triage";
  /** ISO-8601 timestamp at which the file was first written. */
  created_at: string;
  /** ISO-8601 timestamp at which the file was last modified. */
  updated_at: string;
  /** Version of `crimes` that wrote the file last. Informational. */
  crimes_version?: string;
  entries: TriageEntry[];
}

interface TriageEntry {
  /** Stable `<type>::<file>::<symbol-or-empty>` identity. Required. */
  fingerprint: string;
  /** Denormalised — same as the type segment of `fingerprint`. */
  type: string;
  /** Denormalised — same as the file segment of `fingerprint`. */
  file: string;
  /** Denormalised — same as the symbol segment; empty string when absent. */
  symbol?: string;
  /**
   * Headline disposition. `fix-now` and `fix-this-PR` keep the finding
   * visible in `crimes scan` (annotated with a `▶` prefix); the other
   * three hide it by default and resurface on touched files.
   */
  disposition: "fix-now" | "fix-this-PR" | "needs-design" | "wont-fix" | "scaffolding";
  /** Required, non-empty. The team's justification. */
  reason: string;
  /**
   * Required at the schema level — present on every entry. May be the
   * empty string when the user declined to set one during the
   * interactive walk.
   */
  owner: string;
  /** YYYY-MM-DD when the disposition was recorded. Required. */
  date: string;
}
```

`reason`, `owner`, and `date` are **required at the zod level** so the
on-disk file always carries the receipts. `owner` may be the empty
string when the user explicitly declined to set one, but the field
must be present. `reason` and `date` are non-empty. `fingerprint`
follows the same `<type>::<file>::<symbol-or-empty>` scheme as
`Baseline` and `Suppressions`.

The denormalised `type` / `file` / `symbol` fields are redundant for
matching (only `fingerprint` drives it) but are load-bearing for human
review of `git diff .crimes/triage.json`.

The file is rewritten in full by `crimes triage` — pretty-printed with
2-space indent and a trailing newline. Each disposition write is
incremental: a SIGINT or terminal crash mid-walk does not lose
progress. `crimes triage --apply <file>` merges by fingerprint —
entries in the applied file overwrite existing entries with matching
fingerprints; unmentioned fingerprints stay untouched.

Malformed files raise `MalformedTriageError` and exit `2`, mirroring
`MalformedSuppressionsError`.

---

## `AuditSuppressionsReport` (output of `crimes audit-suppressions`)

Lists every entry in `.crimes/suppressions.json` with per-entry age
and concerns. Sorted oldest first. A missing file is not an error —
the report sets `loaded: false` and `entries: []`; a present-but-
malformed file exits `2` from the CLI with no JSON output.

```ts
interface AuditSuppressionsReport {
  schema_version: "0.3.0";
  /** Discriminator. Always the literal `"audit_suppressions"`. */
  report_type: "audit_suppressions";
  /** Absolute path of the suppressions file (read or not). */
  suppressions_path: string;
  /** True when the file existed and was read; false on an empty/missing file. */
  loaded: boolean;
  /** ISO-8601 timestamp the audit ran. Drives `age_days`. */
  generated_at: string;
  /** Total entries (clean + flagged). */
  total: number;
  /** Number of entries with at least one concern. */
  flagged_count: number;
  /** Every entry, sorted oldest first. */
  entries: AuditSuppressionEntry[];
}

interface AuditSuppressionEntry extends SuppressionEntry {
  /** Whole-number days between `created_at` and `generated_at`. */
  age_days: number;
  /** Empty for clean entries; one or more of the concerns below. */
  concerns: ("stale" | "short_reason" | "vague_reason")[];
}
```

Concern semantics:

| Concern | Meaning |
| ------- | ------- |
| `"stale"` | `age_days > 180`. |
| `"short_reason"` | `reason.trim().length < 16`. |
| `"vague_reason"` | The reason starts with a deferral keyword (`tmp`, `todo`, `wip`, `fixme`, `noisy`, `legacy`, `later`, `skip`, `ignore`) or matches `too noisy` / `we know …`. Only set when the reason is **not** already flagged as short. |

The thresholds are fixed in this release. JSON consumers that want
different rules can re-filter the `entries` array using the raw
`age_days` and `reason` fields.

---

## Suppression fields

Every report that lists findings (`ScanReport`, `ContextReport`,
`BaselineCheckReport`, `DiffReport`, `VerdictReport`) carries an
optional `suppressed_count?: number` field. Present **only** when ≥1
entry in `.crimes/suppressions.json` matched a finding in this
invocation. Absent otherwise — JSON consumers should treat absent as
equivalent to "no suppressions configured".

The per-finding annotations only appear when `--show-suppressed` is set:

- `Finding.suppressed?: true` — flags an entry that would otherwise be
  filtered out.
- `Finding.suppression_reason?: string` — the reason recorded in the
  suppressions file.

Gate semantics are independent of display: findings with `suppressed
=== true` never trip a `--fail-on` gate on any command, whether or not
`--show-suppressed` is on.

---

## `FeedbackReport` (output of `crimes feedback list / summary / export`)

Per-repo or global rollup view of the captured feedback JSONL.
`scope: "repo"` reads `.crimes/feedback.jsonl`; `scope: "global"`
reads `~/.crimes/feedback-rollup.jsonl` (which carries a `repo` field
per entry). Emitted by `--format json` from
`crimes feedback list / summary / export`. `recheck` has its own
shape (`feedback_recheck`) listed below.

```ts
interface FeedbackReport {
  schema_version: "0.3.0";
  report_type: "feedback";
  scope: "repo" | "global";
  /** Absolute path of the JSONL file read. */
  source_file: string;
  entries: FeedbackEntry[];
  /** Aggregate roll-up. Always present from `summary`; optional from `list`/`export`. */
  summary?: FeedbackSummary;
}

interface FeedbackEntry {
  /** ISO 8601 timestamp of when the verdict was recorded. */
  timestamp: string;
  /** Full semver of the crimes version that produced the finding. */
  crimes_version: string;
  /** Stable `<type>::<file>::<symbol>` fingerprint — primary identity. */
  fingerprint: string;
  /** Convenience denormalisation of the detector id. */
  finding_type: string;
  verdict: "tp" | "fp" | "known";
  /** Required when verdict is "fp" (it becomes the suppression reason). */
  note: string | null;
  /** sha256 of the scan JSON when `crimes feedback ... --file` was used. */
  scan_hash: string | null;
  /** Prior minor when this entry re-confirms / resolves a resurfaced fp. */
  resurfaced_from: string | null;
  /** Only present in the global rollup — absolute repo path. */
  repo?: string;
}

interface FeedbackSummary {
  total: number;
  by_verdict: { tp: number; fp: number; known: number };
  by_detector: Record<string, { tp: number; fp: number; known: number }>;
  by_version: Record<string, number>;
  /** Only present in global-rollup summaries. */
  by_repo?: Record<string, number>;
}
```

`crimes feedback recheck --format json` emits a sibling
`feedback_recheck` report:

```ts
interface FeedbackRecheckReport {
  schema_version: "0.3.0";
  report_type: "feedback_recheck";
  current_version: string;          // e.g. "0.7.0"
  current_minor: string;            // e.g. "0.7"
  resurfaced: Array<{
    fingerprint: string;
    type: string;
    file?: string;
    symbol?: string;
    reason: string;
    crimes_version_pinned: string;
    /** Per-detector release-notes hint, or the generic fallback. */
    hint: string;
    /** Verbatim re-feedback commands the user can copy. */
    commands: {
      reconfirm_fp: string;
      mark_resolved: string;
    };
  }>;
}
```

---

## Triage and resurface fields

Every report that lists findings (`ScanReport`, `ContextReport`,
`DiffReport`, `BaselineCheckReport`) can carry one of two families of
per-finding annotations:

**Triage annotations** (since `0.11.0`) — set when the finding
matched an entry in `.crimes/triage.json`:

- `Finding.triaged?: { disposition, reason, owner, date }` — set for
  visible dispositions (`fix-now`, `fix-this-PR`). The finding is kept
  in `findings[]`; gate evaluation treats it like any other visible
  finding.
- `Finding.hidden_triage?: { disposition, reason, owner, date }` —
  set only when `--show-triaged` is on AND the finding matched a
  silencing disposition (`needs-design`, `wont-fix`, `scaffolding`).
  Gate evaluation always ignores findings with `hidden_triage !==
  undefined`, regardless of `--show-triaged`. Mirrors the
  `suppressed` / `suppression_reason` pattern.
- `ScanReport.triage_hidden_count?: number` — count of findings
  hidden because of a silencing triage entry; only present when ≥1
  silencing entry matched and `--show-triaged` was off.

**Resurface annotations** (feedback-sourced since `0.7.0`; triage
and baseline resurfacing since `0.11.0`) — set when a finding
matched an entry in `.crimes/feedback*.jsonl`, `.crimes/triage.json`,
or `.crimes/baseline.json` and is being re-surfaced for review:

- `Finding.previously_suppressed?: true` — set when a feedback-sourced
  suppression's pinned minor differs from the current crimes minor.
  Paired with `Finding.previous_suppression?: { pinned_version, reason }`.
- `Finding.previously_triaged?: true` (new in `0.11.0`) — set when the
  finding matched a `.crimes/triage.json` entry and the file is in the
  branch diff against `config.triage.resurfaceBase`. Paired with
  `Finding.previous_triage?: { disposition, reason, owner, date }`.
- `Finding.previously_baselined?: true` (new in `0.11.0`) — set when
  the finding matched a `.crimes/baseline.json` entry and the file is
  in the branch diff. Paired with
  `Finding.previous_baseline?: { date?, reason? }` (best-effort
  metadata; baselines don't store per-entry reasons today).
- `previously_triaged` and `previously_baselined` are mutually
  exclusive in practice. When a finding matches both, triage wins
  (more specific).

Consumers can detect resurfaced findings without reading the
on-disk files by walking `findings[]` and filtering on
`previously_suppressed === true || previously_triaged === true ||
previously_baselined === true`. Counting them powers the resurface
block in the human renderer ("You're editing files you previously
triaged — was this still intentional?").

Resurfaced findings are emitted at the **start** of `findings[]`
(before non-resurfaced findings), in `rank_score` order within the
resurfaced subset.

---

## Stability guarantees

Within a single `schema_version`:

- Field **names** in the JSON output never change.
- Field **types** never change.
- A required field never becomes optional, or vice versa.
- New detector `type` values may be added without bumping the schema —
  consumers should treat unknown `type`s defensively.
- New `kind` values for `suggested_actions` may be added without bumping.
- The numeric formulas behind `severity`, `confidence`, and `agent_risk`
  scores **may change** between minor releases. Treat scores as ordinal
  signals, not exact measurements.

Breaking changes bump `schema_version` and are called out in release notes.
