# Using crimes with coding agents

Use crimes to understand the change you are making. Findings are evidence
for a decision, not an automatic work queue.

## Before editing

Use the project’s installed executable consistently. Prefer
`./node_modules/.bin/crimes` or the project’s package-manager script over a
global CLI; only fall back to `crimes` on PATH when no local installation exists.
Check `--version`; do not silently fetch a different version for the second
scan. In a source checkout use the built CLI. Retain the pre-edit scoped scan
JSON outside scanned sources, then repeat that scope after editing. Files
added to the scope later do not have a pre-edit observation to compare.

```bash
crimes context src/billing/tax.ts --root . --format json
crimes scan --files src/billing/tax.ts,src/billing/invoice.ts --format json
crimes scan --related-to src/billing/tax.ts --related-depth 1 --format json
```

1. Check `repo.root` and `file`. All reported paths are relative to that root.
   `context` defaults to the nearest package marker (`package.json`,
   `pyproject.toml`, `setup.py`, `setup.cfg`). Use `--root .` for a monorepo-wide
   briefing so configuration, dependencies and fingerprints share a root.
2. Check `analysis_status`: `complete`, `partial`, or `not_analyzed`.
   Review `coverage.warnings`. An excluded or unparsed file can have no
   findings; that is not evidence of safety. Complete means the configured
   analysis finished, not that every possible defect was detectable.
3. Read `agent_guidance`, `evidence`, `related_files` and `likely_tests`.
   Resolved importers and dependencies outrank name similarity. Resolved
   importing tests come first; filename and textual-reference matches are
   fallbacks. Inspect assertions before treating any test as protection.
4. Preserve JSON finding order when prioritising. `scores.agent_risk` is
   ordinal, not a probability; recency also affects default order.
5. Review relevant code and tests before choosing a scoped edit.

`context` and `scan` share discovery, indexes, detector execution, claim
filtering and scoring. Context includes findings anchored elsewhere when
its target is in `related_files`. Both analyse the repository to obtain
cross-file evidence; scoping primarily narrows output, not analysis cost.
Context findings are not hidden by triage; committed dispositions should be
read with `crimes triage --list --format json`. Suppressions apply unless
`--show-suppressed` is requested.

## After editing and before merging

```bash
crimes scan --changed --format json
crimes scan --changed --base main --format json
crimes verdict --base origin/main --fail-on new-high --format json
```

Compare fingerprints with the pre-edit result using the same root and
configuration. `scan --changed` selects changed files, including old debt
in those files. Its `--fail-on high` gate does not mean "only new highs".
For committed changes, `verdict` and `diff` compare findings between refs.
For legacy debt, save a baseline and use `baseline check`.

Run the repository's own behavioural checks. Crimes does not replace
compilation, unit/integration tests, accessibility tools, linters or security
analysis. Escalate a new high finding according to the repository's policy;
explain its evidence and the options rather than silently suppressing it.

## Identity and decisions

- Treat `fingerprint` as opaque. Do not construct it or use positional
  `crime_NNNNN` ids across scans.
- Judge `(type, claim, subject)`, not an entire detector based on one sample.
  A `weak_test_signal/no_assertions` finding makes a different statement
  from `weak_test_signal/weak_assertion_matchers`.
- For a false positive: `crimes feedback '<fingerprint>' --verdict fp --note 'why'`.
  This writes local feedback and a suppression pinned to the current minor.
- Do not silently renew a previously suppressed false positive. Ask whether
  it remains false or has been resolved; preserve the calibration signal.
- In a non-TTY, use `crimes triage --apply decisions.json`. The minimal input
  is an array of `{ "fingerprint": "copied value", "disposition": "wont-fix",
  "reason": "specific reason" }`. Owner defaults to empty and date to today.
- For stale pins, [preview a migration](./pin-migration.md). Applying a
  reviewed plan preserves reasons, owners, dates and feedback expiry pins.

## Setup and output

`crimes init --agents` writes skills for Claude Code and Codex and installs
an optional Claude pre-edit hook; `--no-hooks` skips hooks. After a CLI
upgrade, `crimes init --refresh-skills --check` previews skill updates and
`crimes init --refresh-skills` updates unchanged generated copies while
preserving config, hooks and customizations. Npm alone does not update
project skill files. Consult
[the integration reference](./skills.md) for exact files. Do not assume a
settings file is an active integration merely because it exists.

Use JSON for decisions and comparisons. Human output is useful for concise
readbacks: quote relevant evidence and add your interpretation. You need not
paste a whole report or run another full scan just to repeat information.

JSON is versioned by `schema_version`; read [the JSON contract](./json-schema.md).
New optional fields can appear. Do not assume a missing signal is a measured
zero, or that a numeric score is calibrated as a probability.

Exit codes: `0` completed without a blocking threshold, `1` configured gate
failed, `2` usage/environment error. Advisory commands can report findings
while exiting zero. Check the report's coverage as well as its exit code.

[Generated command/detector reference](./reference.md) · [Scoring](./scoring.md) ·
[Configuration](./configuration.md) · [CI recipes](./ci.md) · [Feedback](./feedback.md)
