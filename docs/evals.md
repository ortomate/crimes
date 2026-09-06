---
title: crimes evals — the agentic harness
description: How the eval harness scores Claude and Codex against fixture × scenario combinations, how to add fixtures or scenarios, and how the CI replay catches detector-tuning regressions without invoking fresh agent runs.
---

# crimes evals — the agentic harness

There are three different measurements. None substitutes for the others.

| Measurement | What it establishes | What it does not establish |
| --- | --- | --- |
| Detector tests and scenario verification | Known findings and evidence appear on fixture inputs | Real-world precision or safer edits |
| Ranking and structural replay | Known relevant findings surface, and recorded responses mention expected artifacts | Correctness of a completed change |
| Paired edit outcomes (`evals:outcomes`) | Actual changes pass independent acceptance checks, with/without a briefing | General agent benefit from a small sample |

## Completed edit outcomes (0.29)

`pnpm evals:outcomes` verifies twelve purpose-built behavioral tasks without
invoking a model: original source must fail independent acceptance and the
reference solution must pass. The old three-task runner has been replaced;
its 0.28 result remains a historical 3/3 versus 3/3 tie.

The live runner compares three assigned conditions for each task and host:

- **Without:** inspect and edit normally, without invoking crimes.
- **Briefing:** receive pre-edit context, without invoking crimes separately.
- **Installed:** discover the generated project skill normally; Claude also
  gets its supported generated Edit/Write hook. No briefing is forced into
  the prompt and failure to activate is part of the outcome.

All conditions receive identical source, available package and scanner
configuration. Each edit uses a fresh Git repository. Acceptance files and
reference solutions are outside the agent's workspace; acceptance is copied
in only after the host exits. Extra files are flagged for human scope review,
not automatically scored as bad edits: a new regression test or shared policy
module can be a legitimate solution. Baseline and candidate source hashes
establish whether observed scans actually bracketed the edit, including newly
added source files. A successful pre/post scan of only intermediate states
does not count.

```bash
pnpm build
pnpm evals:outcomes
python3 scripts/eval-outcomes.py --run --package /tmp/crimes-candidate.tgz \
  --output-dir /tmp/crimes-outcomes --host both \
  --codex-model <explicit-model-id> --claude-model <explicit-model-id> \
  --repeats 3 --jobs 4
```

Live runs consume the installed hosts' subscription/quota. CLI adapters use
explicit model ids and high reasoning effort, disable user configuration
where supported, and record host versions, requested/observed model ids,
Node/Python versions, fixture/harness/package hashes and provider-reported
usage. An explicit model id does not guarantee that a provider freezes its
underlying weights. Runtime versions describe the controller environment;
agent-selected login shells may select other installed runtimes or test
tools. This is source isolation, not a hermetic operating-system image.
Raw transcripts and patches stay in the requested output
directory outside the repository; commit reviewed summaries only.

Twelve tasks × three conditions × three repetitions × two hosts is **216
runs**. Case order is seeded; each condition occupies every position for each
case/host across three repeats. Concurrency is recorded. Use `--cases` and
`--repeats 1` for a pilot. `--partition development` / `holdout` selects the
six tasks available for tuning or the six reserved tasks. `--resume` refuses
changed inputs and reuses completed trial files instead of silently rerunning
only failures. CI runs oracle and harness-method tests, never fresh host calls.

Keep the primary comparison by **assigned condition**, including missed
activation and failed runs. Report acceptance, host completion, reviewed
unrelated edits, end-to-end task time and usage separately. Task time includes
supplied briefing and agent tool calls, but excludes package installation
and the independent acceptance runner. Repeated runs of the same task are
not independent examples; report paired wins/losses/ties and uncertainty at
the task level. A tie or wide interval does not demonstrate improved edits.

The pilot exposed an ambiguous refund task: its wording preserved analytics
behavior while acceptance expected no event after a failed write. The task
now states that requirement explicitly; the original refund pilot results
are excluded from product conclusions. This is a measurement correction,
not a scanner improvement. A separate review made the concurrency requirement
explicit in the batch task before its first host trial. The pilot also led
to balanced condition positions across repeats and file-set-aware scan
hashes; neither correction changes the product or counts as a benefit.

For runs recorded before the 0.29 command-recognition correction, audit every
row from its raw CLI log before pooling. This recognizes successful report
envelopes when a global option precedes the subcommand, and excludes help or
error output from context counts. It retains the originally recorded metrics
and hashes; it cannot infer calls that bypassed the instrumented binary.

