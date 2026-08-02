# Remediation of the 0.14 → 0.17 dogfooding round

**Date:** 2026-08-03
**Version:** `0.17.1` (patch bump — findings moved, no release, no tag)
**Round report:** [`2026-08-02-0.14-to-0.17.md`](./2026-08-02-0.14-to-0.17.md)
**Friction log:** [`2026-08-02-log.md`](./2026-08-02-log.md)

The round found ~30 verified defects. This is the first remediation
pass: **11 fixed, all test-driven, `pnpm verify` green at every commit.**
Test count 1873 → 1911.

This document is the handoff. It records what changed, what was
deliberately *not* changed, and what is left — enough to resume cold.

---

## 1. What was fixed

Each entry names the commit, the measured before/after, and the cost.

### 1.1 `crimes init` wrote a JS-only config — `36cb5fb`

`init-detect.ts:85` hardcoded `include: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"]`,
so the documented first-run command — and `crimes init --agents`, which
the docs tell every agent user to run — made `crimes` see **less** than
running with no config at all.

- PostHog: the generated config cost **23,273 of 38,063 findings (61%)**
- `products/metrics`: Python 48 files → 0, `cross_language` 1 → 0
- `packs_loaded` still reported `language-py` throughout

Now starts from `DEFAULT_SOURCE_INCLUDES`. `--detect` keeps its one
useful narrowing (a TS-only repo gets `**/*.{ts,tsx}`) but replaces the
JS glob **in place**, so Python, Rust, Go and docs survive it. Python
test globs added to the generated `scopeTiers.nonDomain`.

### 1.2 `.gitignore` was never implemented — `3968042`

`CLAUDE.md` has listed "fast-glob + `ignore` (respect `.gitignore`)" as a
locked stack decision since v0. Grep for gitignore parsing under
`discovery/` returned nothing; the `ignore` package was not a dependency.

- buildfest: a gitignored `migrate-output/` was **323 of 1556 findings
  (20.8%)** and **136 of 158 (86%)** of all `exact_duplicate_block`
- mysidekick-cc: two gitignored esbuild bundles were **19.1%**, and the
  report's single closing recommendation pointed at one of them

Follows git precedence: nested `.gitignore` files apply relative to their
own directory, deepest explicit decision wins. Opt out with
`respectGitignore: false`.

> **A test was corrected, not the code.** My first negation test asserted
> `!generated/bundle.ts` re-includes a file under an excluded
> `generated/`. Real `git check-ignore -v` says it does not — a negation
> cannot re-include under an excluded directory. The test was wrong; both
> behaviours are now pinned.

### 1.3 Dot-directories were skipped and reported clean — `3968042`

`dot: false` meant a repo keeping source under a hidden directory got
"No crimes detected. Suspiciously clean." and exit 0 for code never
opened. ebg keeps all 62 of its `.py` files under `.agents/`; unhiding
them took that scan 759 → 967 findings and surfaced a real
`cross_language` finding the true scan reported as zero.

A `NEVER_WALK` list keeps `.git`, `.hg`, `.svn`, `.venv`, `.tox` and the
caches out regardless of user `exclude`, which a config can replace
wholesale.

### 1.4 `scan` on a bad path exited 0 — `9d4d999`

A mistyped path produced a well-formed, empty, exit-0 report — in JSON
too. A typo in CI was a permanently green gate. Now exits 2 for a missing
path and for a path that is a file.

### 1.5 `large_file` invented a line per file — `9d4d999`

`universal-file.ts` kept the empty string after a trailing newline, so
every universal-pack file was inflated by exactly one while the JS pack,
which trims it, was not.

| file | claimed | real total | real non-blank |
|---|---|---|---|
| `pydantic/fields.py` | 1914 | 1913 | 1654 |
| `pydantic/types.py` | 3336 | 3335 | 2647 |

**11 of pydantic's 109 `large_file` findings (10%) existed only because
of it**, including two markdown files — so the 0.17.0 `docs` shape
inherited the bug. Counting now matches the JS pack. The evidence string
is corrected to "N lines"; it never counted non-empty lines.

### 1.6 OR-trigger detectors disproved their own headline — `4d00849`

Both fired on `A || B` and built summary and leading evidence from `A`
unconditionally.

`large_function.py` always said "`name` is N lines … At this size an
agent must read the whole body" — on a nesting-only finding, a size claim
the evidence directly below refutes. pydantic `get_strict` at 14 lines
against a 50-line threshold; drf 12 of 50 sampled cards; **zulip 172 of
898 Python findings**. Every blind judge independently used the word
"contradicted".

