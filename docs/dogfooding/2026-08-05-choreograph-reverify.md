# Step 0: re-verifying the choreograph field notes against `main`

**Date:** 2026-08-05
**Companion to:** [`2026-08-05-choreograph-field-notes.md`](./2026-08-05-choreograph-field-notes.md)
**Purpose:** the field notes were written against `npx crimes@latest`, which
resolves to the **published** version. `main` carries five unreleased
eval-baseline bumps (`0.18.0`–`0.18.4`). Before scoping any work off those
notes, we had to know which complaints still reproduce.

**A fix shipped against a stale complaint is worse than no fix, because it
looks like progress.** This document is what stopped that from happening —
and it also stopped one hypothesis in the release plan from being acted on.

---

## Method

The repo under test is available locally. The field notes describe a task that
*began* at `choreograph.cc@5107cce` ("feat(artist): cap family presence",
2026-08-04) — the last commit before the cost-tracking work the notes
accompany. That snapshot was checked out into a dedicated git worktree so
churn and blame resolve against real history:

```bash
git -C ~/dev/choreograph.cc worktree add <scratch>/choreo-0805 5107cce
```

Both builds were then run against that identical tree:

| build | how |
|---|---|
| `0.17.0` (published) | `npm i crimes@0.17.0 --ignore-scripts` into a temp dir |
| `main` (`0.18.4`) | `pnpm run build` in this repo, run from `dist/index.js` |

`scan --format json` in both cases, no config, no flags.

---

## Result 1: the notes were written against `0.17.0`, not `0.18.x`

The notes' `**Version:** crimes@latest via npx (0.18.x era)` line is the
reporter's assumption. It is wrong, and the numbers prove it:

| | total | high | medium | low | `schema_version` |
|---|---|---|---|---|---|
| **notes as written** | 499 | 34 | 269 | 196 | — |
| **`0.17.0` on `5107cce`** | **498** | **34** | **268** | **196** | 0.4.0 |
| **`main` on `5107cce`** | 491 | 35 | 265 | 191 | 0.6.0 |

`0.17.0` reproduces the notes to within **one medium finding** — consistent
with the reporter scanning a working tree carrying an uncommitted edit.
`main` does not reproduce them. The published version is what was measured.

## Result 2: `0.18.x` moved this repo by −1.4%, and the release plan's
## hypothesis about why was wrong

The plan (`.planning/PROMPT-0.19-to-0.22-releases.md`) reasoned:

> `commented_out_code` alone dropped airflow from 8,019 findings to 45 in
> 0.18.1, and `parallel_destination` is now gated off. **The 499 may already
> be substantially smaller.**

**It is not.** 498 → 491, a −7 delta on 498. Both named mechanisms are
inapplicable here:

- `commented_out_code` fires **2 times** on this repo in both builds. The
  airflow drop was a fix to a detector that was misfiring on a *specific
  shape* — huge commented-out blocks — that choreograph does not contain.
- `parallel_destination` produces **zero** findings here in either build, so
  gating it off changed nothing.

**Where the plan's entry was wrong:** it generalised a corpus-wide headline
(airflow −8,000) to a repo whose profile never included that shape. A
detector fix that removes 99% of findings on one repo can remove 0% on
another; the corpus median is not a prediction for any individual repo.
Volume complaints have to be re-measured on the complaining repo.

### Full per-detector delta, `0.17.0` → `main`

| detector | 0.17.0 | main | Δ |
|---|---|---|---|
| `large_function` | 105 | 104 | −1 |
| `direct_date` | 94 | 91 | −3 |
| `swallowed_error` | 48 | 48 | 0 |
| `high_fan_in_fan_out` | 37 | 36 | −1 |
| `large_file` | 32 | 33 | +1 |
| `orphaned_destination` | 27 | 27 | 0 |
| `boolean_naming_drift` | 21 | 21 | 0 |
| `name_behavior_mismatch` | 19 | 19 | 0 |
| `contract_drift` | 17 | 17 | 0 |
| `duplicated_policy` | 16 | 14 | −2 |
| `sync_io_in_hotpath` | 13 | 11 | −2 |
| `logic_in_comments` | 10 | 10 | 0 |
| `magic_domain_literal_scatter` | 10 | 10 | 0 |
| `duplicated_role_status_plan_check` | 9 | 9 | 0 |
| `config_drift` | 8 | 8 | 0 |
| `unsafe_retry` | 8 | 8 | 0 |
| `exact_duplicate_block` | 7 | 7 | 0 |
| `hardcoded_localhost` | 5 | 6 | +1 |
| `oversized_raster` | 4 | 4 | 0 |
| `commented_out_code` | 2 | 2 | 0 |
| `accessible_interaction_risk` | 2 | 2 | 0 |
| others (7 types, 1 each) | 7 | 7 | 0 |

**Every one of the six charges named in the field notes is within 3 of where
it was.** Nothing in the unreleased work addressed any of them.

---

## Result 3: complaint-by-complaint status

