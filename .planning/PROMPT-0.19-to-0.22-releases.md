# Ship it: a four-release plan from 0.17.0 to a clean agent experience

You're picking up `crimes` (`/Users/andrew/dev/crimes`). The last two
sessions closed the 0.18.x remediation queue. **Nothing has been
published since `0.17.0`**, and two pieces of outside evidence have
arrived that change what should ship next and in what order.

This file is the plan. It is a *sequence of releases*, not a task list:
each one cuts a real npm release before the next begins, so users stop
waiting behind work that isn't done yet.

---

## Where things actually stand

- **Published on npm: `0.17.0`.** Confirmed by a fresh
  `npm i crimes` on a clean machine (below).
- **Unreleased in `main`: `0.18.0` → `0.18.4`.** Five internal
  eval-baseline bumps carrying a **breaking** `schema_version`
  0.5.0 → 0.6.0, four features, ~30 defect fixes and five calibration
  changes. None of it is in anyone's hands.
- `schema_version` **0.6.0**, ~2,117 tests, `evals/results/0.18.4/`
  committed, `pnpm verify` green, `pnpm run evals:verify-scenarios`
  green for the first time since `20e4e52`.

**The single most important fact in this document:** the gap between
`0.17.0` and `main` is now large enough that the choreograph field
notes below were almost certainly written against **`0.17.0`**, not
against what you have. `npx crimes@latest` resolves to the published
version. The notes say "0.18.x era" — that is the reporter's
assumption, and it is probably wrong.

---

## Read these first, in this order

1. `CLAUDE.md` — the non-negotiables. The ones that bite here: JSON
   output is the contract; **evidence before judgement**; signal over
   exhaustiveness; playful, not unserious. Biome's `lineWidth: 90` is a
   *measurement* setting.
2. `docs/dogfooding/2026-08-05-choreograph-field-notes.md` — the
   outside evidence. Read all of it, including the caveat at the end.
3. `docs/dogfooding/2026-08-03-remediation.md` §4 — the queue, every
   entry struck through, with **where the entry was wrong**. Ten
   entries were wrong. §27 and §30 are the newest, and both were wrong
   at the premise.
4. `docs/releasing.md` — the 7-step per-release checklist. You will run
   it four times.
5. `evals/README.md` § "Run evals from a checkout nothing else will
   touch", and § "`ranking_quality` — the metric that can see a
   re-ranking".

---

## How this codebase is worked on

Unchanged, and every one of these earned its place:

**Test-driven, genuinely.** Write the failing test, *run it*, confirm
it fails for the right reason, then the minimal fix. A test that passes
the moment you write it proves nothing.

**Measure on real repos.** `~/crimes-dogfood/corpus/` (outside the
tree, pinned SHAs in `SHAS.txt`): `hono`, `pydantic`, `drf`, `zulip`,
`airflow` (~95s), `mlflow`, `cal.com`, `posthog`, `n8n`. Report
before/after. **A null result reported honestly is worth more than a
number massaged upward.**

**A queue entry is a hypothesis.** Reproduce before fixing. Across the
last two passes, ten entries were wrong — two of them at the premise,
where acting would have made things worse (§15 would have created ~728
false positives; §27 did not reproduce at all in 8 runs).

**Two properties you must not break**, both with standing tests:
fingerprint uniqueness and byte-identical re-scans. Re-check with `cmp`
after anything touching scoring, discovery or sort order.

**Version bumps and evals.** Findings-moving changes get a patch bump
and an eval re-run; batch one bump and one run per group. Say in the
commit message whether a delta is a **measurement correction** or a
**product delta**.

---

## Traps this codebase has fallen into, with the newest first

**1. Never resolve a symbol by name alone.** Matching `x.foo()` against
any function called `foo` produced n8n's 0.98-confidence chain joining
four unrelated registries through `Set.prototype.has` (`2e9b2da`). The
0.18.3 Python symbol index resolves through the MRO and the importing
file's own imports, or stays silent.

