---
title: crimes evals — the agentic harness
description: How the eval harness scores Claude and Codex against fixture × scenario combinations, how to add fixtures or scenarios, and how the CI replay catches detector-tuning regressions without invoking fresh agent runs.
---

# crimes evals — the agentic harness

The 0.7.0 release introduces the **eval harness** at `evals/`. It is
the second half of the calibration story: where
[`crimes feedback`](./feedback.md) captures Andrew's verdicts on
real-world scans, the eval harness captures *agent* behaviour on a
pinned matrix of fixtures and scenarios.

It runs locally on a maintainer's machine via the `claude` and
`codex` CLIs — both authenticate against existing subscriptions, so
**no API keys, no per-call billing**. CI never invokes a fresh agent
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

1. `cd evals/fixtures/<NN>-<name>` and runs `crimes scan -f json`.
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
