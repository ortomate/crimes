# Sprint 0.26 — closing what 0.25.0 opened

Sprint plan for the release after `0.25.0`. Everything here is work
`0.25.0` deliberately left undone, plus the two carried items it did not
touch. Nothing in this plan is speculative: every entry has a measured
before-state already on disk.

---

## 1. What 0.25.0 left behind

Five debts, in the order they were created.

| # | debt | why it was left | size |
|---|---|---|---|
| **D1** | 7 of 8 cross-pack charges disagree | 7 simultaneous scoring changes are unattributable | large, splits cleanly |
| **D2** | 9 differentiated detectors referenced by no scenario | 7 of them need fixture *content* | medium |
| **D3** | Tooling excludes: only the Python half | "ship the Python half first" | medium |
| **D4** | `sync_io_in_hotpath`'s test-only bucket (60 findings) | a judgement call, deferred deliberately | small |
| **D5** | Codex's ±3pp noise band is wrong | discovered by the `0.25.0` run | small, unblocks claims |

Plus two items carried from the `0.24.0` backlog that `0.25.0` did not
touch: **P2.1** (the level `0.3` is unvalidated), **P2.2** (the class
table, `standard` has zero members), **P2.4** (41 intrinsics still
literals), **P3.1** (two disowned-label populations), and **P4.1** (M6
Homebrew / binaries).

---

## 2. The release thesis, chosen deliberately

`0.25.0` was about the denominator. The obvious follow-on is **"one
charge, one answer"** — D1 is the largest single correctness defect the
project currently knows about, and it is entirely undone:

> The same defect scores differently depending on which language it is
> written in. An 8-module Python import cycle reaches `0.92`; the
> identical TypeScript cycle is fixed at `0.45` and cannot escalate at
> all. `deep_import` in TypeScript sits at `0.30`, which is
> `NEUTRAL_INTRINSIC` — the exact value `0.23.0` shipped to stop
> findings falling back to.

That is a user-visible, one-sentence defect with a measured population,
and unlike `0.25.0`'s streams it moves **scores**, which
`evals:ranking` can see directly. It is also the item most likely to
produce a real deep-mean movement, which no release has managed since
`0.24.0`'s `+0.0089`.

**D5 must land first regardless of thesis**, because every claim this
release makes about the agent run depends on a noise band that is
currently known to be wrong.

---

## 3. Sequencing constraint, restated

`0.25.0` demonstrated both halves of this the hard way.

- `evals:ranking` is deterministic, free, and **can** see D1. Measure
  every candidate individually.
- The agent run is scarce and, at `0.25.0`, was **pure noise**: all 96
  stable pairs got byte-identical input and codex still moved −5.1pp.
  Do not spend one to attribute a scoring change; spend
  `evals:ranking` instead.
- The harness kills a backgrounded run at 10 minutes. Use
  `pnpm run evals -- --resume` in foreground chunks, or expect to.
  `--resume` re-bills nothing.

**D1 splits into four independently-attributable changes.** Do not
group them.

---

## 4. Streams

### S1 — re-derive the noise bands (D5) — **do this first**

**Blocks:** every agent-run claim in the release.

`evals/README.md` states ±6pp for claude and ±3pp for codex, derived
from 3 samples at `0.12.1`. The `0.25.0` run refutes the codex figure
directly: **16 of 48 scenarios moved on byte-identical input, netting
−5.1pp**. A band that a no-op release exceeds is not a band.

**Do:** `pnpm run evals:variance` already exists and computes
per-scenario mean ± stddev across samples for a version. There are now
two same-input samples on disk (`0.24.0`, `0.25.0`) for the 48 stable
scenarios — that is a free second data point requiring **zero agent
calls**. Derive both bands from it, publish per-scenario variance, and
mark the worst offenders.

`review-05-permission-and-parallel` went 4/7 → 0/7 on identical input.
Either it is genuinely unstable and should be reported as such, or its
rubric is ambiguous and should be tightened. **Read that scenario before
concluding.**

**Done when:** `evals/README.md` § "Measured noise band" cites the new
derivation and says what a delta must exceed to mean anything.

**Cost:** zero agent calls. Analysis only.

---

### S2 — close the two shape gaps (D1, part 1)

The largest and most defensible slice of D1. `circular_dependency` and
`deep_import` express **no** intrinsic on the universal side, so they
take a flat declared default while Python ramps with evidence.

This is not a disagreement about a constant — it is one side being
unable to escalate at all. A detector that cannot respond to its own
evidence is a defect whichever number you prefer.

**Do:** give the universal side a ladder. Anchor the constants to the
Python pack's, or argue for different ones in the commit.

**Reproduce first:** how many `circular_dependency` and `deep_import`
findings exist on the corpus, and what is the distribution of their
evidence counts? A ramp is pointless if every cycle is 2 modules.

**Measure:** `evals:ranking` before and after. Delete the two entries
from `KNOWN_SHAPE_GAPS` in `intrinsic-parity.test.ts` — the gate fails
if you fix one and forget.

**Own bump, own attribution.**

---

### S3 — port the two one-sided conditions (D1, part 2)

`direct_date`'s naive-parse surcharge and `sync_io_in_hotpath`'s
async-handler base exist only in Python and read as unported
improvements.

**Reproduce first, and be willing to stop.** Both are *plausible*
improvements; neither has been argued. Does the universal pack have the
information to detect a naive parse, and does it have an async-handler
shape? If the answer is no, that is the finding and the entry closes.

**Own bump.** Delete the entries from `KNOWN_DISAGREEMENTS` on success.

