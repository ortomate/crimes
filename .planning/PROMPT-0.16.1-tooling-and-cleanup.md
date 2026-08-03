# PROMPT — 0.16.1 tooling, linting, and repo cleanliness

Paste this whole file as the opening prompt of a fresh session.

---

You are working in the `crimes` repository. `0.16.0` (the correctness
and authority slate — ten new detectors) has just landed and `pnpm
verify` is green. This session is the follow-up work: wiring up
formatting and linting, closing the loose ends 0.16.0 left, and getting
the repo genuinely clean.

Read `CLAUDE.md`, `AGENTS.md`, and `docs/releasing.md` before editing.
The product boundaries in `CLAUDE.md` still apply — nothing here should
change what the scanner reports except where a task explicitly says so.

## Current state (verified, don't re-derive)

- **No formatter or linter exists.** Nothing at the repo root, nothing
  in any `package.json`. `AGENTS.md` says "nothing wired up yet";
  `CLAUDE.md` locks the decision as **"Biome (or ESLint/Prettier — pick
  one, don't run both)"**.
- `pnpm verify` = build + typecheck + test. No lint step.
- `.github/workflows/ci.yml` runs install → build → typecheck → test →
  scan the fixture → website build → smoke. No lint step.
- `packages/cli/package.json` is at **`0.16.0`**. `evals/results/` tops
  out at `0.15.0-r2` — **the 0.16.0 eval baseline has not been run.**
- Three pending changesets in `.changeset/`:
  `release-a-front-door.md`, `release-b-triage.md`,
  `release-correctness-authority.md`.
- `evals/results/` is **55 MB across 32 version directories**.
- Self-scan today: **410 findings, 30 high**. Top types:
  `large_function` 107, `large_file` 68, `swallowed_error` 58,
  `high_fan_in_fan_out` 46, `boolean_naming_drift` 30,
  `sync_io_in_hotpath` 25.

## Task 1 — adopt Biome

Add Biome as the single formatter + linter. `CLAUDE.md` already picked
it; do not introduce ESLint or Prettier alongside it.

**Configure it to match the existing style, not Biome's defaults.**
Per `AGENTS.md`: 2-space indent, double quotes, semicolons, trailing
commas on multi-line literals, `.js` extensions on ESM imports even
from `.ts`. The goal is a formatting pass that is close to a no-op on
well-maintained files, not a rewrite of the codebase.

Sequence this so it does not bury history:

1. **Commit the Biome config and scripts alone**, with formatting not
   yet applied. Confirm `pnpm format:check` fails loudly at this point.
2. **Commit the mechanical reformat as its own commit**, touching
   nothing else, with a message that says it is mechanical so
   `git blame` readers can skip it. Verify the reformat changed no
   behaviour: `pnpm verify` green, and a self-scan before/after
   produces an **identical finding set** (compare `--format json --all`
   with `id` stripped).
3. **Commit lint fixes separately**, in reviewable batches by rule.

Wire `format`, `format:check`, `lint`, and `lint:fix` scripts at the
root and add `lint` + `format:check` to `pnpm verify` and to
`.github/workflows/ci.yml`.

**Do not weaken a rule to get green.** If a Biome rule genuinely
conflicts with this codebase's deliberate patterns, disable it in the
config *with a comment explaining why* — the empty-catch and
`no-explicit-any` families are the likely candidates, since several
detectors and index builders swallow errors on purpose. A blanket
`// biome-ignore` sprayed through the source is not acceptable.

Update `AGENTS.md` ("Format/lint: nothing wired up yet" is now false),
`CONTRIBUTING.md`, and `docs/releasing.md` if it lists pre-flight
commands.

## Task 2 — triage the self-scan

`crimes` scans itself; 410 findings with 30 high is not a good look for
a tool whose product is finding this. Do **not** mass-fix. Instead:

1. Run `crimes scan . --format json --all` and triage by type.
2. For each of the top types, decide one of three things and record it:
   **fix**, **suppress with a reason** (`crimes ignore`), or **triage**
   (`.crimes/triage.json`) with a disposition and owner.
3. Actually fix the ones worth fixing. `large_file` on `README.md` /
   `docs/roadmap.md` is a threshold question, not a defect —
   `thresholds.largeFile` or `scopeTiers.nonDomain` in
   `crimes.config.json` is the right lever there.
