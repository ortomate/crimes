# R5 — `0.23.0`: after the queue

You're picking up `crimes` (`/Users/andrew/dev/crimes`). The previous
session executed
[`PROMPT-0.22-close-the-queue.md`](./PROMPT-0.22-close-the-queue.md)
and shipped it. **The §4 queue that has driven the last four releases
is empty.** This round has to decide what the work is, which is a
different job from the last four.

---

## Where things actually stand

- **Published on npm: `0.22.0`.** Verified from a clean install.
- **`main` is clean and pushed.** No unreleased work.
- `schema_version` **0.7.0**, 2,210 tests, `evals/results/0.22.0/`
  committed (including `ranking.json`), `pnpm verify` green,
  `evals:verify-scenarios` green.

| release | headline |
|---|---|
| `0.19.0` | the backlog — 50 stuck commits, `schema_version` 0.4.0 → 0.6.0 |
| `0.20.0` | the working set — `scan --files` / `--related-to`, `schema_version` → 0.7.0 |
| `0.21.0` | precision — four field-reported false positives |
| `0.22.0` | the queue closed — seven entries, four of them wrong about themselves |

---

## Read these first, in this order

1. `CLAUDE.md` — the non-negotiables.
2. **`evals/README.md` § "A second, accidental repeat sample
   (0.21.0 → 0.22.0)"** — read this before you plan anything that
   quotes an eval number. It is new and it changes what you are
   allowed to claim.
3. `docs/dogfooding/2026-08-03-remediation.md` — the header now says
   what is left, and it is **not** in §4. §4 is closed.
4. `docs/releasing.md` — the 7-step checklist. Step 2 gained a
   standalone bullet for the pinned fixture, because it went stale for
   a whole release under the old wording.

---

## The one measurement that should change how you work

`0.22.0` produced a repeat sample by accident, and it is the most
useful number in the repo right now.

All 14 fixtures scan **byte-identically** between published `0.21.0`
and the `0.22.0` build, and the agent-free `evals:ranking` reports **no
scenario moved**. So the `0.22.0` eval run is a resample of `0.21.0` on
provably identical input. On that input:

| agent | scenarios | moved | up | down | mean \|Δ\| |
|---|---|---|---|---|---|
| claude | 48 | **16** | 10 | 6 | 0.135 |
| codex | 48 | **13** | 4 | 9 | 0.135 |

Full swings are routine: claude's `bugfix-04-weak-tests` 1.00 → 0.00
and `refactor-01-plural-mismatch` 0.00 → 1.00, codex's
`plan-04-hotspots` 0.00 → 1.00.

**A third of scenarios move when nothing changes.** Two consequences:

- **Never quote a per-scenario delta as a product signal** without
  replaying it (`evals:replay` holds responses fixed so only the scorer
  varies). This is now written down; do not re-derive it.
- The aggregate band (±6pp claude, ±3pp codex) still holds, and
  `0.21.0`'s claude 0.82 → 0.77 → 0.81 is settled as noise.

---

## How this codebase is worked on

Unchanged, and `0.22.0` earned every line of it again.

**A queue entry is a hypothesis.** Four of seven entries were wrong
about themselves last round — about which detector they described,
about the size of their own effect, about which *function* they named,
and about whether a defect existed at all. Reproduce before fixing.

**Test-driven, genuinely.** Write the failing test, *run it*, confirm
it fails for the right reason, then the minimal fix.

**Measure on real repos.** `~/crimes-dogfood/corpus/`: `hono`,
`pydantic`, `drf`, `zulip`, `airflow`, `mlflow`, `cal.com`, `posthog`,
`n8n`. Also `~/dev/choreograph.cc` at `5107cce` — use a git worktree so
churn resolves.

**Two properties you must not break**, both with standing tests:
fingerprint uniqueness and byte-identical re-scans. The uniqueness gate
in `scan.test.ts` gained a Python half in `0.22.0`; it was JS-only
before and could not have caught what `0.22.0` fixed.

**Never build while an eval run is in flight, and use a dedicated
worktree.** `0.22.0`'s run was interrupted at 51 of 96 and finished
with `--resume`; that is only defensible because the worktree's `dist`
mtimes provably predate every result file. Check that, don't assume it.

---

## Traps, with the newest first

**1. `*/` closes a block comment.** A JSDoc line reading
`` `*/_vendor/*` `` ends the comment and turns the rest into code. Cost
a confusing `ReferenceError: _vendor is not defined` from a file that
had only had a comment added.

**2. A measurement's *order* is part of the measurement.** §4f indicted
`verdict` on 1762 ms against a scan's 929 ms. Whichever call runs first
in a Node process pays ~70–110 ms of module-init and JIT warm-up, and
`verdict` was always measured first. Reverse the order and the verdict
is the faster one. Warm the process, or measure in the same position.

**3. Check what the measurement actually reads.** The first probe of
JS syntax errors parsed everything as `ScriptKind.TSX` and reported 12
of hono's 307 files as broken — `<T>(v)` is a type assertion in a `.ts`
file and an unclosed JSX tag in a `.tsx` one.