---

### S4 — reconcile the three constant gaps (D1, part 3)

`boolean_naming_drift`, `mixed_utc_local_methods`, and
`commented_out_code`'s intrinsic half (0.48-ramp vs flat 0.35).

Least consequential, most arguable, and the only part of D1 that is
purely a matter of taste. **Do it last and only if S2/S3 land cleanly.**
Whichever direction is chosen, the losing population's scores move, so
say which and by how much.

---

### S5 — scenario coverage for the 9 (D2)

**Two are nearly free, and this corrects an error in the `0.25.0`
notes.** Those notes claimed none of the nine fires on an existing deep
fixture; that was checked against fixtures 02–04 and not 01. In fact
fixture 01 (deep, 42 findings) already fires:

- `contract_drift` — **2 findings, both high**, on `src/api/state.ts`
- `dependency_provenance_gap` — 1 finding on `package.json`

Both need a scenario and nothing else. `contract_drift` is the more
valuable of the two: it is the type `STRUCTURAL_CEILING`'s original
comment named as the thing a `large_file` must not outrank, and no
scenario has ever labelled it.

The remaining seven need fixture content: `agent_permission_sprawl`,
`config_drift`, `duplicated_policy`, `finder_duplicate_filename`,
`mock_saturation`, `pass_through_abstraction`, `unsafe_retry`.
`duplicated_policy` is worth prioritising — it is the detector the
self-scan flags 13 times in `dependency-provenance-gap.ts`, so this
repo is its own fixture.

**Constraint that bit last round:** adding scenarios changes the deep
population and makes the headline mean incomparable. The guard now says
so, but plan for it — land scenario additions in their own bump, never
mixed with a scoring change.

---

### S6 — the other three tooling-exclude sources (D3)

`.gitattributes linguist-vendored`, `tsconfig` `exclude`,
`.eslintignore`. The mechanism, the allowlist discipline and the
corroboration rule are built and tested; this is applying them to three
more formats.

**Corroboration is the open design question.** For Python, four tools
read one file, so "two independent tools" is cheap. A JS repo has
`tsconfig.json`, `.eslintignore` and `.gitattributes` in three separate
files with different semantics — `linguist-vendored` is a *display*
hint, not a maintenance claim, and may not deserve to be an authority at
all. **Decide what corroborates what before writing a reader.**

**Reproduce first:** on `hono`, `cal.com`, `n8n` and `posthog`, what
would each source exclude, and how many pairs corroborate? If the answer
is "nothing corroborates anywhere", the entry closes with a
measurement — which is a good outcome and cheaper than shipping a
mechanism nothing triggers.

---

### S7 — `sync_io_in_hotpath`'s test-only bucket (D4)

60 airflow findings sit in modules referenced **only by tests**. `0.25.0`
took the conservative cut (zero references) and left these reported.

**The judgement:** a module a test suite exercises is not obviously
unmaintained — but a module *only* a test suite references is also not
obviously production. Both readings are defensible, which is exactly the
shape of the `task_runner.py` decision, so **write the decision down
before the code**.

Small, self-contained, and the measurement already exists (94 files /
151 findings unreferenced, 35 / 60 test-only, 8 / 16 non-test).

---

## 5. Explicitly deferred again, with reasons

- **P2.1 the level `0.3`.** Still needs an instrument that does not
  exist. S1 may be a step toward it; do not conflate them.
- **P2.2 the class table.** `standard` still has zero members across all
  70 detectors. Real, no user-facing number.
- **P2.4 the 41 literals.** `0.25.0` moved 14 of them into named
  `{base, step, cap}` data at their call sites, which is most of the
  benefit. The rest can follow D1 naturally rather than as its own push.
- **P3.1 the two disowned-label populations.** Still the honest fix is
  new scenarios, which is S5.
- **M6 Homebrew / binaries.** Fourth deferral. It is the only
  user-facing *feature* on the table and it has zero eval interaction,
  so it is the natural headline for `0.27.0` if `0.26.0` is another
  correctness release. **Decide it as a release, not as a backlog item.**

---

## 6. Suggested shape

```
S1  noise bands (free, blocks claims)
     └─► S2  shape gaps ──► S3  one-sided conditions ──► S4  constants
S5  scenarios (own bump, never mixed with scoring)
S6  tooling sources — measure first, may close
S7  test-only bucket
```

S1 first and alone. S2–S4 strictly sequential, one bump each, because
the whole point is attribution. S5, S6 and S7 are independent of the D1
chain and of each other.

**Agent-run budget: one, at the release, or zero.** `0.25.0` showed a
full run measuring nothing but agent variance. If S1 concludes the bands
are wide, the honest position is that `structural_pass_rate` cannot
resolve a single release and the run is a smoke test — in which case say
so and stop paying for it every time.

## 7. Definition of done

- [x] `pnpm verify`, smoke, fingerprint-uniqueness, byte-identical
      re-scan, the intrinsic gate and the parity gate all green.
      — 2,318 tests, `crimes@0.25.5` smoke, fixtures 01 and 11 scan
      byte-identically across repeat runs, 42/42 unique fingerprints.
- [x] Every stream re-derived its own before-state rather than quoting
      this document. — and six of them found the document wrong.
- [x] `KNOWN_DISAGREEMENTS` / `KNOWN_SHAPE_GAPS` shrank by exactly the
      entries the release claims to have fixed, and the parity gate's
      staleness assertion still passes. — `KNOWN_SHAPE_GAPS` is empty;
      `KNOWN_DISAGREEMENTS` lost `boolean-naming-drift` and kept four
      entries whose surviving differences are each argued.