**2. Crossing a file boundary can break an assumption nobody stated.**
0.18.3 nearly shipped crediting tests through `assert` statements in
*production* code — preconditions defending a function from its caller,
not tests checking a result. Same-file resolution never needed the rule
because a test file's own functions are test infrastructure by
construction. **Caught only by opening the files named in the
evidence.** When you widen a detector's reach, ask what the old scope
was silently guaranteeing.

**3. Apparatus that fails closed on correct input.** Three instances
now: the eval scorer's extension list (a missing language scored 0 on
answers that were right), the biome guard's summary regex (`format`
reports `Formatted`, not `Checked`, so the guard failed a *successful*
run), and `enable` as a pure allowlist. When you write a check, ask
what a *correct* input that it rejects would look like.

**4. Never build while an eval run is in flight.** The runner scans
with the built CLI, so a rebuild silently splits the run across two
products. This invalidated `0.18.0`. **Use a dedicated git worktree**
— during the 0.18.4 run another session wrote a file into this tree,
and while it could not reach a fixture scan, the "checkout nothing else
will touch" rule was not met. Don't rely on getting lucky twice.

**5. `pnpm run build` ordering is fine.** The long-standing warning
that a reporter change can be missing from the CLI bundle **does not
reproduce** — 8 of 8 runs carried it (§27). If you go to re-test it,
note that an *unused exported constant* is the wrong marker: esbuild
tree-shakes it, which looks identical to a build-order failure.

---

## Input A: what a clean-machine install looks like today

```
andrew@orto-mini dev % npm i crimes

added 2 packages in 990ms
npm warn allow-scripts 1 package has install scripts not yet covered by allowScripts:
npm warn allow-scripts   crimes@0.17.0 (postinstall: node ./scripts/postinstall.mjs)
npm warn allow-scripts
npm warn allow-scripts Run `npm install-scripts ls` to review, or `npm install-scripts approve <pkg>` to allow.
```

**The only crimes-specific output on a fresh install is a security
warning.** npm 11.18+ blocks install scripts by default and asks the
user to approve arbitrary code execution.

What that script does, in full: prints seven lines of welcome text.
`packages/cli/scripts/postinstall.mjs` — and **its own comment already
concedes the point**:

> npm 7+ swallows postinstall stdout/stderr unless the user passes
> `--foreground-scripts` … **Most users will never see this message**,
> but those who do get the three commands they'd want next. The bare
> `crimes` invocation in the CLI itself is the reliable surface.

So the package is spending an install-script trust prompt — on a tool
whose entire pitch is trustworthiness — to buy a message that was
already invisible. **Verified: the bare `crimes` invocation already
prints the onboarding** (`crimes context <file>` / `crimes scan` /
`crimes init --agents` / `crimes --help` / docs link).

Also visible: `added 2 packages`. The second is `typescript`, a real
`dependencies` entry (~22MB unpacked) pulled on every install. That was
a deliberate call — `packages/cli/tsup.config.ts` externalises it to
keep the tarball small — but it has never been weighed against the
*install* experience, only the tarball.

---

## Input B: the choreograph field notes

`docs/dogfooding/2026-08-05-choreograph-field-notes.md`. A Next.js 16
app, ~209 files, used **mid-design to scope cleanup for a refactor
touching ~19 files** — not an ongoing hygiene loop. Read the caveat at
the end: `triage` / `baseline` / `verdict` were never exercised, and
the "499 findings is overwhelming" complaint may be exactly what
`baseline` exists to solve.

**What worked** (do not regress these): the top-file ranking picked the
two files the task touched most; `exact_duplicate_block` found a clone
a human had *consciously deferred* with a comment, and reopened the
decision — the reporter says this single finding justified the run;
`crimes context`'s "Likely tests: (no test file matched…)" line
communicated "this repo has zero tests" in one shot and reshaped the
plan; the charge names are memorable enough to discuss with a user
without re-explaining them.

**What cost time**, verified against `main` before you act on any of it:

