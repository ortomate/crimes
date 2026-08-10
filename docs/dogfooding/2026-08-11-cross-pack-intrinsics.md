# The same charge is scored differently depending on the language

Audit of backlog item **P2.3**, run during R7. The entry named two
disagreeing pairs, both found incidentally, and guessed "the set is
probably larger."

**It is 7 of 8.**

## What was audited

A *cross-pack charge* is one finding type implemented by more than one
detector. There are 8: every file in `packages/core/src/detectors/` that
has a same-named sibling in `packages/core/src/detectors/py/`.

Both packs compute the intrinsic with the identical formula —

```
round(clamp01(min(base + (count - 1) * step, cap)))
```

— so the constants are directly comparable. The Python side factors it
into `intrinsicFor({count, base, step, cap})` in `py/shared.ts`; the
universal side inlines the arithmetic in each detector. **Same formula,
duplicated by hand.** That duplication is the mechanism of the drift.

## The table

| charge | universal (TS/JS) | python | how they differ |
|---|---|---|---|
| `large_function` | shared helper | shared helper | **agree** |
| `boolean_naming_drift` | 0.35 / 0.06 / 0.70 | 0.30 / 0.05 / 0.60 | python uniformly lower, floor *and* ceiling |
| `mixed_utc_local_methods` | 0.65 / 0.10 / 0.90 | 0.62 / 0.06 / 0.90 | same cap, python ramps at 60% the rate |
| `direct_date` | 0.45 / 0.07 / 0.85 | 0.45 **or 0.55** / 0.07 / 0.88 | python adds a naive-parse surcharge the universal side has no concept of |
| `sync_io_in_hotpath` | 0.55 / 0.08 / 0.90 | 0.50 **or 0.70** / 0.06 / 0.90 | python conditions the base on `inAsyncHandler`; universal does not |
| `weak_test_signal` | **0.68 / 0.58 binary** | 0.32 / 0.045 / 0.72 | not a ladder at all on the universal side; bases differ by **0.26** |
| `circular_dependency` | **flat 0.45** (declared default) | 0.68 / 0.07 / 0.92 | universal expresses nothing and cannot escalate |
| `deep_import` | **flat 0.30** (declared default) | 0.40 / 0.06 / 0.75 | universal expresses nothing and cannot escalate |

## Three kinds of divergence, not one

**1. Different constants for the same shape.** `boolean_naming_drift`,
`mixed_utc_local_methods`. Ordinary drift between two hand-maintained
copies.

**2. Different shape.** `circular_dependency` and `deep_import` express
no intrinsic on the universal side, so they take a **flat** value from
`INTRINSIC_DEFAULTS` while Python gets a ramp. One side escalates with
evidence and the other cannot, whatever the evidence says. A circular
dependency among 8 Python modules can reach **0.92**; the identical
cycle in TypeScript is pinned at **0.45** no matter how large it gets.
`deep_import` on the universal side sits at **0.30** — which is
`NEUTRAL_INTRINSIC`, the exact value the whole of `0.23.0` was written
to stop findings falling back to.

**3. Extra conditions on one side only.** `direct_date`'s naive-parse
surcharge and `sync_io_in_hotpath`'s async-handler base exist only in
Python. Both look like genuine improvements that were never ported.

## Why this matters, in one sentence

**In a polyglot repo, `crimes` ranks the same defect differently
according to which language it is written in** — and since
`rank_score = agent_risk * (1 + recency * 0.5)`, that difference decides
what an agent reads first. A JS test with no assertions scores 0.68; the
identical Python test starts at 0.32.

## The direction is not consistent

Python is *higher* for `circular_dependency` and `deep_import`, *lower*
for `boolean_naming_drift` and `weak_test_signal`. So this cannot be
corrected with a single per-pack offset — every pair was chosen
independently, and each needs its own argument. That is precisely why
this audit **reports and does not fix**: seven simultaneous scoring
changes in one baseline would be unattributable, which is the rule the
`0.23.0` / `0.24.0` split exists to enforce.

## What should happen next, in order

1. ✅ **Give the universal pack `intrinsicFor`.** **Done.** One
   `intrinsicFrom(count, {base, step, cap})` in
   `packages/core/src/scoring/intrinsic.ts`; the 14 universal detectors
   that inlined the arithmetic now call it, and `py/shared.ts`'s
   `intrinsicFor` delegates to it, so exactly one copy of the formula
   exists. Eleven now-dead local `round` helpers removed.

   **Proven findings-neutral** on 5,164 findings across cal.com (4,633),
   hono (377), and fixtures 01/02/05 — chosen because these are
   universal detectors and the corpus repos measured earlier are Python.
   All 14 are exercised (739 findings from them). Zero added, zero
   removed, zero scores moved; `evals:ranking` byte-identical.