`todo_density` justified a count-floor finding with "3.0 markers per 1k
LOC (threshold 10)" — a passing check offered as the reason. 45 of 73
zulip findings.

Both now name the condition that tripped. Verified: an 8-line, depth-5
function reports `nesting depth 5, 8 lines (within the 50-line budget)`.

### 1.7 The quadratic duplicate-block sort — `d098c37`

`Detector.run()` is called once per file. Both duplicate-block detectors
spread the entire repo-wide hash map into an array and
`localeCompare`-sorted it on **every one of those calls**, then discarded
every group not anchored on the current file — O(files × hashes log
hashes). A PostHog CPU profile put **36% of all samples** in those two
comparators.

`anchoredGroups(index, view)` now groups by anchor once per index,
cached on a `WeakMap`. Each `run()` is an O(1) lookup.

- **Output byte-identical** — hono 376 findings, id-stripped equality
- hono 6.89s → 5.39s
- **n8n, which never finished at 60 min or 2h51m, completed in 789s
  (13m 9s)**: 16,325 findings, 1,662 high, 19,738 files, and
  `coverage.by_package` populated with 86 entries — a surface that was
  previously untestable because only subtree scans ever completed. A
  second run under heavy CPU contention (96 concurrent eval agents) took
  1082s, so treat both as upper bounds rather than a clean benchmark.

### 1.8 `context` printed a handle `explain` could not resolve — `775996a`

`context` numbers findings from 1 *per file*; `explain` resolves
globally. Same shape, different meaning:

```
$ crimes context src/MetricsGrid.tsx   → id=crime_00001
$ crimes explain crime_00001           → file: src/server/migrations.ts
```

They agreed only when the file ranked first. This is the documented
pre-edit agent workflow — what `crimes init --agents` wires up — so it
was a silent wrong answer at the centre of the agent-native positioning.
`context` now prints `fingerprint=<type>::<file>::<symbol>`, which
`explain`, `ignore` and `feedback` already accept.

### 1.9–1.10 Fingerprint collisions — `ab58fdb`, `543a594`

0.17.0 broke the wire format to stop `crimes ignore` suppressing
findings its author never looked at, shipped `Finding.discriminator` as
the general answer, then wired it into **two** detectors — the ones its
own self-scan surfaced. That was a biased sample.

Fixed: `commented_out_code` (hashed block text), `weak_test_signal` (test
title), `large_function` (start line, **only** where the symbol is
ambiguous).

Measured:

| repo | before | after |
|---|---|---|
| hono | 89 of 377 (23.6%) | **2 of 376 (0.5%)** |
| n8n | 2,723 of 16,325 (16.7%) | **496 of 16,325 (3.0%)** |
| self-scan | 3 | **0** |

**Three detectors still collide and were not fixed** — they are next in
the queue (§4.4a): `unbounded_async_fanout` (294 on n8n),
`swallowed_error` (111), `contract_drift` (26), plus `logic_in_comments`
(18). `commented_out_code`'s residual 15 are genuinely identical comment
blocks in one file, which the content hash cannot separate and arguably
should not.

> **A weaker guarantee, recorded rather than glossed.** `large_function`
> uses the start line, which is positional, not content-derived — it
> moves if code above it moves. For two anonymous callbacks in one file
> there is nothing more stable to key on, and an unstable fingerprint on
> a previously *colliding* finding still beats one that silently
> suppresses its neighbours. Revisit if a body hash becomes available.

### 1.11 `dependency_provenance_gap` checked Python against npm — `5726216`

The undeclared-imports arm iterated every import edge regardless of
language. On zulip: a **HIGH-severity** finding claiming "450 external
package(s) … a clean install can fail", itemising `abc` and `_typeshed`
(Python stdlib) and `aioapns` (declared, in `pyproject.toml`). The
implied fix was to add the Python stdlib to `package.json`.

Edges from files Node does not resolve are now skipped. **Verified on
zulip: the 450-package finding is gone; the correct medium-severity
lockfile finding remains.**

The rest of this detector is among the strongest in the product —
`by_package` was 118/118 correct on cal.com and the 0.17.0 `!`-negation
work correctly excluded five template scaffolds. One arm was broken, not
the detector.

---

## 2. Deliberately not changed

Each of these is a real decision, not an oversight.

**`large_file` still counts blank lines.** Both packs do. Making it count
true non-blank lines would drop every number 15–25% and effectively
retune thresholds repo-wide. That is calibration, not a bugfix.