I checked whether the four precision complaints were already fixed in
the unreleased work. **They are not.** `logic_in_comments`,
`name_behavior_mismatch`, `direct_date` and `high_fan_in_fan_out` have
had only fingerprint-discriminator changes since `0.17.1` — no
behaviour change. So those complaints stand against `main`.

I did **not** verify the volume complaints (499 findings, `scripts/`
157) against `main`, and you should before scoping R2. `commented_out_code`
alone dropped airflow from 8,019 findings to 45 in 0.18.1, and
`parallel_destination` is now gated off. **The 499 may already be
substantially smaller.** Re-running the notes against the current build
is Step 0.

Charge name → detector, so you can find them:

| charge | detector |
|---|---|
| Logic in the Alibi | `logic_in_comments` |
| False Identity | `name_behavior_mismatch` |
| Temporal Recklessness | `direct_date` |
| Double Jeopardy | `unsafe_retry` |
| Environment Roulette | `config_drift` |
| Policy Doppelgänger | `duplicated_policy` |

---

## Step 0 — before planning anything past R1

> **DONE (2026-08-05).** Results in
> [`docs/dogfooding/2026-08-05-choreograph-reverify.md`](../docs/dogfooding/2026-08-05-choreograph-reverify.md).
> choreograph.cc was available locally, so the *exact* snapshot the notes
> were written against (`5107cce`) was scanned by both builds.
>
> - The notes were written against **`0.17.0`** — 498/34/268/196 vs the
>   notes' 499/34/269/196. Hypothesis confirmed.
> - `main` gives **491** — a **−1.4%** delta. **Nothing comes out of the
>   plan; all nine complaints reproduce**, four of them with byte-identical
>   evidence strings.
> - **Where this document was wrong:** "`commented_out_code` … the 499 may
>   already be substantially smaller" — `commented_out_code` fires twice on
>   this repo in both builds, and `parallel_destination` fires zero times.
>   The airflow headline did not transfer. A corpus-wide delta is not a
>   prediction for an individual repo.
> - **R2 is re-ordered on evidence:** `--changed --base main` returns
>   **zero** on the clean tree the notes' workflow actually starts from. It
>   is the *post-edit* default, not "the" agent default. Scope-to-a-plan
>   (R2.2) is promoted to R2's lead item. See §"Result 4" in the re-verify.

Re-run the field notes against `main`, on a repo of the same shape
(Next.js App Router, TypeScript strict, no tests). `cal.com` and
`posthog` are in the corpus and are the closest available; better still,
ask the maintainer for access to choreograph.cc itself.

Report, as a table: finding count then vs now, per-detector counts for
the six charges above, and which of the seven "where it cost time"
complaints still reproduce. **Any complaint that no longer reproduces
comes out of the plan below**, and say so — a fix shipped against a
stale complaint is worse than no fix, because it looks like progress.

---

## Release 1 — `0.19.0`: ship the backlog, and fix the install

> **SHIPPED 2026-08-05.** `crimes@0.19.0` is live on npm. Clean-machine
> install verified under npm 12.0.2: the published `0.17.0` reproduces
> the `install-scripts` warning, `0.19.0` installs as a bare
> `added 2 packages`. Notes: `docs/releases/v0.19.0.md`.
>
> One thing this release nearly shipped broken, found while cutting it:
> `feedback recheck` looked up its per-detector migration note by the
> current minor **exactly**, so all fifteen `0.17` notes had been
> unreachable since `0.18.0`. The release whose headline is "twelve
> detectors need re-recording" would have told every user "detector
> behaviour unchanged". Fixed in `7592c0c`; nine `0.18`-era entries
> added with it. **Third instance of apparatus failing closed on correct
> input** — trap 3 in this document, now with a third data point.

**Add nothing.** The point of this release is that ~30 defect fixes and
four features are sitting in `main` where nobody can use them. The only
new work is the install fix, because it is one line and every install
until R1 lands carries the warning.

Contents:

1. **Remove the postinstall.** Drop `scripts.postinstall` from
   `packages/cli/package.json` and `scripts/postinstall.mjs` from
   `files`. Keep the script file itself only if something else uses it
   (nothing does). Acceptance: `npm pack`, install the tarball into a
   clean temp dir with npm ≥ 11.18, and confirm **no `allow-scripts`
   warning** and a clean `added N packages` line. `pnpm --filter crimes
   smoke` must still pass — it exercises every command from a packed
   tarball, and it is the thing that will catch a `files` mistake.
2. **Everything already in `main`.** `schema_version` 0.6.0 (breaking:
   `fingerprint` required, `score_rationale` added — migration note is
   already written in `docs/json-schema.md`), detector gating, the
   repo-level output section, the Python cross-file symbol index, and
   the ~30 fixes in §4 of the remediation doc.
3. **Changelog and release notes** covering the whole 0.17.0 → 0.19.0
   span. `docs/releases/` holds in-repo drafts. This is the biggest
   release the project has cut; the notes carry the weight.
4. A Changeset, a tag, the 7 steps in `docs/releasing.md`.

**Why 0.19.0 and not 0.18.5:** `0.18.0`–`0.18.4` are internal
eval-baseline markers that were never published. Publishing into that
range would put a released version next to four siblings that don't
exist on npm. Roll them up, per the policy in `evals/README.md`.

**Do not let R1 grow.** Every item below is a reason to delay it and
none of them are worth delaying it for.

---

## Release 2 — `0.20.0`: make the agent workflow the default one

> **SHIPPED 2026-08-05.** `crimes@0.20.0` is live. Notes:
> `docs/releases/v0.20.0.md`.
>
> **Acceptance, as asked for:** on Step 0's repo, the documented default
> path (`scan --related-to src/lib/creative-pass.ts`) shows an agent
> **24 findings across 6 files**, against **491** for bare `scan`.
>
> Item-by-item against this section:
>
> 1. **Docs reframed** — README, `docs/agent-usage.md`, the `--help`
>    tips block (which now leads with scoping), and the skill
>    `init --agents` writes. Framed as `--changed` = post-edit,
>    `--files` / `--related-to` = pre-edit, per Step 0's finding.
> 2. **Scope to a plan — done, as `scan --files` / `--related-to`.**
>    `crimes context --files a,b,c` was *not* built: `context()` builds
>    every cross-file index per call, so 19 files means 19 index builds.
>    The notes asked for either; this is the one that also ranks and
>    gates. Recorded in the release notes rather than dropped.
> 3. **`scaffolding` globs — NOT BUILT, and this document was wrong to
>    ask for them.** The mechanism ships today as
>    `scopeTiers.nonDomain`, on by default, with `scripts/**` as its
>    literal first entry; all 148 `scripts/` findings already carried
>    `tier: "nonDomain"`. What was actually broken: the header counted
>    491 findings above a body listing 339. Fixed there. Checking
>    `util/scope-class.ts` first — which this document told me to do —
>    is what caught it.
> 4. **Output ordering — done**, as a repeat above the action-close
>    rather than a `--summary-last` flag (a flag has `--changed`'s
>    discoverability problem).
> 5. **Agent discoverability — done.** `init --agents` is the first
>    thing in the README's agent section.

The field notes' core finding, stated plainly: **`--changed --base main`
is the answer, and it was not reached for.** Bare `scan` is the obvious
invocation, and on a 209-file repo it returns 499 findings, which
invites an agent to either over-fix into unrelated files or dismiss the
tool. The most valuable invocation is the least discoverable one.

1. **Reframe the docs around the working set.** `scan --changed --base
   main` becomes *the* documented agent default; bare `scan` becomes
   the "audit the whole repo" special case. README, `docs/agent-usage.md`,
   the `--help` tips, and the skill that `crimes init --agents` writes.
   The tips block currently names `init --agents` and `context <file>`
   and **does not mention `--changed` at all** — that is the one-line
   version of this problem.
