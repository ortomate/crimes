# `direct_date`: the second R3 precision item, and the example that was wrong

**Charge:** Temporal Recklessness.
**Complaint:** [field notes](./2026-08-05-choreograph-field-notes.md) —
"conflates reading time with recording it… the genuinely risky case —
time used in a **branch or comparison** — is a much narrower and more
valuable signal than time used as a value to record or display."
**Status vs `main`:** [re-verified](./2026-08-05-choreograph-reverify.md)
— 91 findings, and the cited evidence string reproduced byte-identically.

---

## The framing is right. The example is not.

The notes cite `src/components/admin/JobDetail.tsx`:

> As shipped, `JobDetail.tsx` reports "9× Date.now(), 4× new Date()" and
> essentially all of it is display formatting.

Opening the file — the rule this codebase keeps re-learning — found:

```ts
// line 870
if (Date.now() - startedAt >= VIDEO_POLL_TIMEOUT_MS) {
  clearInterval(poll); clearInterval(ticker)
```

and the same shape again at line 1086 for the audio poll. Plus line 642,
`const now = Date.now()` feeding a comparison.

**Three of the thirteen decide a branch**, and a poll timeout is exactly
the case the notes describe as the valuable one. "Essentially all of it
is display formatting" is not true of this file.

So the narrowing as proposed — report only comparisons — **would not
have fixed the complaint about this file**, because the file would have
kept the finding. What was actually wrong is that the evidence could not
tell the reporter which three of the thirteen mattered. The count was
right; it just could not be acted on.

**Where the notes were wrong:** they generalised from an evidence string
to the code behind it. `9× Date.now(), 4× new Date()` says nothing about
what the readings are *for*, so a reader scanning a component full of
`formatTs()` calls will reasonably conclude they are all formatting. The
detector invited the wrong conclusion, and then got blamed for the
conclusion rather than for the invitation.

---

## The fix: say which ones, don't hide any

`DateUse` gains `usage: "compared" | "value"`, classified in the parser
by walking up from the reading:

- **`compared`** — reaches a relational/equality operator, or sits in an
  `if` / `while` / `for` / ternary condition. Arithmetic, parentheses,
  `.getTime()` and non-null assertions are transparent, because
  `Date.now() - startedAt >= TIMEOUT` is the canonical shape and the
  reading is three nodes down from the comparison.
- **`value`** — consumed by a call argument, a property assignment, a
  return, a template literal, JSX.
- **one hop through a local binding**, because `const now = Date.now()`
  followed by `now > deadline` is at least as common as the inline form.
  One hop only: this is a syntax walk, not dataflow, and a second hop
  would be guessing.

**Unknown resolves to `compared`.** A wrong answer in that direction
leaves a finding's severity where it already was; the other direction
silently downgrades a real one. (The one-hop scan needed a re-entry
guard — the declaration's own name is a reference to itself, and the
first version recursed until the stack ran out.)

Evidence gains one line:

```
9× Date.now(), 4× new Date()
3 decide a branch or comparison (lines 642, 870, 1086); 10 only record or render the reading
lines: 47, 637, 642, 661, 705, 868, 870, 885, 921, 1084, …+3 more
a reading in a comparison changes what the code does — tests cannot pin
the behaviour without controlling the clock
```

That is the same finding the reporter dismissed, now pointing at the two
poll timeouts.

Severity gains one rule: **a file whose readings are all `value` caps at
`medium`**, however many there are. Thirteen `new Date().toISOString()`
calls writing timestamp columns is a real testability cost and a real
finding; it is not a poll timeout, and calling it `high` on volume alone
is what made this detector read as noise on a component that formats a
lot of dates.

---

## Measured

choreograph.cc @ `5107cce`:

| | before | after |
|---|---|---|
| `direct_date` findings | 91 | **91** |
| high | 4 | **1** |
| medium | 54 | 57 |
| low | 33 | 33 |

**No finding is hidden**, which is the deliberate outcome: the notes'
own example proves the narrowing-as-a-filter would have been wrong.
Three files move `high → medium`, each with the reason on the finding:

```
src/app/api/cron/daily-generate/route.ts   none decide a branch — all 11 record or render the reading
src/app/[person]/[date]/page.tsx           none decide a branch — all 19 record or render the reading
scripts/_telos-andrew-conversations.ts     none decide a branch — all  8 record or render the reading
```

`JobDetail.tsx` **stays `high`**, correctly, and now names lines 642,
870 and 1086 out of its thirteen.

Eval fixtures: **0 of 15 moved** — fingerprints *and severities*
compared, since this change moves severity. `evals/results/0.18.4/`
stands; a re-run could only measure agent nondeterminism.

---

## What this does not do

It does not attempt dataflow. `const now = Date.now(); pass(now)` where
`pass` compares is classified `value`. That is the conservative
direction for a *severity* rule but the wrong one for a *filter*, which
is another reason this landed as evidence-and-severity rather than as a
gate.

It does not touch the `low` band. A single clock read in a file is still
`low`, and 33 of choreograph's 91 are exactly that.