**4. Apparatus that fails closed on correct input.** Five instances
now. The newest is hypothetical and worth keeping that way: reading a
repo's `pyproject.toml` lint excludes would make airflow report as
completely clean, because it carries `exclude = ["*"]` under
`[tool.hatch.build]`.

**5. Never resolve a symbol by name alone**, including in prose.

**6. Opening the file settles it.**

---

## What is actually open

Nothing is a *correction* any more. All three of these are features,
and each carries a measured size so you can rank them honestly.

### A. Honour a repo's own tooling excludes

`pydantic/v1/` is **85 findings across 20 files — 17.5% of pydantic's
entire report** — and it is a bundled copy of pydantic 1.x, regenerated
by `make update-v1`. No path rule separates it from a real `v1/` API
directory, and `0.18.1` correctly declined to invent one.

**The general signal is the repo's own tooling.** `pydantic/v1` appears
in four separate exclusions in `pyproject.toml` — ruff
`extend-exclude`, coverage `omit`, mypy `exclude`, codespell `skip`. A
directory a repo excludes from its own linter and type-checker is a
directory it does not maintain.

**The whole design problem is trap 4.** This turns a config file into a
silent-suppression mechanism, and airflow's `pyproject.toml` has
`exclude = ["*"]` under `[tool.hatch.build]`. It needs: named tables
only (never "any `exclude` key"), a `coverage.warnings[]` entry per
skipped path, and probably an opt-out. Generalises to
`.gitattributes linguist-vendored`, `tsconfig` `exclude`, and
`.eslintignore`.

### B. `sync_io_in_hotpath` should decide by reachability, not by file

Airflow **227 of 811**, mlflow **88 of 402**, pydantic **7 of 19**
findings sit in a file carrying an `if __name__ == "__main__":` guard,
and the charge does not apply to a one-shot script — there is no worker
to hold and no event loop to stall.

Two signals were tried in `0.22.0` and **both fail on the same file**.
`task-sdk/src/airflow/sdk/execution_time/task_runner.py` carries a
guard at line 2441 of 2443, is production code, and reports **0 direct
importers** because airflow launches it as a subprocess. Read §9 of the
remediation doc before starting; the counter-example is the whole
briefing.

The signal that would work: a function every one of whose same-file
call paths starts inside the guard block, in a module nothing imports.
`weak_test_signal.py` already does bounded same-file call following —
the machinery exists. **It moves 22–28% of a detector's output, so it
needs a baseline and it needs the `task_runner.py` case decided
explicitly rather than by accident.**

### C. The two `commented_out_code` variants still disagree

The language-js one always appends a block hash; the universal one now
appends it only when a file holds more than one block (`0.22.0`, so
that single-block files keep their fingerprints). Unifying either way
churns fingerprints for one of the two populations. Small, and it is
the kind of drift §24 was written about.

---

## Carried, and older than the queue

- **§5 `agent_risk`'s shape.** `0.18.1` stopped it being a length
  ranking and the maintainer **parked** it there, calling it "the next
  release's focus". Four releases later nobody has picked it up.
  zulip's top 20 is 16/20 `sync_io_in_hotpath` — a concentration of its
  own. `docs/calibration-followups.md` separates what is measured from
  what is believed. **This is the largest open product question in the
  repo** and it is not in any queue.
- **§28: six eval scenarios whose labels encode the old ranking.**
  Their expected answer is a length finding, and the product has
  decided length findings should not lead. Re-labelling them would
  improve the metric without improving the product. Left deliberately;
  anyone quoting `mean_ndcg_deep` should know those six are in it.
- **§27: `pnpm run build` ordering.** Did not reproduce over 8 runs.
  Left open as a possibility, not a fact.

---

## Release mechanics

`docs/releasing.md` is canonical — 7 steps. Six version surfaces in
step 2, plus `docs/fixtures/messy-ts-app.json`, which is now its own
bullet: it is not conditional on the schema changing, and it went stale
through the whole of `0.21.0` because it used to be.

Local pre-flight: `pnpm verify` **and** `pnpm --filter crimes smoke`.
Then commit, push, wait for CI, `gh release create v0.23.0
--notes-file docs/releases/v0.23.0.md`, watch the Release workflow, and
**verify from a clean directory outside this repo**.

Eval-baseline discipline: findings-moving change → patch bump, batched
one bump and one run per group, and say in the commit message whether a
delta is a **measurement correction** or a **product delta**. "The
fixtures didn't move" is only true if you compared the bytes — `0.22.0`
did that against the published previous release and it is a two-minute
check worth repeating.

---

## How to proceed

1. **Decide the round's shape first.** There is no queue to work
   through. A, B and C above are sized; §5 is the biggest question and
   the least specified. Pick deliberately and say why.
2. Whatever you pick, **reproduce before building**. The last round's
   single most valuable output was seven measurements that stopped work
   rather than starting it.
3. If you touch anything that moves findings, one eval run for the
   group, from a dedicated worktree, then the release.

Record where each entry turns out to be wrong, in the doc it came
from. That record has been the most useful thing in this repo four
rounds running.
