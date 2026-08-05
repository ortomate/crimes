# R4 pre-measurements: two queue entries checked before acting

Taken while the `0.21.0` eval run was in flight, so nothing here has
been applied. Both entries turn out to be wrong about their own numbers,
in opposite directions.

---

## `large_file` counts blank lines — the impact is 2–4× smaller than the entry claims

**The entry:** "Fixing it drops every number **15–25%** and retunes
thresholds repo-wide — calibration, not a bugfix."

**Measured**, on every file currently carrying a `large_file` finding:

| repo | n | blank share, all | **code files** | prose files |
|---|---|---|---|---|
| choreograph.cc | 33 | 12.2% | ~10% | ~20% |
| crimes (self-scan) | 100 | 5.6% | **3.6%** | 18.8% |
| hono | 26 | 8.9% | **8.9%** | — |

**The 15–25% figure is wrong**, and the way it is wrong matters. The
high numbers come almost entirely from **prose** — `docs/superpowers/plans/*`
runs 19–23% blank, because markdown is blank-line separated by
construction. Actual source files run **3.6–10%**.

And prose already has its own budget: the `docs` shape `0.17.0` added
gives `.md` / `.mdx` / `.rst` / `.adoc` / `.txt` a 1000-line allowance at
`low`/`medium`. So the file class where the correction would bite
hardest is the one already measured against a different ruler.

On choreograph, **5 of 33** findings would fall below the 300-line
domain threshold. On the crimes self-scan a 3.6% shift is inside the
noise of any threshold worth having.

**Revised disposition:** this is closer to a bugfix than the entry
allows. A function named `countNonEmptyLines` that counts every line is
a naming lie — the kind `name_behavior_mismatch` exists to charge — and
the corrected number moves code files by single digits. It still needs a
baseline and an `evals:ranking` pass, but "retunes thresholds repo-wide"
overstates it.

```ts
// packages/language-js/src/parse/utils.ts
export function countNonEmptyLines(source: string): number {
  const lines = source.split(/\r?\n/);
  let total = lines.length;
  if (total > 0 && lines[total - 1] === "") total -= 1;   // only the trailing one
  return total;
}
```

**Where the entry was wrong:** it estimated the impact from prose-heavy
files without separating them, and prose is exactly the class that was
given its own threshold three releases ago.

---

## The cross-file Python fixture — the obvious version of it proves nothing

**The entry:** "Add a fixture with a base-class assertion helper and one
with an imported one, so the suite can see this class of change at all.
Cheap; can move earlier than R4."

It is cheap. It is also easy to build a version that **does not work**,
and the first attempt here was one.

A fixture was written with `assert_invoice_balances()` imported from
`tests/support.py` and `self.assert_gross_for()` inherited from a base
class. Scanned with both builds:

| build | `weak_test_signal` findings |
|---|---|
| `0.17.0` (pre symbol index) | 1 |
| current (post symbol index) | 1 |

**No difference.** The same-file matcher has always been
`/^assert[A-Z_]/`, and `assert_invoice_balances` matches it — `assert`
followed by `_`. This is precisely what §4.1 recorded when the original
blocker was closed:

> **The premise in this entry was partly wrong**: the existing matcher
> `/^assert[A-Z_]/` already credited `assert_valid_user()`, because
> `assert` is followed by `_`. The real false positive is the helper
> *not* named `assert*` — zulip's `self.verify_action()`.

Renaming the helpers to `verify_invoice_balances`, `expect_gross_for`
and `expect_account` — the shape that actually needs the index:

| build | `weak_test_signal` findings |
|---|---|
| `0.17.0` (pre symbol index) | **2** — including `tests/test_invoices.py` |
| current (post symbol index) | **1** — `test_invoices.py` correctly credited |

Now the fixture can see the change. `tests/test_reporting.py` still
fires in both, which is the guard that the fixture did not simply go
quiet.

**Where the entry was wrong:** "a base-class assertion helper and one
with an imported one" describes the *location* of the helper and says
nothing about its *name*, and the name is what decides whether the old
matcher already handled it. A fixture built to the entry's letter would
have been committed, passed review, and measured nothing — the same
failure the entry exists to fix, one level up.

Ready to apply, validated both ways:

```
evals/fixtures/12-py-tested/
  billing/invoices.py          # build_invoice / apply_credit
  tests/support.py             # verify_invoice_balances + InvoiceCase base
  tests/test_invoices.py       # 5 tests, none containing a bare assert
```

Needs its own eval baseline, since it changes what the agents are shown.

---

## `transitiveImporterCount` counts a file as its own importer — measured, and the answer is no change

**The entry:** "Left deliberately; it is the number `blast_radius`
normalises. Now that `blast_radius` is log-scaled with a direct-count
term, worth revisiting."

Two things were measured.

**First, the saturation that motivated the log scale is gone.**
`blast_radius == 1.0` used to sit on **47%** of findings, which is what
`0.18.1` set out to fix:

| repo | files with a transitive count | `blast_radius == 1.0` |
|---|---|---|
| choreograph.cc | 208 | **0 (0.0%)** |
| crimes (self-scan) | 1,136 | **0 (0.0%)** |
| hono | 152 | **0 (0.0%)** |
| cal.com | 2,079 | **0 (0.0%)** |

The log scale worked. There is no longer a compressed band at the top
for an off-by-one to hide in — but there is also no longer a score
crying out for correction.

**Second, how many files the self-count can even reach:**

| repo | files on a reported cycle | share |
|---|---|---|
| choreograph.cc | 0 of 207 | 0.0% |
| crimes (self-scan) | 1 of 1,169 | 0.1% |
| hono | 4 of 152 | 2.6% |

**Disposition: no change, and this is the §15 shape** — the entry's
premise is sound but acting on it buys nothing. The defect is real (a
file on a cycle counts itself), it is confined to 0–2.6% of files, and
its magnitude is **+1 on a log-scaled input**. Changing it would move a
handful of scores by less than a rounding step and invalidate a
baseline for the privilege.

What is *not* wrong is the honesty: the function's doc comment already
says what it computes —

> the result is "files that can reach this one, plus this one if it is
> cyclic", not a fan-in count

— and `blast_radius_direct_importers` has existed since `0.5.0` for
anyone who wants the fan-in number. Nothing is lying, which was the
original reason for leaving it.

**This entry can be closed as measured-and-declined** rather than
carried forward again. It interacts with `high_fan_in_fan_out`'s
type-only rule from `0.21.0` only in principle: that change touches
which *severity* a fan-in gets, not what the count is.
