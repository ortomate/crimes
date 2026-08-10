# Sprint 0.25 — the honest denominator

Sprint plan for the release after `0.24.0`. Derived from
[`BACKLOG-2026-08.md`](./BACKLOG-2026-08.md) and
[`PROMPT-0.25-parallel-backlog.md`](./PROMPT-0.25-parallel-backlog.md);
where this plan departs from either, it says so and why.

---

## 1. The release thesis

`0.23.0` and `0.24.0` were scoring-model internals. Both were real, both
were measured, and both cost a paragraph of explanation to justify —
because the instrument could not see the direction the product had
chosen. Neither was a release anyone outside the repo would read.

`0.25.0` has a thesis that survives contact with a reader:

> **A scanner is only as trustworthy as its denominator.** `crimes`
> currently looks at things it should not (your lockfile), charges things
> it did not establish (a hotpath it never proved was hot), disagrees
> with itself (one charge, two implementations, two intrinsics), and —
> the release's actual feature — has no first-class way to tell you
> what it skipped. `0.25.0` fixes all four and ships the ledger that
> makes the fixes auditable.

Every P0/P1 item in the backlog is an instance of that one sentence.
That is the release, and it is why the four items belong in one release
rather than four.

**The counter-headline, which must be in the notes:** three of the four
changes make the tool see *less*. Trap #5 in the R7 prompt counts six
prior instances of apparatus failing closed on correct input. A release
that removes 20–30% of findings on some repos and cannot prove it kept
the good ones is a regression with good PR. That is the entire reason
S0 goes first.

### Quotable numbers this release is going after

| item | claimed impact | status |
|---|---|---|
| A — tooling excludes | pydantic `v1/`: 85 findings, 17.5% of the report | **re-derive before building** |
| B — `sync_io_in_hotpath` reachability | airflow 227/811, mlflow 88/402, pydantic 7/19 | **denominator ambiguous — re-derive** |
| P0.2 — config merge | `pnpm-lock.yaml` scanned, 5,469-line `large_file`, **high** | reproduced (backlog §0.2) |
| C — variant unification | small; fingerprint churn on one population | **decide which population** |

The B figures are written as `n/N` with no stated denominator — total
findings, or that detector's findings? Trap #2 says re-derive a number
before building on it. **No stream may quote its own backlog figure in a
release note without having re-derived it that round.**

---

## 2. Scope — decided

**In.** P0.2, P1.1 (A, Python half only), P1.2 (B), P1.3 (C) + the P2.3
cross-pack intrinsic audit, P3.2 (deep eval scenarios), and a
first-class skipped-path ledger.

**Out, explicitly.**

- **M6 Homebrew / standalone binaries.** Real user-facing work with zero
  eval interaction, and genuinely tempting for a bumper edition — but it
  is a distribution story stapled to a trust story, and standalone Node
  binaries (SEA or bun) is unscoped. Deferred, on purpose, this round.
- **P2.1 the level `0.3`, P2.2 the class table, P2.4 the 41 literals.**
  Demoted by the backlog for a reason. Do not let them back in. P2.3 is
  in only because `commented_out_code` is itself one of the disagreeing
  pairs, so S5 is already in the file.
- **P3.1 the two disowned-label populations.** Related to S0 and will be
  tempting to fold in. Re-labelling improves the metric without
  improving the product; S0 adds *new* scenarios only.
- **PRD §26 / `crimes ask`.** Still deferred.

---

## 3. The one decision that shapes the sprint: instrument first

P3.2 has been implicitly deferred three times. It is now S0, and it runs
**before any product change**.

The argument is not tidiness. It is that this release's headline claim is
"we removed 20–30% of the findings and they were the wrong ones." Only
3 deep-fixture scenarios label any of the 28 detectors un-suppressed in
`0.23.0`. An instrument that cannot see the differentiated detectors
cannot distinguish "removed noise" from "removed signal" — so shipping
A and B against it produces the same unquotable "aggregate flat-or-down,
split unanimous-up" shape as the last two releases, on the release where
it matters most.

**The cost, stated honestly:** one extra agent run (~43 min), and
`0.25.0`'s headline numbers are **not comparable to `0.24.0`'s**. The
`0.24.1` instrument-only baseline becomes the reference point, and the
release notes must say that in the first paragraph that quotes a number.
That is a real loss and it is worth paying once.

