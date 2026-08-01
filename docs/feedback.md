---
title: crimes feedback — the calibration loop
description: How to capture true/false-positive verdicts on crimes findings so each release gets better, and how the auto-resurface mechanism keeps the loop alive across minor bumps.
---

# `crimes feedback` — the calibration loop

The 0.7.0 release adds **one new command**: `crimes feedback`.

It exists so the experience of running crimes on a real codebase can
get *better* over time without depending on someone reading bug
reports and triaging tickets. Every verdict you record — `tp` (true
positive), `fp` (false positive), or `known` (acknowledged) — is
pinned to the crimes minor that produced the finding, and the
`fp`-flagged ones automatically resurface for re-confirmation when
the next minor ships. The trajectory those re-confirmations carve
out (`fp` → `tp` after a tuning change, or `fp` → `fp` again
because nothing helped) is the highest-value calibration data we
collect.

## TL;DR — the three commands you'll use

```bash
# See a finding you disagree with? Mark it false positive — one command, one note.
crimes feedback <fingerprint> --verdict fp --note 'Builder pattern — DSL chain'

# See a finding that mattered? Confirm it.
crimes feedback <fingerprint> --verdict tp --note 'Yep, real cycle I had been ignoring'

# Walk every resurfaced finding after a crimes minor bump.
crimes feedback recheck
```

Where `<fingerprint>` is the stable `<type>::<file>::<symbol>[::<discriminator>]` shape
already printed at the bottom of every finding in `crimes scan` /
`crimes context` human output:

```
     Give feedback: crimes feedback large_function::src/billing.ts::generateInvoice --verdict {tp|fp}
```

## Verdict semantics

| Verdict | Writes feedback entry | Writes suppression | Closes prior verdict |
|---------|-----------------------|--------------------|----------------------|
| `tp`    | yes                   | no                 | deletes any feedback-sourced suppression on the same fingerprint |
| `fp`    | yes (note required)   | yes (`source: "feedback"`, pinned to current minor) | upserts the suppression with the new reason |
| `known` | yes                   | no                 | no change to suppressions |

- `tp` — "true positive, the finding caught a real issue." If you'd
  previously marked it `fp`, the `tp` deletes the suppression so the
  finding is visible again. The transition is the calibration win
  ("we used to be wrong; now we're right").
- `fp` — "false positive, the detector got this wrong." Writes a
  feedback entry AND a suppression. The suppression is tagged
  `source: "feedback"` with `crimes_version_pinned: "<minor>"`. On
  every scan with that crimes minor the finding stays silent; on the
  first scan with a newer minor it resurfaces for re-confirmation.
- `known` — "I'm aware of this, leaving it for now." Records the
  judgment without silencing.

## Feedback from `crimes triage`

`crimes triage` records a verdict for every disposition automatically,
so you don't have to run `crimes feedback` a second time on findings
you've already judged. Triage is where the thinking happens; the
verdict is a byproduct of it.

| Triage disposition | Verdict recorded |
|--------------------|------------------|
| `fix-now`, `fix-this-PR`, `needs-design` | `tp` — you're committing to act, so you agree it's real |
| `scaffolding` | `known` — real pattern, intentional here |
| `wont-fix` | **asks you** — see below |

The triage `reason` carries across as the feedback note.

`wont-fix` is the one disposition that doesn't imply a verdict. It
conflates "crimes was wrong" with "crimes was right and we accept the
risk", and those are opposite calibration signals — the first should
retune a detector, the second must not. So interactive triage asks one
extra question:

```
  Was crimes wrong here? [y/N]:
```

`y` records `fp`; anything else records `known`. In the non-interactive
`--apply` path there's nobody to ask, so `wont-fix` takes the
conservative `known`.

**Triage-sourced feedback never writes a suppression**, including for
`fp`. A triage entry already hides the finding from default output;
adding a suppression on top would silence the same finding through two
mechanisms, and unpicking that later is worse than the duplication it
saves. If you want the resurface-on-next-minor behaviour, use
`crimes feedback <fingerprint> --verdict fp --note "…"` directly.

## The auto-resurface loop

A `crimes feedback ... --verdict fp` written under `crimes@0.7.x` is
silent for every `0.7.x` scan after it. When you upgrade to `0.8.x`
(or any newer minor), the finding **resurfaces**:

- The finding stays in the JSON `findings[]` and the human-format
  output rather than being dropped.
