# Pick up `crimes` after the 0.18.1 remediation pass

You're continuing work on `crimes` (`/Users/andrew/dev/crimes`). The
0.19-followups queue is **closed**: all six Tier 1 items, all ten Tier 2
items, both Tier 3 items, both Tier 4 decisions the maintainer took, and
all five annoyances shipped across 32 commits as `0.18.1`, with a
verified-clean eval baseline.

What's left is smaller in count and larger in consequence. One item is
blocking a question the maintainer has already parked; one is an
environment failure; the rest are known misses recorded honestly rather
than fixed.

## Read these first, in this order

1. `CLAUDE.md` — the non-negotiables. The ones that bite: JSON output is
   the contract; deterministic before magical; **evidence before
   judgement**; signal over exhaustiveness. Biome's `lineWidth: 90` is a
   *measurement* setting.
2. `docs/dogfooding/2026-08-03-remediation.md` §4 — every queue item,
   struck through, with what was measured **and where the entry was
   wrong**. Six entries were wrong; §15's premise was wrong enough that
   acting on it would have created ~728 false positives.
3. `docs/calibration-followups.md` § "`agent_risk`: what we know and what
   we believe" — the parked decision, with measured facts separated from
   assumptions. Read this before touching any scoring constant.
4. `evals/README.md` § "What `structural_pass_rate` does and does not
   measure", and § "Run evals from a checkout nothing else will touch".

Current state: version `0.18.1`, `schema_version` **0.6.0**, ~2,075
tests, `evals/results/0.18.1/` committed. Tree clean.

---

## How this codebase is worked on

Unchanged from the last pass, and worth restating because every one of
these earned its place:

**Test-driven, genuinely.** Write the failing test, *run it*, confirm it
fails for the right reason, then the minimal fix. A test that passes the
moment you write it proves nothing.

**Measure on real repos.** `~/crimes-dogfood/corpus/` (outside the tree,
pinned SHAs in `SHAS.txt`): `hono` ~8s, `pydantic` ~6s, `drf`, `zulip`,
`airflow` ~95s, `mlflow`, `cal.com`, `posthog`, `n8n`. Report
before/after. **A null result reported honestly is worth more than a
number massaged upward** — §15 of the last pass is the proof.

**A queue entry is a hypothesis.** Reproduce before fixing. Last pass,
six entries were wrong: one at the premise, one framed backwards, two
understated, two with the wrong number. Record where an entry was wrong;
that record is the most useful thing in the doc.

**Two properties you must not break**, both with standing tests:
fingerprint uniqueness (`scan.test.ts` has a mutation-checked gate) and
byte-identical re-scans. Re-check with `cmp` after anything touching
scoring, discovery or sort order.

**Version bumps and evals.** Findings-moving changes get a patch bump;
batch one bump and one eval run per group. Say in the commit message
whether a delta is a **measurement correction** or a **product delta**.

---

## Three traps this codebase has already fallen into twice

Read these before starting; each cost real time in the last pass.

**1. Never resolve a symbol by name alone.** Matching `x.foo()` against
any function called `foo` produced n8n's 0.98-confidence "chain" joining
four unrelated registries through `Set.prototype.has` (`2e9b2da`), and
it is the single reason §4d below is not done. Resolve through imports
or the MRO, or stay silent.

**2. `pnpm run build` does not reliably build `packages/cli` after
`packages/reporter`.** A reporter change can be missing from the CLI
bundle, which cost two confusing measurements last pass. Always
`pnpm --filter crimes run build` afterwards, or verify with
`grep -c '<your new string>' packages/cli/dist/index.js`. **Fixing this
properly is a task below.**

**3. Never build while an eval run is in flight.** The runner scans with
the *built* CLI, so a rebuild silently splits the run across two
products. This invalidated the 0.18.0 baseline (`a13277a`). The 0.18.1
run was verified clean afterwards by comparing `dist` mtimes and
`git log --since` against the run window — do the same.

---

## The work

### 1. A ranking-quality metric — blocking, and the most valuable thing here

**This is the item to start with.** It is not a nice-to-have; it blocks
a decision the maintainer has already made.

The 0.18.1 run rebuilt the ranking twice (`agent_risk` decoupled from
length and severity; `blast_radius` re-scaled) and moved
`structural_pass_rate` by **noise** — claude +3pp against a ±6pp band,
codex −2pp against ±3pp.

That is not because the changes did nothing. It is because the metric
**cannot see ranking at all**: `referenced_findings` and
`expected_priority` match a detector's literal **id** in the response
text, and an agent quotes the right id whether that finding ranked 1st
or 30th. `evals/README.md` documents the blindness in both directions.

So there is currently **no way to tell whether the `agent_risk` work
improved ranking**, and re-running the existing suite will never produce
one. Everything in §2 below waits on this.

What it plausibly needs — scope it deliberately, don't assume:

- Rank-aware scoring: did the agent act on a finding the scan ranked
  highly, or one it buried? Something like rank-of-first-referenced-
  finding, or nDCG against the scenario's expected finding set.
- Scenarios where the *right* answer is buried by the old ranking and
  surfaced by the new one. The current fixtures are small and clean;
  a ranking metric on a 12-finding fixture measures very little.
- The README's own smaller fix, which is worth doing regardless:
  match a detector's human-readable `charge` and `name` as well as its
  id, and treat a file path mentioned in any form as a reference. Codex
  scored zero on two `bugfix` scenarios in the 0.18.1 run while giving
  demonstrably correct answers.