---

## 4. Streams

Six streams. S0 and S1 start immediately and in parallel — they share no
files. S3 consumes S1's contract, so S1's *type change* must land before
S3 writes code (the rendering can trail). S2, S4, S5 are independent of
everything.

Each stream has the same shape, which is the repo's convention and is
not optional: **reproduce → write down whether the entry is right →
failing test → minimal fix → measure.** A stream that reports "the entry
is wrong, here is the measurement, I stopped" has succeeded.

---

### S0 — the instrument (P3.2)

**Blocks:** every eval claim in the release.
**Files:** `evals/scenarios/*.json`, `evals/fixtures/**`. No `packages/`
changes at all.

**Hypothesis to test first:** "only 3 deep-fixture scenarios label any of
the 28 detectors un-suppressed in `0.23.0`." Derive the current number
directly from `evals/scenarios/*.json` against the `INTRINSIC_DEFAULTS`
table before authoring anything. If it is 3, proceed; if it is 9, the
sprint's central justification is weaker and that changes S0's size.

> **Executed. Confirmed 3 of 28 exactly** — `plan-04-hotspots`,
> `refactor-02-component-shape`, `review-02-react-dashboard`. 11 of the
> 28 are referenced by no scenario at all. **And the check surfaced a
> larger defect the entry does not mention: the depth cliff.** Fixture
> `01` emits 42 findings against a floor of 40 and carries **75% of the
> deep population**; losing 3 findings from it moves the headline
> `+0.1333` on membership alone, ~15× any real movement ever shipped.
> On a suppression release that is a phantom success waiting to happen.
> **Guard landed first** (`ranking-population.ts`, 12 tests, no
> arithmetic changed, no bump owed). S0's scenario work now has a second
> and arguably more important goal: **deep scenarios off fixture `01`**,
> to dilute the 75%. Full write-up in `evals/README.md` § "The depth
> cliff" and `BACKLOG-2026-08.md` §3.2.

**Do:** author new deep scenarios covering the differentiated detectors
(`contract_drift`, `swallowed_error`, `duplicated_policy`,
`permission_ia_drift`, `unsafe_retry`, `mock_saturation` are the six the
`0.23.0` notes name as having ranked beneath the most lenient charge —
start there). Follow the procedure in
[`evals/PROMPT-build-detector-coverage.md`](../evals/PROMPT-build-detector-coverage.md),
which already ran this play once, and the "Scenario↔fixture coverage
discipline" section of `evals/README.md`.

**Hard constraints:**
- **New scenarios, not re-labelled ones.** P3.1's honest-fix argument.
- **Do not touch `score.ts`, `judge.ts`, or `verify-scenarios.ts`.**
  Changing the scorer while authoring scenarios stacks measurement drift
  on coverage change.
- Fixtures stay realistic. Do not pile every trigger into one file.

**Done when:** `pnpm evals:verify-scenarios` is clean, `pnpm verify` is
green, and the differentiated-detector coverage count is written down
before and after.

**Bump:** `0.24.1`, instrument-only, **full agent run**. This is the new
reference baseline.

---

### S1 — the skipped-path ledger (the release's feature)

**Files:** `packages/core/src/finding.ts` (the `CoverageWarning`
contract), `packages/core/src/discovery/coverage.ts`,
`packages/reporter/src/human/coverage.ts`.

**Start by reading the shipped contract — the backlog is wrong about it.**
`BACKLOG-2026-08.md` §1.1 requires "a `coverage.warnings[]` entry per
skipped path." The type shipped in `0.18.0` (`finding.ts:531`) says the
opposite, deliberately: `CoverageWarning.subject` "is never a file path"
because it is the aggregation key, `files` carries the count, and
`examples` is capped at five. The doc comment gives the rationale — one
warning with `files: 1226`, not 1,226 warnings.

**So the backlog's non-negotiable, taken literally, would break a shipped
contract and produce 85 warnings on pydantic alone.** Resolve it as:
*every skipped path is accounted for*, aggregated by authority, with
examples. Write that resolution into the backlog doc — this is the
"record where each entry turns out to be wrong" rule.

**Build:**
- Provenance on the warning: which mechanism skipped this, and **which
  config file and key authorised it**. A skip nobody can trace to a line
  in a file is the failure mode this stream exists to prevent.
