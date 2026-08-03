# Remediation of the 0.14 → 0.17 dogfooding round

**Date:** 2026-08-03
**Version:** `0.18.0` (no release, no tag — see §3)
**Round report:** [`2026-08-02-0.14-to-0.17.md`](./2026-08-02-0.14-to-0.17.md)
**Friction log:** [`2026-08-02-log.md`](./2026-08-02-log.md)

The round found ~30 verified defects.

- **First pass (`0.17.1`, §1):** 11 fixed. Tests 1,873 → 1,911.
- **Second pass (`0.17.2`–`0.17.3`, §1b):** the fingerprint-collision
  class closed — §4.4a plus six detectors it had not named, the
  discovery that every discriminated finding was unignorable, and
  blocker 3 (scan determinism). Tests 1,911 → 1,950.
- **Third pass (`0.18.0`, §1c):** the remaining three blockers, done in
  parallel worktrees. Tests 1,950 → 2,011.

**Every blocker in §4 is now closed.** All test-driven, `pnpm verify`
green at every commit.

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

## 1b. Second pass — the fingerprint class, closed

A later session picked up §4.4a and finished it. Version `0.17.2`.

### 1.12 The remaining nine colliding detectors — `29f6555`, `37404d6`, `c93b530`

§4.4a named four. Fixing those and re-measuring found five more, so the
queue's list was itself a partial sample — the same mistake 0.17.0 made
by trusting its own self-scan.

| pass | detectors | n8n findings lost |
|---|---|---|
| pre-0.17.0 | — | 3,091 of 16,325 (18.9%) |
| 0.17.0–0.17.1 | 5 fixed | 496 of 16,325 (3.0%) |
| §4.4a (`29f6555`) | +4: `unbounded_async_fanout`, `swallowed_error`, `contract_drift`, `logic_in_comments` | 47 of 16,325 (0.3%) |
| found by measurement (`37404d6`, `c93b530`) | +5: `duplicate_component_shape`, `name_behavior_mismatch`, `duplicated_role_status_plan_check`, `negative_flag_maze`, `return_shape_roulette` | 28 of 16,325 (0.17%) |

Each discriminator is derived from what actually separates the findings:
the collection expression, the condensed protected operation, the other
declaration in the pair, a hash of the comment or condition, the shape
hash, the `(field, literal)` key, or — where nothing content-derived
exists — the start line.

**The residual 28 is not a bug.** All of it is two findings whose content
is genuinely identical: `commented_out_code` on duplicated comment blocks
(15) and `weak_test_signal` on tests with identical titles (13). A
content hash cannot separate those and arguably should not — they are
the same finding twice, which is a *deduplication* question, not an
identity one.

Verified against the shipped build, not derived by subtraction:

| repo | findings | pre-0.17.0 | 0.17.2 |
|---|---|---|---|
| n8n | 16,325 | 3,091 (18.9%) | **28 (0.17%)** |
| hono | 376 | 97 (25.8%) | **0** |
| self-scan | 283 | 7 (2.5%) | **0** |

The finding *count* is identical before and after on every repo — no
finding was added, removed, or rescored. Only the wire output moved,
which is why `0.17.2` is a patch bump rather than nothing.

`duplicate_component_shape` was the entire residual on hono (2 of 376
after 0.17.1) and the round had attributed that to nothing in particular.

### 1.13 A standing gate, so this cannot regress a third time — `29f6555`

The rule that decides whether a candidate discriminator survives now
lives in one place, `detectors/disambiguate.ts`, rather than being
open-coded per detector. Detectors offer a candidate; the pass drops it
where `symbol` is already unique, keeps it where it is not, and appends
the start line where two candidates in one ambiguous group still match.
That last case is what the per-detector implementations lacked — a
discriminator that is merely *usually* unique is the same bug in a
smaller font.

`scan.test.ts` gains a fixture repo built to trip every multi-emit
detector, asserting both that they fired and that no two findings share a
fingerprint. **Mutation-checked**: reverting the detectors makes it fail
with exactly the collisions the round measured.

> **What the gate does not cover.** It is a fixture, not a corpus. A new
> detector that collides on a shape the fixture does not contain will
> pass it. Both of this session's five extra detectors were found by
> measuring a real repo, not by the gate.