- It's tagged `previously_suppressed: true` with
  `previous_suppression: { pinned_version, reason }`.
- The first scan after the minor bump emits a one-line stderr
  breadcrumb:

  ```
  crimes: 5 feedback-sourced suppressions resurface because they
          were pinned to 0.7. Run `crimes feedback recheck` to review.
  ```

- The reporter prints an alternate hint per resurfaced finding:

  ```
       ⚠ Previously marked fp in 0.7. Re-confirm: crimes feedback <fp> --verdict {tp|fp}
       ↳ See `crimes feedback recheck` to walk all resurfaced findings.
  ```

`crimes feedback recheck` walks every resurfaced suppression and
prints the prior reason + the per-detector release-notes hint + the
exact re-feedback commands:

```
3 findings previously marked fp (resurface for crimes 0.8):

[1/3] direct_date — src/suppressions.test.ts
      Marked fp in 0.7: "Test-file injection — intentional"
      In 0.8: direct_date now skips test files. Likely resolved if your fp was on a test file.
        Re-confirm fp: crimes feedback direct_date::src/suppressions.test.ts:: --verdict fp --note '<reason>'
        Mark resolved: crimes feedback direct_date::src/suppressions.test.ts:: --verdict tp
```

The per-detector release-notes hints are baked into the binary so
they always match the version that produced them; see the
`RELEASE_NOTES` map in `packages/core/src/feedback/release-notes.ts`.

### Re-feedback on a resurfaced finding

- `--verdict fp` — rewrites the suppression's `crimes_version_pinned`
  to the current minor and appends a feedback entry with
  `resurfaced_from: "<previous-minor>"`. The finding is silent again
  for one more release.
- `--verdict tp` — deletes the suppression entirely and appends a
  feedback entry with `resurfaced_from` set. The finding will
  surface normally on every future scan.
- `--verdict known` — keeps the suppression but doesn't bump its
  pinned version; it'll resurface again next minor.

### Why minor-version granularity (not patch)

Patch releases (0.7.0 → 0.7.1) are bug fixes — detector behaviour
shouldn't change meaningfully. Resurfacing on every patch would be
annoying without signal. Minor releases (0.7.0 → 0.8.0) are where
detector tuning lives, so resurfacing aligns with the "did the new
tuning fix this?" question.

## Reading what you've recorded

```bash
# Latest verdict per fingerprint, sorted newest first.
crimes feedback list

# Just the fp's (current verdict).
crimes feedback list --verdict fp

# Last 30 days only.
crimes feedback list --since 30d

# JSON for piping into other tools.
crimes feedback list --format json
```

```bash
# Quick-read aggregate: counts by verdict / detector / version.
crimes feedback summary
```

## Cross-project rollup

Run crimes on N projects? Each project's `.crimes/feedback.jsonl` is
local. Push entries into one machine-wide rollup at
`~/.crimes/feedback-rollup.jsonl` with:

```bash
cd ~/dev/project-a && crimes feedback export --append-global
cd ~/dev/project-b && crimes feedback export --append-global
# ...

# Now query across all projects:
crimes feedback summary --global
crimes feedback list --global --verdict fp
```

`--append-global` deduplicates by `(repo, timestamp, fingerprint)`,
so re-running it is safe and a no-op for entries already present.

## Other shapes

```bash
# Pipe-friendly raw JSONL of every entry in the local file.
crimes feedback export

# Markdown report grouped by detector — paste-into-notes-friendly.
crimes feedback export --format md
```

## Where the data lives

- **Per-repo:** `.crimes/feedback.jsonl` — committed, reviewed in PRs
  alongside `.crimes/baseline.json` and `.crimes/suppressions.json`.
- **Global rollup:** `~/.crimes/feedback-rollup.jsonl` — per-machine,
  not committed anywhere. Set `CRIMES_HOME` to override the home
  directory (useful for sandboxed test setups).

Both files are JSON-Lines (one entry per line). Append-only —
re-feedback on the same fingerprint appends a new line; read paths
walk backwards from EOF for the current verdict. The history is
preserved deliberately so "how did my judgment evolve?" is
inspectable.

## See also

- [`docs/suppressions.md`](./suppressions.md) for the underlying
  suppression mechanism the `fp` verdict feeds.
- [`docs/json-schema.md`](./json-schema.md#feedbackreport) for the
  `FeedbackReport` JSON shape emitted by `crimes feedback {list,
  summary, export, recheck} --format json`.