Acceptance: re-running 0.18.1's fixtures under the new metric produces a
number that *differs* from the 0.17.1 ranking in a direction someone can
defend. If it cannot distinguish those two, it does not work yet.

### 2. `agent_risk` — parked, and the focus of this release

Do not retune constants before §1 exists. `ce0ccab` removed a defect
(the score was a length ranking: 18 of zulip's top 20, zero Python on a
71%-Python repo). It did not settle the shape.

`docs/calibration-followups.md` separates what is measured from what is
assumed and asks four questions. The two that matter most:

- **Is a hard ceiling right?** It collapses every structural finding
  above the cap to exactly 0.3 — the same plateau problem
  `blast_radius` was just fixed for. A monotonic squash would preserve
  order within the class.
- **Are per-detector intrinsics calibrated against each other?** Each
  was chosen locally by whoever wrote the detector. Nothing has ever
  compared `sync_io_in_hotpath`'s 0.5–0.7 band against
  `contract_drift`'s — and the 0.3 ceiling was fitted to that
  unvalidated band.

Also unresolved: zulip's top 20 is now **16 of 20 `sync_io_in_hotpath`**.
A differentiated detector on a repo that genuinely has a lot of blocking
I/O in Python, but 16-of-20 is not obviously better than the 18-of-20
`large_function` it replaced. It may be a more interesting monoculture.

### 3. `pnpm verify`'s lint step has not run since `6edfe2d`

`biome` dies with *"Linter process terminated abnormally (possibly out
of memory)"* — on the whole repo, on one package, and on a single file,
with ~55–60MB free. The cause was system memory pressure, not this
work; typecheck (six packages), `format:check` and 2,075 tests were all
green throughout.

**Run `pnpm verify` first thing** and fix whatever it finds across the
~16 commits from `6edfe2d` to `053cd14`. If biome still cannot start,
that is now its own bug worth chasing (`NODE_OPTIONS`, a biome version
bump, or `--max-diagnostics`) rather than something to work around
again.

### 4. §4d — the Python symbol index

Already scoped in `.planning/PROMPT-0.19-python-symbol-index.md`. Read
that file rather than re-deriving it. Summary: `weak_test_signal.py`
follows assertion helpers two hops, same file only, so it reports tests
that do assert through a base-class helper — zulip's
`capture_send_event_calls`, and the reason airflow's improvement stopped
at 12%.

The note explains why the obvious version is wrong (trap 1 above), and
that the real work is architectural: Python files are parsed *inside*
the per-file detector loop, so a repo-wide index has nowhere to live.
Three options compared, shared parse cache recommended.

### 5. The build-ordering bug (trap 2)

`pnpm run build` runs `pnpm -r --filter "./packages/*" run build`, which
does not reliably order `packages/cli` after `packages/reporter`. Give
the workspace packages explicit `dependencies` on each other, or make
the root `build` script sequence them, so a reporter change cannot be
absent from the CLI bundle. Small, and it removes a whole class of
"my change didn't work" confusion.

### 6. Known misses, recorded and deliberately not fixed

Each of these is documented where the code lives. Fix or re-close them
on their merits; do not treat them as oversights.

- **`if __name__ == "__main__"` scripts** still classify as `domain`, so
  `sync_io_in_hotpath.py` fires on them. No signal distinguishes them
  from real domain code without reading module-level control flow.
  (§4.9.)
- **`pydantic/v1/`** — a bundled legacy copy `scope-class` does not
  recognise. No general rule separates it from any other `v1/` API
  directory. (§4.13.)
- **`large_file` counts blank lines.** Untouched from the last pass and
  never asked about. Fixing it drops every number 15–25% and retunes
  thresholds repo-wide — **calibration, not a bugfix**, and it needs the
  same measure-then-decide treatment `blast_radius` got. The evidence
  line already says `N lines` rather than claiming non-blank.
- **`transitiveImporterCount` counts a file as its own importer** on a
  cycle. Left deliberately; it is the number `blast_radius` normalises.
  Now that `blast_radius` is log-scaled with a direct-count term, this
  is worth revisiting.
- **§4e — JS syntax errors have no `coverage.warnings[]` signal.**
  Still no supported API; `ts.createSourceFile` keeps `parseDiagnostics`
  off the public type. Revisit only if a supported signal appears.
- **2 fingerprint collisions of 3,585** on n8n `packages/cli`: two tests
  with identical titles in one file, so the JS `weak_test_signal`
  discriminator (the test title) cannot separate them. Folding the line
  range in would fix it and invalidate every pinned
  `weak_test_signal` suppression — a migration, not a patch.

### 7. A release decision, when you're ready

`0.18.1` is an eval-baseline bump, not a release. Accumulated since
0.18.0: a **breaking** `schema_version` 0.5.0 → 0.6.0 (`fingerprint`
required, `score_rationale` added), three features (detector gating, the
repo-level output section, `score_rationale`), and two calibration
changes. That is a **minor** when shipped, with a Changeset, a tag, and
the migration note already written in `docs/json-schema.md`.

---

## How to proceed

Do §3 first — it is a gate, and it may already have found something.
Then §1, because §2 cannot be answered without it. §5 is fifteen minutes
and saves you an hour. §4 is the feature; take it when you want a large
piece rather than as a warm-up.

Do **not** start §2 by adjusting numbers. The whole point of the parking
record is that the current constants were fitted to an unvalidated band,
and changing them without a ranking metric would be swapping one
unmeasured judgement for another.

Update `docs/dogfooding/2026-08-03-remediation.md` §4 and
`docs/calibration-followups.md` as you go, in the same format: strike
through, say what was measured, and **record where the entry was
wrong**.