### 1.14 Every discriminated finding was unignorable — `1499b5e`

Found while fixing the above, and the more consequential half of it.
0.17.0 folded the discriminator into `fingerprintFinding`, but three
commands still built or validated fingerprints by hand:

- `crimes ignore <crime_id>` reconstructed `type::file::symbol`, so it
  wrote an entry matching nothing. It printed "Suppressed …" and exited
  0 while suppressing nothing. Reproduced on a two-anonymous-callback
  file: the entry lands, the finding is still in the next scan.
- `crimes feedback <crime_id> --file` had the same reconstruction.
- All three commands validated the argument against
  `/^[a-z0-9_]+::[^:]*::[^:]*$/` — three separate copies — which
  *rejects* every four-part fingerprint the scanner emits.

So a discriminated finding could not be ignored by id (silent no-op) or
by fingerprint (hard reject). The pattern now lives in `@crimes/core`
next to `fingerprintFinding` and treats the discriminator as an opaque
tail.

Also: the 0.17 release notes now cover all fifteen detectors whose
fingerprints changed in this minor. Three shipped in 0.17.0 with no
note, so `crimes feedback recheck` was reporting "detector behaviour
unchanged" about the one change that had invalidated the user's pin.

### 1.15 A re-scan of an unchanged tree was not reproducible — `3658750`

Blocker 3. Two scans of the same tree produced different
`crime_NNNNN` ids, so `crimes explain <id>` from one scan pointed at a
different finding in the next.

**The queue's number was mostly a measurement artifact.** §4.3 recorded
202 of 3,593 positions moved on n8n `packages/cli`. That measurement
matched findings by fingerprint while 567 of those 3,593 fingerprints
still collided, so it was reading ambiguous keys. With unique
fingerprints the figure is 11, and 7 of those are still collisions. The
genuine instability was **4 findings**.

Root cause: `recencyForDate` measured age in elapsed milliseconds, so
`scores.recency` was a continuous function of wall-clock time, rounded
to 2dp for the report. Any file whose true value sat within one
scan-gap of a `0.005` boundary flipped between runs → different
`rank_score` → different sort → every id after it renumbered. The
evidence was one file moving `0.23 → 0.22` across two scans 93 seconds
apart while every other file in the decay band held still.

Age is now whole UTC days, both endpoints floored, so the value changes
only at UTC midnight and for every file at once. Two supporting fixes
were needed for the guarantee to hold: the sort tiebreaker ran out at
`(severity, confidence, file, line-start)` and now ends on the
fingerprint, and `duplicated_policy` was still colliding.

> **`duplicated_policy` is the lesson worth carrying.** It collides at
> package scope and not at repo scope, because it anchors on its
> group's lex-first file and repo scope puts the groups on different
> anchors. The whole-repo measurement in §1.12 therefore called the
> class closed while it was not. **Scope changes which collisions
> manifest** — measure at more than one before claiming a class is
> closed.

**Verified:** two consecutive scans of n8n `packages/cli` (3,593
findings) and of hono (376) now produce **byte-identical** JSON. Not
"the ids match" — the whole report compares equal.

Residual: a scan pair straddling UTC midnight can still disagree. That
is bounded and predictable rather than continuous, and it is documented
on the function.

### 1.16 `weak_test_signal` did not follow assertion helpers — `4456904`, `8db9487`

Blocker 1, and the largest noise source in the product: **619 findings,
0 acted on, from both blind judges.**

The queue said the fix needed call extraction in the Python parser,
which `ParsedPyFile` did not have — only `dateCalls` and `ioCalls`. That
was right. `PyCall` is now a general capability (callee, receiver, line,
arg count, keywords, enclosing functions), not a one-off; `dateCalls` /
`ioCalls` were deliberately **not** folded into it, because their
`kind` / `timezoneAware` fields are Python-API knowledge that belongs in
the pack rather than re-derived in `core`.