4. Leave the repo with a **committed** `.crimes/suppressions.json` and
   `.crimes/triage.json` that a reviewer can read and disagree with.

The point is that every remaining finding is one somebody consciously
accepted. Report the before/after counts.

## Task 3 — 0.16.0 detector calibration follow-ups

Two known items, both from the 0.16.0 completion report:

**`swallowed_error` fires 58 times on this repo**, mostly on
deliberate best-effort helpers (`safelyBuildIaIndex`,
`safelyBuildImportGraph`, and friends in `packages/core/src/indexes.ts`
and `context-indexes.ts`). They are genuine instances and correctly
ranked `low`, but the volume reads as noise. Decide between: widening
`BEST_EFFORT_FUNCTION_RE` in
`packages/core/src/detectors/swallowed-error.ts`, using the
`allowedFunctions` option in `crimes.config.json`, or accepting them
via triage. Whichever you pick, justify it — and if you change the
detector, that is a **product change that moves findings**, so it needs
a patch bump and an eval re-run per `evals/README.md` § Versioning
policy.

**`magic_domain_literal_scatter` self-collides on fingerprints** (two
findings share `type::file::symbol`). This is the documented limitation
in `packages/core/src/fingerprint.ts`, and it predates 0.16.0 — the
0.16.0 detectors each carry a stable disambiguating `symbol` precisely
to avoid it. Decide whether to give this detector the same treatment.
**Changing its `symbol` changes its fingerprint**, which invalidates
existing baselines and suppressions for that type in the wild, so weigh
that explicitly rather than just doing it.

## Task 4 — changeset and release hygiene

Check whether `release-a-front-door.md` and `release-b-triage.md` are
**stale** — `0.15.0` has shipped, so if those releases already went out,
those changesets should have been consumed and are now leftovers that
would corrupt the next version bump. Verify against the git history and
`docs/releases/`, then either delete them or explain why they're still
pending.

## Task 5 — repo weight

`evals/results/` is 55 MB across 32 version directories, several of
which are `-r2` / `-r3` re-runs of the same version. Propose (don't
unilaterally execute) a retention policy: which baselines are load-
bearing for `evals:diff` / `evals:replay`, which are historical, and
whether the historical ones belong in git at all. Bring me the
recommendation before deleting anything.

## Task 6 — the eval baseline (ASK FIRST)

`packages/cli/package.json` is at `0.16.0` but `evals/results/0.16.0/`
does not exist, so the 0.16.0 baseline is unrecorded. Running
`pnpm run evals` spawns real `claude` and `codex` sessions against every
fixture — minutes of wall clock and meaningful spend against my
subscription.

**Do not run it without asking me.** When you get to this point, tell
me what it will cost in rough terms and let me decide. If I say yes,
commit `evals/results/0.16.0/` and note in the commit message that the
delta is a **product delta** (new detectors fire), not a measurement
correction.

If Task 3 changes what a detector reports, that needs its own patch
bump and its own eval run — flag that too rather than folding it in
silently.

## Constraints

- `pnpm verify` must be green at every commit, and `pnpm --filter
  crimes smoke` green before you declare done.
- Do not change `schema_version`, existing detector ids, charges, or
  finding meanings.
- Do not weaken any existing check to obtain a green build.
- Commit in logical units as you go (per `CLAUDE.md`), keeping the
  mechanical reformat isolated from behavioural changes.
- Do not publish, tag, or push tags.

## Verification before you finish

1. `pnpm format:check` and `pnpm lint` clean.
2. `pnpm verify` green.
3. `pnpm --filter crimes smoke` green.
4. Self-scan finding set **identical** before and after the mechanical
   reformat (prove it, don't assert it).
5. Self-scan finding count after triage, with every remaining finding
   either fixed, suppressed with a reason, or triaged with an owner.
6. Working-tree diff reviewed for accidental changes, generated junk,
   and secrets.

## Report back

- What Biome flagged, what you fixed, and every rule you disabled with
  the reason.
- Before/after self-scan counts by type and severity.
- The calibration decisions from Task 3 and why.
- Whether the two old changesets were stale.
- Your `evals/results/` retention recommendation.
- Anything you deliberately did not do, and why.
