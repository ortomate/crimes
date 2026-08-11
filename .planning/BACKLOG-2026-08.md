# Backlog — after `0.24.0`

Written at the end of R6, because progress has slowed and the reason is
diagnosable rather than mysterious.

## Why progress slowed

`0.23.0` and `0.24.0` both went into the scoring model. Both were real
defects and both are measured — but **the three sized product items
carried since R5 have not moved in three rounds**, and they are the ones
with user-facing numbers attached:

| carried item | measured impact |
|---|---|
| A — honour a repo's own tooling excludes | pydantic `v1/`: 85 findings, **17.5% of the whole report** |
| B — `sync_io_in_hotpath` by reachability | airflow **227/811 (28%)**, mlflow 88/402 (22%), pydantic 7/19 (37%) — **note: % of that detector's findings, not of the report; see below** |

> **⚠ The two rows above are in different units.** Re-derived at R7 and
> both reproduce exactly, but A's percentage is a share of the *whole
> report* and B's is a share of *`sync_io_in_hotpath`'s own findings*.
> In report terms B is airflow **2.29%**, mlflow **1.36%**, pydantic
> **1.44%** — an order of magnitude smaller than the column invites you
> to read. Report totals are airflow 9,924 / mlflow 6,468 / pydantic
> 487. B's `227` is also an **upper bound**: it counts sync_io findings
> in files that merely *contain* a `__main__` guard, whereas the rule
> §9 proposes is far stricter (every same-file call path starting inside
> the guard, in a module nothing imports), and `task_runner.py` is a
> guarded file that arguably should *not* be suppressed.
| C — the two `commented_out_code` variants disagree | small, but it is the drift §24 was written about |

Three things are structurally causing the drag. They are the "underlying
issues", and each has a cheap fix:

**1. Scoring calibration is self-referential.** Every round measures the
measurement. It closed real defects, but it generated new "still
unsettled" entries at least as fast as it closed them — the level `0.3`,
the class table, cross-pack disagreement, 41 literals. None of those has
a user-facing number attached. **Deliberately demoted to P2 below.**

**2. We cannot dogfood.** The self-scan reports 2,220 findings, and
**1,901 of them (86%) are in `evals/`** — committed agent transcripts
and eval fixtures, i.e. scanner input being scanned. `crimes.config.json`
excludes `evals/fixtures/**` but not `evals/results/**`. The flagged
files include the transcripts for the scenarios *named*
`plan-01-hardcoded-local-path` and `review-01-hardcoded-localhost`: a
transcript discussing a hardcoded-path finding is being reported as a
hardcoded-path finding. So every recent round measured on the external
corpus only, and the fastest feedback loop we own has been noise.
**One line of config. P0.**

**3. The eval fixtures under-represent the detectors the product favours.**
`0.23.0` un-suppressed 28 detectors, and **only 3 deep-fixture scenarios
label any of them**. So the instrument cannot see the product's own
chosen direction, and every release in that direction produces the same
shape — aggregate flat or down, split unanimous up — costing a paragraph
of explanation each time. There are now **two** disowned-label
populations (§28's six length-labelled scenarios, plus the 22 that
dropped uniformly in `0.23.0`). **P3, but it is the thing that makes
every future scoring claim expensive.**

---

## P0 — measurement correctness (cheap, unblocks everything else)

### 0.1 The self-scan is 86% artifact — ✅ **DONE**

Fixed. `evals/results/**`, `.planning/prototypes/**` and
`docs/fixtures/**` added to `crimes.config.json`, plus the 12 default
exclusions the config had silently fallen behind on (see 0.2).

| | before | after |
|---|---|---|
| findings | 2,362 | **331** |
| high | 415 | **8** |

**404 of 415 "high" findings were artifact.** Confirmed not
findings-moving: `evals:ranking` is byte-identical and no fixture reads
the root config, so no bump was owed per `evals/README.md` § "When *not*
to bump at all".