> **The queue's premise was partly wrong.** It gave
> `assert_valid_user()` as the motivating example. That call was
> *already* credited — the existing matcher is `/^assert[A-Z_]/` and
> `assert` is followed by `_`. The real false positive is the helper
> **not** named `assert*`: zulip's `self.verify_action()`,
> pydantic's `import_from()`.

Helper following is **two hops, same file, receiver empty or
`self`/`cls`** — and each limit was measured rather than guessed. A
third hop credits **zero** additional tests on zulip and drf. Allowing
any receiver changed zulip's result by **zero**, while risking
`client.check(x)` being credited against an unrelated module-level
`check`.

| repo | files flagged | silent tests |
|---|---|---|
| zulip | 47 → **19** | 467 → **56** |
| pydantic | 52 → **33** | 236 → **96** |
| drf | — | 60 → **29** |
| airflow | — | 790 → **696 (12%)** |

**Airflow's 12% is a poor result and is reported as one.** Its helpers
live in `conftest.py` and in base classes in other modules — exactly the
case the same-file limit declines to guess at, because there is no
Python symbol index to resolve them with. Expect airflow-shaped repos to
still find this detector noisy.

All three smaller corrections landed: `self.fail` (matched only on a
framework receiver, so a project-local `job.fail("retry")` stays a state
transition), `@pytest.mark.benchmark`, and
`model_dump_json(warnings='error')`. The benchmark exemption went wider
than the brief for a measured reason: in pydantic's benchmark suites
**201 of 203** tests declare `benchmark` as a *parameter* and none carry
the decorator.

### 1.17 `coverage.warnings[]` — the scan now says what it skipped — `707ddf6`, `eedf2c3`

Blocker 2. Nine warning kinds (`files_not_discovered`, `files_excluded`,
`files_not_followed`, `files_in_hidden_path`, `files_unreadable`,
`files_unparsed`, `files_partial_parse`, `index_truncated`,
`index_unavailable`), each aggregated by subject with a count and up to
five example paths — 1,226 `.vue` files are one warning, not 1,226.

Four silent-skip paths the queue did not list turned up:

- **`ImportGraph` truncation at 5,000 files.** `imports/build.ts`
  already computed `limited` / `limitedReason`; nothing carried it to
  the report. Above the cap `blast_radius`, fan-in and cycles are
  advisory and said so nowhere.
- **Whole-index failure.** Every `safelyBuild*` in `indexes.ts` returns
  `undefined` on throw, silently zeroing a signal repo-wide.
- **Symlinks.** zulip's `docs/*.md` are symlinks;
  `followSymbolicLinks: false` drops them.
- **Read/parse swallowing is wider than the one site named** —
  `jsx/shape-index.ts`, `petty/build.ts`, `ia/build.ts` (×3),
  `imports/build.ts`, `imports/python.ts` (×2).

The reference set is `git ls-files --cached --others
--exclude-standard`, one cheap process that already knows `.gitignore`,
rather than a second filesystem walk that would either miss it or
reimplement it. Non-Git roots get **no** discovery-gap warnings rather
than a guess.

> **The queue's "gitignored counts" was already obsolete.** `.gitignore`
> has been honoured since `3968042` (§1.2), so gitignored files are not
> a coverage gap. Verified on hono: `node_modules` and `dist` correctly
> produce no warning.

`SCHEMA_VERSION` was **not** bumped for this — an optional additive
field on `coverage`, matching the precedent of
`universal_only_by_extension` (0.13.0) and `by_package` (0.15.0). It
moved anyway, for an unrelated reason (§1.18).

### 1.18 `blast_radius` called a reachability closure an importer count — `e379126`

Blocker 4. `transitiveImporterCount` returns the size of the transitive
importer closure. It was stored as `blast_radius_importers` and rendered
as "N importers".

Measured on hono: **six files all report 197** while their direct fan-in
ranges from 2 to 70 — the strongly-connected-component plateau, the same
signature as zulip's 866-findings-on-798. Six files appear in their own
"importer" closure, because the walk goes round the cycle back to the
start.

```
scores.blast_radius_transitive_importers   // renamed from blast_radius_importers
scores.blast_radius_direct_importers       // new
```

`scan` / `context` now print `blast top-quartile (70 direct / 197
transitive importers)`; `explain` prints both integers.