- [x] Any deep-population change is reported via `delta_on_stable_set`,
      never as a headline delta. — S5 moved the deep set 30 → 32; the
      guard fired and `delta_on_stable_set` is +0.0000.
- [x] Every place an entry in this plan turned out to be wrong is
      recorded in this file. `0.25.0` corrected four; assume this one
      contains some too. — §8 records 26 across seven streams.

---

## 8b. After the plan — what the queue turned up

### A (`0.25.6`) — churn is silently lost through a symlinked scan root

Went looking for a manifest floor on `agent_risk`. There isn't one. Found
a product bug instead.

**`git log -- <pathspec>` only matches paths git has committed.** When the
scan root is a symlink, the pathspec exists on disk and not in history, so
the log matches nothing, `rebaseChurnFile` drops every entry, and the
caller receives `gitAvailable: true` with an empty file list. Churn 0 for
every file — **presented as a measurement rather than as a failure**,
which is why it survived.

`evals/fixtures/01-messy-ts-app` is a symlink to `examples/messy-ts-app`:

```
scan evals/fixtures/01-messy-ts-app   42 findings, churn>0:  0
scan examples/messy-ts-app            42 findings, churn>0: 42  (0.05–0.20)

hotspots evals/fixtures/01-messy-ts-app  git_available: true, every change_count 0
hotspots examples/messy-ts-app           git_available: true, src/billing.ts: 4
```

Not an eval-harness quirk. Any user scanning through a symlinked
checkout, a workspace link or a mounted path lost the whole signal, with
`git_available: true` to say everything was fine.

**Three things follow, and the third is the uncomfortable one.**

1. Fixed by resolving the scan root's real path before computing the
   pathspec, with a regression test that fails without it — asserting
   non-empty, because two empty lists compare equal and that is the bug.

2. **The first real deep-mean movement of the sprint, and it is not
   D1's.** `mean_ndcg_deep` 0.3449 → **0.3468** with the deep set
   unchanged, so the delta is real. 19 scenarios moved, 10 up and 9
   down, mean |Δ| 0.013, largest `refactor-01-mixed-utc` +0.086. §2
   predicted D1 was "the item most likely to produce a real deep-mean
   movement, which no release has managed since `0.24.0`". D1 produced
   none; this did.

3. **It qualifies S1's conclusion, which the whole sprint leaned on.**
   `evals:ranking` was the instrument that could "resolve a release".
   It was ranking fixture 01 — 70% of the deep aggregate — with `churn`
   pinned to zero, and `recency` is *still* zero on all four deep
   fixtures. `rank_score = agent_risk * (1 + recency * 0.5)`, so on the
   deep set `rank_score` **is** `agent_risk`, and `agent_risk` was
   running on three of its four terms. Two of PRD §10's six scores are
   inert in the metric this project trusts. That is worth its own
   investigation, and it got one — see E, and then F.

### E — `recency` is not a bug, and that is worse

Chased the second zero from A. **`recency` on the deep fixtures is
correct**: it is 1 for a file committed within 7 days, decays linearly to
0 at 14, and the deep four were last touched months ago. No defect.

The problem is what that implies for the metric.

**`evals:ranking` is a function of wall-clock time, and the README says
it is not.** `rank_score = agent_risk * (1 + recency * 0.5)`, so the same
build scanning the same fixture ranks it differently seventeen days
later — by up to 50% of `rank_score` on recently-edited files. The
documented claim is "there is no noise band, so any delta is real". That
is false across a 7-or-14-day boundary for any fixture touched in
between.

Measured today: `14-tooling-excludes` recency **1.0** (committed today),
`11-py-service` and `12-py-tested` 0.43, and **0 for the entire deep
set**. So the live exposure is 7 of 53 scenarios and none of the
headline — which is exactly why it has never bitten. The four deep
fixtures are old.

**It is dormant, not small.** Editing a deep fixture wakes it, and
fixture 01 is 70% of the deep aggregate. It bears directly on the
standing S5 work: authoring seven fixtures puts every new finding at
recency 1 for a week and decaying for another, so a baseline taken the
day they land does not reproduce a fortnight later.

**Fixed in `0.25.7`, having first been documented and deferred.**
`buildScoringContext` takes its reference "now" from `CRIMES_NOW` when
set — the same escape hatch as `CRIMES_HOME` in `feedback/paths.ts` —
and the eval runner pins every fixture scan to a committed constant.
Product runs leave it unset, which is correct: a user's repo really is
a function of today. The ranking report records `reference_date` and
`--compare` warns when two reports disagree about it.

Demonstrated on identical code and fixture, varying only the calendar:
`14-tooling-excludes` scores recency 1 at `2026-08-11` and 0 at
`2026-09-10`. Nothing moved on the run itself, because the pinned date
is today; from here it stays put.

### C (`0.25.8`) — D2 closed, and six of the seven already had content

§4 S5 says the remaining seven detectors "need fixture content". **Six
of them already had it**, in `examples/risky-service` — the 0.16.0
correctness fixture, which `CLAUDE.md` documents and which was never
registered as an eval fixture. Scanning it fires
`agent_permission_sprawl` (3), `config_drift`, `duplicated_policy`,
`mock_saturation`, `pass_through_abstraction` and `unsafe_retry` (2)
with no authoring at all.

Same shape of error as the one §4 S5 itself corrects in the `0.25.0`
notes: a claim about what fixtures contain, made without scanning them.
That is twice in one plan, on the same question.