```bash
python3 scripts/audit-outcome-usage.py --input-dir /tmp/development \
  --output /tmp/development-audited.json
python3 scripts/audit-outcome-usage.py --input-dir /tmp/holdout \
  --output /tmp/holdout-audited.json
```

Pool completed development and holdout partitions with:

```bash
python3 scripts/summarize-outcomes.py /tmp/development-audited.json \
  /tmp/holdout-audited.json --output /tmp/outcomes-reviewed.json
```

The summarizer rejects missing/duplicate cells and changed package, fixture,
harness or host settings. It preserves failures, separates provider usage
fields and reports paired acceptance differences. Its task-resampled interval
is descriptive of this fixed suite; constant differences produce `null`
rather than a misleading zero-width uncertainty estimate.

These cases cover more failure modes but remain small synthetic repositories.
Use the [external trial](./external-trial.md) to collect independently reported
editing outcomes; do not present these runs as adoption or general productivity
proof. [Performance measurements](./performance.md) isolate scanner latency
from host/model and task time.

### Recorded 0.29 results

The [complete 216-run record](../evals/results/0.29.0/outcomes.json) uses Codex
CLI 0.153.4 with `gpt-5.6-sol` and Claude Code 2.1.263 with `claude-opus-5`,
both at high effort. All 216 host runs completed and passed the predefined
acceptance checks. Both the development and reserved partitions tied across
conditions: **no measured acceptance improvement**. The suite has a ceiling
effect; these small tasks do not distinguish the conditions on correctness.

| Host | Condition | Acceptance | Median task seconds | Comparable candidate scans |
| --- | --- | ---: | ---: | ---: |
| Claude | Without | 36/36 | 53.6 | — |
| Claude | Briefing | 36/36 | 45.4 | — |
| Claude | Installed | 36/36 | 89.3 | 36/36 |
| Codex | Without | 36/36 | 52.2 | — |
| Codex | Briefing | 36/36 | 51.3 | — |
| Codex | Installed | 36/36 | 116.3 | 34/36 |

All 72 installed runs took an observable skill action. Claude received 63 hook
contexts across its 36 runs. Two Codex runs selected a different executable
for some or all analysis, despite discovering the local package. They remain
in the assigned installed condition. The [workflow review](../evals/results/0.29.0/workflow-review.json)
records both deviations. Reprocessing all raw logs corrected metrics in 13
rows, including six missed comparable scan pairs; no acceptance result changed.
The control/briefing transcripts contain no executed crimes command.

Every one of the 31 file-scope flags was [reviewed](../evals/results/0.29.0/scope-review.json).
Twenty-six were relevant test additions. Five were policy extractions in the
briefing condition on `plan-limit`, compared with none of that task's twelve
control/installed runs. One extraction changed fallback for prototype-key
plan names outside the named-plan acceptance contract. The retained
[reproduction](../evals/results/0.29.0/review/probe.mjs) establishes that edge
change; it is a supplementary observation, not a retroactive primary failure.
The transcript explicitly connected consolidation to the briefing's advice.
This supports narrowing the advice, not changing detector thresholds.

The installed workflow took longer on this suite. Provider usage is retained
per host in the record; token definitions differ and are not pooled. The
briefing timing differences and complete acceptance tie do not establish
general productivity gains. The 48 later checks use separate packages: 18 for literal advice, 12 for
executable selection and 18 for test preservation. All pass acceptance, but
review records both the intermediate loss of persisted test checks and a
remaining final-scan workflow miss. They are reported separately in the
[release notes](./releases/v0.29.0.md).

## Ranking labels

`expected_artifacts.finding_labels` optionally specifies `type`, `file`,
`claim`, `symbol`, `discriminator` and `priority`. When supplied, these
replace detector-type-only ranking labels. A matching detector at the
wrong claim or subject receives no relevance credit. Six initial scenarios
use precise labels, including checkout errors versus unrelated legacy
payout failures. Scenario verification checks every precise label fires.
Legacy scenarios still use type labels; the ranking result remains limited
by those labels. Missing expected findings are reported separately from
ranking quality.

Two old default scenarios were retired in 0.28: boolean naming, now
optional, and a generic synchronous function with no evidenced hot path.
The frontend scenario now targets responsive fragility. These are declared
measurement changes, not passing results. Compare scanner versions using
the same revised labels, fixtures and reference clock.