> **The queue over-credited `explain`.** It said `explain` "renders it
> honestly". `explain` did say *transitive* — better than
> `scan`/`context` — but it inverted the capped score rather than
> reading the measured count, so **798 rendered as "50+"**, and it never
> mentioned direct fan-in at all. Less wrong is not right.

`schema_version` 0.4.0 → **0.5.0**: a field rename is a breaking wire
change. No fingerprint changes, so no pinned suppression or baseline is
invalidated by it.

---

## 2. Deliberately not changed

Each of these is a real decision, not an oversight.

**`large_file` still counts blank lines.** Both packs do. Making it count
true non-blank lines would drop every number 15–25% and effectively
retune thresholds repo-wide. That is calibration, not a bugfix.

**`weak_test_signal` follows assertion helpers as of `0.18.0`** (§1.16)
— this entry is superseded. What remains deliberate is the *limit*: two
hops, same file, receiver empty or `self`/`cls`. Cross-file helpers are
still unresolved (§4d), which is why airflow only improved 12%.

~~**`agent_risk` still collapses into length.**~~ **Resolved in
`0.18.1`** — see §4.5. The maintainer took the decision; severity is no
longer an input and structural findings are capped.

~~**No detector was disabled or gated.**~~ **Resolved in `0.18.1`** —
`Detector.defaultOff` exists and `parallel_destination` is the one
detector carrying it. See §4.11. The rest of the sunset shortlist was
fixed rather than gated.

~~**`blast_radius`'s score is still pinned at 1.0 on 47% of zulip
findings.**~~ **Resolved in `0.18.1`** — the standing recommendation
(quartile rank, direct count as tiebreaker) was taken. Two caveats the
decision did not anticipate, both measured: resolution drops from 22
distinct values to 4 on hono, and it does not fix the modal-share
problem where more than half the data is tied (hono 54% at 0 → 53% at
0.25). The 47% figure itself was **not re-measured** — `zulip/zerver`
showed 0% at 1.0 even before, so it must come from a whole-repo scan
including the JS frontend. Original text follows.

**`blast_radius`'s score is still pinned at 1.0 on 47% of zulip
findings.** 0.18.0 fixed what the number is *called*, not how it is
scaled — the closure saturates a fixed cap of 50 on any repo with a
large strongly-connected component. Two options, both requiring a full
eval re-baseline: score direct fan-in instead (cheapest, but discards
real reach signal), or keep the closure and quartile-rank it within the
scan as `test_gap` already does (removes saturation by construction,
but `blast_radius` stops being comparable across repos). The second,
with the direct count as an in-quartile tiebreaker, is the standing
recommendation. It is a **calibration** change and must be recorded as
one.

**`transitiveImporterCount` still counts a file as its own importer**
when the file sits on an import cycle. Left deliberately: it is the
number `blast_radius` has always normalised, and changing it moves every
score. Documented on the function rather than silently corrected.

---

## 3. Eval baseline

`packages/cli/package.json` is at **0.17.1**. Seven fixes move findings,
so the baseline moved. `pnpm run evals` was run at the maintainer's
explicit request — 96/96 combinations in 32m 31s, results in
`evals/results/0.17.1/`.

| agent | 0.17.0 | 0.17.1 | move |
|---|---|---|---|
| claude | 0.84 | 0.82 | −2pp |
| codex | 0.57 | 0.56 | −1pp |

**Neither move is claimable, and neither is a regression.** The measured
noise band in [`evals/README.md`](../../evals/README.md) § Measured noise
band — three full runs of identical code at 0.12.1 — puts 2σ at roughly
**±6pp for claude and ±3pp for codex**. Both moves sit inside it.

`per_scenario_kind` swung hard in both directions (bugfix: claude −14pp
but codex +24pp; plan: claude +14pp but codex −11pp). That field holds
only 7–8 scenarios per kind and the README explicitly says not to quote
it without repeat samples — `plan`/claude ranged 0.64–0.88 across three
*identical* runs. It is recorded here and interpreted as nothing.