Registered as fixture `15` by symlink — the mechanism fixture `01` uses,
now that the symlink churn bug (A) is fixed. Only
`finder_duplicate_filename` needed new content: `repo/user-schema 2.ts`,
a Finder conflict copy of the real schema that has *drifted* (no `plan`
field, `role` predating `owner`), so the scenario can ask which is
canonical and the answer is in the files rather than in the filename.

Seven scenarios across five kinds. **All nine of D2's detectors now have
one**, and `evals:verify-scenarios` reconciles 60 against 15 fixtures.

Two properties worth having deliberately:

- **Fixture 15 is shallow (22 findings), so `mean_ndcg_deep` is
  untouched** — 0.3468 before and after, no scenario moved. Seven
  scenarios were added without making the headline incomparable, which
  is the constraint §4 S5 flagged.
- **It narrows the depth floor's slack from 14 to 5.** `floor_placement`
  still reports `well_placed: true`, but fixture 15 is now the nearest
  fixture below the floor: six more findings in `risky-service` and it
  enters the deep set and moves the headline. The diagnostic exists to
  make that visible in advance; it now has something to say.

### B (`0.25.9`) — one ladder for `commented_out_code`, and a published anchor that was unreachable

`0.25.5` left this in `KNOWN_SAME_DIR_DISAGREEMENTS` saying the blocker
was two evidence units and a hand-rolled formula. Both true, and both
smaller than what was actually wrong.

**The language-js twin's published base could not be emitted.** Its
ladder was `0.48 + statementCount * 0.04` capped at 0.72, where
`statementCount` is not a statement count but
`syntaxCount + callLines + tokens.length + codeLikeLines.length` — a
composite the detector *also gates on* at `>= 5`. So the floor was
`0.48 + 5 × 0.04 = 0.68`, and 6 saturated the cap. Measured: **all 463
corpus findings carried exactly 0.68 or 0.72.** A two-value ladder
pretending to be a ramp, running at twice the universal twin's flat 0.35
for the same charge in the same report.

That leaks past the twins. `detector-defaults.ts` publishes `0.48
commented_out_code (js)` in the list of expressed bases **every**
`INTRINSIC_DEFAULTS` entry was anchored against. The peers were
calibrated against a number no report ever contained.

