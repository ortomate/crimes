# crimes JSON output

JSON is the public product contract. Reports currently use
`schema_version: "0.8.0"`. Before 0.28.2, feedback commands incorrectly
emitted `0.1.0` and triage summaries omitted the envelope. Consumers upgrading
those paths should accept the corrected version/discriminators. Existing triage
`entries` and `applied` fields are preserved. Route by `report_type`, accept documented optional
fields, and reject schema versions your consumer does not understand.

The [generated report types](./api-types.md) are derived from the public
TypeScript declarations and checked by `pnpm verify`. Use them for exact
field names, types and optionality. This guide explains their meaning;
[agent usage](./agent-usage.md) explains the editing workflow.

## Reading a report

Commands with `--format json` emit one JSON document on stdout. Diagnostics
and skill-update notices use stderr. JSON invocations do not prompt for
setup or automatically refresh skills; CI skips integration maintenance.
Use `--no-skill-update` to omit maintenance notices outside CI.

Successful report commands exit 0, or 1 when a selected gate fails.
Handled usage/environment errors exit 2, usually without a report; unexpected
internal failures can exit 1 without JSON. Validate both the exit status and
the presence/shape of the document. Exit 0 is not proof of complete analysis
or safe code. The advisory `hook` adapter deliberately exits 0 on errors;
its host envelope is described under [hooks](#hooks).

`repo.root` is absolute and machine-specific; file paths are relative to
that root, with forward slashes. Compare reports using the same executable,
root, scope, configuration and reference clock. JSON object property order
is not a consumer contract. Array order can carry ranking or discovery
priority; preserve it when presenting findings and suggested neighbors.

## Reports

| Command / document | `report_type` | Exact declaration |
| --- | --- | --- |
| `scan` | `scan` | [ScanReport](./api-types.md#scanreport) |
| `context` | `context` | [ContextReport](./api-types.md#contextreport) |
| `hotspots` | `hotspots` | [HotspotsReport](./api-types.md#hotspotsreport) |
| `diff` | `diff` | [DiffReport](./api-types.md#diffreport) |
| `baseline save` file | `baseline` | [Baseline](./api-types.md#baseline) |
| `baseline check` | `baseline_check` | [BaselineCheckReport](./api-types.md#baselinecheckreport) |
| `verdict` | `verdict` | [VerdictReport](./api-types.md#verdictreport) |
| `explain` | `explain` | [ExplainReport](./api-types.md#explainreport) |
| Suppression file | `suppressions` | [Suppressions](./api-types.md#suppressions) |
| Triage file | `triage` | [Triage](./api-types.md#triage) |
| `triage --list` | `triage_list` | [TriageListReport](./api-types.md#triagelistreport) |
| `triage --apply` | `triage_apply` | [TriageApplyReport](./api-types.md#triageapplyreport) |
| `triage --clear` | `triage_clear` | [TriageClearReport](./api-types.md#triageclearreport) |
| `audit-suppressions` | `audit_suppressions` | [AuditSuppressionsReport](./api-types.md#auditsuppressionsreport) |
| `feedback list / summary / export` | `feedback` | [FeedbackReport](./api-types.md#feedbackreport) |
| `feedback recheck` | `feedback_recheck` | [FeedbackRecheckReport](./api-types.md#feedbackrecheckreport) |
| `migrate-pins` | `pin_migration` | [PinMigrationPlan](./api-types.md#pinmigrationplan) |
| `migrate-pins --apply` | `pin_migration_apply` | [Pin migration](./pin-migration.md) |
| `migrate-pins --recover` | `pin_migration_recovery` | [PinMigrationRecoveryReport](./api-types.md#pinmigrationrecoveryreport) |

## `ScanReport` (output of `crimes scan`)

`findings` contains every visible finding, including its evidence, scores
and fingerprint. Human-only presentation flags do not truncate JSON.
`summary` counts visible findings. Suppression and triage metadata explain
intentionally hidden observations.

`working_set` records explicit file/import-neighbor selection;
`changed_files` records Git selection. The engine still analyzes the
repository before selecting output, so these flags do not promise a cheaper
scan. Findings anchored elsewhere can participate through related files.

### `scan --changed --fail-on` gate fields

With `--fail-on` and a working set (`--changed`, `--files`, or `--related-to`),
`fail_on` records the severity threshold and `failed` records the gate result.
The gate can include old findings in selected files. It is not a finding-delta
gate. See [CI modes](./ci.md) for baseline and committed-ref alternatives.

### `coverage`

Inspect [ScanReport.coverage](./api-types.md#scanreport) and
[CoverageWarning](./api-types.md#coveragewarning). Per-pack counts describe
which files were discovered and claimed, not which behaviors were tested.
Read `warnings` for unavailable/truncated indexes, unreadable or unparsed
files, unmatched selectors and stale pins. `detectors_default_off` describes
intentional optional defaults and does not imply incomplete analysis.
Missing coverage on an older or empty report does not establish completeness.

### Ranking

`ranking.recency_enabled` records whether the recency multiplier is active.
Finding order uses risk and the selected ranking policy. Human file grouping
starts with the strongest finding and adds diminishing support from distinct
claims. See [scoring](./scoring.md) for formulas and limitations.

## `Finding`

The [generated Finding declaration](./api-types.md#finding) is authoritative.
Read `type`, optional `claim`, `summary` and concrete `evidence` together.
`pack` identifies the analysis pack; `detector_id` identifies the registration
(for example `large_function` or `large_function.py`). Scores are ordinal
prioritization signals, not probabilities. Churn, test-gap and blast-radius
scores are populated where supported; they are not reserved placeholders.
An absent score is not a measured zero. `test_gap` measures discovery signals,
not executed coverage. `score_rationale` explains detector calibration when
available. Suggested actions are review options, not authorization to edit.

### `id`

`crime_NNNNN` is local to one report and can change after sorting or filtering.
Use it only with that report; do not persist it for before/after comparisons.
`explain --from report.json` can resolve a report-local ID.

### `fingerprint`

Persist and compare the emitted `fingerprint` verbatim. It is opaque to
consumers. Its current construction uses type, optional claim, file, symbol
and optional discriminator, but delimiters can also occur inside components.
Do not split or reconstruct it. Quote it when passing it to a shell command.

Line shifts usually preserve identity, but some subjects use a start line
as a discriminator. Renames, changed subjects and detector identity corrections
can produce an absent/new pair. An absent fingerprint is not proof that a
problem was fixed. [Pin migration](./pin-migration.md) preserves recorded
reasons, ownership and expiry rather than silently re-deciding them.

### `claim`

Multi-claim types name the particular assertion in `claim`. Composite claims
join sorted atoms with `+`. Group by `(type, claim)` when interpreting feedback.
A bare detector disable silences the whole detector; a claim disable targets
that assertion. See [configuration](./configuration.md).

## `ContextReport` (output of `crimes context <file>`)

Context shares repository discovery, analysis and scoring with scan. It
includes target-anchored findings and findings whose `related_files` name
the target. Use `--root .` for repository-wide analysis; the default selects
the nearest package/project marker and can omit monorepo consumers.

`analysis_status` is optional for compatibility with earlier reports:

| Status | Interpretation |
| --- | --- |
| `complete` | The enabled configured analysis finished. It is not a safety guarantee. |
| `partial` | Some analysis/indexing failed or was truncated; inspect coverage. |
| `not_analyzed` | The target did not participate in the configured analysis. |
| Absent | An older producer; do not assume completeness. |

`risk` counts visible findings, so `risk.level: "none"` can occur alongside
`not_analyzed`. Check status before interpreting risk. Related-file and
likely-test lists prioritize resolved imports, then use heuristic fallbacks.
These are suggestions to inspect, not proof that tests cover the behavior.
`*_reason` fields explain empty lists. `clues` carries ambient churn,
suppression inventory and test-discovery data where available.

Context does not apply triage hiding; inspect committed dispositions with
`triage --list --format json`. Suppressions apply unless requested for display.

## `HotspotsReport` (from `crimes hotspots --format json`)

Ranks files using Git churn and aggregate finding risk. Read `history_limited`
before interpreting shallow-clone results. Churn-based rank is a prioritization
hint, not a probability or a finding-delta gate. Use the generated declaration
for the `hotspots` entries and history fields.

## `DiffReport` (output of `crimes diff <base...head>`)

Compares two committed refs by exporting them into temporary directories;
working-tree edits are excluded. New/fixed/unchanged sets match fingerprints.
The command analyzes the named refs directly; three dots in its CLI range
syntax do not imply Git's merge-base diff semantics. Suppressions apply to
new findings. `--show-suppressed` changes display, not gate evaluation.
`--fail-on new-high` and `new-medium` opt into gates.

## `Baseline` (on-disk shape of `.crimes/baseline.json`)

Stores compact observations rather than full findings. Review and commit a
baseline when adopting a gate with accepted existing debt. New writes use
the current schema; loaders also accept the historical versions listed in
the generated type reference. Version acceptance does not migrate identities.

## `BaselineCheckReport` (output of `crimes baseline check`)

Compares current observations to the saved baseline. `new_findings` and
`unchanged_findings` are current Findings; `fixed_findings` contains old
BaselineEntry records, which have no current evidence. Default gate: new
medium or high findings. Absence can reflect exclusions or incomplete analysis;
review before replacing a baseline. [CI guide](./ci.md).

## `VerdictReport` (output of `crimes verdict`)

Summarizes a committed-ref comparison as `cleaner`, `worse`, `unchanged` or
`mixed`, with reasons, counts and optional next actions. Any new high produces
`worse`; otherwise new/fixed weighted severity uses high=3, medium=2, low=1.
These are ordinal comparisons, not measured safety improvements.

Prefer an explicit project base. Automatic selection tries the remote default
branch (`origin/HEAD`), then `origin/main`, `main`, `origin/master`, `master`.
The default head is `HEAD`. Uncommitted edits do not participate. Advisory
runs return 0 when analysis succeeds; `--fail-on` enables a gate.

## `ExplainReport` (output of `crimes explain`)

Explains a detector type or a finding selected by fingerprint/report-local ID.
Use `--from` to bind an ID to a retained scan. A live scan can assign a different
ID; a context ID is not an ID from a full scan.

## `Suppressions` (on-disk shape of `.crimes/suppressions.json`)

Entries carry identity and a reason; feedback-origin entries also carry the
minor-version pin governing resurfacing. See [suppressions](./suppressions.md)
and [feedback](./feedback.md). A recognized old schema is not proof that its
fingerprints still match. Unmatched pins are diagnostic evidence for review.

## `Triage` (on-disk shape of `.crimes/triage.json`)

Entries record fingerprint, disposition, reason, owner and date. Silencing and
resurfacing depend on the disposition and policy; see [triage](./triage.md).
`triage --apply` expects the documented decision-array input, not a ScanReport.

## `AuditSuppressionsReport` (output of `crimes audit-suppressions`)

Lists recorded suppressions and review concerns. A stale or absent subject
needs investigation; the report does not authorize deleting the decision.

## `FeedbackReport` (output of `crimes feedback list / summary / export`)

Feedback documents carry `report_type: "feedback"`, scope, source file,
entries and optional summary. Individual JSONL storage records have a different
shape and no report envelope. `note`, `scan_hash` and `resurfaced_from` can be
null; do not treat null as an omitted field. See [feedback](./feedback.md).

### Feedback recheck

`feedback recheck --format json` uses `report_type: "feedback_recheck"`,
`current_version`, `current_minor` and `resurfaced`. Each resurfaced
row contains the [resurfaced suppression](./api-types.md#resurfacedsuppression)
fields plus `commands.reconfirm_fp` and `commands.mark_resolved` hints.
Reconfirming a false positive also requires your reviewed `--note`.
This is an inventory for reconsideration, not an automatic renewal.

## Suppression fields

`--show-suppressed` retains normally hidden observations with `suppressed: true`
and their reason. Gates exclude these findings. `suppressed_count` is optional
and reports matched suppressions; its placement depends on report type.

## Triage and resurface fields

Scan can hide silencing dispositions and report `triage_hidden_count`.
`--show-triaged` exposes them with `hidden_triage`; display alone does not
make them gate failures. `--gate-needs-design` opts that disposition into the
scan gate. `previously_triaged` / `previously_baselined` observations are
advisory unless `--gate-resurfaced` is set. Feedback expiry is a separate
mechanism: `previously_suppressed` findings can participate in gates.

## Hooks

`hook --format json` emits the ordinary ContextReport. `hook --format claude`
emits Claude's host envelope containing `hookSpecificOutput.hookEventName`
and `additionalContext`, without a permission decision. The envelope is a
host protocol, not a crimes schema-versioned report. `compact` emits plain
text for manual payloads and the host envelope when stdin identifies a
Claude PreToolUse event. [Integration details](./skills.md#discovery-and-hooks).

## Stability guarantees

Optional additions can ship without a schema bump. Removing or repurposing
existing fields requires one. Finding counts, calibration, defaults and
identities can change when the scanner changes even if the wire shape does
not. Pin the CLI version used by CI and compare upgrades deliberately.

The npm package bundles a CLI; generated TypeScript documentation does not
make its internal workspace packages a supported import API.

## Historical migrations

The notes below describe earlier changes, not the current report declarations.
For current exact types use the [generated reference](./api-types.md).

## Migrating from `0.7.0` to `0.8.0`: one type, one claim

- **New optional field on `Finding`:** `claim?: string`.
- **New optional field on suppression and triage entries:** `claim?: string`,
  denormalised from the fingerprint the same way `type` / `file` /
  `symbol` already are.
- **`fingerprint` changes shape when `claim` is set.** The leading
  segment becomes `<type>/<claim>`. Findings from single-claim
  detectors — the large majority — keep the shape they have always had.

### What was wrong

`type` was doing two jobs: naming the detector, and standing in for what
the detector alleged. Those coincide only while a detector says exactly
one thing, and eleven types said more than one. `weak_test_signal`
emitted both:

```
Test "…" contains no expect/assert calls.
Test "…" only uses weak assertion matchers.
```

Two questions, two answers, two fixes — under one `type`, which is what
triage, suppressions, baseline, and `detectors.disable` all key on. On a
761-file repo a consumer verified three findings of the first shape,
found all three false, and disabled the type. That was correct about the
38 findings it had looked at and wrong about the 67 it had not.

`crimes` is built for agents and an agent triages by `type`, so this is
the main path rather than an edge case.

### What `claim` is

A claim is an assertion with its own truth value and its own fix. Count
and wording variation is not a claim: "1 declaration" and "3
declarations" are the same statement.

Most multi-claim detectors pick exactly one claim per finding — a test
either asserts nothing or asserts weakly. A few assert a **conjunction**
about one subject: `config_drift` reports one finding per environment
variable listing everything wrong with it, because a reviewer wants
`DATABASE_URL`'s problems in one place. Those carry a **composite**
claim — the atoms sorted and joined with `+`:

```
config_drift/type_disagreement+undocumented::src/env.ts::DATABASE_URL
```

Sorting is what makes a composite an identity rather than an accident of
evaluation order.

### The eleven types that changed

| type | claims |
| --- | --- |
| `weak_test_signal` | `no_assertions`, `weak_assertion_matchers`, `file_asserts_nothing` (Python) |
| `config_drift` | `type_disagreement`, `default_disagreement`, `requiredness_disagreement`, `unit_disagreement`, `client_exposed_secret`, `client_reachable_secret`, `boundary_bypass`, `undocumented`, `documented_but_unused` |
| `swallowed_error` | `empty`, `comment_only`, `discarded_rejection`, `bland_fallback`, `log_without_error` |
| `agent_permission_sprawl` | `permissive_allow_rules`, `hazardous_hook`, `unpinned_mcp_server`, `risky_instructions` |
| `dependency_provenance_gap` | `undeclared_import`, `lockfile_gap`, `unpinned_specifier` |
| `duplicated_policy` | `identical_copies`, `disagreeing_variants` |
| `mock_saturation` | `subject_mocked`, `collaborators_mocked` |
| `pass_through_abstraction` | `forwarding_chain`, `forwarding_cluster` |
| `cross_language_route_drift` | `path_not_declared`, `method_mismatch` |
| `large_function` | `too_long`, `deeply_nested` (Python) |
| `direct_date` | `clock_read`, `naive_datetime` (Python) |

`large_function` and `direct_date` are emitted by two packs each, and
only the Python side makes the second claim. Both packs label anyway:
consumers group by `type`, and a labelled finding sitting beside an
unlabelled one under the same type is the ambiguity this field exists to
remove.

### Silencing one claim

`detectors.disable` accepts `<type>/<claim>`. The bare id still disables
the whole detector, so existing config keeps working:

```jsonc
{
  "detectors": {
    // Silences the 38 that were wrong. Leaves the 67 that were right.
    "disable": ["weak_test_signal/no_assertions"]
  }
}
```

A composite is matched by atom, so `config_drift/client_exposed_secret`
also drops a finding claiming
`client_exposed_secret+undocumented` — asking not to hear about
client-exposed secrets means it whether or not the variable has other
problems too. A misspelled claim is rejected at config load and the
error names the claims that detector declares.

### What to do

For existing decisions, [preview a pin migration](./pin-migration.md), review
candidate claims and preserve the original rationale and expiry when applying.
A pre-0.8.0 pin on a multi-claim type stops matching; entries for other types
are unaffected. Re-record a decision only when you have reconsidered it.

## `0.22.0`: fingerprints move for findings that were colliding

**No schema change** — no field is added, renamed, or retyped, and
`schema_version` stays at `0.7.0`. What changes is the *value* of
`fingerprint` for a small set of findings, which matters to anyone
holding pinned entries in `.crimes/suppressions.json`,
`.crimes/baseline.json`, or a triage file.

Four detectors could emit more than one finding per
`(type, file, symbol)` and had no way to tell them apart, so
`crimes ignore` on one silenced its neighbours:

| detector | why it collided | now discriminated by |
| --- | --- | --- |
| `large_function` (Python) | one method name on several classes in a module — airflow's operator pattern gives `sagemaker.py` four `execute`s | the class, else the start line |
| `sync_io_in_hotpath` (Python) | same, for the enclosing hot function | the class, else the start line |
| `commented_out_code` (non-JS files) | every block in a file shared one fingerprint; the language-js variant has hashed the block since `0.17.0` | a hash of the block's text |
| `weak_test_signal` (JS) | two `it(...)` blocks in one file wearing the same title | the title, plus the start line |

**Only ambiguous fingerprints move.** A finding whose `symbol` is
already unique in its file keeps the fingerprint it has always had —
that rule is why the churn is small. Measured across four repos and
7,888 findings: **16 fingerprints retired, 51 introduced**, every one
of the 16 having previously covered two or more findings. hono, which
had no collisions, is byte-identical across the change. No finding
appears or disappears anywhere.

**What to do.** Nothing, unless `crimes scan` starts reporting a
finding you thought you had suppressed. If it does, that pin was
covering several findings at once: re-record it against the one you
meant. `crimes feedback recheck` names the change per detector.

## Migrating from `0.6.0` to `0.7.0`

- **New optional field on `ScanReport`:** `working_set`.
- **New `coverage.warnings[].kind`:** `working_set_path_unmatched`.

`working_set` is present only when the scan was narrowed with
`--files` or `--related-to`, and records the *resolved* set —
for `--related-to` that is the result of the import-graph walk, not the
seeds you passed.

```jsonc
"working_set": {
  "selector": "related-to",     // "files" | "related-to"
  "seeds": ["src/lib/api.ts"],  // what you named, sorted
  "depth": 1,                   // hops walked; "related-to" only
  "files": [                    // what was actually scanned, sorted
    "src/lib/api.ts",
    "src/lib/types.ts",
    "src/app/page.tsx"
  ]
}
```

It is recorded rather than left implicit because a graph walk that
silently included or excluded a file, with no way to check, is the shape
this codebase keeps getting bitten by. An agent must be able to confirm
what was looked at.

`--changed` continues to report through `changed_files` and sets no
`working_set` — the two carry different information (`changed_files`
includes files outside the discoverable source set, which a working set
by construction cannot).

Nothing was renamed or removed, so a consumer that ignores unknown keys
needs no change. `additionalProperties: false` validators and
`schema_version === "0.6.0"` hard-checks need updating. Baseline,
suppressions and triage files written at `0.6.0` are read unchanged.

Consumers switching on `coverage.warnings[].kind` should already
tolerate an unrecognised value — the field documents that new kinds may
be added in a minor.

## Migrating from `0.5.0` to `0.6.0`

- **New required field on every finding:** `fingerprint`.
- **New optional field:** `score_rationale` — how `confidence` and
  `severity` were arrived at, as a base value plus named deltas. The finding's
  stable identity — `<type>::<file>::<symbol>`, plus `::<discriminator>`
  when the detector sets one.

This is the handle four commands accept — `crimes ignore`, `crimes
unignore`, `crimes feedback`, `crimes triage` — and until now the JSON
did not contain it. `id` is positional and only means something inside
the report that produced it, so a consumer wanting to act on a finding
had to rebuild the fingerprint from the other fields and hope its
construction matched the one in `fingerprintFinding` — including the
discriminator rule, which is exactly the part a reimplementation gets
wrong.

Nothing was renamed or removed, so a consumer that ignores unknown keys
needs no change. A consumer validating with `additionalProperties:
false`, or one that hard-checks `schema_version === "0.5.0"`, must
accept the new field and the new version. Baseline, suppressions and
triage files written at `0.5.0` are still read without migration.

## Migrating from `0.4.0` to `0.5.0`

The blast-radius integer is split in two, because the one that shipped
was mislabelled.

- **Renamed:** `scores.blast_radius_importers` →
  `scores.blast_radius_transitive_importers`. Same value, honest name.
  It is the size of the file's transitive importer closure — every file
  that can *reach* it — not a count of files that import it.
- **New optional field:** `scores.blast_radius_direct_importers`. The
  number of distinct files with a direct import edge to this one,
  deduplicated across repeated imports from the same file and excluding
  self-edges. This is the "N files import this" number.

Consumers that hard-checked `schema_version === "0.4.0"` must accept
`"0.5.0"`. Consumers reading `blast_radius_importers` must rename the
key — and should look hard at whether they wanted
`blast_radius_direct_importers` instead, because the old name promised
the direct count and delivered the closure.

The two diverge by more than a rounding error. The walk does not break
cycles, so a file on an import cycle counts itself, and every member of
a strongly-connected component reports the same number. On the `hono`
corpus `src/utils/mime.ts` has 5 direct importers and a closure of 240;
six files in the core component all report exactly 197 while their
direct fan-in ranges from 2 to 70.

`scores.blast_radius` itself is unchanged — it is still
`min(transitive_closure / 50, 1)`. Only the reporting is corrected; the
score's calibration is a separate decision. No fingerprint changes, so
no `.crimes/baseline.json` or `.crimes/suppressions.json` entry is
invalidated by this bump.

## Migrating from `0.3.0` to `0.4.0`

`crimes@0.17.0` bumps the schema:

- **New optional field on `Finding`:** `discriminator?: string`. A
  tiebreaker for detectors that legitimately emit more than one finding
  for the same `(type, file, symbol)` triple. Absent on findings from
  every other detector.
- **`fingerprint` changes shape when `discriminator` is set.** The
  fingerprint becomes `<type>::<file>::<symbol-or-empty>::<discriminator>`.
  Findings without a discriminator keep the three-part form they have
  always had.

Consumers that hard-checked `schema_version === "0.3.0"` must accept
`"0.4.0"`. Consumers that parse fingerprints by splitting on `::` and
assuming exactly three segments must accept four.

**This invalidates pinned entries for three detector types.** Any
`.crimes/baseline.json` or `.crimes/suppressions.json` entry whose
fingerprint names `magic_domain_literal_scatter`,
`exact_duplicate_block`, or `near_duplicate_block` stops matching: the
old fingerprint reads as fixed, the new one reads as new. Re-run
`crimes baseline save`, and re-record the affected suppressions with
`crimes ignore`.

That churn is the point rather than a side effect. Before `0.4.0` those
detectors could emit several findings sharing one fingerprint, so
`crimes ignore <fingerprint>` on one of them silently suppressed the
others — a user got findings hidden that they never saw. Re-recording
each entry is what makes the suppression mean the one finding its author
actually looked at.

Loaders accept the whole window (`0.1.0` through `0.4.0`), so an
un-migrated file still reads; it just matches fewer findings for those
three types.

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