## Historical response-replay harness

The 0.7.0 release introduces the **eval harness** at `evals/`. It is
the second half of the calibration story: where
[`crimes feedback`](./feedback.md) captures Andrew's verdicts on
real-world scans, the eval harness captures *agent* behaviour on a
pinned matrix of fixtures and scenarios.

It runs locally on a maintainer's machine via the `claude` and
`codex` CLIs — both authenticate against existing subscriptions, so
no separate API keys in the default CLI adapters. These runs use the available subscription or quota. CI never invokes a fresh agent
run; it only replays the structural rubric over already-committed
results.

## Directory layout

```
evals/
  fixtures/                  # one directory per fixture
    01-messy-ts-app/         # symlink → examples/messy-ts-app
    02-react-dashboard/      # OSS clone (gitignored body, committed meta)
    03-node-cli-tool/        # OSS clone
    04-monorepo/             # OSS clone
    05-stress-ia-drift/      # hand-crafted, committed
    06-stress-duplication/   # hand-crafted, committed
    07-stress-frontend/      # hand-crafted, committed
    08-stress-dependency/    # hand-crafted, committed
    09-clean-tiny/           # control: should produce zero findings
    10-clean-typed/          # control: well-tested strict-TS module
    fixtures.meta.json       # registry: id, path, name, kind, purpose
  scenarios/                 # one JSON file per scenario kind
    refactor.json bugfix.json review.json context.json plan.json
  results/                   # per-version pinned eval outputs
    0.7.0/
      claude/<scenario-id>.json
      codex/<scenario-id>.json
      summary.json
  runner/                    # the runner workspace package (evals-runner)
    src/index.ts             # orchestrator
    src/agents/claude.ts     # claude CLI shell-out
    src/agents/codex.ts      # codex CLI shell-out
    src/score.ts             # §5.5 structural rubric
    src/judge.ts             # opt-in --judge pass
    src/replay.ts            # evals:replay entry
    src/diff.ts              # evals:diff entry
    src/setup.ts             # evals:setup entry — clones OSS fixtures
```

## Running

```bash
# One-time per machine — clones OSS fixtures at their pinned SHAs.
pnpm run evals:setup

# Full matrix (every fixture × scenario × agent).
pnpm run evals

# Subset of the matrix.
pnpm run evals -- --agent claude
pnpm run evals -- --fixture 01
pnpm run evals -- --scenario refactor

# Add the opt-in judge-model pass.
pnpm run evals -- --judge
```

Per fixture × scenario × agent invocation, the runner:

1. `cd evals/fixtures/<NN>-<name>` and runs `crimes scan --format json`.
   That output is the scenario context.
2. Composes the scenario `prompt` + scan JSON and shells out to the
   agent (`claude -p ... --output-format json` or `codex exec
   --json ...`).
3. Captures the response and applies the §5.5 structural rubric.
4. (Optional, `--judge`) sends scenario + expected_artifacts +
   response to `claude` in an evaluator role; captures structured
   `{score, reasoning}` per `judge_questions` entry.
5. Writes
   `evals/results/<crimes-version>/<agent>/<scenario-id>.json`
   atomically (tempdir + rename).

## Structural rubric

Each scenario carries an `expected_artifacts` block; the runner
checks the agent's response against it:

- `referenced_findings` — extract every known detector-id from the
  response (`\b<id>\b`); one pass per expected id.
- `referenced_files` — extract file-path-shaped tokens; one pass
  per expected path.
- `forbidden_actions` — pass when none of the listed regex patterns
  appear in the response.
- `expected_priority` — first detector id in the first 200 chars of
  the response must match.

Result shape:

```ts
interface ScoreResult {
  scenario: string;
  agent: "claude" | "codex";
  crimes_version: string;
  timestamp: string;
  run_id: string;
  response: string;            // preserved so `evals:replay` can re-score
  structural_score: {
    passed: number;
    failed: number;
    details: ScoreDetail[];
  };
  judge_score?: {
    overall: number;           // 0-10, mean across per_question
    per_question: Array<{ question: string; score: number; reasoning: string }>;
    model: string;
  };
}
```

A `summary.json` at the version root rolls up per-agent and
per-scenario-kind pass rates after every run.

## Judge pass (opt-in, `--judge`)