**This is a product delta, not a measurement correction.** Nothing in the
scorer, judge prompts, scenario rubrics or fixture finding sets changed;
what moved is what `crimes` reports. The honest reading is that eleven
fixes which removed false and duplicated findings and corrected
misleading messages **did not degrade agent task performance, and did
not measurably improve it either**. That is the expected shape: the
fixtures are small, clean, mostly-TS repos, and most of what was fixed
(gitignore, dot-directories, the Python `init` amputation, the quadratic
scale wall, fingerprint collisions at volume) barely bites at fixture
scale. The evidence that those fixes matter is in §1's measurements on
real repos, not here.

If a future change is expected to move the aggregate, take repeat
samples (`pnpm run evals -- --label r2`) before claiming it.

### Migration note for anyone with pinned entries

Suppressions and baselines naming a **`commented_out_code`**,
**`weak_test_signal`**, or **anonymous `large_function`** finding stop
matching and need re-recording — the same migration 0.17.0 described for
the three detectors it changed. `crimes feedback recheck` surfaces them.

**0.17.2 extends this to nine more detectors** (§1.12):
`unbounded_async_fanout`, `swallowed_error`, `contract_drift`,
`logic_in_comments`, `duplicate_component_shape`,
`name_behavior_mismatch`, `duplicated_role_status_plan_check`,
`negative_flag_maze`, `return_shape_roulette`. For the symbol-bearing
ones only the *ambiguous* findings move; pins on uniquely-named symbols
are untouched. `crimes feedback recheck` now carries a per-detector note
for all fifteen — it previously fell back to "detector behaviour
unchanged" for three of them.

Re-recording actually works now: before `1499b5e`, `crimes ignore` on a
discriminated finding was a silent no-op by id and a hard reject by
fingerprint (§1.14).

---

## 4. Remaining work, in impact order

### Blockers

**None. All four are closed** — 1 and 2 and 4 in `0.18.0` (§1.16–1.18),
3 in `0.17.3` (§1.15), 4a in `0.17.2` (§1.12–1.14).

The list below is kept because each entry records what was measured, and
because three of the four entries contained a claim that turned out to
be wrong — see the strikethroughs.


1. ~~**`weak_test_signal` assertion helpers.**~~ **Done** in `0.18.0` —
   see §1.16. All three smaller corrections landed too. **The premise
   in this entry was partly wrong**: the existing matcher
   `/^assert[A-Z_]/` already credited `assert_valid_user()`, because
   `assert` is followed by `_`. The real false positive is the helper
   *not* named `assert*` — zulip's `self.verify_action()`.
2. ~~**`coverage.warnings[]`.**~~ **Done** in `0.18.0` — see §1.17.
   Nine warning kinds, four more silent-skip paths than this entry
   listed. **The "gitignored counts" half of this entry was already
   obsolete** when it was written: `.gitignore` has been honoured since
   `3968042` (§1.2), so gitignored files are not a coverage gap and are
   correctly absent from the warnings.
3. ~~**Finding ids are not stable across runs.**~~ **Done** in `0.17.3`
   — see §1.15. Two consecutive scans of n8n `packages/cli` and of hono
   are now byte-identical. The 202-of-3,593 figure recorded here was
   mostly a measurement artifact: it matched by fingerprint while 567 of
   those fingerprints collided. The genuine instability was 4 findings,
   caused by `recency` being a continuous function of wall-clock time.
   The zulip figure (139 of 3,759) was measured the same way and was
   never re-checked — treat it as unverified rather than as a
   still-open number.
4. ~~**`blast_radius` prints a component size as a per-file count.**~~
   **Done** in `0.18.0` — see §1.18. **This entry over-credited
   `explain`**: it did say "transitive", but it inverted the capped
   score instead of reading the measured count, so 798 rendered as
   "50+". It was less wrong than `scan`/`context`, not right.
   The **score** saturation (pinned at 1.0 on 47%) was deliberately not
   touched — see §2.

4a. ~~**Three detectors still collide on fingerprints.**~~ **Done** in
   `0.17.2` — see §1.12–1.14. Nine detectors fixed, not the four listed
   here; n8n's residual is 28 of 16,325 (0.17%) and all of it is
   content-identical pairs. A standing uniqueness gate is in
   `scan.test.ts`. The related discovery — that every discriminated
   finding was unignorable by both id and fingerprint — is §1.14.

