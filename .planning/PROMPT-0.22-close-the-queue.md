# R4 — `0.22.0`: close the queue

You're picking up `crimes` (`/Users/andrew/dev/crimes`). The previous
session executed
[`PROMPT-0.19-to-0.22-releases.md`](./PROMPT-0.19-to-0.22-releases.md)
and shipped three of its four releases. **This is the fourth and last.**

---

## Where things actually stand

- **Published on npm: `0.21.0`.** Verified from a clean install.
- **`main` is clean and pushed** at `382e404`. No unreleased work.
- `schema_version` **0.7.0**, 2,195 tests, `evals/results/0.21.0/`
  committed (including `ranking.json`), `pnpm verify` green,
  `evals:verify-scenarios` green.

Shipped in the three prior releases, so you don't re-derive them:

| release | headline |
|---|---|
| `0.19.0` | the backlog — 50 stuck commits, `schema_version` 0.4.0 → 0.6.0, postinstall removed |
| `0.20.0` | the working set — `scan --files` / `--related-to` / `--related-depth`, `schema_version` → 0.7.0 |
| `0.21.0` | precision — `logic_in_comments`, `direct_date`, `high_fan_in_fan_out`, `name_behavior_mismatch` |

---

## Read these first, in this order

1. `CLAUDE.md` — the non-negotiables. The ones that bite here: JSON
   output is the contract; **evidence before judgement**; signal over
   exhaustiveness. Biome's `lineWidth: 90` is a *measurement* setting.
2. **`docs/dogfooding/2026-08-05-r4-premeasurements.md`** — three of the
   items below already have measurements instead of estimates, and two
   of the queue entries are wrong about their own numbers. Read this
   before touching anything; it will change what you do.
3. `docs/dogfooding/2026-08-03-remediation.md` §4 — the queue. Note §4f,
   added last session: `verdict`'s identical-tree short circuit is
   **slower than the scan it replaces** on a small repo.
4. `docs/releasing.md` — the 7-step checklist. You will run it once.
5. `evals/README.md` § "Versioning policy" and § "Run evals from a
   checkout nothing else will touch".

---

## How this codebase is worked on

Unchanged, and every one of these earned its place last session:

**Test-driven, genuinely.** Write the failing test, *run it*, confirm it
fails for the right reason, then the minimal fix. Two `0.21.0` fixes
were caught mid-flight by exactly this: a word-boundary rule that broke
a real cal.com finding, and a factory rule that swallowed a `fetch`.

**A queue entry is a hypothesis.** Reproduce before fixing. Last session
seven entries turned out to be wrong, including three of the four
detector fixes the field report asked for — in each case the suggested
rule did not survive contact with the file that prompted it.

**Measure on real repos.** `~/crimes-dogfood/corpus/`: `hono`,
`pydantic`, `drf`, `zulip`, `airflow` (~95s), `mlflow`, `cal.com`,
`posthog`, `n8n`. Also `~/dev/choreograph.cc` — the field-report repo.
Its snapshot is `5107cce`; use a git worktree so churn resolves.
**A null result reported honestly is worth more than a number massaged
upward.**

**Two properties you must not break**, both with standing tests:
fingerprint uniqueness and byte-identical re-scans. Re-check with `cmp`
after anything touching scoring, discovery or sort order.

**Never build while an eval run is in flight, and use a dedicated
worktree.** Last session was the first time this demonstrably mattered:
the main tree's `dist` was rebuilt *inside* the run window for unrelated
measurements, and the worktree's isolation is the only reason the
baseline is valid.

---

## Traps, with the newest first

**1. Check what the measurement actually reads, not what you assume it
reads.** `0.20.1` and `0.20.2` shipped without eval runs because a check
found "0 of 15 fixtures moved, compared on fingerprint **and**
severity". Accurate, and the wrong comparison — the scorer has indexed
finding **evidence strings** since `0.18.2`, and `direct_date` gained an
evidence line. 29 of 48 claude scenarios saw a changed input across four
fixtures. **Before claiming a fixture didn't move, diff what the scorer
consumes**: `scan_context.detector_id_by_evidence` as well as
fingerprints and severities.