`--judge` sends the scenario + expected_artifacts + agent's response
back to `claude` (in a different role) with the scenario's
`judge_questions`. Each answer must be a JSON object
`{score: 0-10, reasoning: string}`; malformed answers are marked
`failed` (score 0) rather than crashing the run.

The judge pass is **opt-in** and never gates anything — judge models
are stochastic and we don't want a structural-rubric-stable diff to
churn on judge variance. Use it for "did the agent's reasoning make
sense, not just whether it referenced the right finding?"
investigations.

## CI: replay, never re-invoke

The PR workflow at `.github/workflows/evals-pr.yml` triggers on PRs
touching detector / scoring / language / CLI / evals code:

1. Builds the PR's crimes binary.
2. Runs `pnpm run evals:setup` — materialises the gitignored OSS
   fixture bodies. Without it every scan below runs against an empty
   directory.
3. Runs `pnpm --filter evals-runner evals:verify-scenarios` — checks
   that every scenario's expected findings actually fire on its
   fixture.
4. Runs `pnpm run evals:replay` — re-scores every committed result in
   the pinned baseline against the PR's structural rubric. No agent
   calls.
5. Runs `pnpm run evals:diff` — compares per-agent pass rates from
   the replay to the pinned summary. Writes
   `evals/diff-summary.md`.
6. Posts (or updates a single) PR comment with the markdown diff.

The **pinned baseline** is the newest `evals/results/<version>/` that
holds both agent result files and a `summary.json` — not simply the
newest directory, since `evals:ranking` writes a `ranking.json`-only
directory on every patch bump. `evals:replay` and `evals:diff` share
that selection so they can never compare two different samples.

A **pass-rate move is signal, not a gate**: within ±10% it is marked
stable, outside it is flagged ("improved" / "regression"), and either
way the job stays green. Investigate flagged regressions before merging
detector changes.

**Having nothing to measure is a gate.** Each of these commands exits
`2` rather than `0` when its input is missing — no results to replay,
no replay output to diff, a fixture still absent from disk. All three
used to report that state and exit 0, so the job went green having
measured nothing. See `evals/README.md` § Exit codes.

## Adding a fixture

1. Pick a slot number (`02-04` reserved for OSS clones; `05-08`
   stress; `09-10` clean controls; start higher for new categories).
2. Make `evals/fixtures/NN-name/` and add the project files.
   - **Hand-crafted:** commit the body directly.
   - **OSS clone:** add a `.crimes-eval-meta.json` with
     `{upstream, sha, license, purpose}`. The body is gitignored;
     `pnpm run evals:setup` materialises it at the pinned SHA.
3. Register the fixture in `evals/fixtures/fixtures.meta.json`.
4. Add scenarios for the fixture to the relevant
   `evals/scenarios/<kind>.json` array.

## Adding a scenario

Each scenario in `evals/scenarios/<kind>.json` is an object:

```json
{
  "id": "refactor-NN-name",
  "fixture": "NN",
  "kind": "refactor",
  "prompt": "...",
  "expected_artifacts": {
    "referenced_findings": ["..."],
    "referenced_files": ["..."],
    "forbidden_actions": ["..."],
    "expected_priority": "..."
  },
  "judge_questions": ["..."]
}
```

`expected_artifacts` is what the structural rubric checks against.
`judge_questions` is what the opt-in judge pass asks. Both are
optional — supply only the checks that make sense for the scenario.

## OSS fixture rot

OSS upstreams change. We mitigate with:

- Every clone pinned to a specific SHA in the meta file.
- `.crimes-eval-meta.json` records the upstream + license + purpose
  at vendoring time.
- `pnpm run evals:setup` fails loudly when a clone can't be retrieved.
- If an upstream disappears, mark the fixture as
  `archived: true` in the meta file and the runner skips it.

## Subscription CLI availability

The runner does a startup `which claude` / `which codex` check.
Missing CLIs are skipped with a setup message ("install it and
re-authenticate, then re-run") rather than crashing mid-matrix.
`--agent claude` or `--agent codex` lets you run the matrix against
just the CLI you have available.

## See also

- [`evals/README.md`](../evals/README.md) — the contributor-facing
  quick reference (same content but lives next to the harness).
- [`docs/scoring.md`](./scoring.md) — the per-finding score model
  the eval rubric tests detectors against.
- [§5 of `.planning/archive/0.7.0-calibration-evidence-loop.md`](https://github.com/ortomate/crimes/blob/main/.planning/archive/0.7.0-calibration-evidence-loop.md)
  — the spec the harness implements.
