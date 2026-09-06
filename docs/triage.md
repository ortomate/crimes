# Record and revisit risk decisions

Triage records what the team intends to do about a finding, with a reason,
owner and date. It writes `.crimes/triage.json` and records feedback. Commit
these decisions so future contributors can see their context.

## Choose a disposition

| Disposition | Effect in an ordinary scan |
| --- | --- |
| `fix-now` | Remains visible. |
| `fix-this-PR` | Remains visible. |
| `needs-design` | Hidden until requested or resurfaced. |
| `wont-fix` | Hidden until requested or resurfaced. |
| `scaffolding` | Hidden until requested or resurfaced. |

A disposition is not proof that the detector was right or wrong. The
non-interactive `wont-fix` path records a known decision, not a false-positive
claim. Use [feedback](./feedback.md) to explicitly record a false positive.

## Interactive or agent workflow

In a terminal, `crimes triage` walks findings. `--all` includes non-domain
findings in the walk; `--owner` supplies a default owner.

For agents and scripts, inspect `crimes scan --format json`, copy the emitted
fingerprint and write a reviewed decision array:

```json
[
  {
    "fingerprint": "copied opaque fingerprint",
    "disposition": "needs-design",
    "reason": "The public API needs a coordinated migration before this can change.",
    "owner": "@api-team"
  }
]
```

```bash
crimes triage --apply decisions.json --format json
crimes triage --list --format json
```

`owner` defaults to empty and `date` to today when omitted. The input is an
array of decisions, not the full saved file or a scan report. Check the
fingerprint against the observation being discussed: applying a decision
file does not establish that its rationale is correct.

`--list`, `--apply`, `--clear` and `--retriage` are mutually exclusive.
JSON is available for list/apply/clear; the interactive walk uses human output.
See the [generated report types](./api-types.md#triagelistreport) for envelopes.

## Revisit a decision

```bash
crimes triage --retriage 'src/billing/**'
crimes triage --clear 'copied opaque fingerprint' --format json
crimes scan --show-triaged --format json
```

`--retriage` is interactive and accepts a fingerprint, file or glob.
`--clear` removes the selected entry; it does not delete the source code or
undo prior feedback records. `--show-triaged` displays hidden entries and
their recorded reason without automatically making them fail a gate.

Touched files can resurface old triage/baseline decisions according to
[`triage.resurfaceBase`](./configuration.md#triageresurfacebase-since-0110).
Those observations carry `previously_triaged` or `previously_baselined` and
are advisory unless `scan --gate-resurfaced` is selected. Feedback expiry
uses a separate `previously_suppressed` mechanism; see [CI rules](./ci.md).

For identities that no longer match, [preview pin migration](./pin-migration.md)
before re-recording anything. Reasons, ownership and expiry are decisions to
preserve, not metadata to reset on every CLI upgrade.