The surviving 8 highs are all legible: `duplicated_policy` in
`dependency-provenance-gap.ts` (13 variants of one rule across 12
files — worth a real look), `large_function` on `scan`,
`runDetectorsForFile`, `context` and `weak-test-signal.py run`,
`large_file` on `scoring/build.ts` (686 lines), and two
`hardcoded_local_path` in prose docs quoting real session paths.

**The self-scan ratchets.** It was 2,220 earlier the same day and 2,362
after committing one eval baseline — every release added ~140 findings
purely by storing its own results. That is now capped.

### 0.2 A user `exclude` silently falls behind the defaults

Found by doing 0.1, and it is **a product-level footgun, not a
repo-local mistake**.

`mergeConfig` does `exclude: override.exclude ?? base.exclude` —
wholesale replacement, which is the documented contract (remediation
doc §1.3, and `scopeTiers.nonDomain` says the same). So any user who
sets `exclude` at all inherits **nothing** from `DEFAULT_CONFIG`, and
must re-list it by hand.

This repo's own config had done that — and then fell behind. When the
`.json` / `.yaml` includes landed, `DEFAULT_CONFIG` gained 12 patterns
(`**/pnpm-lock.yaml`, the other 8 lockfiles, `**/tsconfig*.json`,
`**/pnpm-workspace.yaml`). `crimes.config.json` was never updated, so
`pnpm-lock.yaml` was being scanned and reported as a **high** `large_file`
at 5,469 lines — in the repo of the tool whose own `CLAUDE.md` says
"Defaults exclude … lockfiles".

The 12 patterns are now re-listed here, but that is a patch on the
symptom. Options worth weighing:

- **Merge instead of replace**, with an explicit opt-out for users who
  really want to start from nothing. Changes a documented contract.
- **Keep replace, but warn** when a user `exclude` omits patterns the
  default carries — cheap, and it fits the "be trustworthy about what
  you looked at" rule better than silence.
- **`extends` / `excludeAdd`** as a separate additive key.