### New, surfaced by the 0.18.0 work

These were found while fixing the blockers and are deliberately *not*
folded into them — each is a separate behaviour change.

4b. ~~**Nested `test_*` functions are counted as tests.**~~ **Done** in
   `0.18.1` — `f303882`. Measured on zulip `zerver/tests` (whole tree):
   17 of 40 claimed silent tests were nested functions, 42.5%, and two
   files left the report entirely. **The entry was right about the
   counts and slightly wrong about their cause**: `test_message_delete.py`
   was 9 of 23, of which *eight* are nested — the ninth is a genuine
   miss (`capture_send_event_calls` is a base-class context manager in
   another file, so it is 4d). `test_decorators.py` was 5 of 71 and all
   five are nested. The exclusion is drawn at *any* enclosing function
   rather than at an enclosing test, because that is where pytest's own
   collection boundary sits.

4c. ~~**`pytest.warns(...)` is not credited as an assertion.**~~ **Done**
   in `0.18.1` — `e2c4762`. `@pytest.mark.xfail` landed with it.
   Measured on pydantic `tests`: 22 files / 76 claimed silent tests →
   15 / 45. **One number in the entry needs restating**: the "36
   occurrences" figure counts uncredited `pytest.warns` *call sites*,
   which is not the same measurement as tests credited — 31
   claimed-silent tests is what the change is worth on that tree.
   pydantic writes `pytest.warns` 175 times in `tests/`.

4d. **Cross-file assertion helpers are unresolved**, which is what
   airflow's 12% improvement is waiting on (§1.16). Needs a Python
   symbol index that does not exist. Feature-sized; scope it
   deliberately, and note it would also serve any other Python detector
   that wants to follow a call. **Still open** — deliberately not
   attempted in the 0.18.1 pass; it is the one item here that is a
   feature rather than a correction.

4e. **JS syntax errors have no `coverage.warnings[]` signal.** The
   Python pack surfaces `hasSyntaxErrors`; the JS pack has no public
   equivalent — `ts.createSourceFile` keeps `parseDiagnostics` off the
   public `SourceFile` type. Reaching it means an internal-API
   dependency, which was judged not worth it *in a field whose entire
   value is being trustworthy*. Revisit if a supported signal appears.

### Real problems

5. ~~**`agent_risk` is a length ranking.**~~ **Done** in `0.18.1` —
   `ce0ccab`. Severity is no longer an input at all (the fallback
   intrinsic derived from it was the collapse, for the ~18 detectors
   that set none of their own), and findings are classified
   `structural` / `agent_signal` / `standard` with a ceiling on the
   first. Measured on the top 20 by rank: zulip/zerver structural 18→0
   and Python 0→20 of 20; hono structural 14→0 with distinct types 8→10.
   **The ceiling had to be measured, not guessed** — 0.4 left
   `large_file` outranking `contract_drift` because it sat inside the
   agent-signal band (0.31–0.53); 0.3 is the band's floor. **New
   concern**: zulip's top 20 is now 16/20 `sync_io_in_hotpath`, which is
   a concentration of its own and the next thing to look at.
6. ~~**Repo-level findings are invisible in the default view.**~~
   **Done** in `0.18.1` — `92af2cc`. A `Repo-level` section above the
   per-file groups, driven by an explicit type list rather than a path
   heuristic. On n8n `packages/cli` it surfaces five findings that were
   in the JSON and nowhere in the view, including
   `dependency_provenance_gap` on `package.json` and
   `agent_permission_sprawl` on `AGENTS.md`. A section rather than a
   scoring boost: the problem was the grouping, not the ranking.
