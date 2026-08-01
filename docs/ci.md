# Using `crimes` in CI

`crimes` is built for CI. Every gating command exits non-zero on the
threshold you opt into, prints JSON when asked, and is deterministic — no
LLM, no network, no state outside `.crimes/`. This page documents the four
recommended CI integration modes (one of which lands in `0.5.0`) and the
ready-to-copy GitHub Actions example that ships with the repo.

> **`0.5.0` additions:** the **`diff --fail-on new-high | new-medium`**
> mode joins the three existing gate flavours, and
> **`.crimes/suppressions.json`** is now applied *before* every gate
> evaluation — a suppressed finding never trips a `--fail-on` check. See
> [Suppressions vs baselines](#suppressions-vs-baselines) below.

For the wire format, see [`docs/json-schema.md`](./json-schema.md). For the
agent-loop equivalent of the same commands (pre-edit / post-edit), see
[`docs/agent-usage.md`](./agent-usage.md).

---

## Advisory vs gating

Every shipped command runs in one of two modes. Pick whichever fits the
contract you want with your team.

- **Advisory** — always exits `0`. Use when the team should see the
  report but not be blocked on it. Examples: `crimes scan`, `crimes diff`,
  `crimes verdict` (the **default** of all three).
- **Gating** — exits `1` when a configured threshold is met, `2` on
  usage / environment errors, `0` otherwise. Examples: `crimes baseline
  check --fail-on …`, `crimes verdict --fail-on …`, and
  `crimes scan --changed --fail-on …`.

Mixing advisory and gating commands in the same job is fine — e.g. run
`crimes verdict --format json` for the PR comment and `crimes baseline
check --fail-on medium` to block the merge.

---

## Three recommended modes

Pick **one** of the three. They are not mutually exclusive but they answer
different questions, and running all three in the same job is rarely worth
the latency.

### Mode A — Changed-files gate

Use after agents or humans edit code in the working tree, and you want a
narrow gate that only inspects what the change actually touched. This is
the cheapest scope — it skips legacy files entirely.

```bash
crimes scan --changed --fail-on high
```

Behaviour:

- Scans only files changed in the working tree, plus (with `--base`)
  commits unique to the current branch. See `crimes scan --changed --help`.
- Exits `1` when any finding in the changed set has severity ≥ the
  threshold. The threshold accepts `low | medium | high`.
- Exits `0` otherwise.
- Exits `2` on usage errors — including `--fail-on` passed without
  `--changed`, an unknown threshold, or running outside a git repo.
- JSON output gains two extra top-level fields when `--fail-on` is set:
  `fail_on` (the threshold) and `failed` (the boolean gate result). The
  rest of the `ScanReport` shape is unchanged.

When to reach for it:

- A pre-commit hook on a developer machine, or a CI job that runs on
  every push and only cares about the new diff.
- An agent loop where you want the agent to fail fast on its own diff
  before handing off to the user.

Known limits:

- It scans only files in the changed set, so it can miss pre-existing
  high findings in untouched files. That's the point — use Mode B if you
  want a baseline-aware view that pins legacy debt instead.
- File renames register as a fix + new pair, same as `git diff` without
  `--find-renames`.

### Mode B — Baseline gate

Use for legacy repos with existing debt. Snapshot the current findings
once, commit `.crimes/baseline.json`, then gate CI on findings absent from
that snapshot — pre-existing debt stays out of the way.

```bash
# One-time adoption, on a clean branch:
crimes baseline save
git add .crimes/baseline.json
git commit -m "Add crimes baseline"

# On every PR:
crimes baseline check --fail-on medium
```

**Re-snapshot after a `crimes` upgrade.** `0.6.0` ships 18 new
detector types. Those findings are — by definition — not in a
baseline saved with `crimes@0.5.0` or earlier, so a CI run with
`--fail-on medium` will start flagging them. The recommended path is
to re-pin the baseline once per upgrade:

```bash
crimes baseline save
git add .crimes/baseline.json
git commit -m "Re-pin crimes baseline after 0.6.0 upgrade"
```

Or temporarily raise the gate to `high` until you've audited the new
findings — only `circular_dependency` at ≥ 3 files defaults to
`high`, so the gate stays meaningful even at the stricter
threshold.

Behaviour:

- Loads `<repo>/.crimes/baseline.json`, runs a full repo scan, and
  partitions the result into `new` / `fixed` / `unchanged` by stable
  fingerprint (`<type>::<file>::<symbol-or-empty>[::<discriminator>]`). Small line shifts
  from unrelated edits don't register as fix + new.
- `--fail-on` accepts `low | medium | high`. Default is `medium`.
- Exits `1` when at least one **new** finding has severity ≥ the
  threshold. Pre-existing findings — even high — do not affect the gate.
- Exits `2` on missing or malformed baseline, or a bad flag.
- Exits `0` otherwise.

When to reach for it:

- Adopting `crimes` on an existing codebase that already has findings
  you don't want to chase before turning the gate on.
- A team that wants "never get worse than the last green build" rather
  than "never have any findings at all".

Known limits:

- The baseline is repo-wide. If you want per-directory thresholds today,
  run `crimes baseline check` from a subdirectory or split the repo.
- Renames register as a fix + new pair, same as `crimes diff`.
- Two findings with identical `(type, file, symbol)` collide on one
  fingerprint — rare in practice (nested helpers with the same name).

### Mode C — Branch verdict

Use for a one-line "did this branch make the repo cleaner, worse,
unchanged, or mixed?" summary suitable for a PR comment or a status check
display name. Advisory by default — opt into a gate with `--fail-on`.

```bash
# Advisory PR comment (always exits 0):
crimes verdict --base origin/main --format json

# Gating: fail the build on any new high-severity finding.
crimes verdict --base origin/main --fail-on new-high
```

Behaviour:

- Built on top of `crimes diff` — same archive-into-temp scanning, same
  fingerprint-based matching. Working-tree-safe.
- Default base picks `origin/main` first, then `main`. Pass `--base
  <ref>` to override.
- `--fail-on` values: `worse` (verdict is `worse`), `new-high` (any new
  finding has severity `high`), `new-medium` (any new finding has
  severity `medium` or `high`).
- Exits `1` when the threshold is met.
- Exits `2` on usage / environment errors (not a git repo, no resolvable
  default base, bad flag).
- Exits `0` otherwise — including when no `--fail-on` is passed.

When to reach for it:

- A PR summary check that says "this branch removed 2 high findings and
  introduced 1 medium" without blocking the merge.
- A nightly run that posts a cleanliness trend to Slack — feed
  `summary.new_weighted` / `summary.fixed_weighted` into a chart.

Known limits:

- Severity weights are `high = 3`, `medium = 2`, `low = 1`. They are
  ordinal — treat the exact numbers as advisory; they may shift between
  minor releases.
- Like `crimes diff`, file renames register as a fix + new pair.

---

## Exit codes (all gating commands)

| Exit | Meaning                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| `0`  | Command succeeded; no blocking findings under the configured `--fail-on`.    |
| `1`  | The configured `--fail-on` threshold was met. Treat as a CI gate failure.    |
| `2`  | Usage / environment error — bad flag, missing baseline, not a git repo, etc. |

`0` and `1` always emit JSON to stdout when `--format json` is set. `2`
writes a short human-readable error line to stderr and emits no JSON, so
callers can distinguish "gate failed" from "command broke" without
parsing the body.

---

## GitHub Actions

A copy-paste example lives at
[`examples/github-actions/crimes.yml`](../examples/github-actions/crimes.yml).
Drop it under `.github/workflows/crimes.yml` in your repo to wire up the
default Mode C (`crimes verdict --base origin/main --fail-on new-high`)
gate. Commented alternatives in the same file show the Mode A and Mode B
swaps.

Three things are easy to get wrong, and the example handles them:

1. **Fetch enough history.** `actions/checkout` defaults to a shallow
   clone (`fetch-depth: 1`), which means `origin/main` won't resolve from
   a PR build. The example sets `fetch-depth: 0`. If you'd rather keep
   the clone shallow, fetch the base ref explicitly:

   ```yaml
   - run: git fetch --depth=1 origin ${{ github.base_ref || 'main' }}
   ```

2. **Install Node ≥ 18.** `crimes` requires it. The example pins Node 20.

3. **Use the published binary, not the source.** `npm install -g crimes`
   is the production path. The example does that; don't replace it with
   a checkout-and-build unless you're testing an unreleased branch.

---

## Picking a mode

Quick decision tree:

- **Brand-new repo, or repo that already has zero findings** → Mode A.
  Smallest blast radius and the easiest to explain to contributors.
- **Existing repo with pre-existing findings you don't want to chase
  yet** → Mode B. Snapshot, commit, gate forward.
- **You want a PR-comment trend signal, not a hard merge gate** → Mode C
  without `--fail-on`. Add `--fail-on new-high` later if you want it to
  start blocking.

You can run Mode C **and** Mode A or B in the same workflow — Mode C as
advisory copy in the PR description, Mode A or B as the actual gate. The
JSON outputs share `schema_version` and are stable across minor releases.

---

## Suppressions vs baselines

`crimes@0.5.0` introduces `.crimes/suppressions.json`. The file lives
next to `.crimes/baseline.json` (and is intended to be committed
alongside it) but the two solve different problems:

| `.crimes/baseline.json` | `.crimes/suppressions.json` |
| ----------------------- | --------------------------- |
| Repo-wide snapshot of pre-existing findings. | Per-finding deliberate exception with a reason. |
| Forward-only — new findings are blocked. | Permanent — entries persist until you delete them. |
| Written by `crimes baseline save`. | Written by `crimes ignore`. |
| Read by `crimes baseline check`. | Read by every report-producing command. |
| Use when adopting `crimes` for the first time. | Use when one specific finding is acceptable. |

Most teams want both: `baseline` to ignore legacy debt, `suppressions`
to document the specific findings the team has triaged.

### Suppressions and `--fail-on`

Suppressions are applied **before** every `--fail-on` evaluation. A
suppressed finding never trips a gate, regardless of severity or which
of the four gating commands you run:

- `crimes scan --changed --fail-on <severity>`
- `crimes baseline check --fail-on <severity>`
- `crimes diff --fail-on new-high | new-medium` (new in `0.5.0`)
- `crimes verdict --fail-on worse | new-high | new-medium`

Each command exposes a `suppressed_count` field in its JSON output
when ≥1 entry matched; `--show-suppressed` re-surfaces them annotated
without changing the gate verdict. See
[`docs/suppressions.md`](./suppressions.md) for the full workflow.

### Feedback-sourced suppressions across CI minor bumps (0.7.0+)

Suppressions written by `crimes feedback ... --verdict fp` carry
`source: "feedback"` and `crimes_version_pinned: "<minor>"`. They
behave identically to `source: "manual"` suppressions for every
gate **while the CI runner's crimes minor matches the pinned
value**. On the first CI run after a crimes minor bump:

- The matching findings *resurface* — they're kept in
  `findings[]` (tagged `previously_suppressed: true`) instead of
  being silenced.
- `suppressed_count` does NOT include them, so existing JSON
  consumers see the resurfaced finding as a normal finding.
- Gates **will trip on resurfaced findings** at their original
  severity. This is intentional: a freshly resurfaced
  high-severity finding should pause the merge until the user has
  re-confirmed `fp` or marked `tp`.

The stderr breadcrumb the CLI prints on the first scan after a
minor bump ("5 feedback-sourced suppressions resurface because
they were pinned to 0.6 — run `crimes feedback recheck`") shows
up in CI logs same as locally. Pin the crimes version your CI
uses (`npm install -g crimes@<exact-version>`) if you want gate
behaviour to be lock-step with the local developer experience.

See [`docs/feedback.md`](./feedback.md#the-auto-resurface-loop) for
the lifecycle.

## See also

- [`examples/github-actions/crimes.yml`](../examples/github-actions/crimes.yml) —
  copy-paste GitHub Actions workflow.
- [`docs/json-schema.md`](./json-schema.md) — wire format for every
  command's JSON output.
- [`docs/agent-usage.md`](./agent-usage.md) — the same gating commands
  used inside an agent loop instead of CI.
- [`docs/suppressions.md`](./suppressions.md) — `.crimes/suppressions.json`
  shape, workflow, and anti-patterns.
- [`docs/configuration.md`](./configuration.md) — full
  `crimes.config.json` reference.
