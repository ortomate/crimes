# Migrate existing decisions

`crimes migrate-pins` previews legacy fingerprint updates in
`.crimes/triage.json`, `.crimes/suppressions.json` and `.crimes/baseline.json`.
It scans the current repository, proposes matches, and writes nothing.

```bash
crimes migrate-pins --format json > /tmp/crimes-pin-plan.json
# Review the plan alongside the source decision files and current findings.
crimes migrate-pins --apply /tmp/crimes-pin-plan.json --format json
```

Run from the intended root, or pass it as a positional path. A proposal
matches the old detector, file and symbol; it retains an existing claim
and discriminator constraint. A unique candidate receives `to` automatically
for review. Remove `to` to leave that decision untouched. An ambiguous row
has no selection; set `to` only after inspecting the candidates' evidence.

| Status | Meaning |
| --- | --- |
| `unchanged` | The existing fingerprint still matches. |
| `candidate` | One identity candidate, not proof that the old rationale still applies. |
| `ambiguous` | Multiple candidates; no automatic selection. |
| `not_reported` | No matching finding now. The pin is retained, not marked fixed. |

Apply rescans and rejects destinations that no longer match, changes to the
source pin files since preview, and collisions with existing decisions.
Reasons, owners, dispositions, creation dates and feedback `crimes_version_pinned`
are preserved. Migration does not renew an expired decision. Writes replace
each selected JSON file atomically; the set of files is not a cross-file
transaction. Commit or back up decisions before applying a reviewed plan.

The report has `report_type: "pin_migration"`, `source_hashes`, and `entries`
with `source`, `from`, `status`, `candidates`, and optional `to`. Treat
fingerprints as opaque outside this migration tool. Do not edit them by
splitting strings in integration code.

Suppressed and triaged findings are included in the scan used for matching.
Disabled detectors, changed configuration, deleted files and incomplete
analysis can all explain absence. A stale entry alone does not prove its
subject is fixed. Use [feedback](./feedback.md) to reconsider the verdict.
