# R7 — working the backlog in parallel

You're picking up `crimes` (`/Users/andrew/dev/crimes`). `0.24.0` is
the latest release. The prioritised backlog is
[`BACKLOG-2026-08.md`](./BACKLOG-2026-08.md) — **read it first**; it
explains why the last two rounds produced less product movement than
they should have, and the ordering there is deliberate.

This round is explicitly about **spreading load across subagents**,
because the work finally decomposes: P0 and the three P1 items touch
different detectors, different files, and different evidence.

---

## Read these first, in this order

1. `CLAUDE.md` — the non-negotiables.
2. `.planning/BACKLOG-2026-08.md` — priorities and the diagnosis.
3. `evals/README.md` §§ "Versioning policy", "When *not* to bump at
   all", "Run evals from a checkout nothing else will touch", and "A
   second, accidental repeat sample". The last one governs what you are
   allowed to claim from any eval number.
4. `docs/dogfooding/2026-08-03-remediation.md` §§ 9 and 13 — the full
   briefings for P1.2 and P1.1. **§9's counter-example is the whole
   job**; do not start B without reading it.
5. `docs/releasing.md` — the 7-step checklist.

---

## How this codebase is worked on

Unchanged, and every round keeps re-earning it.

**A backlog entry is a hypothesis.** Across R4–R6, entries have been
wrong about which detector they described, the size of their own effect,
which function they named, whether a defect existed at all, and — in
R5/R6 — about the measured band a shipped constant was fitted to.
**Reproduce before fixing.** The most valuable output of several rounds
has been measurements that *stopped* work.

**Test-driven, genuinely.** Write the failing test, *run it*, confirm it
fails for the right reason, then the minimal fix. R6 found that both
tests pinning `STRUCTURAL_CEILING` used maximal inputs — the single
point where the old and new mechanisms agree — so a change touching
22–61% of every report passed 2,212 tests untouched. **Ask what your
test cannot distinguish.**

**Measure on real repos.** `~/crimes-dogfood/corpus/`: `hono`,
`pydantic`, `drf`, `zulip`, `airflow`, `mlflow`, `cal.com`, `posthog`,
`n8n`, `p-limit`.

**Two properties you must not break**, both with standing tests:
fingerprint uniqueness and byte-identical re-scans.

**A third standing gate, new in `0.23.0`:** every registered detector
must express an intrinsic or declare one in `INTRINSIC_DEFAULTS`. It
reads the detector sources, so it sees detectors added tomorrow.

---

## Traps, newest first

**1. Check what the measurement actually reads.** P0 exists because the
self-scan has been 86% eval transcripts. The tool reported its own
stored agent transcripts — including the ones for the scenarios *named*
`plan-01-hardcoded-local-path` — as hardcoded-path findings.

**2. A quoted band may be the head of a distribution.** `0.23.0` found
`STRUCTURAL_CEILING`'s justifying band was a list of per-type *maxima*,
and that one of the four types cited did not fire on the tree at all.
**Re-derive a number before building on it**, especially one written in
a comment.

**3. Reusing a measurement across a changed baseline.** R5 measured the
squash against `0.22.0`, when 28 detectors were still suppressed. R6
re-ran it from `0.23.0` rather than quoting the old figures. If the
baseline moved, the measurement is stale.

**4. `*/` closes a block comment.** A JSDoc line reading `` `*/_vendor/*` ``
ends the comment and turns the rest into code.

**5. Apparatus that fails closed on correct input.** Six instances now.
P1.1 is a *deliberate* attempt to build one safely — airflow's
`exclude = ["*"]` under `[tool.hatch.build]` would report the whole repo
clean.

**6. Never resolve a symbol by name alone**, including in prose.

**7. Opening the file settles it.**

---

## Suggested parallelisation

These four are genuinely independent — different detectors, different
files, no shared state. Dispatch them as subagents.

| stream | scope | shares files with |
|---|---|---|
| **S1** | P0.1 self-scan config + verify the surviving findings | nothing |
| **S2** | P1.1 (A) tooling excludes — Python half only | `scope-class`, `coverage.warnings[]` |
| **S3** | P1.2 (B) `sync_io_in_hotpath` reachability | `sync-io-in-hotpath.py`, py call-following |
| **S4** | P1.3 (C) `commented_out_code` unification + the P2.3 cross-pack intrinsic audit | both `commented-out-code*.ts` |

S4 bundles C with the cross-pack audit deliberately: `commented_out_code`
is *itself* one of the disagreeing pairs (0.48 JS vs 0.35 universal), so
the same agent should settle both kinds of divergence in that pair and
report whether the audit found more.

**Give each subagent the reproduction first, not the fix.** Ask it to
return the measured before-state and its reading of whether the entry is
correct, *then* implement. Several entries have been wrong about
themselves.

### What must NOT be parallelised

- **The eval agent run.** 96 combinations, ~43 minutes, billed against a
  subscription. One at a time, from a dedicated worktree built once.
- **Landing two findings-moving changes in one baseline** if you need to
  attribute them separately. A and B are both suppression-shaped;
  measure each with `evals:ranking` (deterministic, agent-free, free)
  before deciding whether they can share one.
- **Version bumps.** One bump per group, in the same commit as the
  change.

---

## How to proceed

1. **Do P0 first, alone.** It is one line of config, it is not
   findings-moving for the eval baseline (check the fixtures rather than
   assuming), and it makes the self-scan usable — which every other
   stream then benefits from. The deliverable is not the smaller number;
   it is a review of the ~320 findings that survive.
2. **Then dispatch S2–S4 in parallel**, each in its own worktree.
3. **Reconvene before any eval run.** Decide as one step which changes
   share a baseline and which need their own, then run once.
4. **Record where each entry turns out to be wrong, in the doc it came
   from.** That record has been the most useful thing in this repo five
   rounds running.

If a stream's measurement says the entry is wrong or the fix is not
worth it, **stop that stream and write down why**. That is a successful
outcome, not a failed one.

---

## One thing to decide early

P3.2 says the deep eval fixtures barely exercise the detectors the
product has decided to favour — only 3 deep scenarios label any of the
28 un-suppressed in `0.23.0`. Every scoring release therefore produces
"aggregate flat-or-down, split unanimous-up" and costs a paragraph of
explanation.

That is not urgent, but it is the reason scoring work is expensive to
justify, and it will keep being so. **Decide deliberately whether this
round adds scenarios for it or explicitly defers again** — it has been
implicitly deferred three times, which is not the same as deciding.
