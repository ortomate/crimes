# Suppressions

`.crimes/suppressions.json` carries per-finding exceptions the team
has deliberately decided to live with. Suppressed findings are
filtered out of every report by default; the gate (`--fail-on`) never
trips on them. The file is intended to be **committed** and reviewed
in PRs — every entry requires a `reason`.

## When to use a suppression vs the alternatives

| Situation | Right answer |
| --------- | ------------ |
| A specific finding is acceptable in this one place. | `crimes ignore <fingerprint> --reason "…"` |
| A particular value is fine for *one* detector across the whole repo. | `detectors.options.<id>` in [`configuration.md`](./configuration.md#detectorsoptions). |
| You're migrating to `crimes` and don't want to fix everything first. | `crimes baseline save` — see [`ci.md`](./ci.md). |
| A detector fundamentally doesn't fit the repo. | `detectors.disable` in [`configuration.md`](./configuration.md). |
| A threshold is wrong for the repo. | `thresholds.*` in [`configuration.md`](./configuration.md). |
| You want to silence the entire codebase. | Don't. Choose one of the above. |

## Suppress one finding

```bash
crimes explain large_function::src/billing.ts::generateInvoice
# → reads the rationale, decides this is acceptable

crimes ignore large_function::src/billing.ts::generateInvoice \
  --reason "Legacy billing module — rewrite tracked in #1234."
```

Or starting from a per-scan id:

```bash
crimes scan -f json > scan.json
# → spot crime_00005 in the output
crimes ignore crime_00005 --reason "…"
```

`crimes ignore` always persists by **fingerprint**, never by id. Ids
are reassigned every scan; the fingerprint
(`<type>::<file>::<symbol>[::<discriminator>]`) is stable across scans.

The trailing `discriminator` segment appears only on findings from
detectors that can report several results for one file — today
`magic_domain_literal_scatter`, `exact_duplicate_block`, and
`near_duplicate_block`. It was added in `schema_version: "0.4.0"`
because without it those findings shared a fingerprint, so suppressing
one of them silently suppressed the others as well. **Entries for those
three types written before `0.4.0` stop matching and need re-recording**
with a fresh `crimes ignore` — which is the point: the new entry names
the single finding you actually looked at. Every other type is
unaffected and its fingerprints are byte-identical to before.

`--reason` is required and non-empty. The CLI refuses to write
without one.

### Other flags

- `--file <path>` — override `.crimes/suppressions.json`.
- `--dry-run` — print the entry that would be written and exit.
- `--no-verify` — skip the fresh scan that confirms the fingerprint
  matches a real finding. Useful for pre-emptively suppressing a
  finding the detector hasn't seen yet (rare).

## File shape

```json
{
  "schema_version": "0.1.0",
  "report_type": "suppressions",
  "created_at": "2026-05-17T11:30:00.000Z",
  "updated_at": "2026-05-17T11:30:00.000Z",
  "crimes_version": "0.5.0",
  "suppressions": [
    {
      "fingerprint": "large_function::src/billing.ts::generateInvoice",
      "type": "large_function",
      "file": "src/billing.ts",
      "symbol": "generateInvoice",
      "reason": "Legacy billing module — rewrite tracked in #1234.",
      "created_at": "2026-05-17T11:30:00.000Z",
      "created_by": "andrew@example.com"
    }
  ]
}
```

See [`json-schema.md`](./json-schema.md#suppressions-on-disk-shape-of-crimessuppressionsjson)
for the field-by-field reference.

`created_by` is filled in from `git config user.email` when available;
omit it if your repo doesn't carry one. The denormalised `type` /
`file` / `symbol` fields are redundant for matching (only
`fingerprint` drives it) but are load-bearing for human review — a
reviewer scanning `git diff .crimes/suppressions.json` can read the
entry without parsing the fingerprint.

### Feedback-sourced suppressions (0.7.0)

`crimes feedback ... --verdict fp` writes the same suppression file,
but with two extra fields:

```json
{
  "fingerprint": "direct_date::src/suppressions.test.ts::",
  "type": "direct_date",
  "file": "src/suppressions.test.ts",
  "reason": "Test-file injection — intentional",
  "created_at": "2026-05-20T12:00:00.000Z",
  "source": "feedback",
  "crimes_version_pinned": "0.7"
}
```

- `source: "manual"` (the default when absent) — the long-standing
  `crimes ignore` path. These suppressions stay silent forever.
- `source: "feedback"` — managed by `crimes feedback`. These
  **auto-resurface** when the crimes minor moves past
  `crimes_version_pinned`. The next scan on a newer minor keeps the
  finding in `findings[]` tagged `previously_suppressed: true`, the
  human reporter prints a "⚠ Previously marked fp in 0.7" hint per
  finding, and a one-line stderr breadcrumb tells you to run
  `crimes feedback recheck`.

The mechanism is what keeps the calibration loop alive across
releases — see [`feedback.md`](./feedback.md#the-auto-resurface-loop)
for the full lifecycle.

## Removing a suppression

```bash
crimes unignore large_function::src/billing.ts::generateInvoice
# → "Removed … from .crimes/suppressions.json. Commit the change …"
```

`crimes unignore` is symmetric to `crimes ignore`:

- Takes a stable fingerprint (no id support — once suppressed, there
  is no per-scan id to look up).
- `--dry-run` previews without writing.
- `--file <path>` honours the same override as `crimes ignore`.
- Exits `2` on an unknown fingerprint, with a pointer at
  `crimes audit-suppressions`.

The file is **never deleted** — an empty `suppressions: []` array
stays so reviewers can see the file exists and has been intentionally
cleared. Delete it by hand if you truly want it gone.

## Auditing suppressions

```bash
crimes audit-suppressions
crimes audit-suppressions --format json
```

Lists every entry sorted oldest first, with `age_days` and a per-entry
`concerns` array. Entries are flagged when:

- **`stale`** — older than 180 days.
- **`short_reason`** — `reason.trim().length < 16`.
- **`vague_reason`** — the reason reads as a deferral keyword (`tmp`,
  `todo`, `wip`, `fixme`, `noisy`, `legacy`, `later`, `skip`,
  `ignore`, `too noisy`, `we know …`).

The human report groups entries into "Flagged" and "Active". The JSON
output carries the same data under `report_type:
"audit_suppressions"` — agents can re-sort or filter without
re-running heuristics.

Run it as part of a quarterly suppression review, or wire it into a
nightly CI job that watches the count and reasons.

## Reviewing suppressions

The file is intended to be **committed**. Reviewers should:

1. **Read the reason.** "TODO" or "too noisy" usually means the
   suppression is wrong — either fix the code or tune the detector.
   `crimes audit-suppressions` surfaces these automatically.
2. **Verify the fingerprint maps to a real, ongoing exception.** The
   denormalised `file` / `symbol` are there for this — you should
   recognise what is being suppressed without grepping the codebase.
3. **Check the count and the ages.** A growing
   `.crimes/suppressions.json` is a smell. `crimes audit-suppressions`
   or `git log -p .crimes/suppressions.json` shows the trend.

`crimes scan` prints `N findings suppressed; run with
--show-suppressed to see.` when ≥1 entry matched. Use
`--show-suppressed` to re-surface them annotated.

## Suppressions and CI gates

Suppressions are applied **before** every `--fail-on` evaluation. A
suppressed finding never trips:

- `crimes scan --changed --fail-on <severity>`
- `crimes baseline check --fail-on <severity>`
- `crimes diff --fail-on new-high | new-medium`
- `crimes verdict --fail-on worse | new-high | new-medium`

The gate semantics are independent of `--show-suppressed`: an entry
that surfaces in the output as annotated is still excluded from the
threshold check.

## Suppressions vs baselines

| `.crimes/baseline.json` | `.crimes/suppressions.json` |
| ----------------------- | --------------------------- |
| Repo-wide snapshot of pre-existing findings. | Per-finding deliberate exception with a reason. |
| Forward-only — new findings are blocked. | Permanent — entries persist until you delete them. |
| Written by `crimes baseline save`. | Written by `crimes ignore`; removed by `crimes unignore`; reviewed by `crimes audit-suppressions`. |
| Read by `crimes baseline check`. | Read by every report-producing command. |
| Use when adopting `crimes` for the first time. | Use when one specific finding is acceptable. |

Most teams want both: `baseline` to ignore legacy debt, `suppressions`
to document the specific findings the team has triaged.

## Anti-patterns

- **"Too noisy" as the reason.** If your reason is "too noisy", the
  suppression is probably wrong. Tune the detector via config (per-shape
  thresholds, disable on a research repo) or fix the code.
- **Whole-codebase suppressions.** There is no glob support on purpose
  — the on-disk-as-review-artefact discipline only works when every
  entry maps to one specific finding.
- **Stale suppressions.** Renaming a file changes the fingerprint and
  silently breaks the suppression. That is a feature, not a bug — the
  renamed file deserves a fresh review.
