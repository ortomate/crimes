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
| B — `sync_io_in_hotpath` by reachability | airflow **227/811 (28%)**, mlflow 88/402 (22%), pydantic 7/19 (37%) |
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

### 1.1 (A) Honour a repo's own tooling excludes

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

### 1.3 (C) Unify the two `commented_out_code` variants

The `language-js` one always appends a block hash; the universal one
appends it only when a file holds more than one block (`0.22.0`, so
single-block files keep their fingerprints). Unifying either way churns
fingerprints for one of the two populations — say which and why.

Note these are the two entries that already showed up side by side in
the `0.23.0` intrinsic audit (`commented_out_code` appears twice in the
registry with different expressed bases, 0.48 JS vs 0.35 universal), so
this is **two** kinds of divergence in one detector pair.

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
- **2.3 Cross-pack intrinsic disagreement.** `sync_io_in_hotpath` is
  0.55 in JS and 0.50 / 0.70 in Python; `commented_out_code` 0.48 vs
  0.35. **Audit every charge implemented in both packs** — those two
  were found incidentally, so the set is probably larger.
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
