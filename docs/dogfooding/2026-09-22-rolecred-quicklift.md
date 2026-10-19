# Field notes: crimes on rolecred (QuickLift)

**Date:** 2026-09-22
**Version under test:** `crimes` **0.28.1** (global npm install)
**Repo under test:** rolecred: career product, TypeScript/React, QuickLift feature work
**Reporter:** the implementing agent in that repo, relayed by the user
**Task shape:** ongoing feature development — context reports plus before/after
scans across a multi-file change, not a one-shot audit

> **Disposition (0.29.1, same day):** the three confirmed items are fixed
> under the continuous-improvement patch bump — prefix word boundary and a
> React-component exclusion in `name_behavior_mismatch`, `argKind` honoured
> in `direct_date`, and a `data` shape for `large_file`. Ranking is
> unchanged at NDCG 0.4770 / 0.3895 deep. The two re-verify items are
> still open and still need a 0.29.0 re-run in the reporting repo.

> **Triage status:** each complaint below was checked against `main` at
> 0.29.0 on the day it arrived. Three reproduce in current source and are
> cited to the line. Two map to 0.29.0 advice changes the reporter had not
> yet run and need re-verification rather than a fix.

## What worked

Recorded first because a round that only collects complaints produces a
skewed picture of the tool.

- Dependency context and blast radius were the reason the tool stayed in
  the loop — "particularly useful for understanding dependencies and
  keeping changes manageable".
- Before/after scans over stable fingerprints did the job they exist for:
  the last scoped change was summarised as "two low-level dependency
  warnings and no new medium/high findings". That is the diff contract
  working as designed.
- Findings drove real edits: growing generation/checkout routines were
  split into smaller helpers, and shared code was flagged for regression
  checks.

## Coverage statement, not a defect

The production bug that mattered on this project — a database permission
error — surfaced in a live walkthrough, not in crimes. It was in SQL,
outside analysed languages. Recorded here as a positive statement about
the boundary: there is no SQL pack, so no claim was made and none was
missed. It belongs in the "an empty report is not a safety verdict"
column, not in the miss column.

## Friction log

### `name_behavior_mismatch` matches a prefix without a word boundary
- **repo:** rolecred
- **what happened:** `ReadinessForm` was treated as a pure `read` function,
  and its React state updates were then read as suspicious side effects.
- **reproduces at 0.29.0:** yes.
  `packages/core/src/detectors/name-behavior-mismatch.ts:113` is
  `lower === prefix || lower.startsWith(prefix)`. `readinessform`
  starts with `read`, so the prefix test passes on a word that is not
  the prefix. `render` is also in `PURE_PREFIXES`, and the `ASSIGNMENT`
  regex counts `=` occurrences, so a component whose body sets state
  scores as a mutating body.
- **why it matters:** this is the compounding shape — a wrong name
  classification is what makes the body evidence look damning. Two
  independent errors are needed to produce the finding, and the first
  one is a missing `[A-Z_]` boundary check.
- **severity:** real problem

### `direct_date` does not distinguish parsing a timestamp from reading the clock
- **repo:** rolecred
- **what happened:** `new Date(evidence.submitted_at)` was reported as a
  system-clock dependency. It formats a timestamp that already exists.
- **reproduces at 0.29.0:** yes, and the data needed to fix it is already
  parsed. `packages/language-js/src/parse/dates.ts:217` classifies the
  argument as `none` / `string-literal` / `number` / `expression`, and
  `DateUse.argKind` is documented as feeding `timezone_unsafe_parse`.
  `packages/core/src/detectors/direct-date.ts` never reads `argKind`: it
  takes every hit in `ctx.parsed.dateNowOrNewDateUses`, so
  `new Date(x)` counts toward the same `newCount` as `new Date()`.
- **why it matters:** the detector's own claim is `clock_read`.
  `new Date(someTimestamp)` does not read the clock, so the finding
  asserts something untrue rather than something debatable. A reporter
  who checks one such finding and finds it wrong discounts the rest.
- **severity:** real problem

### `large_file` gives generated artefacts production-code severity
- **repo:** rolecred
- **what happened:** large generated audit JSON files became high-severity
  findings and crowded out runtime changes.
- **reproduces at 0.29.0:** yes. `packages/core/src/detectors/large-file.ts:6`
  has exactly three shapes — `domain`, `test_file`, `docs` — and anything
  that is not a docs extension or a test file takes domain thresholds and
  domain severity. `looksGeneratedSource`
  (`packages/core/src/util/scope-class.ts:164`) exists and is exported,
  but no detector applies it; the `classifyScope` consumers are
  `unsafe-retry`, `unbounded-async-fanout`, `swallowed-error` and
  `dependency-provenance-gap`.
- **why it matters:** 0.17.0 added the `docs` shape for exactly this
  complaint shape in prose. Generated data is the same argument and did
  not get the same treatment. The cost is not one wrong finding, it is
  the ranking: a generated artefact outranks the runtime change the
  developer came to review.
- **severity:** real problem

### Limit comparison read intentional variants as conflicting policy
- **repo:** rolecred
- **what happened:** a 20,000-character document limit and a 2,400-character
  excerpt limit were reported as conflicting policies. Both are intentional
  and serve different purposes. Separately, "role" in a career product was
  interpreted as an authorisation concept.
- **reproduces at 0.29.0:** unknown — **re-verify before acting**. The
  0.29.0 notes record that literal-scatter advice now "preserves
  intentional policy variants and keeps consolidation within the requested
  task", which is this complaint, and the reporter was a version behind.
  The "role" half is not covered by that change:
  `duplicated_role_status_plan_check` is literal-driven and its worked
  examples are `admin` / `active` / `pro`, so which detector fired here
  cannot be settled without the fingerprint.
- **why it matters:** if 0.29.0 fixed the limits half and not the "role"
  half, they are two separate items and only one is closed.
- **severity:** annoyance, pending re-verification

### Split advice on a shared schema undercuts the contract it protects
- **repo:** rolecred
- **what happened:** identifying a schema's 15 importers was called useful;
  automatically recommending that it be split was not, because one
  authoritative contract is the point of the file.
- **reproduces at 0.29.0:** unknown — **re-verify before acting**. The
  0.29.0 notes record that connectivity advice now "distinguishes importers
  from dependencies and preserves useful regression tests", which is
  plausibly this exact case, on a version the reporter had not run.
- **why it matters:** the reporter drew the right distinction unprompted —
  the *evidence* (15 importers) is the valuable part and the *recommendation*
  is what damaged trust. That split is worth preserving in how connectivity
  findings are worded generally.
- **severity:** annoyance, pending re-verification

## The reporter's summary, recorded verbatim

> the evidence, dependency context and change comparisons are valuable;
> improving semantic precision would make the recommendations much more
> trustworthy.

## Recommended disposition

Costs as required by the round protocol. The first three landed in
0.29.1 on the day the notes were written; the last two are unchanged:

| Item | Cost |
| --- | --- |
| `name_behavior_mismatch` word boundary | done in 0.29.1 |
| `direct_date` honours `argKind` | done in 0.29.1 |
| `large_file` data shape | done in 0.29.1 (`thresholds.largeFile.data`) |
| Limits / "role" | re-run on 0.29.0 first; fingerprint needed |
| Shared-schema split advice | re-run on 0.29.0 first |

The first three share a theme the reporter named better than this repo has:
the findings are **lexically** triggered and **semantically** wrong. Each
one is a missing distinction that the parser or a helper already computes
(`argKind`, `looksGeneratedSource`) or could compute cheaply (a word
boundary). None requires new analysis machinery.
