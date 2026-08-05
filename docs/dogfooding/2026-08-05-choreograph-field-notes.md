# Field notes: crimes on choreograph.cc

**Date:** 2026-08-05
**Version:** `crimes@latest` via `npx` (0.18.x era)
**Repo under test:** choreograph.cc — Next.js 16 App Router, TypeScript strict, ~209 files, personal daily-art pipeline
**Reporter:** Claude Opus 5, acting as the implementing developer
**Task shape:** one-shot design + planning task, NOT an ongoing hygiene loop

## How it was used

The user asked for a feature (per-post cost tracking + an admin costs report)
and said "let's run crimes and do any relevant cleanup as we go". So crimes
was used **mid-design, to scope cleanup for a refactor touching ~19 files** —
deciding what to fix alongside the feature and what to explicitly leave.

Commands actually run: `scan --top 15`, `scan --top 3`, `context <file>`,
`--help`, `scan --help`. Not run: `triage`, `baseline`, `verdict`, `diff`,
`hotspots`, `explain`, `feedback`, `ignore`.

Headline result: **499 findings across 209 files — 34 high, 269 medium,
196 low.** Six were acted on.

## What genuinely worked

### The top-file ranking was accurate

`daily-agents.ts` and `JobDetail.tsx` came back as the two worst files, and
they were independently the two files the task touched most. That is not a
result a plain linter produces — the risk scoring (churn × blast radius ×
test gap) did real work.

### `Exact Duplicate Block` found the flagship finding

It caught `repairJsonControlChars` cloned across `creative-pass.ts` and
`daily-agents.ts`. That clone was **deliberate** — the source carries a
comment reading "Lifted from creative-pass.ts; duplicated on purpose to
avoid refactoring a piece of critical working code as part of this PR."

crimes found the thing a human had consciously deferred, and produced the
evidence to reopen the decision. The user's response on seeing it was to
say the note could be deleted and the duplication removed. **This single
finding justified the run.**

### `Environment Roulette` led to a latent bug

It flagged scattered `*_MODEL` env reads (`GAME_PITCH_MODEL`, 2 reads across
2 files). Centralising them surfaced that `game_pitch` skips `CREATIVE_MODEL`
while every sibling agent honours it — a real inconsistency nobody had
noticed, now preserved deliberately with a comment.

The finding did not state the bug. It pointed at the rock the bug was under.
That is the right level of ambition for a static tool.

### `Double Jeopardy` is a novel category

"retry construct: attempt loop … retried mutation — fetch at line 71
(HTTP POST)" is a genuinely useful thing to name, and not something other
tools in this space surface.

### `crimes context` is well-designed for agents

The line

> Likely tests: (no test file matched the target basename …)

communicated in one shot that the repo had **zero tests**, which reshaped
the entire implementation plan (a test framework became stage 1 of 5).
That fact would otherwise have taken several greps to establish.

"Agent guidance", "Related files", and the churn clues are the right things
to surface. Stable `id=crime_00001` plus the
`explain`/`feedback`/`triage`/`baseline`/`verdict` command set is a coherent
loop design.

### The charge names are memorable

God Function, Catch and Release, Logic in the Alibi, Policy Doppelgänger,
False Identity, Temporal Recklessness. Findings could be discussed with the
user without re-explaining them. This is worth more than it looks.

## Where it cost time

### The headline number is demoralising and not actionable

"499 findings across 209 files" on a working, shipping project reads as
*your codebase is a crime scene* when the codebase is in fact fine. A
conscious decision was needed to ignore 493 of them, and that scoping had
to be justified to the user.

For an agent specifically, a large number invites one of two failure modes:
over-fixing (scope explosion into unrelated files) or dismissing the tool
wholesale. **`--changed --base main` is the answer, and it was not reached
for** — bare `scan` is the obvious invocation and the flag only appears in
`--help`.

### `scripts/ 157 findings`

Roughly a third of all findings live in `scripts/` — one-off `_check-*.ts`
diagnostics and backfill utilities that are quick and dirty *by design*.

`triage` offers a `scaffolding` disposition, but that is per-finding and
after the fact. What was wanted was a `scaffolding: ["scripts/**"]` glob in
`crimes.config.json`, applied at scan time, so those findings never enter
the count.

### `Logic in the Alibi` had the worst false-positive rate

Representative hit, from `src/lib/types.ts`:

> "Panorama — 360° equirectangular bonus piece (day % 3 == 2; never required
> for publish). Authored by the Curator…"
> — rule terms: never, required

That is **documentation of a deliberate design decision** — precisely what
you want in a codebase. The rule appears to key on modal words
(must / always / never / required / before) without distinguishing:

- "this comment asserts a rule the code does not enforce" (actionable), from
- "this comment explains why the code is the way it is" (a virtue)