**2. Never resolve a symbol by name alone — including in prose.**
`logic_in_comments` matched domain terms with `String.includes`, so
`auth` matched "**Auth**ored by the Curator" and `utc` matched "captured
that o**utc**ome". Same rule as `2e9b2da`'s `Set.prototype.has` chain.

**3. Apparatus that fails closed on correct input.** Four instances now:
the eval scorer's extension list, the biome guard's summary regex,
`enable` as a pure allowlist, and — found last session —
`feedback recheck` keying its per-detector note on the current minor
*exactly*, which orphaned all fifteen `0.17` notes the moment `0.18.0`
shipped. When you write a check, ask what a *correct* input that it
rejects would look like.

**4. Opening the file settles it.** `direct_date`'s reported false
positive turned out to contain two real poll timeouts. The field report
was wrong about its own example, and only reading `JobDetail.tsx` showed
it.

---

## Step 0 — rebuild the cross-file Python fixture (it was lost)

The previous session wrote and **validated** this fixture, then the
scratchpad it lived in was cleaned up. It is not in git. Rebuild it —
`docs/dogfooding/2026-08-05-r4-premeasurements.md` records the one
non-obvious constraint, which is the whole reason it took two attempts.

Target: `evals/fixtures/12-py-tested/`, which today has three modules at
three coverage levels (real tests / hollow tests / no tests). Add a
**fourth** case without disturbing those three:

```
billing/invoices.py     build_invoice / apply_credit
tests/support.py        an imported helper + a unittest.TestCase base class
tests/test_invoices.py  5 tests, none containing a bare `assert`
```

**The constraint that makes or breaks it:** the helpers must **not** be
named `assert_*`. The same-file matcher has always been
`/^assert[A-Z_]/`, which already credits `assert_valid_user()` because
`assert` is followed by `_`. A fixture built to the queue entry's letter
passes review and measures **nothing**. Use `verify_*` / `expect_*` —
the shape of zulip's `self.verify_action()`, which is the real miss the
`0.18.3` symbol index closed.

**Acceptance, and run it both ways:**

```
crimes@0.17.0 (pre symbol index)  →  2 findings, incl. tests/test_invoices.py
current build                     →  1 finding  (test_invoices.py credited)
```

`tests/test_reporting.py` must still fire in both — that's the guard
that the fixture didn't simply go quiet. Update the fixture's `purpose`
in `evals/fixtures/fixtures.meta.json`.

This changes what the agents are shown, so it needs a baseline.

---

## The queue, with what is already known

### Already answered — close them, don't redo them

**`transitiveImporterCount` counts a file as its own importer.**
**Measured and declined**, §15 shape. The 47% `blast_radius == 1.0`
saturation that motivated revisiting it is now **0.0%** across 3,575
files, files on a cycle are **0–2.6%**, and the magnitude is +1 on a
log-scaled input. Nothing is lying — the doc comment already states what
it computes and `blast_radius_direct_importers` has existed since
`0.5.0`. **Close it in the remediation doc; write no code.**

**`large_file` counts blank lines.** The entry's "drops every number
15–25%" is **wrong**. Measured across three repos: 5.6–12.2% overall,
**3.6–10% for actual source**. The high numbers are prose, which has had
its own 1000-line `docs` budget since `0.17.0`. So this is closer to a
bugfix than the entry allows — and `countNonEmptyLines()` in
`packages/language-js/src/parse/utils.ts` counts every line, which makes
its name a lie of exactly the kind `name_behavior_mismatch` charges.

Still needs measure-then-decide: 5 of 33 choreograph findings would fall
below the 300-line domain threshold. Run `evals:ranking` across it —
that's the metric with no agent in it.

**§4e — JS syntax errors have no `coverage.warnings[]` signal.** Revisit
only if a supported API appeared; `ts.createSourceFile` still keeps
`parseDiagnostics` off the public `SourceFile` type. Expect to re-close.