2. **Scope to a plan, not a file or a diff.** `context <file>` is
   per-file; the task had ~19 files in scope. The ask is
   `crimes context --files a,b,c` or `scan --related-to src/lib/x`.
   The notes call this "the single part of the task most worth
   automating, and the thing crimes is closest to already solving."
   Design it deliberately — `--related-to` implies walking the import
   graph, which already exists and already carries Python edges.
3. **`scaffolding` globs in `crimes.config.json`, applied at scan
   time.** A third of choreograph's findings were in `scripts/` —
   one-off diagnostics that are quick and dirty by design. `triage`
   already has a `scaffolding` disposition but it is per-finding and
   after the fact. **Check first whether `util/scope-class.ts` already
   answers this** — it is the one place that decides generated /
   vendored / fixture / test / production, and a config-driven
   scaffolding class may belong there rather than as a new mechanism.
4. **Output ordering.** `--top 15` scrolled the summary header off the
   buffer, forcing a second run at `--top 3` just to read the totals.
   The header is the most important part of the output and it is the
   first thing lost. Repeat the summary at the end, or add
   `--summary-last`. Cheap, and it fixes a real second invocation.
5. **Agent discoverability.** The reporter took **four steps to first
   run**: searched `~/.claude/skills`, `~/.claude/commands`,
   `~/.claude/plugins`, a filesystem find that turned up a *directory*
   in `~/dev`, `which crimes` (nothing), then guessed
   `npx crimes@latest`. That search order is real data about how an
   agent looks for a tool. `crimes init --agents` is the fix and it is
   a tip at the bottom of `--help` — which an agent reads only if it
   already decided to run `--help`. Make it the loudest thing in the
   README's agent section.

Acceptance: re-run Step 0's repo with the R2 build and report the
number an agent sees on the *documented default path*, not on bare
`scan`.

---

## Release 3 — `0.21.0`: precision, where the false positives are

> **Pre-measurements taken before touching anything:**
> `docs/dogfooding/2026-08-05-r3-premeasurements.md`. Two of this
> section's suggested fixes do not survive contact with the files that
> prompted them — item 3's exports-are-type-only rule would not exempt
> `types.ts` (24 types, one const), and item 1's no-adjacent-identifier
> rule would not silence the representative `logic_in_comments` hit.

All four verified as still live against `main`. Each is a calibration
change: corpus measurement before and after, a patch bump, an eval run.
**Do not tune more than one at a time** — the eval aggregate cannot
attribute two changes at once, and `evals:ranking` only sees ordering.

1. **`logic_in_comments` had the worst false-positive rate.** It keys
   on modal words (must / always / never / required / before) without
   distinguishing "this comment asserts a rule the code does not
   enforce" (actionable) from "this comment explains why the code is
   the way it is" (a virtue). It fired on five files in a repo that
   documents its reasoning unusually well, and **none were actionable**.
   The detector systematically punishes good practice. Suggested fix
   from the notes: drop confidence hard when the comment references no
   identifier appearing in the adjacent code, or split the charge into
   prescriptive vs explanatory. Measure the split on the corpus before
   choosing.
2. **`direct_date` conflates reading time with recording it.**
   `formatTs()` rendering a timestamp and `completed_at: new
   Date().toISOString()` writing a column are both fine. The risky case
   is time used in a **branch or comparison** — a much narrower and more
   valuable signal. One file reported "9× Date.now(), 4× new Date()"
   and essentially all of it was display formatting.
3. **`high_fan_in_fan_out` on a shared types module is a category
   error.** 33 importers is a types module's entire job. Exempt
   modules whose exports are type-only. Note this interacts with
   `blast_radius`, which normalises `transitiveImporterCount` — see the
   queue item below.
4. **`name_behavior_mismatch` on data access.** `getChoreoByDate() →
   calls createClient` fired five times in one file, because a `get*`
   function makes a "side-effect-like call" — but `createClient()` is
   constructing the client *in order to do the read*. Every data-access
   layer in every Next.js app has this shape.