This repo documents its reasoning unusually well — it has a detailed
CLAUDE.md and inline rationale comments throughout — and the rule
systematically punishes that. It fired on `types.ts`, `job-processor.ts`
(twice), `game-generator/generate.ts`, and `api/admin/jobs/route.ts`. None
were actionable.

Suggested fix: drop confidence hard when the comment references no
identifier appearing in the adjacent code, or split the charge into
prescriptive vs explanatory.

### `Temporal Recklessness` conflates reading time with recording it

Flagged `formatTs()` in a UI component rendering a timestamp, and
`completed_at: new Date().toISOString()` writing a DB column. Both are fine.

The genuinely risky case — time used in a **branch or comparison** — is a
much narrower and more valuable signal than time used as a value to record
or display. As shipped, `JobDetail.tsx` reports "9× Date.now(), 4× new
Date()" and essentially all of it is display formatting.

### `High Fan-In` on `types.ts` reads as a category error

`src/lib/types.ts` flagged at 33 importers. High fan-in is a shared types
module's entire job. Consider exempting modules whose exports are
type-only.

### `False Identity` on data access

`getChoreoByDate() → calls createClient` — flagged five times in `api.ts`
alone, because a `get*` function makes a "side-effect-like call". But
`createClient()` is constructing the client in order to *do the read*.
Every data-access layer in every Next.js app has this shape.

### No way to scope to a planned change

`context <file>` is per-file; the task had ~19 files in scope. What was
wanted: `crimes context --files a,b,c` or `scan --related-to src/lib/openrouter`.

Doing that scoping by hand was **the single part of the task most worth
automating**, and it is the thing crimes is closest to already solving.

### Output ordering

`--top 15` scrolled the summary header off the terminal buffer; a second
run at `--top 3` was needed just to read the repo totals. The header is the
most important part of the output and it is the first thing lost. Consider
repeating the summary at the end, or a `--summary-last` flag.

## Assumptions held that did not play out

**1. That `crimes` was a skill or slash command.** The user said "let's run
crimes". Search order was `~/.claude/skills`, `~/.claude/commands`,
`~/.claude/plugins`, then a filesystem find that turned it up as a
*directory* in `~/dev`, then `which crimes` (nothing), then a guess at
`npx crimes@latest`. **Four steps to first run.**

`crimes init --agents` is the fix, and it is real — but it is a tip at the
bottom of `--help`, which an agent only reads if it has already decided to
run `--help`. If that command writes discovery info into `AGENTS.md` /
`CLAUDE.md`, that is the entire onboarding story for agents and deserves to
be the loudest thing in the README's agent section. It was not set up in
this repo.

**2. That findings would be scopeable to a working set.** They are ranked
globally by risk — valid, but a different question from "what is relevant
to what I am about to do".

**3. That `--fail-on` was the CI story.** It is — but it requires
`--changed`. The combination `--changed --base main --fail-on medium` is the
most valuable invocation for this workflow and the least discoverable one.

## Five concrete asks

1. Document `scan --changed --base main` as **the** agent-workflow default;
   make bare `scan` the "audit the whole repo" special case.
2. `scaffolding` globs in `crimes.config.json`, applied at scan time.
3. Split `Logic in the Alibi` into prescriptive vs explanatory, or drop
   confidence when the comment references no adjacent identifier.
4. Exempt type-only modules from fan-in.
5. Scope-to-a-plan: accept a file list, not just one file or one diff.

## Caveat on this feedback

This was a **one-shot design task, not an ongoing hygiene loop**. The
`triage → baseline → verdict` commands are clearly built for the latter and
were not exercised. The "499 findings is overwhelming" complaint is quite
possibly exactly what `baseline` exists to solve — weight it accordingly.

## What was actually fixed as a result

Scoped into the accompanying refactor
(`choreograph.cc/docs/superpowers/plans/2026-08-05-cost-tracking.md`):

| Finding | Action |
|---|---|
| Exact Duplicate Block (`repairJsonControlChars`, 2 files) | Extracted to `openrouter/json.ts`; the "duplicated on purpose" note deleted |
| Environment Roulette (`*_MODEL` across 8 files) | Centralised in `openrouter/models.ts` |
| Double Jeopardy (retry-around-fetch, 2 files) | Replaced by a shared `withAttempts` helper |
| God File `daily-agents.ts` (1276 lines, 4.3×) | Transport + JSON helpers extracted |
| God File `JobDetail.tsx` (1842 lines, 6.1×) | Five sections extracted to their own files |
| 8 near-identical `*RateLimitError` classes | Shared `RateLimitedError` base |

Explicitly declined and recorded as out of scope: `scripts/` (157),
`smoke-test.ts`, `QuotesAdmin.tsx`, `api.ts` False Identity, the
`job-processor.ts` and `video/generate.ts` God Functions, `types.ts`.
