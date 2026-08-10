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

1. **Give the universal pack `intrinsicFor`.** The formula is already
   identical; extracting it removes the mechanism of the drift without
   changing a single number. Findings-neutral, so it can land any time.
2. **Close the two shape gaps** (`circular_dependency`, `deep_import`).
   These are the largest and the easiest to argue: a detector that
   cannot escalate with its own evidence is a defect regardless of which
   constant you prefer. Own bump, own attribution.
3. **Port the two one-sided conditions** (`direct_date`,
   `sync_io_in_hotpath`) if they survive review as improvements.
4. **Reconcile the three ordinary constant gaps last** — they are the
   least consequential and the most arguable.

A standing gate belongs with step 1: once both packs call one helper, a
test can assert that any charge implemented twice declares the same
`(base, step, cap)`, or names why not. Without that this table is a
snapshot that rots.

## Relationship to P2.4

P2.4 says 41 intrinsics are still literals inside their own detectors.
This audit is what that costs: the two things most likely to drift are
a constant nobody can see and a constant that exists in two places.
Both are true of every row above.