- A new `CoverageWarningKind` for tooling-derived exclusion, distinct
  from the existing `files_excluded` — a user needs to tell "your config
  said so" from "pydantic's `pyproject.toml` said so."
- Rendering under the existing `--explain-coverage`, which already has a
  banner and tests (`packages/reporter/src/human/coverage.test.ts`).

**Additive only.** No field removed, no meaning changed → `schema_version`
stays `0.7.0`. If a stream finds itself wanting a breaking change, stop
and raise it; that is a different release.

**Done when:** the ledger renders, `evals:ranking` is byte-identical
(this stream must move zero findings), and S3 has a contract to emit into.

**Bump:** groups with S2 into `0.24.2`.

---

### S2 — a user `exclude` silently falls behind the defaults (P0.2)

**Files:** `packages/core/src/config.ts`, `init-detect.ts`.

**Reproduce:** confirm `mergeConfig` does
`exclude: override.exclude ?? base.exclude` and that this is the
*documented* contract (remediation doc §1.3, `scopeTiers.nonDomain`).
This one is already well-evidenced — the repo's own config fell behind by
12 patterns and scanned `pnpm-lock.yaml` as a **high** `large_file`.

**The decision this stream owns.** Three options are on the table
(backlog §0.2): merge-instead-of-replace with an opt-out; keep replace
but warn; or an additive `extends` / `excludeAdd` key.

**The framing that should decide it:** `crimes init` writes a config with
an `exclude` array, so **the documented first-run command puts every user
into the broken state**. That makes this the third instance of "following
our own advice degrades the scan silently" (§1.1 init wrote a JS-only
config; §30 the tool's own remediation hint gutted the scan). A warning
tells the user they are already broken. Merging means they never were.
Recommend merge + opt-out, but the stream owns it — with the reasoning
written down, because it changes a documented contract.

**Whatever is chosen, it emits into S1's ledger.** A silently-narrowed
scan is exactly what the ledger is for.

**Done when:** a test proves a user config with a partial `exclude` no
longer loses the defaults (or is warned about it), `crimes init`'s output
is consistent with the choice, and the changed contract is documented in
the remediation doc.

**Bump:** `0.24.2` with S1. Check `evals:ranking` first — if no fixture
reads a root config this is likely **identity-only**, and
`evals/README.md` § "Identity-only bumps" says carry the baseline
forward rather than re-run. Confirm, don't assume.

---

### S3 — honour a repo's own tooling excludes (P1.1 / A), Python half only

**Depends on:** S1's warning contract.
**Files:** manifest reading, `util/scope-class.ts`, ledger emission.

**Re-derive first:** pydantic's 85 findings / 17.5%. The design is
already written in remediation doc §13 — read it, then check the figure
against today's `main`, which is two releases downstream of when it was
written.

**The design problem is the whole job.** This turns a config file into a
silent-suppression mechanism.

- **Named tables only.** Never "any `exclude` key". airflow's
  `pyproject.toml` has `exclude = ["*"]` under `[tool.hatch.build]`; a
  naive reader reports airflow as **completely clean**.
- **Write the airflow test first, and watch it fail.** Not "add a test
  for the airflow case" — the failing test on airflow's real
  `pyproject.toml` is the gate this stream passes through before any
  implementation. This is the seventh instance of the fail-closed class
  and the first one built on purpose; it earns a test that would have
  caught the previous six.
- **Every skipped path accounted for in the ledger**, with the config
  file and table that authorised it.
- **An opt-out.**

**Scope discipline:** the mechanism generalises to `.gitattributes
linguist-vendored`, `tsconfig` `exclude`, and `.eslintignore`. **Ship the
Python half only.** Note the generalisation in the notes; do not build it.

**Bump:** `0.24.3`, **own agent run**. A is suppression-shaped and needs
separate attribution from B.

---

### S4 — `sync_io_in_hotpath` by reachability (P1.2 / B)

**Files:** `sync-io-in-hotpath.py` detector, Python call-following.
**Independent of every other stream.**

**Read remediation doc §9 before writing anything.** Its counter-example
is the job: `task-sdk/src/airflow/sdk/execution_time/task_runner.py`
carries a `__main__` guard at line 2441 of 2443, is production code, and
reports **0 direct importers** because airflow launches it as a
subprocess. It defeated both candidate signals tried in `0.22.0`.

