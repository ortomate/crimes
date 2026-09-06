# Using crimes in CI

Choose a gate for the question you need answered. Reports are advisory until
you select a threshold; analysis errors remain errors in either mode.
Pin the CLI version so a package upgrade does not unexpectedly change a
team's gate. The scanner runs locally without an LLM or network access.

## Three recommended modes

| Question | Command | Existing findings |
| --- | --- | --- |
| Does this working set contain a high finding? | `crimes scan --changed --fail-on high` | Existing findings in selected files can fail. |
| Did this repo gain findings beyond accepted debt? | `crimes baseline check --fail-on medium` | Findings already in the saved baseline do not fail. |
| Did this committed branch introduce high findings? | `crimes verdict --base origin/main --fail-on new-high` | Findings shared with the base do not fail. |

These commands answer different questions. Usually one gate is enough.

### Mode A — Changed-files gate

```bash
# Working tree versus HEAD:
crimes scan --changed --fail-on high --format json
# Include commits since the selected base:
crimes scan --changed --base origin/main --fail-on high --format json
```

The threshold accepts `low`, `medium`, or `high`. Explicit `--files` and
`--related-to` selections can also use `--fail-on`.

Working sets narrow the reported findings after repository analysis. They
retain cross-file evidence and do not promise a cheaper scan. The gate checks
all visible eligible findings in that set, including old debt. Use a baseline
or committed-ref comparison when you mean *new findings only*.

### Mode B — Baseline gate

Review the findings you intend to accept, then save and commit a baseline:

```bash
crimes baseline save
git add .crimes/baseline.json
git commit -m "Record accepted crimes baseline"
```

On subsequent runs:

```bash
crimes baseline check --fail-on medium --format json
```

The default threshold is medium. New findings are matched by the emitted
opaque fingerprint; old baseline entries do not fail the gate. A missing or
malformed baseline is an error.

**Review upgrades before replacing a baseline.** Changed defaults, identities,
configuration or incomplete analysis can change what is reported. Preview
[pin migration](./pin-migration.md) when identities changed. Re-saving the
baseline accepts everything currently reported; do that only after reviewing
those decisions. It is not routine upgrade housekeeping.

### Mode C — Branch verdict

```bash
crimes verdict --base origin/main --format json
crimes verdict --base origin/main --fail-on new-high --format json
```

The first is advisory; the second gates on any new high finding. Both compare
the named base with committed `HEAD` by exporting refs into temporary trees.
Uncommitted edits are excluded. A ref compared with itself is unchanged;
a `main` push job comparing `HEAD` with `origin/main` is not a useful new-risk
gate. Use a PR base, or explicitly select the prior commit for a push check.

Prefer an explicit base. Auto-selection tries `origin/HEAD`, then
`origin/main`, `main`, `origin/master`, `master`. Thresholds are `new-high`,
`new-medium` (medium or high), and `worse` (the aggregate verdict).
The verdict uses ordinal severity weights, not measured defect probabilities.

For two explicit refs, use:

```bash
crimes diff main...HEAD --fail-on new-high --format json
```

This compares the two refs directly; it does not automatically select a
merge base because the syntax contains three dots.

## Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | Analysis succeeded without a selected threshold failing. |
| 1 | A configured gate failed; unexpected internal errors can also return 1 without a report. |
| 2 | Handled usage/environment error, such as an invalid path, flag, base or baseline. |

A successful or gate-failing JSON report is one document on stdout.
Diagnostics use stderr. Validate the document as well as the exit code.
Check coverage warnings and context analysis status before treating an empty
list as evidence. None of these gates replaces the project's behavior tests.

With `CI` set, setup prompts and automatic integration maintenance are
skipped. JSON invocations never prompt or refresh skills. Outside CI,
`--no-skill-update` suppresses integration notices and refreshes.

## GitHub Actions

Copy [the example workflow](../examples/github-actions/crimes.yml) into
`.github/workflows/crimes.yml`. It runs on pull requests, compares with the
actual PR target branch, installs an exact crimes version and fetches full
history. Update the pinned version deliberately after reviewing an upgrade.
If the project already declares crimes as a dependency, use its lockfile and
package-manager script instead of a separate global installation.

Shallow clones must contain both compared refs. Fetch the actual base before
analysis; a missing ref fails with exit 2. Python analysis also requires the
WASM files shipped in the npm package; do not copy only `dist/index.js`.

## Suppressions vs baselines

A baseline records accepted existing observations. A suppression records an
exception with a reason. Commit these decisions with the project.
Suppressions apply before gates; `--show-suppressed` changes display without
turning suppressed findings into gate failures.

Manual suppressions remain until removed. Feedback false-positive decisions
are pinned to a crimes minor: on a later minor they can resurface with
`previously_suppressed: true` and participate in gates. Review them with
`crimes feedback recheck`; do not renew them automatically.

Scan triage/baseline resurfacing is a separate mechanism.
`previously_triaged` and `previously_baselined` findings are advisory by default;
`--gate-resurfaced` opts them into the scan gate. `--show-triaged` also does
not make hidden dispositions fail; `--gate-needs-design` selectively opts in
that disposition. See [triage](./triage.md) and [feedback](./feedback.md).

Renames, changed identities and configuration can create apparent new/absent
pairs. Preserve fingerprints as opaque strings, retain the root and version
with stored reports, and investigate before re-pinning decisions.

[JSON contract](./json-schema.md) · [Agent workflow](./agent-usage.md) ·
[Suppressions](./suppressions.md) · [Configuration](./configuration.md)