7. ~~**`commented_out_code` matches English prose.**~~ **Done** in
   `0.18.1` — `f3a0b19`. **Confirmed to the number**: airflow 8,019 →
   45, and 7,320 of those were the licence header, 41.2% of a 17,745-
   finding report. The whole report drops to 9,771. Cause: the code-token
   list was bare words, and the header contains three of them
   ("**for** additional information", "may not **use** this file", "the
   License **for** the specific language"). Matching now requires code
   *syntax*. 680 further non-licence blocks stopped firing; two sampled
   at random were both false positives (a licence header behind a
   shebang, a Go package doc comment).
8. ~~**tsconfig path aliases** in `dependency_provenance_gap`.~~
   **Done** in `0.18.1` — `6908ddf`. Two independent causes, both
   confirmed on cal.com. `.` and `..` slipped through a relative-path
   guard that required a trailing slash — a one-character fix. Aliases
   are now collected from every tsconfig under `apps/` / `packages/` /
   `libs/` / `services/`, not just a root one cal.com does not have.
   Patterns only: resolving an alias to a *file* still needs the root
   `baseUrl`, but knowing a specifier is an alias is enough to stop
   calling it a missing dependency.
9. ~~**`sync_io_in_hotpath` has no working hotpath test.**~~
   **Mostly done** in `0.18.1` — `b330cd2`. Findings are now one per
   enclosing function, so `symbol`, `lines` and evidence describe the
   same code: airflow span median 8→1 line, max **4,196→185**. Django
   management commands and `@cache`-decorated functions are exempt
   (`cli_command`, and a new `memoised` shape). Splitting per function
   multiplied volume 494→1,108, capped to the 3 worst per file at 811.
   **The `if __name__ == "__main__"` half is NOT fixed** — those
   functions classify as `domain` and I found no signal separating them
   from real domain code without reading module-level control flow.
10. ~~**`pass_through_abstraction` fabricates chains from method
    names.**~~ **Done** in `0.18.1` — `2e9b2da`. **Worse than the entry
    says**: the 0.98 `has` chain on n8n starts at `Set.prototype.has`
    and joins four unrelated registries, each delegating to its own
    private Map. A member call (`this.repo.delete(…)`) is no longer
    followed at all — its tail names a method on an object whose type
    was never read — and a cross-file step now requires the target to be
    exported. n8n `packages/cli`: 13 findings / 7 chains, all 7 at
    confidence ≥0.9 → 6 findings / **0 chains**. The surviving 6 are
    clusters, which the entry correctly called sound.
11. ~~**`parallel_destination`: 2,819 findings from 134 files.**~~
    **Done** in `0.18.1` — `20e4e52`. Confirmed exactly: 2,819 findings,
    134 files, **52.8%** of n8n `packages/frontend/editor-ui`. It is now
    the first and only detector to ship gated behind
    `Detector.defaultOff`; the package's report drops 5,342 → 2,523. A
    gated detector is announced on stderr even under `--no-color`,
    because the user did not make that choice — we did.
12. ~~**`boolean_naming_drift`** flags framework-owned names.~~ **Done**
    in `0.18.1` — `67ae2ce`. Confirmed on drf and pydantic: `many`
    (`Serializer(many=True)`), `public`, `coerce_to_string`,
    `strip_whitespace`, `fail_fast`, `repr` — all published API, all
    flagged at `effort: "quick"`. The charge is now scoped to
    *unannotated locals inside a function*, which is the only place its
    own rationale holds. Class attributes, instance attributes and
    annotated bindings are excluded. drf 7→1, pydantic 34→20. The
    annotated case was self-contradictory: the detector's own suggested
    fix is "rename it, **or add a `: bool` annotation**".
13. ~~**`scope-class` misses vendored trees.**~~ **Mostly done** in
    `0.18.1` — `9d6a871`. The last clause was the serious one and is
    **worse than stated**: not two airflow paths but **15 files carrying
    44 findings**, all from the ~50 detectors that predate
    `isNeverReportable` and never ask it. The policy is now enforced once
    in `scan`, so a detector added tomorrow inherits it. Classifier also
    widened for `_pb2.py` / `*.pb.go` and for minified bundles by name;
    drf's `prettify-1.0.js` needed content sniffing because it is
    minified but not *named* minified. airflow 44→0, drf 2→0.
    **`pydantic/v1/` is NOT fixed** — no general rule separates a bundled
    legacy copy from any other `v1/` API directory.
14. ~~**`hotspots`** ranks manifest churn #1.~~ **Done** in `0.18.1` —
    `f58061b`. All three parts confirmed on hono, and the first two share
    a cause: the row set was the union of *every churned path* with every
    file carrying a finding. Restricted to files `scan` could report on,
    plus an explicit manifest / lockfile / changelog list. hono's #1 goes
    from `package.json` (risk 0.72, 29 changes, one *low* finding) to
    `src/adapter/aws-lambda/handler.ts`. A `ranking_note` now states when
    the order is really `localeCompare`.
15. ~~**`mixed_utc_local_methods` cannot fire on modern Python.**~~
    **NO CHANGE MADE — the entry's premise is wrong**, and acting on it
    would have been a large regression. `beb569f`. Measured on airflow:
    728 of 740 `utcnow()` receivers are `timezone`, and
    `airflow_shared.timezones.timezone.utcnow()` returns
    `dt.datetime.now(tz=utc)` — timezone-**aware**. That is not the
    naive-UTC trap this detector charges; it is the fix it *recommends*.
    Matching any `<x>.utcnow()` would have produced ~728 high-confidence
    false positives. Airflow's whole tree has exactly one
    `datetime.datetime.utcnow()` and it is inside a comment. **Zero
    findings is the correct answer.** A regression test now pins the
    decision. The narrow technical claim (a wrapper is not matched) is
    true, but whether that is a defect needs 4d.
16. ~~**`cross_language_route_drift` is confidently wrong.**~~ **Done**
    in `0.18.1` — `c0135ff`. Confirmed on a real slice of PostHog: one
    HIGH-severity finding accusing `/api/projects/*` of drifting from a
    Stripe mock. **One correction**: it is *one* sidecar service, not
    two — all five decorator-routed Python files in PostHog live in
    `services/stripe-mock`, against 90 DRF `router.register` calls the
    detector cannot see. An orphan is now only reported when the backend
    declares at least one route sharing its first path segment. Match
    *count* would have been the wrong test — the detector's own
    canonical positive has zero matches too.

### Annoyances

17. ~~`--all` is a byte-for-byte no-op in `--format json`.~~ **Done** in
    `0.18.1` — `ad2e679`. Confirmed with `cmp` (42 findings either way;
    human output 63→485 lines). **Framed backwards in the entry**: json
    already emits everything, and teaching it to honour `--all` would
    mean teaching the machine contract to withhold findings by default.
    The flag is made *honest* instead — a stderr line when it had no
    effect — which leaves stdout byte-identical. Covers `--flat` and
    `--top`, which had the identical defect.
18. Default-view suppression is a *file* cap (`scan.topFiles`), not a
    finding budget — no compression on small repos.
19. ~~`explain` exits 2 on `oversized_raster`.~~ **Done** in `0.18.1` —
    `4fb9887`. **Wider than the entry**: asset detectors live in their
    own registry that `explain` never searched, so
    `raster_should_be_vector` and `svg_with_embedded_raster` were
    unexplainable too. The `crimes ignore` line is now single-quoted, and
    the pasted command was run end-to-end against a `my src/big file.ts`
    fixture to prove it works. Same fix applied to `crimes feedback
    recheck`'s command fields, which had the identical defect.
20. ~~`verdict` fails on `master`-default repos.~~ **Done** in `0.18.1`
    — `6be5681`. `refs/remotes/origin/HEAD` is consulted first —
    guessing by name order would silently compare against the wrong
    branch on a repo with both — then a widened candidate list. The
    two-scan cost is halved by reusing the base scan when both refs
    resolve to the same tree: hono `verdict --base HEAD` 12.3s/15.8s →
    7.0s/7.1s over two runs each. **An earlier single 40.6s measurement
    did not reproduce and is not quoted.** Lands in `diff`, so it is also
    half of §21.
21. `diff` human output is three integers with no locations, and runs two
    full scans.
22. ~~No `fingerprint` field in the JSON.~~ **Done** in `0.18.1` —
    `286c24e`. `schema_version` 0.5.0 → **0.6.0**; migration note in
    `docs/json-schema.md`. Both load-bearing properties re-checked after
    the change: byte-identical re-scans (`cmp` clean on messy-ts-app and
    hono) and fingerprint uniqueness (hono 376/376 unique).
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