**The signal that should work:** a function every one of whose same-file
call paths starts inside the guard block, in a module nothing imports.
`weak_test_signal.py` already does bounded same-file call following, so
the machinery exists — reuse it rather than writing a second one.

**Decide `task_runner.py` explicitly, in writing, before the code.** Both
readings are defensible: a task-runner process is one-shot, but a
blocking email send inside it is still worth saying. The failure mode
here is deciding it by accident and discovering the decision later from
the corpus numbers.

**Re-derive the denominators.** `227/811` needs to become a sentence.

**Bump:** `0.24.4`, **own agent run**.

---

### S5 — unify `commented_out_code` + the cross-pack intrinsic audit (P1.3 / C + P2.3)

**Files:** both `commented-out-code*.ts`, the intrinsic tables.

Bundled deliberately: `commented_out_code` is *itself* one of the
disagreeing pairs, so one stream settles both kinds of divergence in the
same detector.

**Two divergences, one detector pair:**
1. **Behaviour.** The `language-js` variant always appends a block hash;
   the universal one appends it only when a file holds more than one
   block (`0.22.0`, so single-block files keep their fingerprints).
2. **Intrinsic.** 0.48 (JS) vs 0.35 (universal), found incidentally in
   the `0.23.0` audit.

**Unifying either way churns fingerprints for one of the two
populations. Say which and why, with counts, before choosing** — a
fingerprint change breaks users' `crimes ignore` entries, and the repo
has a standing test on fingerprint uniqueness plus one on byte-identical
re-scans. Both must stay green.

**Then the audit (P2.3):** the two known disagreements
(`sync_io_in_hotpath` 0.55 JS vs 0.50/0.70 Python; `commented_out_code`
0.48 vs 0.35) were both found incidentally, **so the set is probably
larger**. Enumerate every charge implemented in both packs and report the
full disagreement list. Reporting it is the deliverable; fixing all of
them is not in this sprint unless the list is short.

**Bump:** `0.24.5` if fingerprints move (measure `evals:ranking` first —
if only fingerprints move and no ordering does, this may qualify as
identity-only and carry the baseline forward).

---

## 5. Baseline and bump ledger

The eval baseline is a shared resource and the agent run is the scarce
one — 96 combinations, ~43 min, billed against a subscription. Rules:
`evals:ranking` is deterministic, agent-free and free — **run it on every
candidate, in its own worktree, as often as you like.** The agent run is
one at a time.

| bump | contents | why grouped / separate | agent run |
|---|---|---|---|
| `0.24.1` | **S0** scenarios | instrument-only; must not mix with product change | **yes** — new reference baseline |
| `0.24.2` | **S1** ledger + **S2** config | neither needs attribution against the other; S1 is additive, S2 likely fixture-identity | check `evals:ranking` — likely **identity-only, carry forward** |
| `0.24.3` | **S3** (A) | suppression-shaped, needs its own attribution | **yes** |
| `0.24.4` | **S4** (B) | suppression-shaped, needs its own attribution | **yes** |
| `0.24.5` | **S5** (C + audit) | fingerprint-moving | check `evals:ranking` — possibly identity-only |
| `0.25.0` | release | rolls up the patch bumps | only if anything moved after `0.24.4` |

Budget: **3 agent runs certain, 5 worst case** (~2–3.5 h wall clock,
serialised). No release, no Changeset, no tag on any of the patch bumps —
`CLAUDE.md` § "Eval baseline version bumps".

**Non-negotiables, all previously violated at least once:**
- Never build while an eval run is in flight. Use a dedicated worktree —
  the runner derives its CLI path from `import.meta.url`, so a worktree
  genuinely isolates it. **Verify that rather than assume it**, and check
  `dist` mtimes predate every result file afterwards.
- One bump per group, in the same commit as the change.
- A measurement taken before the baseline moved is stale. S3 and S4 must
  measure from `0.24.1`+, not from figures written at `0.24.0`.

---

## 6. Parallelisation

```
S0 (instrument) ─────────────────────────► 0.24.1 [RUN]
S1 (ledger) ──┬──────────────────────────► 0.24.2
S2 (config) ──┘
              └─► S3 (A, needs S1 type) ─► 0.24.3 [RUN]
S4 (B) ──────────────────────────────────► 0.24.4 [RUN]
S5 (C + audit) ──────────────────────────► 0.24.5
                                            └─────► 0.25.0
```

