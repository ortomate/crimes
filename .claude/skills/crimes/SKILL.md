---
name: crimes-codebase-risk
description: Use when editing, reviewing, or investigating a TypeScript / JavaScript codebase that ships with the `crimes` CLI. Helps agents run pre-edit context checks, post-edit scans, and interpret findings before risky changes.
---

# crimes — codebase risk workflow

`crimes` is a deterministic CLI (no LLM) that reports change risk and
agent risk on a TS/JS repo. JSON output is the stable contract for agent
decisions; prefer it when planning, gating, comparing, or making
decisions. For user-facing readbacks, use the default human output
instead of rebuilding the report in your own prose.

This skill is short on purpose: run the right command at the right moment,
read the JSON, act on it — and when reporting back, paste the human
readout rather than re-rendering it.

## When to invoke

Before **any** of these:

- Editing a file you have not read in this session.
- Editing a file > 200 lines.
- Refactoring across multiple files.
- Renaming a function, prop, or type used in more than one place.
- Adding a new branch to existing logic in domain code (billing, auth,
  permissions, scheduling, anything stateful).

Skip when:

- Pure greenfield code in a new file.
- Doc-only changes.
- The user has explicitly said "don't run crimes for this".

## Commands

`crimes` binary if installed; otherwise `node packages/cli/dist/index.js` from
the monorepo root.

### Before editing one specific file

```bash
crimes context <file> --format json
```

Reads:

- `risk.level` — headline (`none | low | medium | high`)
- `findings[]` — per-file findings, read every `high` first
- `likely_tests[]` — run these after editing
- `agent_guidance[]` — one short line per finding type that fired

### Before a broad refactor

```bash
crimes scan <path> --format json
```

Reads:

- `summary.high` / `summary.medium` / `summary.low`
- Every finding with `severity: "high"`
- `evidence[]` on each finding — concrete facts, treat as ground truth
- `scores.agent_risk` — read these next; high means "easy to misread"

### After editing (the post-edit gate)

```bash
# Re-run the same scope you scanned pre-edit
crimes scan <path> --format json
# OR, if you are mid-task and only touched files in the working tree
crimes scan --changed --format json
```

Diff the findings against the pre-edit run.

### Changed-files-only scope

`crimes scan --changed` restricts to files changed in the working tree.
With `--base <ref>` it also includes commits unique to the current branch:

```bash
crimes scan --changed --format json                     # working tree
crimes scan --changed --base main --format json         # + branch commits
crimes scan --changed --base origin/main --format json  # + unpushed commits
crimes scan --changed --fail-on high --format json      # CI gate — exit 1 on new high
```

Requires a git repo. Outside a repo it exits 2 — fall back to a path-scoped
`crimes scan <path>`.

`--fail-on low|medium|high` is the opt-in gate for the changed set. Only
valid with `--changed`; passing it alone exits 2. When set, the JSON
gains `fail_on` (the threshold) and `failed` (boolean) at the top level,
and the command exits 1 when at least one finding in the changed set
meets the threshold.

### Branch-level review (`crimes diff`)

When two committed refs exist and you want **new** / **fixed** /
**unchanged** crimes between them (e.g. branch review, release-to-release):

```bash
crimes diff main...HEAD --format json
crimes diff origin/main...HEAD --format json
crimes diff v0.1.0...HEAD --format json
```

Triple-dot form only. Working-tree-safe — `crimes` exports each ref into
a temp dir via `git archive` and scans there, so a dirty working tree is
preserved.

Read on the JSON:

- `summary.new` — headline gate. If `> 0` and any are `severity: "high"`,
  treat the branch as regressing.
- `new_findings[]` — full Finding shape; quote `evidence` and `lines`.
- `fixed_findings[]` — wins from the branch; mention which charges cleared.
- `unchanged_findings[]` — pre-existing debt; don't relitigate.

Findings are matched by stable fingerprint `<type>::<file>::<symbol-or-empty>`,
not the per-scan `id` — small line shifts do not register as fix+new.

### Baseline gate (`crimes baseline`)

When the repo has a committed `.crimes/baseline.json`, run the same gate
CI uses:

```bash
crimes baseline check --format json
crimes baseline check --fail-on high --format json   # stricter
```

To adopt `crimes` on a legacy repo, snapshot the current findings once
and commit the file — pre-existing debt is then pinned and won't block
future CI runs:

```bash
crimes baseline save
git add .crimes/baseline.json && git commit -m "Add crimes baseline"
```

Read on the JSON:

- `failed` — the gate. `true` means at least one new finding meets the
  `--fail-on` threshold (exit `1`). `false` means no regression (exit `0`).
  Exit `2` is reserved for missing / malformed baseline files.
- `new_findings[]` — full Finding shape; treat exactly like
  `crimes diff`'s `new_findings`.