### Genuinely open

**`weak_test_signal` fingerprint collisions.** 2 of 3,585 on n8n
`packages/cli`, 30 of 3,458 on zulip, 115 of 9,926 on airflow — two
tests with identical titles in one file, so the test-title discriminator
can't separate them. Folding the line range in fixes it **and
invalidates every pinned `weak_test_signal` suppression**. That is a
migration, not a patch: it needs a `docs/json-schema.md` note, a `0.22`
entry in `RELEASE_NOTES` (`packages/core/src/feedback/release-notes.ts`),
and prominence in the release notes. This is the item that makes
`0.22.0` a minor.

**`if __name__ == "__main__"` scripts** classify as `domain`, so
`sync_io_in_hotpath.py` fires on them. The last pass found no signal
distinguishing them from real domain code without reading module-level
control flow. Reproduce on airflow/mlflow before deciding; re-closing
with a measurement is a legitimate outcome.

**`pydantic/v1/`** — a bundled legacy copy `scope-class` doesn't
recognise. No general rule separates it from any other `v1/` API
directory. Same treatment: measure, then fix or re-close on merits.

**§4f (new) — `verdict`'s short circuit is not constant-time.** Found
last session while fixing a flaky test. On a 61-file tree the
identical-tree short circuit took **1762ms against a full scan's
929ms**. `6be5681` is not wrong about hono (12.3s → 7.0s); the mental
model it invites is. **Profile the path rather than guessing which call
it is** — a fix chosen from two data points is a guess.

---

## Also worth doing

**Repeat eval samples.** `0.21.0` recorded claude `structural_pass_rate`
0.82 → **0.77**, the largest single-step move in this metric's history.
It is inside the ±6pp band and **has not been separated from noise**.
The agent-free `evals:ranking` moved only −0.0012, which bounds the
problem to the measurement rather than the tool — but the clean
experiment is:

```bash
pnpm run evals -- --label r2
```

Three identical-code runs at `0.12.1` are what established the band in
the first place. If you're running evals for `0.22.0` anyway, running
`r2` against `0.21.0` first is cheap insurance and settles an open
question in the release notes.

---

## Release mechanics

`docs/releasing.md` is canonical — 7 steps, and `verify-build` enforces
things about the landing page you will not guess. Six surfaces in step
2: `packages/cli/package.json`, root `README.md`,
`packages/cli/README.md`, `docs/roadmap.md`, `docs/releases/v0.22.0.md`,
`apps/website/landing/llms.txt`, and `apps/website/landing/index.html`
(JSON-LD `softwareVersion` **and** the hero pill).

Local pre-flight: `pnpm verify` **and** `pnpm --filter crimes smoke`.
Then commit, push, wait for CI, `gh release create v0.22.0
--notes-file docs/releases/v0.22.0.md`, watch the Release workflow, and
**verify from a clean directory outside this repo**.

Between changes, keep the eval-baseline discipline: findings-moving
change → patch bump, batched one bump and one run per group, and say in
the commit message whether a delta is a **measurement correction** or a
**product delta**. Per trap 1, "the fixtures didn't move" is only true
if you diffed what the *scorer* reads.

---

## How to proceed

1. **Rebuild the fixture first.** It is cheap, it is validated, and it
   is the only item that makes the eval suite able to see a whole class
   of change.
2. **Close the three already-answered entries** in
   `docs/dogfooding/2026-08-03-remediation.md` with their measurements.
   Don't re-measure them.
3. **`weak_test_signal` fingerprints** is the real work and the reason
   this is a minor. Do it deliberately, with the migration note.
4. The two Python classification items and §4f on their merits —
   reproduce first, and re-closing with evidence is a fine outcome.
5. One eval run for the group, from a dedicated worktree, then the
   release.

Update `docs/dogfooding/2026-08-03-remediation.md` §4 and this file as
you go, in the same format: strike through, say what was measured, and
**record where the entry was wrong**. That record has been the most
useful thing in the doc every single time — last session it caught
seven wrong entries, three of them before a line of code was written.
