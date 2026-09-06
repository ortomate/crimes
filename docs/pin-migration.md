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
are preserved. Migration does not renew an expired decision. All replacements
are staged before the first pin file changes. A recovery journal retains the
original bytes; ordinary write failures restore them automatically. Each file
replacement is atomic, but another process can observe the interval between
replacements. Stop concurrent pin writers and retain a commit before applying.

## Recover an interrupted migration

If the process stops during replacement, the next preview/apply reports the
pending journal and supplies the recovery command. Stop any other migration
process before running it from the same repository root:

```bash
crimes migrate-pins --recover --format json
```

Recovery checks **every** affected pin file against the original or migrated
bytes before restoring any of them. If a file has a later edit, recovery
refuses and retains `.crimes/.pin-migration/journal.json` for manual
reconciliation. Preserve that later edit; do not discard the journal or
replace the baseline to hide the conflict. A failure during recovery retains
the journal, so recovery can be retried after resolving the storage problem.

Recovery does not need a working scan or valid crimes configuration. Success
returns `report_type: "pin_migration_recovery"` and `restored_files`; then
generate and review a fresh plan. `--apply` and `--recover` are mutually
exclusive. If interruption happened before a complete journal was written,
the command explains that no pin replacement starts before `journal.json`
exists; inspect the incomplete directory before removing it. This is process
interruption recovery, not a guarantee against filesystem or power failure.

The report has `report_type: "pin_migration"`, `source_hashes`, and `entries`
with `source`, `from`, `status`, `candidates`, and optional `to`. Treat
fingerprints as opaque outside this migration tool. Do not edit them by
splitting strings in integration code.

Suppressed and triaged findings are included in the scan used for matching.
Disabled detectors, changed configuration, deleted files and incomplete
analysis can all explain absence. A stale entry alone does not prove its
subject is fixed. Use [feedback](./feedback.md) to reconsider the verdict.