- `fixed_findings[]` — minimal `BaselineEntry` (no `lines` / `evidence`,
  since the offending code may be gone). Mention which charges cleared.
- `unchanged_findings[]` — pre-existing debt the baseline pins. Don't
  relitigate them in the diff conversation.

`--fail-on` values: `low` (any new finding fails), `medium` (medium or
high; the default), `high` (only new high findings fail).

### End-of-task verdict (`crimes verdict`)

When the task is wrapped and you want a one-line "did this branch make
the repo cleaner, worse, unchanged, or mixed?" answer for the user, run
`crimes verdict`. Built on top of `crimes diff`, so same fingerprint
matching and same working-tree-safety:

```bash
crimes verdict --format json                  # default base: origin/main → main
crimes verdict --base main --format json      # override base
crimes verdict --fail-on new-high             # opt-in CI gate
```

Read on the JSON:

- `verdict` — headline, one of `cleaner | worse | unchanged | mixed`.
- `reasons[]` — short human-readable strings explaining what drove the
  verdict; quote them back when summarising.
- `recommended_actions[]` — one or two next-step lines keyed off the
  verdict. Treat both as advisory copy.
- `summary.new_weighted` / `summary.fixed_weighted` — simple weighted
  scores (`high = 3`, `medium = 2`, `low = 1`) that drive the
  judgement. Treat as ordinal — exact weights may change.
- `summary.new_by_severity` / `summary.fixed_by_severity` — per-severity
  counts on each side, useful when explaining trade-offs.
- `new_findings[]` / `fixed_findings[]` — full `Finding` shape, same
  contract as `crimes diff`.

Default base picks `origin/main` first, then `main`. If neither
resolves the command exits `2` — pass `--base <ref>` explicitly.

`--fail-on` is opt-in (the default behaviour is advisory, always exit
`0`). Values:

- `worse` — fail when `verdict === "worse"`.
- `new-high` — fail when any new finding has `severity: "high"`.
- `new-medium` — fail when any new finding has `severity: "medium"` or
  `"high"`.

Decision rule: when the verdict is `worse` because of a new high, treat
it the same as a new high finding from `crimes diff` — a blocker unless
the user explicitly accepts the risk. When the verdict is `mixed`,
surface the trade-off rather than silently merging.

## Decision rules

1. **A new `severity: "high"` finding introduced by your edit is a blocker.**
   Either fix it before continuing, or surface it to the user with the
   finding `id` and `charge` and an explicit reason for leaving it.
2. **If `scores.agent_risk` rose on a touched file, slow down.** You may
   have added a duplicate source of truth, a misleading name, or a hidden
   side effect.
3. **If `summary.high` / `summary.medium` went down, you are in a good
   state.** Mention which findings you cleared.
4. **Quote `evidence[]` strings back to the user** when explaining decisions
   — they are deterministic facts (line ranges, AST observations), not LLM
   opinion.

## Auto-fix policy

Do **not** auto-fix maintainability findings unless **all** of:

- The user asked for the refactor (or accepted a proposal).
- Intended behaviour is clear and you can articulate it in one sentence.
- Relevant tests exist, OR you add them in the same change.
- The change is scoped — no drive-by refactors in unrelated files.

In particular: never split a "God Function" or restructure a "God File"
silently while doing a bugfix. Surface the finding, propose, then act on
user approval.

## What `crimes` does not do

- It is not a linter (no style/syntax rules).
- It is not a security scanner.
- It has no LSP, no watch mode, no editor integration.
- It does not auto-fix. There is no `crimes --fix`.
- These commands are **not yet implemented** and must not be invoked:
  `crimes ask`. (`crimes init`, `crimes ignore`, `crimes unignore`,
  `crimes audit-suppressions`, `crimes explain`, `crimes diff
  --fail-on new-high | new-medium`, and `--show-suppressed` on every
  command that lists findings all shipped in `0.5.0`. `0.6.0`
  added 18 new detector types plus real per-finding `scores.churn`
  / `scores.test_gap` / `scores.blast_radius` and the unified
  `agent_risk` formula documented at `docs/scoring.md`. `0.7.0`
  adds one new command — `crimes feedback` — and **zero** new
  detectors; the 0.6.0 slate is what we calibrate against.)

## `crimes feedback` (new in 0.7.0)

The `crimes scan` / `context` / `diff` human output now prints a
trailing one-line hint under every finding:

```
     Give feedback: crimes feedback large_function::src/billing.ts::generateInvoice --verdict {tp|fp}
```

When a user disagrees with a finding, recommend the `fp` form with
a one-sentence note explaining why; that note becomes the
suppression reason and persists in `.crimes/feedback.jsonl` +
`.crimes/suppressions.json`:

```bash
crimes feedback large_function::src/billing.ts::generateInvoice \
  --verdict fp \
  --note "Builder pattern — DSL chain, not mixed responsibilities"
```

