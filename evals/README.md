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

## Retention of `results/` — PROPOSED, not yet applied

`evals/results/` is **55 MB across 32 version directories** and grows by
one directory per baseline bump. This section is a proposal. Nothing has
been deleted; bring it to a decision before acting on it.

### What is actually load-bearing

Exactly **one** directory. Both consumers pick the newest and read
nothing else:

- `evals:replay` — `pickLatestVersion()` in `runner/src/replay.ts`
  sorts version directories descending and takes `[0]`.
- `evals:diff` — `readPinnedSummary()` in `runner/src/diff.ts` sorts
  descending and returns the first directory that has a `summary.json`.

No command reads the other 31. They are historical evidence, not
inputs.

### Where the bytes are

| | |
|---|---|
| total | 55 MB |
| in `0.9.3`, `0.9.4`, `0.9.5`, `0.10.0` | 38 MB (69%) |
| all 32 `summary.json` files combined | 128 KB |
| result files | 2084 |

The weight is entirely the `response` field — the raw agent transcript.
One file, `0.9.5/codex/bugfix-04-weak-tests.json`, is 4.1 MB, of which
`response` is 4,283,791 bytes and `structural_score` — the part that is
actually scored — is 232 bytes. The four heavy directories are from the
era when full `codex` transcripts were recorded.

**Stripping `response` from every result file takes 50.9 MB to 5.11 MB,
a 90% reduction, while preserving every scored number.**

### Proposed policy

1. **Keep whole:** the current baseline and the one before it. Two
   directories, ~1.8 MB. That is what `evals:replay` and `evals:diff`
   need, plus one to compare against.
2. **Keep scored-only:** every older directory keeps its `summary.json`
   and each result file's `scenario` / `agent` / `crimes_version` /
   `timestamp` / `structural_score`, with `response` dropped. This
   preserves every number the narrative sections of this README cite —
   the 0.7.1 baseline understating both agents, the 0.12.0 measurement
   regression — which would otherwise become unverifiable claims.
3. **Do not keep in git:** the raw transcripts. They are never read by
   any command, and they are not reproducible anyway — each is the
   record of one non-deterministic agent run.

Estimated result: **55 MB → ~3 MB.**

If the full transcripts must be preserved, do not solve it by deleting
selectively — move them out of the repository. `EVALS_RESULTS_DIR`
already exists to redirect the results directory; archive the
transcripts to object storage and record the URL in each `summary.json`.

### Fix this first, whatever is decided

The version comparator in both `diff.ts` and `replay.ts` parses with
`Number.parseInt`, so a `-rN` suffix is discarded:
`"0.15.0-r2".split(".")` yields `["0", "15", "0-r2"]` and
`parseInt("0-r2")` is `0`. **`0.15.0` and `0.15.0-r2` therefore compare
equal**, and which one counts as "latest" falls to directory iteration
order. Since re-run samples (`-r2`, `-r3`, `-judge`) are exactly the
directories that supersede their base, this can silently replay the
*first* sample rather than the corrected one. "Keep the latest baseline"
is ambiguous until this is fixed.

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
```

## Measuring run-to-run noise

Agents are stochastic, so a single run cannot tell you whether a
5-point move is a real change or jitter. `evals:variance` answers that
by comparing repeat samples of the *same* crimes version:

```bash
# Canonical sample lands in evals/results/<version>/.
pnpm run evals

# Repeat samples. Any directory named <version> or <version>-* counts.
pnpm run evals -- --label r2
pnpm run evals -- --label r3

# Per-scenario mean ± stddev across all samples for the current version.
pnpm run evals:variance
```

It needs at least two samples and exits 2 with a clear message
otherwise. Run it before concluding that a baseline moved: the 0.12.0
"regression" that prompted this section was a 5-point drop that turned
out to be entirely measurement error, and with one sample per version
there was no way to see that from the numbers alone.

Record the observed noise band in the release notes alongside the
baseline, so the next person comparing two versions knows how big a
move has to be before it means anything.

### Measured noise band (3 samples at 0.12.1)

Three full runs of **identical code and scorer**
(`0.12.1`, `0.12.1-r2`, `0.12.1-r3`):

| level | claude | codex |
|-------|--------|-------|
| `summary.json` per-agent rate | 0.87 / 0.84 / 0.91 → σ 0.029 | 0.65 / 0.62 / 0.64 → σ 0.012 |
| mean of per-scenario means (`evals:variance`) | 0.901, avg per-scenario σ 0.041 | 0.592, avg per-scenario σ 0.083 |
| per-scenario-kind, worst observed range | 0.25 (`plan`) | 0.15 (`bugfix`, `plan`) |
| per-scenario-kind, best | 0.00 (`context`) | 0.00 (`context`) |

Read this as:

- **The per-agent aggregate is the number to trust.** A 2σ band is
  roughly ±0.06 for claude and ±0.03 for codex, so treat aggregate
  moves under ~6pp as noise.
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
- **Per-scenario noise and aggregate noise point in opposite
  directions.** codex is about twice as noisy as claude on any single
  scenario (avg σ 0.083 vs 0.041), yet its aggregate is the *steadier*
  of the two (σ 0.012 vs 0.029) because those per-scenario errors
  cancel. Don't infer aggregate stability from per-scenario stability,
  or the reverse.

The investigation that produced these numbers began with an apparent
5-point drop between 0.10.5 and 0.12.0, including `bugfix`/claude
−12pp and `plan`/claude −11pp. Both sit inside the band above. There
was no regression — and with one sample per version there was no way
to know that from the summary alone.

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
