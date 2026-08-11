# crimes evals

Reproducible agent-vs-fixture eval harness for calibrating crimes
detector quality across releases. Lives outside `packages/` because it
is a contributor surface, not part of the published `crimes` binary.

## What this harness does

The harness runs every (fixture × scenario × agent) combination,
captures each agent's response, and scores it two ways:

1. **Structural rubric** — deterministic, fast, runs every CI replay.
   Checks the agent's response against `expected_artifacts` on the
   scenario (referenced findings, referenced files, forbidden actions,
   priority finding-type).

2. **Judge-model pass** (opt-in, `--judge`) — sends the transcript to
   the same `claude` CLI in a different role with the scenario's
   `judge_questions`. Captures structured per-question scores.

Per-version results land in `results/<crimes-version>/<agent>/`,
committed to the repo. Subsequent releases compare against the pinned
results to catch detector-tuning regressions.

## Versioning policy (eval baseline bumps)

The runner keys results by the `version` field of
`packages/cli/package.json`. That version doubles as the **eval
baseline version**. Between releases we're in continuous improvement:
any change that would move the eval baseline gets a patch bump,
without cutting a release.

Two kinds of change trigger a baseline bump:

**Calibration changes** (measurement apparatus):

- `evals/runner/src/score.ts` — structural scoring logic.
- `evals/runner/src/judge.ts` and any judge prompts.
- A scenario's `expected_artifacts` rubric in `evals/scenarios/*.json`.
- A fixture whose finding set changes (`evals/fixtures/*`).

**Product changes that affect findings** (what crimes produces):

- New detectors, detector bug fixes that change what fires.
- Scoring formula tweaks (`packages/core/src/scoring/*`).
- Anything in `packages/core/` / `packages/language-js/` that changes
  the contents of `findings[]` for the same input code.

Changes that do **not** trigger a bump:

- CLI output formatting (human renderer changes that don't alter
  `--format json` content).
- Docs, comments, tests, internal refactors.

The procedure:

1. Land the change.
2. Bump `packages/cli/package.json` `version` to the next patch in the
   **same commit** as the change.
3. Re-run `pnpm run evals` so the new baseline lands in
   `results/<new-version>/`. Commit the directory alongside.
4. Do **not** add a Changeset entry, do **not** publish, do **not** cut
   a git tag — patch bumps in continuous-improvement mode exist purely
   to redirect the results directory and preserve historical baselines.

When we're ready to ship, cut a real semver release (minor for new
features, major for breaking changes). The accumulated patch bumps
roll into that release version.

A baseline delta can be a **measurement correction** (a scorer or
fixture fix moved numbers without changing the product) or a **product
delta** (a detector started or stopped firing). Distinguish the two in
the commit message — future readers shouldn't confuse a scorer fix
with an agent improvement, or a detector bug fix with a regression.

### What `structural_pass_rate` does and does not measure

`referenced_findings` and `expected_priority` look for the **literal
detector id** in the agent's response text. An answer that describes the
same defect in prose scores zero on both.

The clearest case on record came from the (later invalidated —
see below) `0.18.0` run. 19 of codex's 48 scenarios moved; **all 12
drops carried a substantive response** — none empty, truncated, or
errored. The example below is from `messy-ts-app`, a TypeScript fixture
untouched by the change that invalidated that run, so the comparison
holds:

```
0.17.1  "The most likely cause is `direct_date` in `src/billing.ts`…"   1.00
0.18.0  "…temporal inconsistency in `generateInvoice`: `src/billing.ts`
         reads the wall clock seven times…"                             0.00
```

Same root cause, same file, same five `Date.now()` calls.
`review-05-permission-and-parallel` fails all eight of its checks while
opening `**Permission IA drift — block merge.**` — the checker wants
`permission_ia_drift`.