2. **Close the two shape gaps** (`circular_dependency`, `deep_import`).
   These are the largest and the easiest to argue: a detector that
   cannot escalate with its own evidence is a defect regardless of which
   constant you prefer. Own bump, own attribution.
3. **Port the two one-sided conditions** (`direct_date`,
   `sync_io_in_hotpath`) if they survive review as improvements.
4. **Reconcile the three ordinary constant gaps last** — they are the
   least consequential and the most arguable.

✅ **The standing gate landed with step 1**:
`packages/core/src/scoring/intrinsic-parity.test.ts` reads the detector
tree, extracts both packs' ladders for every twice-implemented charge,
and fails on any disagreement not listed in `KNOWN_DISAGREEMENTS` /
`KNOWN_SHAPE_GAPS` with a reason. Reconciling a charge means deleting a
line. A second assertion fails when an exception stops describing
anything real, so the table cannot rot into a blanket suppression.

Mutation-checked rather than assumed: removing the
`mixed-utc-local-methods` entry fails the build with the expected
message. The first draft of the gate matched `intrinsicFrom` but not
`intrinsicFor`, so it passed **vacuously** — worth naming, because a
parity gate that silently sees nothing is exactly the apparatus failure
this repo keeps finding.

## Relationship to P2.4

P2.4 says 41 intrinsics are still literals inside their own detectors.
This audit is what that costs: the two things most likely to drift are
a constant nobody can see and a constant that exists in two places.
Both are true of every row above.

---

# Appendix — B (`sync_io_in_hotpath`) : the named signal also fails, and why

Recorded here rather than in a second file because it was found in the
same session. **§9 of the 2026-08-03 remediation doc names a third
signal as "the one that would work". It does not.** But measuring why
produced a fourth that does.

## The chain, traced

§9's counter-example is
`task-sdk/src/airflow/sdk/execution_time/task_runner.py` — a guard at
line 2441 of 2442, production code, two findings the doc says are
**correctly reported**. The proposed rule was: *a function every one of
whose same-file call paths starts inside the guard, in a module nothing
imports*.

Traced in the file:

```
_send_error_email_notification (2010) ← finalize (2245) ← main (2340) ← guard (2441)
_handle_trigger_dag_run        (1874) ← run      (1529) ← main (2340) ← guard (2441)
```

`finalize` and `run` have **no other same-file caller**. So every
same-file call path to both flagged functions does start inside the
guard, and crimes reports the module at 0 direct importers. **The
proposed rule exempts them.** All three candidates now fail on the same
file.

## The fourth signal

Candidate 2 failed because it asked the *import graph*, and airflow
launches this module with `python -m`. But the module is not invisible —
it is referenced 42 times across the repo, including
`mock.patch("airflow.sdk.execution_time.task_runner.startup")`, which is
a string the import graph cannot see.

So: **count textual module references, not graph edges.** Measured over
all 227 guarded airflow findings (137 files):

| bucket | files | findings | exempt? |
|---|---|---|---|
| nothing references the module at all | 94 | **151** | yes — safe |
| referenced only by tests | 35 | 60 | judgement call |
| referenced by non-test code | 8 | 16 | **no** |

`task_runner.py` lands in the last bucket — **42 references, 29 of them
non-test — so it is correctly kept.** The signal that defeated three
candidates is discriminated by the fourth on its first try.

## The decision §9 asked for, made

**`task_runner.py` stays reported.** A task-runner process is one-shot,
but the deciding fact is not its lifetime — it is that 29 non-test files
in the repo reference the module by name. Code that much of the codebase
talks about is load-bearing, and a blocking email send inside it is
worth saying whatever launches it. The one-shot reading would also
exempt every `manage.py`-style entry point in every Django repo, which
is a much larger silent suppression than the one being bought.

## Scope

Conservative rule for a first cut — exempt only the **151 findings in
the 94 modules nothing references at all**, leaving the 60 test-only
ones reported. That is 18.6% of airflow's `sync_io_in_hotpath` output
and **1.5% of its report**, keeps the counter-example, and the
test-only bucket can be revisited with its own argument.

Not built in this session. It needs a repo-wide module-reference index
in the Python pack, which is real work and belongs behind its own bump
and its own attribution.