Reconciled onto one exported ladder over one unit — **code-like lines**,
which both twins already counted. Base 0.45 is what the table already
implied (`exact_duplicate_block` is 0.45, annotated "near
commented_out_code"); cap 0.60 is `docs_code_drift`, since a twenty-line
dead block is a documentation-shaped lie. The js gate clears at two
code-like lines, which scores exactly **0.48** — making the published
anchor true for the first time.

Measured with the B change alone isolated (stash, rebuild, rescan, both
runs clock-pinned): **only `commented_out_code` moves.** 83 js findings
down a mean 0.079, 63 universal findings up a mean 0.091 — two
populations converging, nothing else touched, finding sets identical.
The intrinsic distribution on mlflow goes from `{0.35, 0.68, 0.72}` to
`{0.48, 0.51, 0.57, 0.60}`: one population, and it finally ramps.

`mean_ndcg_deep` 0.3468 → **0.3475**, deep set unchanged. 13 scenarios
outside fixture 15 moved, 12 up.

**The gate had a hole this would have fallen into.** `readLadder` parsed
inline `{base, step, cap}` literals by regex, so a twin referencing a
shared constant reads as "no ladder here" and the pair is silently
skipped. Taught it to recognise a shared-constant reference as agreement
— two detectors naming one constant agree by construction, which is
stronger than two literals that happen to match — with a test that
asserts the `commented_out_code` pair is seen as `shared` rather than
absent. `KNOWN_SAME_DIR_DISAGREEMENTS` is now empty.

**One measurement footnote, and it is E biting again.** Three fixture-15
rows also moved, including `review-15-duplicated-policy` −0.069. That is
not this change: fixture 15 scans byte-identically across it. It is
`user-schema 2.ts` entering git history between the two runs, taking
`recency` 1 and rising past `duplicated_policy`. Pinning `CRIMES_NOW`
makes the metric reproducible for a fixed git state; it cannot stop a
newly *committed* fixture file from becoming recent. That is exactly the
second working rule `evals/README.md` now states — re-baseline after
adding a fixture — encountered live, one commit after writing it down.

### D — `weak_test_signal` is not a constant gap, and the gate cannot see what it is

The last entry in `KNOWN_DISAGREEMENTS`, carried for nine releases as
"widest gap of the eight; needs its own argument". Here is the argument,
and it is not about constants.

The ladders do differ — universal is a binary 0.68 (no assertions) /
0.58 (weak-only) against python's 0.32/0.045/0.72 ramp. But they are not
comparable, because **the two detectors do not emit the same thing**:

```
universal   one finding per hollow test    3,727 findings / 1,168 files = 3.19 each
python      one finding per file           378 findings /   378 files = 1.00 each
```

Python's intrinsic scales on the *proportion* of a file's tests that are
silent, with a good argument in its own comment — "3 silent tests out of
4 is a much stronger signal than 3 out of 60". Universal has no
proportion to scale on, because it never looks at the file as a whole.

So reconciling the constants first would be comparing a per-test
judgement with a per-file one. The granularity has to be chosen before
the number means anything, and that choice changes finding **counts**
rather than scores — a product decision with its own release, not a
calibration patch. **Not taken here**; the entry now says this instead of
"needs its own argument".

**The gate was structurally unable to notice.** `intrinsic-parity`
compares `{base, step, cap}`. Two detectors can agree on all three and
still disagree about what they count, and for nine releases this pair
was filed as a constant disagreement. The gate's own doc comment now
says what it cannot see, and tells the next person adding an exception to
state what the two detectors *count* before arguing about the score.

### F — the recency term has never been validated, and the one measurement is negative

E made the metric reproducible. That made a question askable that never
had been: **does the recency multiplier improve the ranking it is part
of?** `--no-recency` has existed all along and the scenarios carry
relevance labels; nobody had put the two together.

Scanning every fixture both ways, **one of fifteen changes order at
all** — `15-risky-service`, and only because it was committed this week.
In a fortnight it will be none. On the corpus, `recency` is non-zero for
**34.5% of posthog's 14,181 findings**.

Where it can be measured it is negative: `review-15-duplicated-policy`
0.500 → 0.431, six other scenarios unchanged, mean −0.0099.

The mechanism is the interesting part. `repo/user-schema 2.ts` is the
newest commit in that fixture, so its `contract_drift` took the 50%
boost and displaced `duplicated_policy` — promoting a **stale duplicate
that happened to be typed recently** above a live policy duplication.
The term assumes recently-touched means more relevant; here it measured
when the author typed, and in a real repo a file committed yesterday is
often one somebody just fixed.

**And on a real repository it is much bigger than the fixture showed.**
Toggling it on posthog moves **99.9% of 14,181 findings** (median
displacement 534 places), makes the top-20 **100% recency-boosted**, and
costs 0.028 of mean `agent_risk` in that top-20 against the same slice
without it. The first screen of a real report is chosen by commit date.

`PRD.md` says ranking "should sort by an aggregate risk score" and
**never mentions recency**; the field's doc comment gives mechanics and
no rationale. So the term has no stated purpose, no measurement, and one
labelled result against it.

**Superseded by G.** The reading below was one-sided, and building the
fixture that could test the premise both ways reversed the headline.

**Not acted on at the time.** One shallow fixture and one moved scenario
cannot carry a decision about a multiplier this large, and reweighting on it
would be the same unvalidated-constant mistake this project keeps
recording. What can be said: `rank_score = agent_risk * (1 + recency *
0.5)` applies a multiplier bigger than any single `agent_risk` input,
nothing has ever supported it, the only labelled measurement points
against it, and **the eval set cannot settle it** — the deep fixtures are
old by construction and the recent ones are shallow. Settling it needs a
fixture with synthetic git history dated relative to
`RANKING_REFERENCE_DATE`. Sized in `evals/README.md`.

### G (`0.25.11`) — the recency bet, measured from both sides

F said the term was unvalidated and the one measurement pointed against
it. Building the instrument to settle it **reversed the headline**, which
is the best argument in this whole run for not acting on one-sided
evidence.

`16-recency` is the only fixture with git history. `evals:setup` builds
it from `RANKING_REFERENCE_DATE` in four tranches (90/20/9/3 days), so
its ages hold instead of decaying with the wall clock, and at 34 findings
it clears the depth floor. Two scenarios, chosen to test the premise
from **both** sides rather than to confirm it:

| scenario | answer lives in | on | off | |
|---|---|---|---|---|
| `plan-16-checkout-rollout` | `src/checkout/`, 3 days | **0.844** (rank 1) | 0.425 (rank 15) | **+0.418** |
| `review-16-whole-repo-audit` | `src/legacy/`, 90 days | 0.327 (rank 12) | **0.456** (rank 5) | **−0.129** |

The earlier evidence was not wrong, it was **one-sided**: fixture 15's
only recency-sensitive scenario happened to be a whole-repo question,
and posthog's `agent_risk` comparison has no notion of what the user is
asking. Given a question about active work the term moves the finding
you need from 15th to 1st.

So it is a **strong, unlabelled bet that the reader cares about what the
team is currently touching**, paying about three times more when right
than it costs when wrong — not the defect F was heading toward calling
it. What is still open is whether the default should make that bet
silently.

**And it exposed a second half of the same hole.** `recency` was pinned
at `0.25.7`; `churn`'s window was not. `git log --since="90 days ago"`
resolves against the system clock, so this fixture's churn would have
decayed as real days passed while its recency held. Both are now
anchored to the same reference — `normaliseSince` returns an absolute
instant, with calendar-correct months and years rather than 30- and
365-day approximations — and `referenceNowMs` moved to
`util/reference-clock.ts` so that `git/churn.ts` reading it does not
make a cycle with `scoring/build.ts`.

## 9. Outcome

`0.25.0` → `0.25.5`, five patch bumps, **zero agent calls**.

| stream | bump | what landed |
|---|---|---|
| S1 | `0.25.1` | bands re-derived (±5pp claude / ±7pp codex), scorer case-sensitivity fixed, `evals:replay --version/--out` and `evals:variance --dirs` added |
| S2 | `0.25.2` | universal ladders for `circular_dependency` and `deep_import`; 204 corpus findings move |
| S3 | — | both conditions shown unportable; no code, no bump |
| S7 | `0.25.3` | test-only bucket exempted; 63 corpus findings removed |
| S5 | `0.25.4` | two scenarios; the `STRUCTURAL_CEILING` claim now asserted |
| S6 | — | closed with a measurement; nothing corroborates anywhere |
| S4 | `0.25.5` | four constant gaps reconciled; 1,457 corpus findings move |
| A | `0.25.6` | churn silently lost through a symlinked scan root; first real deep-mean movement |
| E | `0.25.7` | ranking clock pinned; the metric stops drifting with the calendar |
| C | `0.25.8` | risky-service registered as fixture 15 — **D2 closed** |
| B | `0.25.9` | `commented_out_code` on one ladder; a published anchor made reachable |

The thesis held: D1 is closed apart from `weak_test_signal`, which
turned out not to be a constant gap at all — see D above. `commented_out_code` closed in `0.25.9`; both exception
tables for shape gaps and same-directory twins are now empty.

**D2, D3, D4 and D5 are all closed too.** What the queue after the plan
added was not more of the plan — it was two defects in the instruments
the plan told me to trust.

**The one that did not go to plan is S1**, and it is the one that
matters most for the next release: `structural_pass_rate` cannot resolve
a release at 48 scenarios, and saying so is worth more than any of the
scoring changes. Resolving a 2pp move needs roughly 283 scenarios for
claude and 468 for codex. Until then a full agent run is a smoke test on
the wire output, and `evals:ranking` is the instrument.

---

## 8. Corrections to this plan, as they were found

### S1 (`0.25.1`)

1. **§4 S1 offers two explanations for `review-05-permission-and-parallel`
   and the answer is neither.** It is not an unstable scenario and its
   rubric is not ambiguous. The scorer matched charge names
   **case-sensitively**, so codex writing "Permission IA drift" instead
   of "Permission IA Drift" scored zero on a finding it had named
   correctly, in a response that was otherwise as good as the one before
   it. Three of that scenario's seven assertions were case alone. Fixed
   in `0.25.1`.

2. **§1 D5 and §4 S1 say the codex band is wrong. It is wrong in the
   other direction too.** The documented pair was ±6pp claude / ±3pp
   codex — codex the steadier agent. Both repeat pairs put codex's band
   *wider*: ±5pp claude, ±7pp codex. The `0.12.1` ordering was an
   artefact of estimating a standard deviation from three points.

3. **The −5.1pp that motivated the stream is −3.2pp.** Under the fixed
   scorer, codex's stable-48 move across `0.24.0` → `0.25.0` is
   −3.2pp, comfortably inside the re-derived band. `0.25.0`'s release
   notes state −5.1pp; that figure was part scorer defect.

4. **§4 S1 says "two same-input samples on disk". There are four.**
   `0.21.0`/`0.22.0` is a second pair, already documented in
   `evals/README.md` and not referenced by the plan. Using both roughly
   halves the error on the band estimate.

5. **`0.22.0` is not a clean repeat sample of `0.21.0`.** Its run
   recorded an **empty `scan_context` for all four `monorepo`
   scenarios**, so 8 of its 96 results were scored slug-only against
   `0.21.0`'s fully-resolved ones — and two of those 8 are among the
   largest movers the README quotes as evidence of agent instability.
   `evals:variance` now excludes such pairs and reports the count.

6. **`evals:variance` was under-reporting every band it printed.** It
   divided the sum of squared deviations by n rather than n−1, which at
   n=2 understates the standard deviation by 29%. Corrected, which
   also means the `0.12.1` per-scenario σ values in the README were
   biased low as published.

7. **The stream was costed as "analysis only" and it was not.** Getting
   two samples onto one scorer needed `evals:replay --version/--out`,
   and comparing across version directories needed `evals:variance
   --dirs`. Neither existed. Still zero agent calls.

### S2 (`0.25.2`)

1. **§2 calls TypeScript's `deep_import` 0.30 "`NEUTRAL_INTRINSIC` — the
   exact value `0.23.0` shipped to stop findings falling back to". It is
   not a fallback.** `INTRINSIC_DEFAULTS` declares `deep_import: 0.3`
   with a stated anchor ("Reaching past a package boundary.
   Mechanical."). The coincidence of value is just a coincidence; the
   detector was never reaching `NEUTRAL_INTRINSIC`. The shape defect is
   real either way — a flat value cannot escalate — but the rhetorical
   framing was wrong.

2. **§2's example is right about the intrinsics and wrong about the
   scores.** "An 8-module Python import cycle reaches `0.92`; the
   identical TypeScript cycle is fixed at `0.45`" describes the
   *intrinsic*. Both charges are in `STRUCTURAL_TYPES`, so both are
   scaled by `STRUCTURAL_CEILING` (0.3) afterwards. The visible
   `agent_risk` gap between those two cycles is about 0.06, not 0.47.

3. **The plan's warning that "a ramp is pointless if every cycle is 2
   modules" nearly came true, and would have if the corpus had been
   sampled.** hono and cal.com together hold 7 `circular_dependency`
   findings, of which one is not a 2-file ring. Across all ten repos
   it is **48 findings, 27 of them above the floor** — including rings
   of 20, 99 and 1,131 files. **Do not conclude a distribution from two
   repos.**

4. **The constants were not anchored to the Python pack's, deliberately,
   so both entries moved to `KNOWN_DISAGREEMENTS` rather than being
   deleted.** `circular_dependency` 0.45/0.06/0.70 vs python
   0.68/0.07/0.92, because the python base is argued on `ImportError` at
   import time and TypeScript has no such failure. `deep_import`
   0.30/0.05/0.55 vs 0.40/0.06/0.75, because the two detectors fire on
   different populations. `KNOWN_SHAPE_GAPS` is now empty, which is what
   §4 S2 actually asked for.

5. **The eval fixtures barely exercise either detector, and this is the
   measurement, not a footnote.** Across all 14: two `deep_import`
   findings and one `circular_dependency`, all at or near the ladder
   floor. Exactly one finding moves (0.10 → 0.11) and `evals:ranking`
   is byte-identical. A change that moves 204 corpus findings is
   invisible to the fixture set — which is an argument for S5 that S5
   does not currently make.

### S3 — both entries closed as findings, no code change

§4 S3 said "be willing to stop". Both stopped, for different reasons,
and neither is the "unported improvement" the parity table claimed.

1. **`direct_date`'s naive-parse surcharge cannot exist in
   JavaScript.** Python's base rises to 0.55 when `datetime.now()` is
   called without `tz=`, because the result carries no offset. JS has no
   naive/aware distinction at all — `Date.now()` and `new Date()` always
   produce an absolute instant. There is no condition to test. The
   nearest JS hazard, `new Date("2026-12-20")`, is about the *string*
   rather than the clock read and already has its own charge,
   `timezone_unsafe_parse`.

2. **`sync_io_in_hotpath`'s async-handler base is available and
   wrong.** This one is the trap. The syntax exists — JS has `async`
   functions, and adding the flag to the parser's `EnclosingFunction`
   is a small change. But the surcharge encodes "the event loop, not one
   worker in a pool", and **Node has no pool**: `readFileSync` blocks
   the single event loop whether or not the enclosing function is
   `async`. Porting it would score a difference that does not exist, and
   would imply the sync call is more acceptable in a non-async handler.

   Worth stating because the plan's own test — "does it have an
   async-handler shape?" — answers *yes* and gets the wrong result. The
   question that decides it is what the condition *means*, not whether
   it can be computed.

3. **Two constant gaps were hiding behind the conditions, and are now
   S4's.** With the surcharges set aside: `direct_date` differs only in
   cap (0.85 vs 0.88) — base and step already agree.
   `sync_io_in_hotpath` differs in base (0.55 vs 0.50) and step (0.08 vs
   0.06). Neither was visible while the entry said "unported
   improvement", so S4's list of three is really a list of five.

### S7 (`0.25.3`)

1. **§4 S7 says "both readings are defensible, which is exactly the
   shape of the `task_runner.py` decision". It is not that shape, and
   the data is not evenly balanced.** Inspected rather than reasoned
   about, the test-only bucket across all four Python corpus repos is
   **63 findings in 36 modules, every one of them developer or CI
   tooling** — `scripts/ci/prek/` pre-commit hooks, `scripts/ci/`
   analysis scripts, `dev/` release tooling, one `examples/`. Each is
   referenced exactly once, by its own unit test in a mirrored test
   tree. Nothing in the bucket is a plausible hot path. `task_runner.py`
   was the opposite case: 42 references, from non-test code.

2. **The load-bearing part of the exemption is the `__main__` guard, not
   the reference count**, and the plan's framing obscures that. The
   modules the zero bar protects against — reached by `python -m`,
   `entry_points`, Django settings, DAG discovery by path — have *zero*
   textual references, so they were already exempt. Widening to
   test-only adds only modules that have a test, and a guarded module
   whose sole mention in the repository is its own unit test is a script
   with a test.

3. **§1 D4 says 60 findings; it is 63, and only 50 of them are
   airflow's.** mlflow contributes 13. zulip and pydantic contribute
   none. Measured effect: airflow 9,793 → 9,743, mlflow 6,413 → 6,400,
   nothing added anywhere, every removed file under `scripts/`, `dev/`
   or `examples/`.

4. **No Python fixture has a `__main__` guard**, so none of the 14 is
   eligible for this exemption and all scan identically. Same coverage
   hole S2 hit from the other direction.

### S6 — closed with a measurement, no code

Full write-up in `docs/dogfooding/2026-08-11-tooling-excludes-js.md`.
§4 S6 offered "if the answer is 'nothing corroborates anywhere', the
entry closes with a measurement". That is the answer.

1. **Zero patterns corroborate on any of `hono`, `cal.com`, `n8n`,
   `posthog`.** The mechanism would exclude nothing however many readers
   were written.

2. **`.eslintignore` does not exist on this corpus.** ESLint 9 replaced
   it with flat-config `ignores`. The plan named a dead format.

3. **The plan named the wrong `.gitattributes` attribute.**
   `linguist-vendored` appears once in four repos; `linguist-generated`
   appears 30 times and names real generated source.

4. **Root `tsconfig.exclude` names nothing crimes does not already
   exclude.** The substance is in the 12–86 *nested* tsconfigs per repo,
   which the root-only rule deliberately does not read.

5. **The corroboration rule is load-bearing, and the plan's doubt about
   `linguist-vendored` was aimed at the wrong file.** n8n's
   `.prettierignore` ends `# Handled by biome` / `**/*.ts`. Read as a
   maintenance claim that excludes **18,783 TypeScript files** — the
   whole repo. The rule that decides this is not a weighting: a tool's
   *preferences* need corroboration; a *provenance* claim
   (`linguist-generated`, `@generated`, `DO NOT EDIT`) does not, and
   crimes already trusts the latter from a single source.

6. **Sized follow-up, taken in `0.25.10`:** reading
   `linguist-generated` into the never-reportable policy catches 4
   posthog files carrying **69 findings** that `GENERATED_RE` misses.
   Measured exactly as sized — posthog 14,250 → 14,181, nothing added,
   no surviving score moved, cal.com unchanged, no fixture affected.

### S5 (`0.25.4`) — the two free ones landed; the seven did not

1. **§4 S5's correction to the `0.25.0` notes is right.** Fixture 01
   does fire `contract_drift` (2, both high, on `src/api/state.ts`) and
   `dependency_provenance_gap` (1, on `package.json`). Both now have a
   scenario. `evals:verify-scenarios` reconciles 53.

2. **The `STRUCTURAL_CEILING` claim holds, and now something asserts
   it.** On fixture 01, `contract_drift` ranks 10th and 11th of 42 with
   **no structural finding above it at all**. That is what the ceiling
   was written for, and until this scenario existed nothing checked it.

3. **The other new scenario immediately found something — and I read it
   wrong.** `dependency_provenance_gap` ranks 35th of 42 on fixture 01,
   nDCG 0.19, with `agent_risk` 0.22 against a declared intrinsic of
   0.55. I recorded that as a manifest problem: a charge buried because
   `package.json` has no churn, tests or importers.

   **That was wrong, and the commit message for `0.25.4` says it.** On
   the corpus the same charge scores **0.25–0.42**, because a real
   `package.json` does churn. Checked properly (§8 A), *every one of
   fixture 01's 42 findings* has `churn: 0` — the observation was about
   the fixture, not the charge, and not about manifests.

   Chasing why produced the actual defect. See A below.

4. **§4 S5 is wrong about `duplicated_policy`, and following it would
   have encoded a bug.** The claim is that "the self-scan flags it 13
   times in `dependency-provenance-gap.ts`, so this repo is its own
   fixture". The self-scan flags it **once**, spanning 12 files; the 13
   is a count of *variants inside that one finding*, and
   `dependency-provenance-gap.ts` is merely where variant C lives.
   Worse, the finding looks like a **false positive**: the 13 "variants
   of one rule shape" are unrelated discriminated-union checks —
   `h.kind === "add"` in `dst-naive-arithmetic.ts` against
   `verdict.kind === "bland_fallback"` in `swallowed-error.ts`. There is
   no policy there. Using this repo as the `duplicated_policy` fixture
   would pin a false positive as expected behaviour.

5. **Not done: fixture content for the seven.**
   `agent_permission_sprawl`, `config_drift`, `duplicated_policy`,
   `finder_duplicate_filename`, `mock_saturation`,
   `pass_through_abstraction`, `unsafe_retry` remain referenced by no
   scenario. The self-scan fires none of them, so none is free. This is
   new fixture authoring and belongs in its own bump; `duplicated_policy`
   should start from the false positive above rather than from the plan's
   recommendation.

### S4 (`0.25.5`) — four of five, and it was not a matter of taste

1. **§4 S4 calls this "the only part of D1 that is purely a matter of
   taste". It is not, and the tiebreak was already in the tree.**
   `detector-defaults.ts` publishes a list of 29 expressed agent-signal
   bases, and **every entry in `INTRINSIC_DEFAULTS` was anchored against
   a value in that list**. All three disputed charges appear there with
   their *universal* value — `mixed_utc_local_methods` 0.65,
   `sync_io_in_hotpath` 0.55, `boolean_naming_drift` 0.35. The Python
   bases (0.62, 0.50, 0.30) appear nowhere and nothing was calibrated
   against them. So the reconciliation direction is decided by which
   number has dependents, not by preference: moving the published one
   would silently invalidate its peers.

2. **The list was three and is five** — see S3. `direct_date`'s cap
   (0.88 → 0.85) and `sync_io_in_hotpath`'s base and step
   (0.50/0.06 → 0.55/0.08) were hidden behind the "unported improvement"
   wording.

3. **Where the two sides count different units, only the base is
   reconciled.** `mixed_utc_local_methods` keeps its Python step of 0.06
   against the universal 0.10, because JS counts UTC/local method calls
   on one receiver and Python — which has no such method pairs — counts
   naive/aware mixes. A shared judgement about the charge with its own
   ramp is the right shape; forcing the step would be parity theatre.

4. **Measured: 1,457 findings move, none appear or disappear.**
   `sync_io_in_hotpath.py` 1,112 (+0.02..+0.05), `boolean_naming_drift.py`
   336 (+0.02..+0.04), `direct_date.py` 9 down (−0.01..−0.02, the capped
   tail only). Every affected finding set is byte-identical before and
   after on all five Python repos.

5. **`mixed_utc_local_methods.py` has zero findings on the entire
   corpus**, so its base change is unobservable outside the fixtures —
   where it does fire, and moves 0.47 → 0.48. Worth knowing before
   anyone quotes it as a result.

6. **`commented_out_code` deliberately not taken, and it is not a
   constant gap.** The two twins count different units (statements vs
   consecutive comment lines) and the js one does not route through
   `intrinsicFrom` at all — it is a hand-rolled `base + n*step` rather
   than `base + (n-1)*step`, so even adopting its constants verbatim
   moves scores. Reconciling means first deciding what one unit of
   evidence is for the charge. Unlike the cross-pack pairs there is no
   language argument available: both emit the same `type` into one
   report.

### Not done in this sprint

- **S5's seven fixtures.** New fixture authoring, own bump.
- **`commented_out_code`.** See S4 above.
- **`weak_test_signal`**, the widest of the eight gaps, which §4 S4 did
  not include and which the parity table still says "needs its own
  argument".
- **`dependency_provenance_gap`'s manifest problem**, found by S5:
  `agent_risk` collapses to the formula floor because `package.json` has
  no churn, tests or importers.
- **P2.1, P2.2, P2.4, P3.1, M6** — deferred by §5 and untouched here.
   `agent_permission_sprawl`, `config_drift`, `duplicated_policy`,
   `finder_duplicate_filename`, `mock_saturation`,
   `pass_through_abstraction`, `unsafe_retry` remain referenced by no
   scenario. The self-scan fires none of them, so none is free. This is
   new fixture authoring and belongs in its own bump; `duplicated_policy`
   should start from the false positive above rather than from the plan's
   recommendation.