**That last example was two separate faults, and `0.25.1` fixed one of
them.** Since `0.18.x` the scorer accepts the charge name
(`Permission IA Drift`) as equivalent to the slug — but it matched case
exactly, so an agent writing the same three words as a sentence-case
prose bullet still scored zero. See
[§ Measured noise band](#measured-noise-band-two-repeat-pairs-4851)
for what that cost. The surviving fault is the real one: an answer
naming neither the slug, the charge, nor any evidence scores zero.

Two consequences when reading any delta:

1. **A move can be pure phrasing.** Codex's `0.17.1 → 0.18.0` −5pp was
   read at the time as exceeding its band and was still not a product
   regression. (The band it was compared against, ±3pp, has since been
   re-derived — it was too narrow. See below.) Look at the responses
   before concluding anything; `structural_score.details` names the
   exact check and what it observed.
2. **The check is insensitive in the other direction too.** A change
   that makes findings *more accurate* need not move this number at all,
   because it does not change whether the agent quotes an id. Do not
   read a flat result as "the fix did nothing".

**Partly fixed in `0.18.2`.** The scorer now also credits a finding
whose *evidence* the response quotes — each evidence line, and each
literal an evidence line cites. `CLAUDE.md` says evidence before
judgement, and an agent that quotes a finding's receipts has referenced
it at least as unambiguously as one that pastes its slug.

Measured by replaying 0.18.1's stored responses, so the responses are
identical and the delta is entirely the scorer: **4 of 96 scenarios
moved, all of them codex, all from a hard 0 to a full pass**. Codex
0.544 → 0.589 (+4.4pp); claude unchanged at 0.854, which is the
evidence that nothing was over-credited.

```
bugfix-01-timezone-parse   named the literal `"2026-12-20"`
bugfix-04-weak-tests       quoted `0 expect/assert calls` verbatim
context-01-locale-drift    "Finding evidence, verbatim:" then quoted it
review-01-dst-arithmetic   quoted the fix_shape line verbatim
```

A key earns a place in the index only if it identifies **exactly one**
detector type in that scan. This is the `has()` rule from `2e9b2da`
applied to measurement: a token that identifies more than one thing
identifies nothing, and an ambiguous string is dropped rather than
attributed to whichever type claimed it first. Bare line references
(`lines 537-548`), strings under 12 characters, and pure prose
(`arrow declaration` — a real `large_function` evidence line, and also
a phrase an agent can write about unrelated code) are all dropped for
the same reason. A scorer that flatters is worse than one that misses.

Still unfixed: an answer that describes the defect in its own words,
naming neither the id, the charge, nor any evidence, scores zero. That
is what the judge pass is for.

**For ranking specifically, don't try to fix it here at all** — see the
next section. No amount of loosening the text match makes an agent's
response report where a finding ranked.

### `ranking_quality` — the metric that can see a re-ranking

```bash
pnpm run evals:ranking                                    # current build
pnpm run evals:ranking -- --compare evals/results/0.17.1/ranking.json
pnpm run evals:ranking -- --cli /path/to/old/dist/index.js --label 0.17.1
```

`structural_pass_rate` is blind to ranking by construction, and the
0.18.1 release proved it: two rebuilds of the ranking moved it by noise
in both directions. This metric measures the **scan alone** — no agent
is invoked. Given a scenario's expected findings as relevance labels
(`expected_priority` graded 2, `referenced_findings` graded 1), it
computes nDCG over the order the scan itself emitted.

That makes it deterministic — **there is no noise band, so any delta is
real** — and directly comparable between two builds, which is the whole
point. `--cli` scans this tree's fixtures with another build's binary,
so the fixture is held constant and the delta belongs to the scanner.

Read it with three caveats, all of them load-bearing:

1. **The absolute number means very little.** Many scenarios ask a
   file-scoped question ("use `crimes context src/date.ts`"), so their
   expected finding has no business leading a whole-repo scan. The
   labels are identical across builds, so the *delta* is meaningful
   even where the level is not.
2. **Only fixtures `01` (42 findings), `02` (99), `03` (55) and `04`
   (92) have the depth to demonstrate anything.** On a 3-finding fixture
   every ordering scores near 1.0 and a single swap moves nDCG by 0.4.
   The report prints `mean_ndcg_deep` (>=40 findings) as the headline
   and marks shallow rows with `·`; ignore the shallow ones.
3. **The mean hides the story.** Read the per-scenario table. On the
   0.17.1 → 0.18.1 comparison the aggregate moved +0.006 while 20 of 26
   deep scenarios moved *up* — the mean was netting out two opposite
   effects that are the actual result (see below).
4. **Deep membership is an input to the metric, and it has a cliff.**
   See below. `--compare` now refuses to present a before/after across a
   population change; believe it.

#### The depth cliff — read this before quoting `mean_ndcg_deep`

`mean_ndcg_deep` averages whichever scenarios sit on a fixture emitting
at least `DEPTH_FLOOR` (40) findings. **Which scenarios those are is an
input to the number, and until `0.25.0` nothing reported when it
changed.** Measured at `0.24.0`:

| fixture | findings | spare | deep scenarios | share of the aggregate |
|---|---|---|---|---|
| `01` messy-ts-app | 42 | **2** | **21** | **75%** |
| `04` monorepo | 92 | 52 | 4 | 14% |
| `02` react-dashboard | 99 | 59 | 2 | 7% |
| `03` node-cli-tool | 55 | 15 | 1 | 4% |

Remove three findings from fixture `01` and 21 of the 28 deep scenarios
leave the aggregate simultaneously. The headline goes **0.3530 →
0.4863, +0.1333, with no scoring change at all** — roughly **15× the
largest real movement ever recorded** (`0.24.0`'s +0.0089 on the
differentiated bucket, whose headline moved −0.0008).

The stored record is clean: fixture `01` has emitted exactly 42 findings
across all nine baselines on disk, so no published number is
contaminated. **That is stability by luck, not by construction** —
nothing had removed a finding from `messy-ts-app` in nine releases. A
release whose changes are suppression-shaped is exactly the one that
walks off it, and it would read the fall as its own success.

**The fix was free, and it was the floor.** The fixture depths are
`[1, 3, 4, 5, 9, 13, 42, 55, 92, 99]` — a **28-finding empty gap**, with
the floor perched at 40: two findings under the nearest deep fixture and
27 over the nearest shallow one. *Every* floor in `[14, 42]` selects the
same four fixtures, so the constant could be re-centred with the
population untouched. `DEPTH_FLOOR` is **28** from `0.25.0`, balancing
the two sides at 14 findings of slack each:

```
mean_ndcg_deep  0.3530 -> 0.3530   (byte-identical)
scored_deep     28     -> 28       (same scenarios)
fixture 01 headroom  2  -> 14
```

All nine stored baselines stay directly comparable, because nothing
about which scenarios are averaged changed. No fixture's findings moved
and the metric value is unchanged, so **no bump was owed** — the rule
that reverted `0.22.1`.

Two standing diagnostics keep it honest, neither of which touches the
arithmetic:

- Every run prints the deep-set composition, plus where the floor sits
  relative to the whole distribution. A `⚠ CLIFF` marks a fixture with
  little headroom carrying a large share; `⚠ badly placed` marks a floor
  that has drifted back toward the fixtures, and suggests the gap centre.
- `--compare` reports `delta_on_stable_set` — movement restricted to
  scenarios deep in *both* runs — and says outright when the headline
  delta is not a before/after. **When the deep set moves, quote
  `delta_on_stable_set` and nothing else.**

Re-centring bought headroom; it did not fix the concentration. Fixture
`01` still carries 75% of the aggregate, which is what the P3.2 work —
**more deep scenarios off fixture `01`** — is for.

#### What it says about `ce0ccab`

Re-scoring 0.18.1's fixtures against 0.17.1's build — same fixtures,
same scenarios, byte-identical between the two commits, so the delta is
the scanner — **36 of 45 scenarios moved**, by up to ±0.47. Splitting
the deep scenarios by whether their expected answer is a length
detector:

| deep scenarios | n | mean nDCG 0.17.1 → 0.18.1 | up | down |
|---|---|---|---|---|
| expect `large_function` / `large_file` | 6 | 0.459 → 0.406 (**−0.053**) | 0 | 5 |
| expect anything else | 22 | 0.325 → 0.347 (**+0.022**) | 19 | 2 |

That is exactly what `ce0ccab` set out to do — demote length findings,
promote differentiated ones — and it is the first evidence that the
change improved *ranking* rather than only changing which detector
dominates. The two "down" rows in the second bucket moved by −0.004 and
−0.003, i.e. flat.

It also says something uncomfortable about the scenarios: the six that
got worse are the ones whose labelled right answer is a length finding,
and the product has now deliberately decided length findings should not
lead. **Those labels encode the old ranking.** Re-labelling them would
improve the metric without improving the product, so it has not been
done — but nobody should read those six rows as a regression without
saying which of the two they think is wrong.

### Run evals from a checkout nothing else will touch

**A baseline is only valid if every scenario ran against the same
build.** The runner scans fixtures with the built CLI, so a `pnpm build`
part-way through silently splits the run across two products.

This invalidated `0.18.0`. The run took 45 minutes; another session
landed two `weak_test_signal` fixes and rebuilt `packages/core/dist`
17 minutes before the end. **34 of 48 codex scenarios completed against
the old build and 14 against the new one** — a number nothing was
measured at. The directory was removed rather than kept with a caveat: a
wrong baseline is worse than a missing one, because the next run
compares against it.

Before starting a run:

- Check `git status` and the recent log. If anyone else is working in
  this tree, don't start.
- Prefer a dedicated checkout or worktree, built once, so a rebuild
  elsewhere cannot reach it.
- Afterwards, confirm no commit landed inside the run window
  (`git log --since` against the run's start) and that `dist` mtimes
  predate it.

### When *not* to bump at all

The trigger above is "a change that would move the eval baseline". A
change to `coverage.warnings[]` is wire output but it is not
`findings[]`, and if no fixture emits the warning, the baseline cannot
move — so there is nothing to redirect and no bump is owed.

`0.22.1` was started and reverted for exactly this reason: a corrected
`files_partial_parse` sentence is only emitted for a file with syntax
errors, no fixture has one, and all 14 fixtures scan byte-identically.
Bumping would have moved the results directory to a version with
nothing new in it — and, because `verify-build` asserts the landing
page matches `packages/cli/package.json`, it would also have made the
website advertise a version that is not on npm. **Check the fixtures
before reaching for the bump; "the wire format can change" is not the
same claim as "the baseline moves".**

### Identity-only bumps: carry the baseline forward

Step 3 is skipped for a bump whose entire effect is on **finding
identity** rather than finding content — a new or changed
`discriminator`, which alters `fingerprint` but not what the scan says.
The finding set is unchanged: nothing added, removed, rescored, or
reworded. No scenario reads a fingerprint, so a re-run cannot do
anything but resample the noise band.

Such a bump still happens, because the results directory has to move
when the wire output moves. Record it here instead of running:

| version | why no run | carried from |
|---|---|---|
| `0.17.2` | fingerprint discriminators for nine detectors; n8n's finding count identical at 16,325 before and after | `0.17.1` |
| `0.17.3` | recency quantised to whole UTC days + a total sort tiebreaker. **Not** structurally identity-only — `scores.recency` can move on a repo with files 7–14 days old. Measured on both fixtures instead: zero recency values change, nothing added, removed, rescored or reordered | `0.17.1` |
| `0.25.2` | `circular_dependency` and `deep_import` gained universal intrinsic ladders. Also not identity-only: it moves `agent_risk` by design. Enumerated across all 14 fixtures rather than sampled — they hold two `deep_import` findings and one `circular_dependency`, and both ladders keep their old value at the floor, so **exactly one finding on one shallow fixture moves, 0.10 → 0.11**. `evals:ranking` reports no scenario moved and its report is byte-identical to `0.25.1`'s. A 0.01 move on one finding is four orders below what a re-run resolves — see the band above | `0.25.1` |
| `0.25.3` | `sync_io_in_hotpath.py` exempts guarded modules only tests reference. This one *removes* findings — 63 across the corpus — so it was checked on the fixtures rather than assumed: **no Python fixture contains a `__main__` guard at all**, so no fixture finding is eligible and all 14 scan identically. `evals:ranking` byte-identical to `0.25.1` | `0.25.1` |
| `0.25.4` | two scenarios added (`review-01-contract-drift`, `context-01-phantom-dependency`). **A different case from the rows above: the scan is untouched, but the carried baseline does not cover the new scenarios** — `--resume` will report them missing until the next real run, which is where they get their first agent responses. `evals:ranking` covers them immediately and needs no agents. Deep set 30 → 32, so the headline `mean_ndcg_deep` 0.3498 → 0.3449 is **membership, not movement**: `delta_on_stable_set` is +0.0000 | `0.25.1` (structural only) |

The `0.17.3` row is a different kind of justification from `0.17.2` and
should not be copied without doing the same work. `0.17.2` could not
move a score by construction. `0.17.3` could, and was **checked** — by
scanning each fixture with the before and after builds and diffing the
reports finding-by-finding. If you skip a run on that basis, run the
diff and say so.

**This applies to identity only.** If a change touches which findings
appear, their scores, or their prose, run the evals — and if you expect
the aggregate to move, take repeat samples before claiming it.

### Scorer-only bumps: replay, don't re-run

A bump whose entire effect is on the **scorer** takes its baseline from
`evals:replay` rather than from fresh agent invocations, and this is
the stronger instrument, not the cheaper one. The responses are held
byte-identical, so the whole delta is the scorer — a fresh run would
resample the noise band and mix agent jitter into a change that has
none.

| version | change | baseline from |
|---|---|---|
| `0.18.2` | scorer credits a finding whose evidence the response quotes | replay of `0.18.1`'s 96 responses |
| `0.25.1` | scorer matches charge names case-insensitively | replay of `0.25.0`'s 102 responses |

The procedure, since `evals:replay` writes to `evals/replay/` and not
to a version directory:

```bash
# 1. bump packages/cli/package.json, then rebuild — replay records the
#    version it ran under, and re-scans fixtures with the built CLI.
pnpm run build
# 2. re-score every stored response against the new scorer
pnpm run evals:replay
# 3. seed the new version directory from the replay
mkdir -p evals/results/<new>/ && cp -R evals/replay/* evals/results/<new>/
# 4. regenerate the summary from disk — runs 0 agents, and says so
pnpm run evals -- --resume
```

Step 4 is safe by construction: `--resume` skips every combination
whose result file exists, so a complete directory invokes nothing and
only rebuilds `summary.json`. Confirm it printed
`96 result(s) already on disk, running 0`. If it reports a number other
than 0, the copy was incomplete — **stop**, because a partially
re-scored directory mixes two scorers the way `0.18.0` mixed two
builds.

This applies to the *scorer* only. A change to a detector, a score, or
finding prose changes what the agent was shown, so its responses are no
longer replayable evidence and it needs a real run.

## Why it's not in CI as a fresh-agent runner

The harness invokes the locally-installed `claude` and `codex` CLIs in
non-interactive mode. Both authenticate against the user's existing
subscription — no API keys, no per-call billing, no monthly caps. That
also means CI doesn't run fresh agents: the
`.github/workflows/evals-pr.yml` workflow only *replays* the structural
rubric against already-committed result files on PRs that touch
detector / scoring code. Fresh runs happen on Andrew's machine as
part of release prep (Prompt M of each milestone).

See [`docs/evals.md`](../docs/evals.md) for the contributor-facing
guide once the M2 release ships.

## Directory layout

```
evals/
  fixtures/                  # one directory per fixture
    01-messy-ts-app/         # symlink → ../../examples/messy-ts-app
    02-...                   # OSS clones (gitignored body, committed meta)
    05-stress-*              # hand-crafted, committed
    09-clean-tiny            # control: should produce zero findings
    fixtures.meta.json       # registry: name, kind, source, pinned SHA
  scenarios/                 # one JSON file per scenario kind
    refactor.json
    bugfix.json
    review.json
    context.json
    plan.json
  results/                   # per-version pinned eval outputs
    0.7.0/
      claude/...
      codex/...
      summary.json
  runner/                    # the runner workspace package
    src/index.ts
    src/setup.ts
    src/agents/{claude,codex}.ts
    src/score.ts
    src/judge.ts
```

## If a run dies part-way

Use `--resume`:

```bash
pnpm run evals -- --resume
```

It skips every work item whose result file already exists, so an
interrupted run finishes without re-billing the agent invocations that
already succeeded — and re-runs nothing when the directory is complete.

`summary.json` is built by reading the result directory, not from an
in-memory tally, so:

- A killed run leaves a directory that can be completed, and the summary
  is regenerated from whatever is on disk.
- Finishing a gap with a filter (`--scenario review --resume`) still
  writes a summary describing the **whole matrix**, not just the
  scenarios that re-ran.

If the directory is short of the full matrix, the runner says so and
refuses to let it pass quietly:

```
evals: WARNING — 3 combination(s) missing. This directory is NOT a
complete baseline; finish it with
  pnpm run evals -- --resume
```

Take that seriously. `evals:replay` and `evals:diff` both select the
highest-versioned directory, so an incomplete one silently becomes the
pinned baseline and every later comparison is made against a truncated
sample. **Never commit a version directory that reports missing
combinations.**

> This section used to describe a manual recovery procedure, because
> none of the above existed. The 0.16.0 baseline was produced by a run
> that died at 85/96, and recovering it by hand — re-run the filter,
> then rebuild the summary from disk, then validate that rebuild against
> a known-good directory — is what motivated building it into the
> runner.

## Retention of `results/` — measured, decision: keep everything

`evals/results/` is 56 MB in the working tree across 32 version
directories. That number invites a cleanup. **Don't do one** — it is a
working-tree number, not a repo-weight number, and the difference is the
whole argument.

### The measurement that settles it

```
evals/results/   56 MB   (working tree)
.git/            12 MB   (entire repository history)
size-pack       9.6 MiB
```

These are agent transcripts: highly repetitive JSON that compresses by
roughly an order of magnitude. A fresh clone is ~12 MB, not 56 MB. There
is no download problem to solve.

Deleting old results in a new commit would also reclaim **nothing** from
a clone — the blobs stay in history. Actually reclaiming them needs
`git filter-repo` or BFG plus a force-push, which
[`AGENTS.md`](../AGENTS.md) safety rule 2 forbids on `main` and which
breaks every existing clone and every published release tag's ancestry.
That is a large, irreversible operation to reclaim single-digit
megabytes of packfile.

The growth is also historical, not ongoing. The heavy directories
(`0.9.3`, `0.9.4`, `0.9.5`, `0.10.0` — 38 MB between them) date from
when full `codex` transcripts were recorded. Recent baselines are ~900 KB
each, so the trajectory is about +1 MB per bump against a 12 MB
repository.

**Decision: keep everything, including raw transcripts.** Revisit only
if `.git` — not the working tree — becomes a real problem. If it ever
does, archive to object storage and use `EVALS_RESULTS_DIR` to redirect
the results directory, rather than rewriting history.

### What is load-bearing, if you ever do prune

Exactly **one** directory. Both consumers pick the newest and read
nothing else:

- `evals:replay` — `pickLatestVersion()` in `runner/src/replay.ts`
  sorts version directories descending and takes `[0]`.
- `evals:diff` — `readPinnedSummary()` in `runner/src/diff.ts` sorts
  descending and returns the first directory that has a `summary.json`.

No command reads the other 31; they are historical evidence, not inputs.
The `summary.json` files (128 KB for all 32 combined) carry every number
this README's narrative sections cite, so those are the part that must
never be lost.

### Fix this regardless

The version comparator in both `diff.ts` and `replay.ts` parses with
`Number.parseInt`, so a `-rN` suffix is discarded:
`"0.15.0-r2".split(".")` yields `["0", "15", "0-r2"]` and
`parseInt("0-r2")` is `0`. **`0.15.0` and `0.15.0-r2` therefore compare
equal**, and which one counts as "latest" falls to directory iteration
order. Since re-run samples (`-r2`, `-r3`, `-judge`) are exactly the
directories that supersede their base, this can silently replay the
*first* sample rather than the corrected one.

## Running

```bash
# One-time per machine — clones OSS fixtures at their pinned SHAs.
pnpm run evals:setup

# Run every fixture × scenario × agent (structural only).
pnpm run evals

# Subset of the matrix.
pnpm run evals -- --agent claude
pnpm run evals -- --fixture 01
pnpm run evals -- --scenario refactor

# Add the judge-model pass.
pnpm run evals -- --judge

# Sanity-check that every scenario's expected findings actually fire
# on its fixture. Fails on any scenario↔fixture drift. Same gate the
# evals-pr.yml workflow runs.
pnpm run evals:verify-scenarios

# Ranking quality — scan-only, no agents, no billing, deterministic.
# Run this on any change that touches scoring or sort order.
pnpm run evals:ranking -- --compare evals/results/0.17.1/ranking.json
```

## Measuring run-to-run noise

Agents are stochastic, so a single run cannot tell you whether a
5-point move is a real change or jitter. `evals:variance` answers that
by comparing repeat samples of the *same input*:

```bash
# Canonical sample lands in evals/results/<version>/.
pnpm run evals

# Deliberate repeat samples. Any directory named <version> or
# <version>-* counts, and this form finds them automatically.
pnpm run evals -- --label r2
pnpm run evals:variance

# Free repeat samples: two version directories either side of a release
# that moved no finding on any fixture. Name them explicitly.
pnpm run evals:variance -- --dirs evals/results/0.24.0,evals/results/0.25.0
```

It needs at least two samples and exits 2 with a clear message
otherwise. Run it before concluding that a baseline moved: the 0.12.0
"regression" that prompted this section was a 5-point drop that turned
out to be entirely measurement error, and with one sample per version
there was no way to see that from the numbers alone.

**Both samples must have been scored by the same build**, or the spread
being measured is partly the scorer moving. `evals:variance` prints the
`crimes_version` behind each sample and warns when they differ, but the
warning can only see what the version field says — re-score the older
sample first and the question does not arise:

```bash
pnpm run evals:replay -- --version 0.24.0 --out evals/replay-0.24.0
pnpm run evals:replay -- --version 0.25.0 --out evals/replay-0.25.0
pnpm run evals:variance -- --dirs evals/replay-0.24.0,evals/replay-0.25.0
```

Record the observed noise band in the release notes alongside the
baseline, so the next person comparing two versions knows how big a
move has to be before it means anything.

### Measured noise band: two repeat pairs (48/51)

**Derived at `0.25.1`. This supersedes the `0.12.1` figures below,
which were too narrow — a no-op release exceeded the codex band on the
first attempt.**

| agent | band on `structural_pass_rate` (2σ) |
|---|---|
| claude | **±5pp** |
| codex | **±7pp** |

A single release's aggregate move must exceed that to mean anything at
48 scenarios. Nothing since `0.24.0` has.

#### Where the numbers come from

Two repeat pairs, neither of them paid for as one. A release that moves
no finding on any fixture hands its agents byte-identical input, so the
version directories either side of it are a repeat sample:

| pair | pairs compared | why it is a repeat sample |
|---|---|---|
| `0.24.0` → `0.25.0` | 48 scenarios, 158 assertions | `scan_context` byte-identical on all 96 (verified by hashing each stored context); scenarios and rubrics added-to but never edited; scorer untouched between the bumps |
| `0.21.0` → `0.22.0` | 44 scenarios, 146 assertions | as recorded below — with 8 pairs excluded, see the correction |

Both re-scored under the `0.25.1` scorer before comparing.

```
                        claude                     codex
0.24.0 → 0.25.0    0.8228 → 0.8291  ±4.7pp    0.6203 → 0.5886  ±4.7pp
0.21.0 → 0.22.0    0.7671 → 0.8151  ±5.0pp    0.5822 → 0.5685  ±7.5pp
pooled                              ±4.9pp                     ±6.2pp
```

The band is **derived from per-scenario variance, not read off the
aggregates**, and that distinction is the whole reason the old figures
were wrong. Two aggregate samples estimate a standard deviation with
roughly 60% error. Two samples of 48 *scenarios* estimate 48 standard
deviations, and the aggregate is a weighted mean of them:

```
sd(aggregate) = sqrt( Σ wᵢ² · sdᵢ² ) / Σ wᵢ      wᵢ = assertion count
```

`sdᵢ` is the unbiased sample standard deviation (÷ n−1); at n=2 that is
|Δᵢ|/√2. The version of `variance.ts` that shipped through `0.25.0`
divided by n instead, under-reporting every band by 29% at n=2.

The derivation assumes scenarios are independent. They are not quite —
21 of the 48 sit on `messy-ts-app` and read the same scan — so the true
band is a little wider than the arithmetic says. That is one reason the
published figures round up rather than to nearest.

#### Why the old ±6 / ±3 was wrong, and backwards

The `0.12.1` derivation took three aggregate samples and reported
σ 0.029 for claude against σ 0.012 for codex, i.e. codex the *steadier*
agent. Both repeat pairs say the opposite, and by a clear margin. Three
points cannot tell a 0.012 from a 0.031; the ordering was an artefact of
the sample size, and it was the ordering that made a −5.1pp codex move
look like a product event.

#### What the pairs turned up on the way

Two corrections, both of which were inflating the band with things that
are not agent variance:

1. **The scorer matched charge names case-sensitively.** An agent
   writing "Permission IA drift" rather than "Permission IA Drift" scored
   zero on a finding it had named. Fixed in `0.25.1`. It cost 7
   assertions across the 316 in these two runs, and it accounted for most
   of the single largest swing in them: codex on
   `review-05-permission-and-parallel` fell 4/7 → 0/7 between two
   byte-identical runs, of which three were case alone. Re-scored, that
   scenario goes 0.43 → 0.57 and codex's band on the pair narrows from
   ±6.1pp to ±4.7pp. **The 0.25.0 release notes' headline finding — codex
   −5.1pp on identical input — is −3.2pp under the fixed scorer.**
2. **`0.22.0`'s run recorded an empty `scan_context` for all four
   `monorepo` scenarios**, so the scorer could not resolve charge names
   or `crime_NNNN` ids for 8 of its 96 pairs. Two of those 8 are among
   the largest movers in that pair (`plan-04-hotspots` codex 0.00 → 1.00,
   `bugfix-04-weak-tests` claude 1.00 → 0.00). They are excluded above,
   and `evals:variance` now excludes such pairs itself and says how many
   it dropped. The claim below that `0.22.0` is a clean repeat sample of
   `0.21.0` is correct about the *fixtures* and wrong about 8 of the
   results.

Both are the same failure mode as the `SCORED_FILE_EXTENSIONS` list in
`score.ts`: measurement apparatus that fails silently, and is therefore
read as a fact about the agent.

#### Per-scenario: do not read one at all

33 of 48 scenarios did not move at all between `0.24.0` and `0.25.0`,
and the mean per-scenario σ was 0.077 (claude) / 0.103 (codex). The
movement is concentrated: eight scenarios supply about 60% of claude's
band. The worst, on identical input:

```
bugfix-01-messy-ts-app        codex   0.00 → 1.00
bugfix-13-polyglot-plan-drift codex   0.00 → 0.50
bugfix-11-py-mixed-clocks     codex   0.75 → 0.25
plan-01-messy-ts-app          codex   0.75 → 0.25
bugfix-08-stress-dependency   claude  1.00 → 0.60
refactor-05-action-labels     claude  0.80 → 0.40
```

`evals:variance` prints this list with each scenario's share of its
agent's band variance. A full 0 → 1 swing on identical input is routine.
**Never read a single scenario's delta as a product signal.** If one is
load-bearing for a claim, replay it — `evals:replay` holds the responses
fixed so only the scorer varies.

#### What this instrument can and cannot resolve

At 48 scenarios and 158 assertions, `structural_pass_rate` resolves a
~5pp (claude) or ~6pp (codex) move. It cannot resolve a release. Scaling
is the usual √n, so:

| to resolve, at 2σ | claude | codex |
|---|---|---|
| a 5pp move | 48 scenarios (today) | ~70 |
| a 2pp move | ~283 | ~468 |
| a 1pp move | ~1,131 | ~1,871 |

Six to ten times the current scenario set, to make a 2pp move mean
something. **Treat a full agent run as a smoke test — evidence that
nothing catastrophic happened to the wire output — and not as a
release's evidence.** The metric that can resolve a release is
`evals:ranking`: deterministic, free, no band at all.

### Superseded: the 3-sample band at 0.12.1

Kept because the `per_scenario_kind` warning below still holds, and
because the reasoning error is worth being able to find again. **The
band in this table is wrong; use the one above.**

Three full runs of **identical code and scorer**
(`0.12.1`, `0.12.1-r2`, `0.12.1-r3`):

| level | claude | codex |
|-------|--------|-------|
| `summary.json` per-agent rate | 0.87 / 0.84 / 0.91 → σ 0.029 | 0.65 / 0.62 / 0.64 → σ 0.012 |
| mean of per-scenario means (`evals:variance`) | 0.901, avg per-scenario σ 0.041 | 0.592, avg per-scenario σ 0.083 |
| per-scenario-kind, worst observed range | 0.25 (`plan`) | 0.15 (`bugfix`, `plan`) |
| per-scenario-kind, best | 0.00 (`context`) | 0.00 (`context`) |

Read this as:

- ~~**The per-agent aggregate is the number to trust.** A 2σ band is
  roughly ±0.06 for claude and ±0.03 for codex, so treat aggregate
  moves under ~6pp as noise.~~ Superseded: ±5pp claude, ±7pp codex,
  and the two σ values were also computed with the biased estimator.
- **`per_scenario_kind` is not interpretable at current scenario
  counts.** Each kind holds only 7–8 scenarios, so one flipped
  assertion moves it 8–15pp, and `plan`/claude ranged 0.64–0.88 across
  three identical runs. Do not quote it in release notes as evidence of
  improvement or regression without repeat samples.

  This also constrains how you evaluate a **new language pack**. The
  0.14.0 Python pack added 6 scenarios across 5 kinds — roughly one per
  kind, which is far below what any per-kind number can resolve. The
  decision there was to judge on the aggregate and say so in the
  release notes, rather than inflate the scenario count purely to make
  a grouping legible. If you do want a readable per-language grouping
  in future, it needs enough scenarios of its own to clear the same bar
  the per-kind numbers fail — plan for that up front rather than
  discovering it after the run.
- ~~**Per-scenario noise and aggregate noise point in opposite
  directions.** codex is about twice as noisy as claude on any single
  scenario (avg σ 0.083 vs 0.041), yet its aggregate is the *steadier*
  of the two (σ 0.012 vs 0.029) because those per-scenario errors
  cancel.~~ **Refuted.** Both repeat pairs put codex's aggregate band
  *wider* than claude's, which is what its larger per-scenario spread
  predicts. The σ 0.012 was three points pretending to be a
  distribution. The surviving half of the lesson: per-scenario errors do
  cancel, by √n — that is why the aggregate band is ±5pp when individual
  scenarios swing 0 → 1.

The investigation that produced these numbers began with an apparent
5-point drop between 0.10.5 and 0.12.0, including `bugfix`/claude
−12pp and `plan`/claude −11pp. Both sit inside the band above. There
was no regression — and with one sample per version there was no way
to know that from the summary alone.

### The first accidental repeat sample (0.21.0 → 0.22.0)

`0.22.0` is a repeat sample of `0.21.0` and nobody paid for it. Two
independent checks say the input is identical, not merely similar:

- All **14 fixtures scan byte-identically** between the published
  `crimes@0.21.0` and the `0.22.0` build — the same bytes, not "no
  findings moved".
- `evals:ranking`, deterministic and agent-free, reports **no scenario
  moved** (mean nDCG 0.3582 → 0.3582 deep, 0.4759 → 0.4759 all).

The only difference is three extra files in fixture `12-py-tested`
that an agent can open. Its scan JSON is unchanged.

**Correction, `0.25.1`: that holds for the fixtures and not for 8 of
the 96 results.** The `0.22.0` run recorded an empty `scan_context` for
every `monorepo` (fixture `04`) scenario, so its scorer was working
slug-only on those while `0.21.0`'s had the full charge and `crime_NNNN`
tables. Two of the swings quoted below are in that set. The band
derivation above excludes all 8; the figures in this section do not.

| | 0.21.0 | 0.22.0 | move |
|---|---|---|---|
| claude | 0.77 | **0.81** | +4pp |
| codex | 0.58 | **0.58** | 0pp |

Two things this settles.

**`0.21.0`'s claude 0.82 → 0.77 was noise.** It was recorded as the
largest single-step move in this metric's history and explicitly not
separated from noise. 0.77 → 0.81 on identical input separates it.

**A third of scenarios move when nothing changes**, which the
three-sample band above could only say in aggregate:

| agent | scored | moved | up | down | mean \|Δ\| |
|---|---|---|---|---|---|
| claude | 48 | **16** | 10 | 6 | 0.135 |
| codex | 48 | **13** | 4 | 9 | 0.135 |

Full swings on identical input are routine, not exotic: claude's
`bugfix-04-weak-tests` went 1.00 → 0.00 and
`refactor-01-plural-mismatch` 0.00 → 1.00; codex's `plan-04-hotspots`
went 0.00 → 1.00. **Never read a single scenario's delta as a product
signal.** If a per-scenario move is load-bearing for a claim, replay
it — `evals:replay` holds the responses fixed so only the scorer
varies. (Two of those three are fixture-`04` scenarios, and are the
scan_context defect above rather than the agent. The point stands on
`refactor-01-plural-mismatch`, and on the six scenarios listed in the
band derivation.)

~~Note the direction split matches the 0.12.1 finding: codex moved on
fewer scenarios than claude here, yet its aggregate was the one that
did not move at all.~~ It matched a finding that turned out to be an
artefact of three samples; one pair agreeing with it does not rescue
it. On the clean pair both agents moved on 16 of 48.

## Scenario↔fixture coverage discipline

Every entry in a scenario's `expected_artifacts.referenced_findings`
or `expected_priority` MUST correspond to a detector type that the
fixture's scan output actually contains. Otherwise we measure
"agents being bad at finding things that don't exist" — which is how
the 0.7.1 baseline ended up understating both agents by ~10–20pp
(the bulk of failures were rubric-vs-fixture mismatches, not real
agent misses).

The `evals:verify-scenarios` script enforces this, runs in CI, and
fails the build on drift. When you add or change a scenario:

1. Run `pnpm --filter evals-runner evals:verify-scenarios` locally.
2. If a referenced finding doesn't fire on the fixture: fix the
   fixture to produce it (preferred — preserves the scenario's
   intent), or shrink the scenario's `expected_artifacts` to match
   what the fixture can legitimately stress.

## What the structural rubric does and does not measure

Two rules exist because violating them produced large, believable,
wrong numbers. Both were found while investigating an apparent 5-point
regression in the 0.12.0 baseline that turned out to be measurement
error in both directions.

**Only the agent's own words are scored.** `codex exec --json` streams
JSONL — tool invocations, captured tool output, and agent messages all
interleaved. Scoring raw stdout meant 82–84% of the scored text was
transcript rather than answer: detector slugs got credited because the
agent `cat`ed `SKILL.md`, file paths got credited from `rg` output, and
the `expected_priority` leading-window read the JSONL preamble instead
of the response. `agents/codex-transcript.ts` reduces the stream to
`agent_message` events before scoring. The `claude` runner was never
affected (`--output-format json` yields one envelope), so agent-vs-agent
comparisons before this fix were not like-for-like.

**The scorer only sees extensions it was told about.**
`extractFilePaths` matches a fixed extension list. A `referenced_files`
expectation naming an extension missing from that list fails *silently*
— the check records `observed: null` and counts as a miss, even when
the agent quoted the path verbatim. There is no error, just a lower
number.

This has bitten twice. 0.8.0 added the asset extensions after
image-referencing scenarios scored 0 on files the agent had named
correctly. 0.14.0 added `py` / `pyi`: every Python scenario's file
checks failed automatically, and the one scenario resting entirely on
file references scored a hard 0.00 for both agents. The uncorrected
numbers said codex had collapsed on Python (0.089); re-scoring the same
responses gave 0.261, and claude went 0.497 → 0.967.

**Adding a language pack means adding its extensions to
`SCORED_FILE_EXTENSIONS` in `score.ts`.** It is pre-seeded with several
languages that have no pack yet, so the next one fails loudly on its
detectors rather than quietly on its scoring.

**Paths the prompt supplies are not scored.** Over half the
`referenced_files` expectations name a file the scenario prompt already
gave the agent ("Use `crimes context src/date.ts` … which helper should
you not copy?"). Crediting the agent for restating its own input
measures phrasing, not whether crimes surfaced the right location — and
it actively punished correct answers that named the *function* the
prompt asked for. Those checks are still recorded in `details` with a
`skipped` reason, but excluded from `passed`/`failed`. Only files the
agent had to discover count.

When adding a scenario, prefer `referenced_files` entries the agent must
find. If the prompt names the file, the check will be recorded and
skipped — that is not a failure, but it does mean the scenario is
resting entirely on its other checks.

## What's in the runner

The runner is a private pnpm workspace package (`evals-runner`); it's
not published. It depends on `@crimes/cli` for invoking the binary
under test and shells out to `claude` / `codex` for agent runs.

Per fixture × scenario × agent invocation:

1. `cd evals/fixtures/<NN>-<name>` and `crimes scan -f json
   > /tmp/eval-<run-id>-scan.json`. That output is the agent's context.
2. Send the scenario `prompt` + scan JSON to the agent.
3. Capture transcript + final response.
4. Apply the structural rubric per §5.5 of the calibration plan.
5. (Optional) judge-model pass per §5.6.
6. Write `results/<crimes-version>/<agent>/<scenario-id>.json`.

## Adding a fixture

1. Pick a slot number (`02–10` are reserved for the §5.2 buckets;
   start higher for new categories).
2. Make `evals/fixtures/NN-name/` and add the project files.
   For an OSS clone, write a `.crimes-eval-meta.json` and leave the
   body gitignored (see existing entries for shape).
3. Add scenarios for the fixture to the relevant
   `evals/scenarios/<kind>.json` array.
4. Register the fixture in `evals/fixtures/fixtures.meta.json`.

## Adding a scenario

Edit the matching `evals/scenarios/<kind>.json` (or add a new kind).
Each scenario carries an `id`, the fixture id, the verbatim agent
`prompt`, and an `expected_artifacts` block — the structural rubric
checks against the latter on every run.