Whichever is chosen, note that `crimes init` writes a config with an
`exclude` array, so **the documented first-run command puts every user
into this state**. That is the same shape as §1.1 (init wrote a JS-only
config that made crimes see *less* than no config at all) and §30 (the
tool's own remediation hint gutted the scan) — a third instance of
"following our own advice degrades the scan silently".

---

## P1 — product work with measured impact (do these next)

### 1.1 (A) Honour a repo's own tooling excludes — ✅ **DONE (Python half)**

Reproduced exactly (85 findings, 17.5%) and shipped. **pydantic
487 → 402, −85, −17.5%**, with one `coverage.warnings[]` entry naming
`pydantic/v1`, its 26 files, five examples and the opt-out. airflow and
mlflow: **unchanged, no warning** — nothing corroborates.

Three things the entry got wrong or did not say:

- **It names the third exclusion "mypy". It is `[tool.pyright]`** —
  pydantic has no `[tool.mypy]` table at all. Load-bearing, because
  pyright's `exclude` takes globs and mypy's takes regexes; mypy is
  therefore deliberately unsupported for now.
- **"A `coverage.warnings[]` entry per skipped path" contradicts the
  shipped contract.** `CoverageWarning.subject` is documented as never a
  file path because it is the aggregation key. Resolved as *aggregated
  by the pattern that authorised the skip* — 85 files, one warning.
- **Corroboration is the safety property, and the entry does not
  mention it.** A path is skipped only when ≥2 *independent* tools name
  it. Across the whole corpus that is exactly one directory: mlflow's
  ruff-only and drf's codespell-only lists corroborate at 1 and are
  left alone.

Also fixed a defect the wiring introduced and the corpus caught: the 26
skipped files were being reported a *second* time as
`files_not_discovered` ("no include pattern matched them"), which is
false. `collectDiscoveryWarnings` now takes `alreadyExplained`.

`evals:ranking` unmoved, no fixture has a `pyproject.toml`. Remaining:
`.gitattributes linguist-vendored`, `tsconfig` `exclude`,
`.eslintignore` — deliberately not built, per "ship the Python half
first".

<details><summary>original entry</summary>

Full design already written in the remediation doc §13. Summary:
`pydantic/v1` appears in **four** separate exclusions in pydantic's
`pyproject.toml` (ruff `extend-exclude`, coverage `omit`, mypy
`exclude`, codespell `skip`) and is regenerated by `make update-v1`. A
directory a repo excludes from its own linter and type-checker is one it
does not maintain.

**The design problem is the whole job.** This turns a config file into a
silent-suppression mechanism. Requirements, non-negotiable:

- **Named tables only** — never "any `exclude` key". airflow's
  `pyproject.toml` has `exclude = ["*"]` under `[tool.hatch.build]`; a
  naive reader reports airflow as **completely clean**.
- **A `coverage.warnings[]` entry per skipped path.** The tool's value
  is being trustworthy about what it looked at.
- **An opt-out.**

Generalises to `.gitattributes linguist-vendored`, `tsconfig` `exclude`,
`.eslintignore`. Ship the Python half first; do not build all four at
once.

</details>

### 1.2 (B) `sync_io_in_hotpath` by reachability, not by file

Remediation doc §9. **Read the counter-example before writing code:**
`task-sdk/src/airflow/sdk/execution_time/task_runner.py` carries a
`__main__` guard at line 2441 of 2443, is production code, and reports
**0 direct importers** because airflow launches it as a subprocess. It
defeated both candidate signals tried in `0.22.0`.

The signal that would work: a function every one of whose same-file call
paths starts inside the guard block, in a module nothing imports.
`weak_test_signal.py` already does bounded same-file call following, so
the machinery exists.

**Decide `task_runner.py` explicitly rather than by accident.** Both
readings are defensible — a task-runner process is one-shot, but a
blocking email send inside it is still worth saying. Write the decision
down before the code.

### 1.3 (C) Unify the two `commented_out_code` variants — ✅ **DONE (discriminator half)**

**Unified toward "always identify a block"**, matching the language-js
twin. The `0.22.0` reasoning for the conditional policy — a file with one
block was never ambiguous, so its fingerprint must not move — holds only
for a tree that never changes. **The conditional policy is not merely
different, it is unstable:** `resolveDiscriminators` discards a lone
block's candidate hash, so when an unrelated second block appears
anywhere in the same file both findings gain discriminators and the
first one's fingerprint changes because of a finding that is not it. A
`crimes ignore` entry the user already wrote stops matching.

Which population churns, measured: **43** universal single-block
findings this way, **67** language-js ones the other way. The count
agrees with the argument, but the argument is stability. Corpus:
airflow 20, mlflow 18, pydantic 4, cal.com 1 — **42 fingerprints
retired and 42 introduced, finding counts identical everywhere, only
`commented_out_code` touched, hono byte-identical.** Identity-only, so
the baseline carries forward.

**The intrinsic half is deliberately left**: language-js ramps
0.48 + 0.04/statement to 0.72, the universal twin is a flat 0.35. That
is a scoring change and needs its own baseline. It is now asserted in
`scoring/intrinsic-parity.test.ts` rather than silent — and finding it
there exposed a hole in that gate's first draft, which walked `py/`
only and so could not see one of the two pairs the audit was written
about.

<details><summary>original entry</summary>

The `language-js` one always appends a block hash; the universal one
appends it only when a file holds more than one block (`0.22.0`, so
single-block files keep their fingerprints). Unifying either way churns
fingerprints for one of the two populations — say which and why.

Note these are the two entries that already showed up side by side in
the `0.23.0` intrinsic audit (`commented_out_code` appears twice in the
registry with different expressed bases, 0.48 JS vs 0.35 universal), so
this is **two** kinds of divergence in one detector pair.

</details>

---

## P2 — the scoring model, deliberately demoted

All real, none with a user-facing number. Do not let these crowd out P1
again.

- **2.1 The level `0.3` is unvalidated.** `0.24.0` fixed the *mechanism*
  (clamp → scale); correcting a mechanism does not choose a constant.
  Any attempt needs an instrument that does not already exist.
- **2.2 The class table is hand-maintained**, and **`standard` has zero
  members across all 70 detectors** — it is an unlabelled-default
  bucket, not a considered third category, and its behaviour (no
  adjustment) is the permissive one.
- **2.3 Cross-pack intrinsic disagreement.** ✅ **AUDITED (R7). It is 7
  of 8.** Full table and remediation order in
  [`docs/dogfooding/2026-08-11-cross-pack-intrinsics.md`](../docs/dogfooding/2026-08-11-cross-pack-intrinsics.md).
  The entry guessed "probably larger" and understated it: of the 8
  charges implemented in both `detectors/` and `detectors/py/`, only
  `large_function` agrees.

  It is also **three** kinds of divergence, not one. Beyond ordinary
  constant drift, `circular_dependency` and `deep_import` express *no*
  intrinsic on the universal side, so they take a **flat** declared
  default while Python gets a ramp — an 8-module Python cycle reaches
  0.92, the identical TypeScript cycle is pinned at 0.45, and universal
  `deep_import` sits at 0.30, which is `NEUTRAL_INTRINSIC` itself. And
  `direct_date` / `sync_io_in_hotpath` carry conditions in Python that
  the universal side has no concept of.

  Direction is inconsistent (Python higher on two, lower on two), so no
  single per-pack offset fixes it. **Reported, deliberately not fixed** —
  seven simultaneous scoring changes in one baseline are unattributable.
  The findings-neutral first step is giving the universal pack the
  `intrinsicFor` helper Python already has, plus a gate asserting that a
  twice-implemented charge declares the same `(base, step, cap)`.
- **2.4 41 intrinsics are still literals** inside their own detectors,
  so half the calibration is only visible by reading 41 files. Moving
  their bases into `INTRINSIC_DEFAULTS` would put it in one place.

---

## P3 — the measurement apparatus

- **3.1 Two disowned-label populations.** §28's six length-labelled
  scenarios, plus the 22 that dropped uniformly in `0.23.0`. Anyone
  quoting `mean_ndcg_deep` should know about both. Re-labelling improves
  the metric without improving the product, so the honest fix is
  probably **new scenarios**, not re-labelled ones.
- **3.2 Deep fixtures barely exercise the differentiated detectors.**
  Only 3 deep-fixture scenarios label any of the 28 detectors
  un-suppressed in `0.23.0`. This is why every scoring release produces
  "aggregate down, split up".

  **Reproduced exactly at `0.24.0` (R7): 3 of 28.** The named scenarios
  are `plan-04-hotspots` (`high_fan_in_fan_out`),
  `refactor-02-component-shape` (`duplicate_component_shape`) and
  `review-02-react-dashboard` (`duplicated_role_status_plan_check`).
  Across *all* scenarios, deep or shallow, 17 of the 28 are referenced
  and **11 are referenced by nothing at all**: `agent_permission_sprawl`,
  `config_drift`, `contract_drift`, `dependency_provenance_gap`,
  `duplicated_policy`, `finder_duplicate_filename`, `mock_saturation`,
  `pass_through_abstraction`, `swallowed_error`, `unbounded_async_fanout`,
  `unsafe_retry`.

  **The entry understates its own severity, and the reason is a second
  defect it does not mention.** `mean_ndcg_deep` is a mean over whichever
  scenarios clear `DEPTH_FLOOR = 40`, and **fixture `01` emits 42
  findings while carrying 21 of the 28 deep scenarios (75%)**. Three
  findings removed from `messy-ts-app` drops all 21 out at once and moves
  the headline **0.3530 → 0.4863 (+0.1333)** with no scoring change —
  ~15× the largest true movement ever shipped. The nine stored baselines
  are uncontaminated (fixture `01` has been at exactly 42 throughout),
  but that is luck: nothing had removed a finding from it in nine
  releases, and `0.25.0` is the suppression release.

  **Closed, and the fix was free.** Fixture depths are
  `[1, 3, 4, 5, 9, 13, 42, 55, 92, 99]` — a 28-finding empty gap with the
  floor perched at 40. Every floor in `[14, 42]` selects the same four
  fixtures, so `DEPTH_FLOOR` was re-centred to **28**: `mean_ndcg_deep`
  byte-identical at 0.3530, `scored_deep` still 28, fixture `01`'s
  headroom 2 → 14, all nine baselines still comparable. Plus two standing
  diagnostics in `evals/runner/src/ranking-population.ts` (20 tests) —
  deep-set composition with `⚠ CLIFF` / `⚠ badly placed` markers on every
  run, and `delta_on_stable_set` on `--compare` instead of a false
  before/after. **No arithmetic changed, so no bump was owed**
  (`evals/README.md` § "When *not* to bump at all", the rule that
  reverted `0.22.1`).

  **Second half now started.** Three deep scenarios added, all off
  fixture `01`: `review-04-swallowed-errors` and
  `bugfix-04-unbounded-fanout` cover two differentiated detectors that
  no scenario referenced at all, and `context-14-what-was-not-scanned`
  runs on a **new fixture 14** built so the tooling-exclude feature is
  measurable — no other fixture has a `pyproject.toml`, so `evals:ranking`
  could not see A.

  | | before | after |
  |---|---|---|
  | deep scenarios labelling a differentiated detector | 3 / 28 | **5 / 30** |
  | of the 28 referenced by any scenario | 17 | **19** |
  | fixture `01` share of the deep aggregate | 75% | **70%** |

  Nine remain unreferenced: `agent_permission_sprawl`, `config_drift`,
  `contract_drift`, `dependency_provenance_gap`, `duplicated_policy`,
  `finder_duplicate_filename`, `mock_saturation`,
  `pass_through_abstraction`, `unsafe_retry`. None fires on an existing
  deep fixture, so covering them needs fixture content, not just
  scenarios.

  **The guard earned itself on its first real use.** Adding the
  scenarios moved the headline `0.3530 → 0.3498`, which reads as a
  regression and is not one: `delta_on_stable_set` is **+0.0000** and
  the two entering scenarios are named. Before `0.25.0` this would have
  been reported as a scoring regression caused by an instrument-only
  change.
- **3.3 `evals/README.md` § "Fix this regardless" is stale** — the
  version-comparator bug it describes was fixed in `versions.ts`, which
  handles the `-rN` suffix properly. Delete or mark the section.
- **3.4 §27 `pnpm run build` ordering** — did not reproduce over 8 runs.
  Open as a possibility, not a fact. Leave unless it recurs.

---

## P4 — product roadmap

- **4.1 M6 — Homebrew tap / standalone binaries.** Not started.
- **4.2 PRD §26 deferred items** — `crimes ask`, LLM-assisted modes.
  Still deferred; confirm that is still the intent before anyone starts.

---

## Sequencing constraints that are easy to get wrong

**The eval baseline is a shared resource.** Two findings-moving changes
in one baseline make neither attributable — that is why `0.23.0` and
`0.24.0` were split. But that does *not* mean one change per release:

- `evals:ranking` is **deterministic, agent-free and free**. Measure
  every candidate with it individually, in its own worktree, as often as
  you like.
- The **agent run** (96 combinations, ~43 min, billed against a
  subscription) is the scarce one. Batch a *group* into one bump and one
  run, per `evals/README.md` § Versioning policy — but only group
  changes you do not need to attribute separately.

A and B are both suppression-shaped (they remove findings). Measure each
separately with `evals:ranking` first; only then decide whether they can
share a baseline.

**Never build while an eval run is in flight, and use a dedicated
worktree.** The runner derives its CLI path from `import.meta.url`, so a
worktree genuinely isolates it — verify that rather than assume it, and
check `dist` mtimes predate every result file afterwards.