S0, S1, S2, S4, S5 can all start at once — different detectors, different
files, no shared state. S3 needs only S1's *type*, not its rendering.

**Must not be parallelised:** the agent runs; landing two
attribution-needing changes in one baseline; version bumps.

**Give each stream the reproduction first, not the fix.** Ask for the
measured before-state and its reading of whether the entry is correct,
*then* implement. Across R4–R6 backlog entries have been wrong about
which detector they described, the size of their own effect, which
function they named, and whether the defect existed at all. S1 has
already found one before the sprint started.

---

## 7. Release-note spine

So the writing is not invented at the end.

1. **The denominator problem.** A scanner's report is a fraction, and
   `crimes` has never shown you the bottom half.
2. **What it looked at that it shouldn't.** S2 — your `exclude` silently
   drops the defaults, `crimes init` puts you there, the third instance
   of following our own advice degrading the scan. Lockfile scanned as a
   high finding in the repo whose `CLAUDE.md` says lockfiles are excluded.
3. **What it charged without establishing.** S4 — "hotpath" was answered
   by file, not by reachability. The `task_runner.py` counter-example and
   the decision we made about it, stated outright.
4. **What it now skips on purpose.** S3 — a directory a repo excludes
   from its own linter and type-checker is one it does not maintain.
   Named tables only, and here is airflow's `exclude = ["*"]` and the
   test that stops it reporting airflow clean.
5. **The ledger.** S1 — every skipped path, aggregated by the config key
   that authorised it, under `--explain-coverage`. **This is the feature.**
6. **One charge, one answer.** S5 — the variant unification and the full
   cross-pack disagreement list.
7. **How we know we removed noise and not signal.** S0 — and the honest
   footnote that the reference baseline moved to `0.24.1`, so these
   numbers are not comparable to `0.24.0`'s.

The essay is section 7 justifying sections 2–6. Without S0 it is an
assertion.

---

## 8. Definition of done

- [ ] `pnpm verify` green; `pnpm --filter crimes smoke` green.
- [ ] Fingerprint uniqueness and byte-identical re-scan tests green.
- [ ] The intrinsic gate green (it reads detector sources, so it sees
      anything S3/S4/S5 added).
- [ ] `pnpm evals:verify-scenarios` clean.
- [ ] Every stream's before/after re-derived on the corpus
      (`~/crimes-dogfood/corpus/`), not quoted from the backlog.
- [ ] **The self-scan used as a signal, not just the corpus.** It went
      2,362 → 331 findings and 415 → 8 high in P0.1 — it is a usable
      loop again and this is the first sprint that can use it. The 8
      surviving highs (13 `duplicated_policy` variants in
      `dependency-provenance-gap.ts`, four `large_function`, `large_file`
      on `scoring/build.ts`) are legible; check the count did not ratchet.
- [ ] `schema_version` still `0.7.0`, or a written argument for why not.
- [ ] Every place a backlog entry turned out to be wrong is recorded **in
      the doc it came from**. Five rounds running, this has been the most
      useful artifact in the repo.
- [ ] `docs/releases/v0.25.0.md`, `docs/roadmap.md` status mirror, and
      the 7 steps in `docs/releasing.md`.

## 9. What we decided not to do, and why

Recorded so the fourth deferral is a decision rather than a drift.

- **M6 Homebrew / binaries** — off-theme for a trust release, and
  unscoped. Next release's candidate headline.
- **P2.1 / P2.2 / P2.4** — real, none with a user-facing number. The
  backlog demoted them precisely so they stop crowding out P1; this
  sprint honours that.
- **P3.1 disowned labels** — new scenarios (S0) yes, re-labelling no.
- **P3.3 stale `evals/README.md` § "Fix this regardless"** — one-line
  deletion, pick it up in any stream that is already in the file.
- **P3.4 §27 build ordering** — did not reproduce over 8 runs. Leave it
  unless it recurs.
- **The other three tooling-exclude sources** (`.gitattributes`,
  `tsconfig`, `.eslintignore`) — the generalisation is real; building
  four at once is how the fail-closed class gets to seven instances.