When a finding catches something real, `--verdict tp` records the
hit (and removes any prior feedback-sourced suppression on the
same fingerprint). `--verdict known` records awareness without
silencing.

**Read `previously_suppressed: true` on findings.** This flag means
the finding *was* silenced under a previous crimes minor and has
auto-resurfaced for re-confirmation. The accompanying
`previous_suppression.{pinned_version, reason}` carries the prior
verdict. Surface the alternate "⚠ Previously marked fp in 0.7"
copy verbatim; do NOT silently re-suppress without asking the
user.

`crimes feedback recheck` walks every resurfaced suppression with
per-detector release-notes hints + the exact `crimes feedback …
--verdict fp|tp` commands the user can copy. Suggest it after any
crimes minor bump.

See [`../../../docs/feedback.md`](../../../docs/feedback.md) for the
full lifecycle and the cross-project rollup workflow.

## Suppressions and `crimes ignore`

When a specific finding is acceptable for a documented reason (a
legacy module under rewrite, a route handler the team has agreed to
keep monolithic, an alias kept for backwards compatibility), the
right answer is **explain then ignore**, not silently skipping the
report:

```bash
crimes explain large_function::src/billing.ts::generateInvoice
# read the rationale, decide this is acceptable
crimes ignore large_function::src/billing.ts::generateInvoice \
  --reason "Legacy billing module — rewrite tracked in #1234"
```

`crimes ignore` requires a `--reason` and persists it to
`.crimes/suppressions.json`, which the team commits and reviews in
PRs. Always phrase the reason as a single specific sentence naming
the constraint or tracking issue — "too noisy" or "we know about
this" are not acceptable suppression reasons. The CLI accepts either
a per-scan id (`crime_00005`) or the stable fingerprint
(`<type>::<file>::<symbol>`) and always persists by fingerprint.
Suppressed findings never trip a `--fail-on` gate.

When a suppression becomes obsolete, remove it with `crimes unignore
<fingerprint>` (symmetric to `ignore`, supports `--dry-run`). To
audit the file — sorted by age, flagging stale (>180d), short
(<16 chars), or vague reasons — run `crimes audit-suppressions`. See
[`../../../docs/suppressions.md`](../../../docs/suppressions.md).

## CI integration

Three deterministic gating modes, see [`../../../docs/ci.md`](../../../docs/ci.md):

- **Mode A — changed-files gate:** `crimes scan --changed --fail-on high`
  (narrow, ignores untouched legacy debt).
- **Mode B — baseline gate:** `crimes baseline check --fail-on medium`
  (after committing `.crimes/baseline.json`; fails only on new debt).
- **Mode C — branch verdict gate:** `crimes verdict --base origin/main
  --fail-on new-high` (PR-comment summary that flips to a hard gate on
  any new high finding).

Uniform exit-code contract across all three: `0` passes, `1` is the gate
failing, `2` is a usage / environment error (bad flag, missing baseline,
not a git repo). A GitHub Actions example lives at
[`../../../examples/github-actions/crimes.yml`](../../../examples/github-actions/crimes.yml).

## Reading findings — five fields that matter

| Field               | Use for                                                        |
| ------------------- | -------------------------------------------------------------- |
| `severity`          | Triage (`high → medium → low`)                                 |
| `file` + `lines`    | Where to read first; `lines` is 1-based inclusive `[start,end]`|
| `symbol`            | Function/method/class name when applicable                     |
| `evidence[]`        | Concrete facts — quote these when explaining changes           |
| `scores.agent_risk` | "Easy for an LLM to misread, duplicate, or break"              |

Default sort is severity-first. If your task is "what should I read before
editing", re-sort by `scores.agent_risk` instead.

## Stability

- `schema_version` at the top of every report is the source of truth.
- While `schema_version === "0.1.0"`, the shape in
  [`docs/json-schema.md`](../../../docs/json-schema.md) is stable.
- Refuse to consume a report whose `schema_version` you do not recognise.

## Reporting findings back to humans

Use `--format json` when you need to plan, gate, compare, or make
decisions. When the user wants to see the results, or when you are
summarising findings back in chat, prefer running the same command
without `--format json` and quote or paste the relevant human-readable
readout. The human report is intentionally designed for people:
severity glyphs, grouped findings, evidence, feedback commands,
suppressions, and gate status are already rendered there.

Do not paraphrase the whole JSON payload in your own voice unless you
need a short executive summary. Use the human readout as the canonical
user-facing presentation, and add your own interpretation only around
the parts that matter for the task.

## See also

- [`AGENTS.md`](../../../AGENTS.md) — repo-level agent instructions.
- [`docs/agent-usage.md`](../../../docs/agent-usage.md) — full pre/post-edit
  workflow with examples.
- [`docs/json-schema.md`](../../../docs/json-schema.md) — wire format.