**Weight these against the caveat.** The reporter used crimes for a
one-shot design task. A detector that is noisy in that mode may be
correctly tuned for the hygiene loop `baseline` and `triage` serve.
Where you decide a complaint is a workflow mismatch rather than a
precision bug, **say so and leave the detector alone** — that is a
legitimate outcome and §15 is the precedent.

---

## Release 4 — `0.22.0`: close the queue

The known misses, recorded honestly rather than fixed. Fix or re-close
each on its merits.

- **`if __name__ == "__main__"` scripts** classify as `domain`, so
  `sync_io_in_hotpath.py` fires on them. No signal distinguishes them
  from real domain code without reading module-level control flow.
  (§4.9.)
- **`pydantic/v1/`** — a bundled legacy copy `scope-class` does not
  recognise. No general rule separates it from any other `v1/` API
  directory. (§4.13.)
- **`large_file` counts blank lines.** Never asked about. Fixing it
  drops every number 15–25% and retunes thresholds repo-wide —
  **calibration, not a bugfix**. The evidence line already says
  `N lines` rather than claiming non-blank, so nothing is currently
  lying. Needs the measure-then-decide treatment `blast_radius` got,
  and `evals:ranking` now exists to measure it with.
- **`transitiveImporterCount` counts a file as its own importer** on a
  cycle. Left deliberately; it is the number `blast_radius` normalises.
  Now that `blast_radius` is log-scaled with a direct-count term, worth
  revisiting — and it touches R3's item 3.
- **§4e — JS syntax errors have no `coverage.warnings[]` signal.** Still
  no supported API; `ts.createSourceFile` keeps `parseDiagnostics` off
  the public type. Revisit only if a supported signal appears.
- **`weak_test_signal` fingerprint collisions.** 2 of 3,585 on n8n
  `packages/cli`, 30 of 3,458 on zulip, 115 of 9,926 on airflow — two
  tests with identical titles in one file, so the JS discriminator (the
  test title) cannot separate them. **Measured identical before and
  after the 0.18.3 index change**, so nothing recent added to it.
  Folding the line range in would fix it and invalidate every pinned
  `weak_test_signal` suppression — a migration, not a patch, and it
  belongs in a minor with a migration note.
- **The eval fixture set cannot see a cross-file Python change.** The
  0.18.3 symbol index moved airflow's claimed-silent tests −27.1% and
  zulip's `test_message_delete.py` to zero, and moved the eval
  aggregate by nothing — because **no fixture has a test helper in
  another module**. The only change it made to any fixture was one
  evidence string growing a clause. Add a fixture with a base-class
  assertion helper and one with an imported one, so the suite can see
  this class of change at all. Cheap; can move earlier than R4.
- **Run evals from a dedicated worktree.** Standing hygiene, now with a
  near-miss behind it.

---

## Release mechanics, all four times

`docs/releasing.md` is canonical — 7 steps, and `verify-build` enforces
things about the landing page you will not guess. In short: bump,
changelog + docs, local pre-flight (`pnpm verify` **and**
`pnpm --filter crimes smoke`), commit and push, GitHub Release, watch
the Release workflow, then **verify from a clean directory outside this
repo** — `npm i crimes` and `npx crimes` both.

For R1 specifically, the clean-directory verification is the acceptance
test for the install fix. Do it on npm ≥ 11.18 or the `allow-scripts`
behaviour won't show.

Between releases, keep the eval-baseline discipline: findings-moving
change → patch bump + `pnpm run evals` in the same group, and say in
the commit message whether a delta is a measurement correction or a
product delta.

---

## How to proceed

1. **Step 0 first.** Re-run the field notes against `main`. It costs an
   hour and it decides how much of R2 and R3 is real.
2. **R1 immediately, and small.** Resist every temptation to add to it.
   The backlog is the risk, not the release.
3. R2, then R3, then R4 — but re-read Step 0's output before scoping
   R2, and re-read R3's caveat before touching a detector.

Update `docs/dogfooding/2026-08-03-remediation.md` §4 and this file as
you go, in the same format: strike through, say what was measured, and
**record where the entry was wrong**. That record has been the most
useful thing in the doc every single time.