**`weak_test_signal` still does not follow assertion helpers.** This is
the largest remaining noise source (619 findings, **0 act from both
judges**) and it is *not* a contained fix: `ParsedPyFile` exposes no
general call data, only `dateCalls` and `ioCalls`. Crediting "this test
calls a helper that asserts" requires adding call extraction to the
Python parser. Feature-sized; scope it deliberately.

**`agent_risk` still collapses into length.** Fixing it changes ranking
across every report and is a scoring-model decision, not a defect fix.

**No detector was disabled or gated.** The sunset shortlist is a
recommendation awaiting a decision.

---

## 3. Eval baseline

`packages/cli/package.json` is at **0.17.1**. Seven fixes move findings,
so the baseline moved. `pnpm run evals` was run at the maintainer's
explicit request; results in `evals/results/0.17.1/`.

**This is a product delta, not a measurement correction.** Nothing in the
scorer, judge prompts, scenario rubrics or fixture finding sets changed.
What moved is what `crimes` reports.

### Migration note for anyone with pinned entries

Suppressions and baselines naming a **`commented_out_code`**,
**`weak_test_signal`**, or **anonymous `large_function`** finding stop
matching and need re-recording — the same migration 0.17.0 described for
the three detectors it changed. `crimes feedback recheck` surfaces them.

---

## 4. Remaining work, in impact order

### Blockers

1. **`weak_test_signal` assertion helpers.** 619 findings, 0 act. Needs
   py-parser call extraction (§2). Also: count `self.fail`, exempt
   `@pytest.mark.benchmark`, and credit
   `model_dump_json(warnings='error')`.
2. **`coverage.warnings[]`.** A single field every silent-skip path
   populates. Would have surfaced four of the eleven bugs fixed above.
   Feeds: files skipped by extension (`.vue` — 1,226 in n8n, in *no*
   coverage field; `.hbs`/`.html` — 749 in zulip; `.ipynb` — 42 in
   mlflow), read failures (`EMFILE` swallowed as "no functions" in
   `ast-hash/function-index.ts:72-79`), `hasSyntaxErrors` (computed,
   never surfaced), and gitignored/excluded counts. Schema addition,
   minor bump.
3. **Finding ids are not stable across runs.** Ids are positional and the
   sort key includes clock-derived `recency`; two runs of an unchanged
   tree reorder. 202 of 3,593 positions moved on n8n `packages/cli`, 139
   of 3,759 on zulip. `crimes explain <id>` does not survive a re-run.
4. **`blast_radius` prints a component size as a per-file count.** zulip:
   3,759 findings, **37 distinct values**; 866 share `798`, 825 share
   `324`; pinned at 1.0 on 47%. The report says `slack.py` has 798
   importers; it has 5. `explain` renders it honestly ("50+ transitive,
   cap reached"); `scan` and `context` do not.

4a. **Three detectors still collide on fingerprints.** The same fix
   pattern as §1.9–1.10, already proven: `unbounded_async_fanout` (294
   findings lost on n8n), `swallowed_error` (111), `contract_drift` (26),
   `logic_in_comments` (18). Each emits more than one finding per
   (type, file, symbol); empty or repeated `symbol` is the tell. Cheap,
   mechanical, and the highest value-per-hour item on this list.
   Consider asserting fingerprint uniqueness in the scan pipeline so the
   class cannot regress a third time.

### Real problems

5. **`agent_risk` is a length ranking.** Top 20 on ebg: 15
   `large_function`/`large_file`. On zulip: 18 of 20, and **zero Python**
   on a repo that is 71% Python. `CLAUDE.md` says it "must not be
   collapsed into severity".
6. **Repo-level findings are invisible in the default view.** `scan`
   groups by file, so cal.com's highest-severity finding (anchored on
   `package.json`) never appears; seven of ten 0.16 detectors are absent
   from n8n's default view despite firing in the JSON.
7. **`commented_out_code` matches English prose.** 8,019 findings on
   airflow — **41.1% of the entire report is the Apache licence header**
   (7,320 at line range `(1,16)`/`(1,17)`). Every Apache-licensed repo
   hits this. Also flags Rust `///` doc comments and long prose.
8. **tsconfig path aliases** in `dependency_provenance_gap` — resolved
   only from a *root* `tsconfig.json`, so cal.com (which has none, normal
   for Next.js) reported `@components/*`, `.` and `..` as undeclared
   packages.
9. **`sync_io_in_hotpath` has no working hotpath test.** Fires on
   `if __name__ == "__main__"` scripts, Django management commands and
   `@cache`-decorated functions. Also a file-level finding wearing one
   function's `symbol` and `lines` (a span covering 81% of a file), which
   corrupts any ±N-line excerpt built from it.