| # | complaint | status vs `main` | evidence |
|---|---|---|---|
| 1 | "499 findings is demoralising" | **stands** | 491. −1.4%. |
| 2 | `scripts/` is a third of findings | **stands** | 157 → **148**; still 30% of the total |
| 3 | `logic_in_comments` worst FP rate | **stands** | 10 → 10, **the same files**: `types.ts` L239, `job-processor.ts` ×2, `game-generator/generate.ts`, `api/admin/jobs/route.ts` |
| 4 | `direct_date` conflates read/record | **stands** | `JobDetail.tsx` evidence string is byte-identical: `"9× Date.now(), 4× new Date()"` |
| 5 | `high_fan_in_fan_out` on a types module | **stands** | `src/lib/types.ts` — **33 importers**, unchanged |
| 6 | `name_behavior_mismatch` on data access | **stands** | `src/lib/api.ts` — **5 hits**, all `side-effect-like calls: createClient` |
| 7 | no way to scope to a plan | **stands** | `crimes context <file>` takes exactly one positional arg |
| 8 | output ordering loses the header | **stands** | `scan --top 15` emits **296 lines**; the summary is line 6 |
| 9 | agent discoverability | **stands** | the `--help` tips block names `init --agents` and `context <file>` and **still does not mention `--changed`** |

**Nothing comes out of the plan.** All nine reproduce.

---

## Result 4: a nuance that changes R2's framing

The plan opens R2 with:

> **`--changed --base main` is the answer, and it was not reached for.**

Measured on the same worktree:

```
scan --changed --base HEAD~1   →  11 findings across 7 files (3 high, 4 medium, 4 low)
scan --changed                 →  clean tree: nothing
```

`--changed` works, and works well — 491 → 11 is exactly the compression the
complaint asks for. **But it only works after the edits exist.** The field
notes describe crimes being used *mid-design, to scope cleanup before writing
code*: at that moment the tree is clean and sitting on `main`, so
`--changed --base main` returns **zero findings**. The single most valuable
invocation is unavailable in the exact workflow the notes describe.

So R2's five items are not equally weighted by this evidence:

- **R2.1 (document `--changed --base main` as the default)** is right for the
  *review* half of an agent loop — after edits, before commit. It does not
  serve the *scoping* half, and documenting it as "the" agent default would
  send an agent in choreograph's position to a command that prints nothing.
  Document it as the **post-edit** default, paired with the scoping command
  below.
- **R2.2 (`context --files a,b,c` / `scan --related-to X`)** is the answer to
  what the notes actually did. The notes already call it "the single part of
  the task most worth automating"; this measurement is why it should be the
  *lead* item of R2 rather than the second.

**Where the plan's entry was wrong:** it treated `--changed` as the fix for a
complaint that arose *before there was anything changed to scan*. The
discoverability problem is real; the command it points at is the wrong one
for that half of the loop.

---

## Addendum: two of the five concrete asks were already shipped

Found while scoping R2, by checking what existed before adding
anything. Recorded here because both were about to be built twice.

### Ask 2 — "`scaffolding` globs in `crimes.config.json`, applied at scan time"

**This ships today, on by default, and `scripts/**` is literally the
first entry.**

```ts
// packages/core/src/config.ts
export const DEFAULT_NON_DOMAIN_PATTERNS: string[] = [
  "scripts/**",
  "examples/**",
  ...
];
```

Measured on the same choreograph snapshot: **all 148** `scripts/`
findings already carry `tier: "nonDomain"`. They are already excluded
from the top-file ranking, already confidence-damped, and already
collapsed into a single `Also flagged elsewhere · scripts/ 144
findings` line. The config knob the notes asked for is
`scopeTiers.nonDomain`, and it is user-overridable per repo.

**So what was actually wrong is narrower, and worse.** The header
counted findings the report then declined to show:

| | header said | body listed |
|---|---|---|
| findings | 491 | **339** |
| files | 208 | **137** |
| high | 35 | **22** |

A third of the demoralising number was findings crimes had already
decided were not the point. **The headline was describing a superset of
itself.** Fixed by making the summary line count what the report shows
and state the remainder (`+152 in non-domain paths`); `summary.total` in
the JSON is untouched, because the renderer is a view and the JSON is
the contract.

**Where the notes were wrong:** the mechanism existed and was working.
The complaint was real, and its cause was in the renderer, not in
missing configuration. Adding a `scaffolding` glob would have been a
second way to say what `scopeTiers.nonDomain` already says — the "don't
invent a third location" rule in `CLAUDE.md`, applied to scope classes.

### Ask 4 — "exempt type-only modules from fan-in"

Not shipped, but the rule as proposed would not have worked. See
[`2026-08-05-r3-premeasurements.md`](./2026-08-05-r3-premeasurements.md):
`src/lib/types.ts` exports 24 types and one constant, so an
exports-are-type-only test fails on the file that prompted the ask.

---

## What Step 0 cost, and what it bought

One hour. It bought:

- confirmation that all four R3 precision complaints are live (they are, and
  the plan had already verified this independently — this is a second,
  stronger confirmation with byte-identical evidence strings);
- **deletion of the plan's hypothesis** that the volume complaint might have
  self-resolved — it did not, and R2's scaffolding/working-set work is fully
  justified;
- **a re-ordering of R2** on evidence rather than on the notes' own
  ordering.