10. **`pass_through_abstraction` fabricates chains from method names.**
    Confirmed on zulip, cal.com and n8n; confidence *rises* with the
    number of unrelated files joined (0.92 across three repositories on
    `delete`, 0.98 across four on `has`). The single-file arm is a
    different code path and looks sound.
11. **`parallel_destination`: 2,819 findings from 134 files** — 53% of
    one n8n package — pairing Vue composables on the token `use`. Zero on
    every other repo. Strongest default-off candidate.
12. **`boolean_naming_drift`** flags framework-owned names that cannot be
    renamed (Django `Migration.atomic`, `Meta.abstract`), Pydantic fields
    already annotated `: bool`, and names its own convention exempts. It
    proposes semver-major renames of public API options at
    `effort: "quick"`.
13. **`scope-class` misses vendored trees** — drf's vendored
    google-code-prettify, `pydantic/v1/`, `_pb2.py`, a file whose first
    line is `# @generated by protoc`, and two airflow paths that *do*
    match `GENERATED_RE` and are `isNeverReportable` yet were reported.
14. **`hotspots`** ranks manifest churn #1 (`package.json` at 72% on
    hono), operates over a different file universe than `scan`, and on a
    quiet repo degenerates to alphabetical order while still printing
    confident percentages.
15. **`mixed_utc_local_methods` cannot fire on modern Python.** It matches
    bare `datetime.utcnow()` but not a wrapper (`timezone.utcnow()`),
    which the parser's `dateCalls` never sees. Airflow has 775 `utcnow()`
    sites and 21 files mixing both; the detector found zero.
16. **`cross_language_route_drift` is confidently wrong.** On PostHog its
    28 "backend routes" came entirely from two sidecar services; zero
    from PostHog's own Django/DRF API, because it matches decorator
    routing only. The `backend.length === 0` guard that would have
    suppressed it was defeated by those sidecars. Result: one
    high-severity finding comparing PostHog's test suite to a Stripe
    mock. `cross_language_type_drift`, by contrast, is the 0.15 release's
    genuine success — keep it.

### Annoyances

17. `--all` is a byte-for-byte no-op in `--format json` while the human
    output advertises it.
18. Default-view suppression is a *file* cap (`scan.topFiles`), not a
    finding budget — no compression on small repos.
19. `explain` exits 2 on `oversized_raster`, a type the scanner emits;
    its copy-paste `crimes ignore` block is not shell-safe.
20. `verdict` fails on `master`-default repos (tries only `origin/main`,
    `main`) and costs two full scans to report "unchanged".
21. `diff` human output is three integers with no locations, and runs two
    full scans.
22. No `fingerprint` field in the JSON, though four commands require one.
23. `lines` absent on 12–16% of findings; `symbol` undefined on 20 of 34
    types.
24. `.json`/`.yaml`/`.txt`/`.rst`/`.adoc` absent from
    `DEFAULT_SOURCE_INCLUDES`, so the 0.17.0 data-format exclusion and 5
    of 7 docs extensions are unreachable at default config.
25. Score derivation is mixed into `evidence` rather than a separate
    field.

---

## 5. How to pick this up cold

1. Read [`2026-08-02-0.14-to-0.17.md`](./2026-08-02-0.14-to-0.17.md) §3
   for the defect list with reproductions, and §8 for the sunset
   shortlist.
2. This file's §4 is the queue. Items 1–4 are the blockers.
3. Every fix in §1 landed as: failing test first → watched it fail →
   minimal fix → `pnpm verify` green. Keep that.
4. Anything that moves findings needs a patch bump in the same commit and
   an eval re-run, per `evals/README.md` § Versioning policy. Say so in
   the commit message when a delta is a measurement correction rather
   than a quality improvement.
5. The corpus is at `~/crimes-dogfood/` (outside the working tree) with
   pinned SHAs in `corpus/SHAS.txt`. Rebuilding it: the clone scripts are
   `clone.sh` / `clone2.sh` there. Nothing from it is committed.

**One framing note for whoever picks this up.** The act rate that opened
the round — 2.5% and 9.5% from two blind judges — is not primarily a
detector-quality number. Strip the linter-bucket findings from zulip and
721 remain, about 1.2 per 1k lines, which is a defensible density. The
work that moves that number is items 1–6: stop hiding the differentiated
findings behind a file-grouped view, stop ranking by length, and stop
reporting confidently on code that was never read.
