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

- **`0.19.0` – `0.21.0`:** the backlog, the working set, and a
  precision pass over four field-reported false positives.
- **`0.22.0`:** **the queue in §4 is closed.** Seven remaining
  entries, every one reproduced first. Four turned out to be wrong
  about themselves — §4g about which detector it described, §2's
  `large_file` about the size of its own effect *and* about which
  function it named, §4e about whether a public API existed, and §4f
  about whether there was a defect at all. Three were fixed, four
  re-closed with a measurement. Tests 2,195 → 2,210.

**Every blocker and every queue entry in §4 is now closed.** All
test-driven, `pnpm verify` green at every commit.

This document is the handoff. It records what changed, what was
deliberately *not* changed, and what is left — enough to resume cold.

**What is left is no longer in §4.** Three things were opened rather
than closed by the `0.22.0` pass, and each is a feature rather than a
correction: honouring a repo's own tooling excludes (with a
`coverage.warnings[]` entry per skipped path, so it cannot become a
silent-suppression mechanism — see §13); deciding
`sync_io_in_hotpath` by reachability from a `__main__` block rather
than by file (see §9); and unifying the two `commented_out_code`
variants, which still disagree about single-block files.

- **`0.23.0`: `agent_risk`'s inputs**, the oldest open item in the
  file. §5 was parked at `0.18.1` as "the next release's focus" and sat
  four releases. Picked up, and the root cause was not among the three
  questions it left open: **28 of 70 detectors expressed no intrinsic at
  all**, so the heaviest term in the formula was a fallback that sat
  below every deliberate judgement. Three of §5's own claims turned out
  to be wrong, including the band its constant was fitted to. The three
  A/B/C features above are untouched and still open.

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

**`large_file` still counts blank lines.** Both packs do. **Measured in
`0.22.0`, tried, and kept** — the entry reached the right decision from
two wrong numbers and one wrong function.

**Wrong number 1: "drops every number 15–25%".** Measured across every
file currently carrying a `large_file` finding:

| repo | n | blank share, all | code files | prose files |
|---|---|---|---|---|
| choreograph.cc | 33 | 6.5% | **3.0%** (n=27) | 21.0% (n=6) |
| crimes (self-scan) | 115 | 9.3% | **5.1%** (n=101) | 17.5% (n=14) |
| hono | 26 | 8.9% | **8.9%** (n=26) | — |

The high numbers are **prose**, which is blank-line separated by
construction — and prose has had its own 1000-line `docs` budget since
`0.17.0`, so the class where the correction bites hardest is already
measured against a different ruler. Actual source runs **3–9%**.

**Wrong number 2: "5 of 33 choreograph findings would fall below the
300-line threshold"** (from the R4 pre-measurements). It is **8 of 33**
— 5 code files and 3 prose ones. Also 6 of 115 on the crimes self-scan
and 5 of 26 on hono.

**Wrong function: `large_file` does not call `countNonEmptyLines`.**
It reads `UniversalFile.lineCount`, whose `countLines` is honestly
named and documented. The misnamed function feeds `ParsedFile.lineCount`,
which is **read by no detector at all** — one assertion in
`parse.test.ts` and ~30 test fixtures satisfying the type are its
entire consumer list. The naming lie and the counting policy were never
the same defect.

**Why the counting policy stays.** The change was implemented and
measured, not argued about:

- It is a **calibration** change wearing a bugfix's clothes. It loosens
  the detector by 3–9% while leaving the 300-line threshold alone.
  Re-tuning to ~285 to hold strictness constant leaves nothing changed
  but the printed number.
- It **silences the canonical fixture finding.**
  `examples/messy-ts-app/src/billing.ts` is 310 lines, 22 of them
  blank — 288 non-blank, under 300. `refactor-01-large-file` goes from
  scored to **unrankable**, and its prompt names the finding: *"src/billing.ts
  has tripped the large_file threshold … Tie your plan to the
  `large_file` finding's evidence."* That is the §30 shape exactly — an
  agent asked to act on something that is not in its context, and
  scored 0 for not finding it.
- The **agent-free ranking metric says nothing moved.** Three scenarios
  shift by +0.001 each. The headline mean rises 0.3582 → 0.3646 only
  because the denominator shrank: deep scenarios 28 → 27, unrankable
  3 → 4. Reading that as an improvement is reading a shrinking
  denominator.
- **Nothing user-facing lies.** §1.5 already changed the evidence line
  to `${lines} lines` rather than "non-empty lines", and the
  detector's own rationale is context budget — a blank line costs a
  token and a screen row.

**What did change: the name.** `countNonEmptyLines` → `countSourceLines`,
which is a lie of exactly the kind `name_behavior_mismatch` charges.
Behaviour-neutral; no finding moves.

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

~~**`transitiveImporterCount` still counts a file as its own
importer**~~ **Measured in `0.22.0` and declined — closed, not carried
forward.** This is the §15 shape: the premise is sound and acting on it
buys nothing. Full numbers in
[`2026-08-05-r4-premeasurements.md`](./2026-08-05-r4-premeasurements.md).

The entry was carried forward on the grounds that `blast_radius` was
log-scaled with a direct-count term in `0.18.1`, so the off-by-one was
worth revisiting. Two things were measured before touching it:

| repo | files with a transitive count | `blast_radius == 1.0` | files on a reported cycle |
|---|---|---|---|
| choreograph.cc | 208 | 0 (0.0%) | 0 of 207 (0.0%) |
| crimes (self-scan) | 1,136 | 0 (0.0%) | 1 of 1,169 (0.1%) |
| hono | 152 | 0 (0.0%) | 4 of 152 (2.6%) |
| cal.com | 2,079 | 0 (0.0%) | — |

**The 47% saturation that motivated revisiting it is gone** — 0.0% on
every repo measured, across 3,575 files. There is no longer a
compressed band at the top for an off-by-one to hide in, and no score
crying out for correction. The defect is real, confined to 0–2.6% of
files, and worth **+1 on a log-scaled input**: changing it would move a
handful of scores by less than a rounding step and invalidate a
baseline for the privilege.

**Where the entry was wrong: nothing is lying, so "documented rather
than silently corrected" was the whole answer all along.** The
function's doc comment already says it computes "files that can reach
this one, plus this one if it is cyclic, not a fan-in count", and
`blast_radius_direct_importers` has carried the fan-in number since
`0.5.0`. It interacts with `0.21.0`'s `high_fan_in_fan_out` type-only
rule only in principle: that change touches which *severity* a fan-in
gets, not what the count is. **No code was written.**

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

### 0.18.1 baseline — no measurable movement, and that is not the same as no effect

`pnpm run evals` at `a6cb5d4`, 96/96 in 31 minutes, results in
`evals/results/0.18.1/`.

| agent | 0.17.0 | 0.17.1 | 0.18.1 | move vs 0.17.1 | 2σ band |
|---|---|---|---|---|---|
| claude | 0.84 | 0.82 | **0.85** | +3pp | ±6pp |
| codex | 0.57 | 0.56 | **0.54** | −2pp | ±3pp |

**Both moves sit inside the noise band and neither is claimable.**

The run window was verified clean, which is the rule `a13277a` added
after 0.18.0 was invalidated for spanning two builds: every `dist` was
built once at 08:11:44–08:11:50 (CLI last), the run covered
08:12:09–08:43:18, and no build or commit landed inside it.

`per_scenario_kind` swung hard again — codex `bugfix` 0.57 → 0.33,
`context` 0.46 → 0.69, `review` 0.53 → 0.39. Per the README that field
holds 7–8 scenarios per kind and must not be quoted without repeat
samples. The `bugfix` drop was investigated rather than assumed, both
ways:

- The expected findings **still fire**. `cross_language_type_drift` = 1
  on `13-polyglot-monorepo`, `timezone_unsafe_parse` = 1 on
  `01-messy-ts-app`.
- The responses are **correct**. Codex identifies the plan-tier drift
  exactly (`free|pro|team|scale` against `free|pro|enterprise`, both
  directions, with a generate-from-one-contract fix) and gives the right
  timezone fix (append `Z`, and it explicitly sets aside the unrelated
  second literal). Neither response contains the literal detector id, so
  both score zero.

That is the artefact `0434d3b` documented: `structural_pass_rate` matches
detector **ids** in response text, so it is blind in both directions —
it cannot see a correct answer phrased in prose, and it cannot see a
finding becoming more accurate.

**This is why a flat aggregate is not evidence the work did nothing.**
The 0.18.1 group removed 8,019 → 45 `commented_out_code` findings on
airflow, 2,819 → 0 `parallel_destination` on n8n, and a
high-severity PostHog finding comparing a frontend to a Stripe mock.
None of those repos is in the fixture set, and none of those defects
exists at fixture scale. The evidence for this pass is in §1 and §4's
measurements on real repositories, not here.

Two changes in this group *should* be visible to a ranking-sensitive
metric and are not, because no such metric exists yet: `agent_risk`
(§4.5) and `blast_radius` (§2). Building one is the open question
recorded in `docs/calibration-followups.md`.

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

4d. ~~**Cross-file assertion helpers are unresolved**, which is what
   airflow's 12% improvement is waiting on (§1.16). Needs a Python
   symbol index that does not exist.~~ **Done** in `0.18.3` —
   `ce2963b`. See the note below the original text for what the scoping
   was wrong about, and for the over-credit found before shipping.
   Original entry, for the record: Feature-sized; scope it
   deliberately, and note it would also serve any other Python detector
   that wants to follow a call. **Still open** — deliberately not
   attempted in the 0.18.1 pass; it is the one item here that is a
   feature rather than a correction. **Now scoped** in
   `.planning/PROMPT-0.19-python-symbol-index.md`: the resolution has to
   go through the MRO rather than the name (matching `self.<method>()`
   against any same-named function is the mistake `2e9b2da` just removed
   from `pass_through_abstraction`), and the real work is architectural
   — Python files are parsed *inside* the per-file detector loop, so no
   repo-wide index has anywhere to live yet. Three options are compared
   there with a recommendation.

   **Where the scoping was wrong: the architectural blocker did not
   exist.** All three options it compares — a second pre-pass, moving
   the detector to the cross-language pass, a shared parse cache — are
   answers to "Python files are parsed inside the per-file loop, so a
   repo-wide index has nowhere to live". But `buildPythonImportEdges`
   already parses **every** discovered Python file in the pre-pass, and
   already builds the `PyModuleIndex` that name resolution needs. It
   kept `parsed.imports` and discarded the rest. The index is a linear
   pass over data already in hand; the recommended option (c) would
   have built a cache for a parse that was already happening.

   The *resolution* half of the scoping was right and load-bearing:
   through the MRO and the importing file's own imports, never by name.

   **One thing neither the scoping nor the acceptance criteria
   anticipated, found on zulip before shipping**: three test files were
   credited through `zerver/actions/*.py`, where `do_set_realm_property`
   asserts `isinstance(raw_value, property_type)` about its own
   argument. That is a *precondition defending a production function
   from its caller*, not a test checking a result — and a test that
   calls it and checks nothing else is exactly the hollow test this
   detector exists to report. Crossing the file boundary silently broke
   an assumption same-file resolution never had to state: a test file's
   own functions are test infrastructure by construction. Cross-file
   credits now require the helper to live in test infrastructure.
   Caught only by reading the cited files, which is the argument for
   naming them in the evidence.

   Measured, before → after:

   | | before | after |
   |---|---|---|
   | zulip `weak_test_signal` | 162 | 152 |
   | zulip files reporting | 48 | 38 |
   | zulip `test_message_delete.py` | 1 | **0** |
   | airflow `weak_test_signal` | 435 | 380 (−12.6%) |
   | airflow files reporting | 326 | 271 (−16.9%) |
   | airflow claimed-silent tests | 634 | **462 (−27.1%)** |

   Cost: airflow 97.1s → 99.4s over three samples each, against a ~12s
   run-to-run spread — no measurable regression. Fingerprint collisions
   are **identical** before and after (zulip 30/3458, airflow
   115/9926, zero new groups), so the pre-existing discriminator issue
   is untouched.

   > **Correction, `0.22.0`:** those two totals were later quoted as
   > `weak_test_signal` collisions, and they are not — they are the
   > totals across every detector, which is what this sentence measured
   > and all it was ever entitled to claim. Re-measured, **zero** of
   > either repo's collisions are `weak_test_signal`. See §4g.

   Note the airflow headline is not the same quantity as the "12%" this
   entry was written about, and should not be read as having moved it.
   That figure was the share credited through assertion helpers; this
   is claimed-silent tests across the repo. Both moved; only the second
   was measured here.

4f. **`verdict`'s identical-tree short circuit is not a constant-time
   path, and on a small repo it is slower than the scan it replaces.**
   Found in `0.20.0` while fixing a flaky timing assertion in
   `verdict.test.ts`, not by looking for it.

   Measured on a synthetic repo, warm process, `verdict --base HEAD`
   against an identical tree:

   | tree | short circuit | full `scan()` of the same tree |
   |---|---|---|
   | 1 file | 416 ms | — |
   | 61 files | **1762 ms** | **929 ms** |

   `6be5681` is not wrong about what it measured — on hono
   `verdict --base HEAD` genuinely went 12.3s → 7.0s, and the second of
   two full scans genuinely was pure cost. What is wrong is the mental
   model the optimisation invites: "identical trees, so we do two
   `git rev-parse` calls and stop". Something on that path scales with
   the tree, and on a small repo it costs more than just scanning.

   **Not fixed here, and deliberately not guessed at.** The next step is
   to profile the short-circuit path rather than to assume which call it
   is; a fix chosen from the table above would be a fix chosen from two
   data points. The flaky test that surfaced it now says so in a comment
   instead of asserting a size-independence claim that does not hold.

   ~~*(entry as filed in `0.20.0`, above)*~~ **Profiled in `0.22.0`.
   The entry does not reproduce: the 1762-vs-929 comparison is a
   measurement-order artifact.** §27's shape.

   **Whichever call runs first in a Node process is the slower one.**
   Same 61-file tree, same process, only the order changed:

   | order | first call | second call |
   |---|---|---|
   | `verdict` then `scan` | verdict **312 / 323 ms** | scan 227 / 212 ms |
   | `scan` then `verdict` | scan **288 / 300 ms** | verdict 243 / 244 ms |

   Module init and JIT cost ~70–110 ms and land entirely on whichever
   call is measured first. `verdict` was always measured first. Reverse
   the order and `verdict` comes in **below** `scan` — which a path
   doing strictly more work than a scan cannot do.

   Comparing like with like, `verdict --base HEAD` on an identical tree
   costs **one scan plus a small constant**. Cold process, at the CLI,
   best of three:

   | files | `scan` | `verdict --base HEAD` | delta |
   |---|---|---|---|
   | 1 | 331 ms | 355 ms | **+24 ms** |
   | 61 | 499 ms | 542 ms | **+43 ms** |
   | 300 | 1007 ms | 1117 ms | **+110 ms** |

   **And the constant-time part really is constant.** Phase profile in
   a warm process:

   | phase | 1 file | 61 files | 300 files |
   |---|---|---|---|
   | 2× `git rev-parse` | 16 ms | 16 ms | **17 ms** |
   | `git archive \| tar` | 15 ms | 20 ms | 48 ms |
   | scan of the exported tree | 28 ms | 165 ms | **680 ms** |

   The two `rev-parse` calls the entry pictured are flat across a
   300× change in tree size. What scales is **the base scan**, which
   the optimisation never removed — `diff()`'s own comment says so in
   as many words: *"The saving is half the work, not all of it, and
   half of an accurate answer beats all of a wrong one."*

   **Where the entry was wrong:** it attributed a mental model to
   `6be5681` that `6be5681` explicitly disclaims, and it compared a
   cold call against a warm one. Nothing is fixed because nothing is
   broken. The test comment now carries the profile instead of the
   artifact, and the test's own title — which claimed the short circuit
   answered "without scanning either side" — is corrected to *head*
   side.

4e. ~~**JS syntax errors have no `coverage.warnings[]` signal.**~~
   **Done** in `0.22.0`. This entry was carried forward twice expecting
   to be re-closed, and **its premise is wrong**: a supported signal
   was there the whole time.

   Original text, for the record: *The Python pack surfaces
   `hasSyntaxErrors`; the JS pack has no public equivalent —
   `ts.createSourceFile` keeps `parseDiagnostics` off the public
   `SourceFile` type. Reaching it means an internal-API dependency,
   which was judged not worth it in a field whose entire value is being
   trustworthy.*

   **Where the entry was wrong: it checked one route and concluded
   there was none.** `SourceFile.parseDiagnostics` genuinely is
   internal, and still is on TypeScript 5.9.3. But
   `ts.NodeFlags.ThisNodeHasError` is **public in
   `typescript.d.ts`**, `Node.flags` is public, and the parser sets the
   flag on the node it failed at. `parseFile` already visits every node
   — so the signal is one bitwise AND inside a traversal that was
   already happening. Two other public routes exist and are both worse:
   `Program.getSyntacticDiagnostics` needs a `Program` the JS pack
   never builds, and `ts.transpileModule(…, { reportDiagnostics: true })`
   does a full emit we throw away — measured at 589–787 ms against
   `createSourceFile`'s 113–177 ms over the same 304 files, a 5× parse
   cost for the same answer.

   Measured cost of the flag, over n8n `packages/cli`, 2,977 files:
   **1262 ms → 1330 ms**, inside the run-to-run spread on the two
   smaller trees.

   **The trap this walked into first, and it is trap 1 again: check
   what the measurement actually reads.** The first probe parsed
   everything as `ScriptKind.TSX` and reported **12 of hono's 307
   files** as broken — all of which compile. `<T>(v)` is a type
   assertion in a `.ts` file and an unclosed JSX tag in a `.tsx` one.
   `pickScriptKind` already gets this right per extension; the flag is
   only trustworthy because of it, and a test now says so.

   With the script kind right, the false-positive rate over n8n,
   cal.com, posthog and choreograph.cc is **1 file in 39,177**: n8n's
   `scripts/block-npm-install.js`, which writes `'\033[0;31m'`. TS
   calls an octal escape an error, so the parser flags it, but the tree
   is complete and the script runs — reporting it as a partial parse
   slightly overstates. A discriminator was tried and **rejected on
   measurement**: requiring a synthesised zero-width node (the parser's
   marker for "expected a token and did not find one") also fails to
   fire on an unclosed function body, which *is* a genuinely partial
   tree. A filter that fails open on the case that matters is worse
   than a 0.003% over-report.

   JS whole-file detectors still run on a partial tree, unlike
   `weak_test_signal.py` — so on `language-js` the warning is the only
   thing separating a broken file from a clean one. Recorded in
   `docs/json-schema.md` and on `CoverageWarningKind`.

4g. ~~**`weak_test_signal` fingerprint collisions.**~~ **Done** in
   `0.22.0`. The collision class is real and now closed. **The entry
   was wrong about which detector it was, and about both Python
   numbers**, which is why it is worth writing down rather than just
   ticking off.

   Original entry: *2 of 3,585 on n8n `packages/cli`, 30 of 3,458 on
   zulip, 115 of 9,926 on airflow — two tests with identical titles in
   one file, so the test-title discriminator can't separate them.
   Folding the line range in fixes it and invalidates every pinned
   `weak_test_signal` suppression.*

   Measured, by grouping every finding by its emitted `fingerprint`:

   | repo | findings | colliding | groups | `weak_test_signal` share |
   |---|---|---|---|---|
   | n8n `packages/cli` | 3,571 | 4 | 2 | **4 of 4** |
   | zulip | 3,453 | 39 | 10 | **0 of 39** |
   | airflow | 9,925 | 184 | 69 | **0 of 184** |

   Only n8n's collisions are `weak_test_signal` at all, and its "2" is
   the *group* count read as a finding count. The 30 and the 115 were
   carried over from §4d, where they are the totals across **all**
   detectors — §4d measured them to show the symbol index changed
   nothing, which is true, and the attribution to `weak_test_signal`
   was added afterwards and was never checked.

   What is actually colliding is a different, larger class, and one
   Python makes endemic:

   | detector | n | why |
   |---|---|---|
   | `large_function` (Python) | 151 + 14 | one method name on many classes in a module — `sagemaker.py` has four `execute`s |
   | `commented_out_code` (non-JS) | 18 + 21 | every block in a file shared one fingerprint; `prod_settings_template.py` had 18 |
   | `sync_io_in_hotpath` (Python) | 15 + 4 | same, for the enclosing hot function |
   | `weak_test_signal` (JS) | 4 | two `it(...)` blocks in one file with the same title |

   **The fix was already in the tree.** `resolveDiscriminators`
   (`detectors/disambiguate.ts`) has implemented exactly the right
   policy since `0.18.x` — a candidate discriminator, kept only where
   the symbol repeats, with the start line as a tie-break. Nine
   detectors call it. These four did not. So the work was to supply
   each one a candidate (the class for the two Python detectors, a hash
   of the block for `commented_out_code`, the existing title for
   `weak_test_signal`) and to route it through the pass.

   **"Invalidates every pinned suppression" is wrong, and it is what
   `resolveDiscriminators` rule 1 exists to prevent.** A finding whose
   symbol is already unique in its file keeps the fingerprint it has
   always had. Measured over four repos and 7,888 findings:

   | repo | findings before → after | fingerprints retired | introduced |
   |---|---|---|---|
   | n8n `packages/cli` | 3,571 → 3,571 | 2 | 4 |
   | zulip | 3,453 → 3,453 | 10 | 39 |
   | pydantic | 487 → 487 | 4 | 8 |
   | hono | 377 → 377 | **0** | **0** |

   hono had no collisions and is byte-identical across the change. No
   finding appears or disappears anywhere; only fingerprints that were
   covering two or more findings move.

   `weak_test_signal` needed one addition to the pass:
   `keepUnambiguous`. Its discriminator has been part of every
   fingerprint it emits since `schema_version` 0.4.0, so the default
   rule would have *stripped* the title from every file holding a
   single silent test — inflicting the exact harm rule 1 exists to
   prevent, inverted.

   Recorded in `docs/json-schema.md` (no `schema_version` bump — no
   field changes shape) and as `0.22` entries on all four detectors in
   `RELEASE_NOTES`. The standing gate in `scan.test.ts` gained a Python
   half; the JS-only fixture could not have caught any of this.

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
   a concentration of its own. **Parked by the maintainer** — the score
   is no longer a length ranking, but its shape is unsettled and is the
   next release's focus. What is measured and what is merely believed
   are separated in `docs/calibration-followups.md` §
   "`agent_risk`: what we know and what we believe".

   **Picked up in `0.23.0`, four releases later. Three of this entry's
   own claims are wrong**, and the root cause was none of the three
   questions it left open.

   - **"0.3 is the band's floor" is false.** Rebuilt `ce0ccab` and
     scanned the tree it cites: the agent-signal population runs from
     **0.12**, not 0.31, and **45% of it sat at or below 0.30** on the
     day the constant was chosen. Every figure in the quoted band is a
     per-type *maximum* — the band was read off the head of each type's
     distribution.
   - **The `contract_drift` comparison is circular.** `contract_drift`
     expresses no intrinsic, so its position was `NEUTRAL_INTRINSIC`,
     not a judgement about contract drift. **28 of 70 detectors** were
     in that position, and 0.30 sits below all 29 expressed
     agent-signal bases (0.35–0.80) — silence scored as less
     agent-hostile than the most lenient deliberate judgement.
   - **"16/20" is stale**: 12/20 at `0.22.0`. And the concentration is
     mostly not the ranking's — against the population the head is
     drawn from, zulip's lift is **1.20**. zulip has a lot of blocking
     I/O in Python. Where lift is high (hono 6.00, mlflow 2.85) the
     cause is an uncalibrated intrinsic, so the question collapses into
     the one above.

   `0.23.0` fixed the inputs — `INTRINSIC_DEFAULTS`, one table with each
   value anchored to a named expressed peer, plus a source-reading gate
   so it cannot re-accumulate. The mechanism was deliberately deferred
   one release so two findings-moving changes would not land in one
   baseline.

   **`0.24.0` closed the mechanism half.** The ceiling became a scale
   (`Math.min(scored, CEILING)` → `round(scored * CEILING)`), on the
   measurement that a clamp does not rank at all: it collapsed 760 of
   zulip/zerver's 1505 findings onto exactly 0.30, and since
   `rank_score = agent_risk * (1 + recency * 0.5)` the order of that
   half fell through to **file age**. The plateau is gone across the
   corpus and length findings stop leading pydantic and drf, which the
   clamp never managed. Re-measured from the `0.23.0` baseline rather
   than reusing the numbers above — those were taken while the 28
   detectors were still suppressed. Full evidence in
   `docs/calibration-followups.md` §§ "`0.23.0` — the intrinsics were
   never calibrated" and "`0.24.0` — the ceiling becomes a scale".

   **All three of §5's open questions are now answered.** What remains
   unsettled is narrower and stated there: the *level* 0.3, the
   hand-maintained class table (`standard` still has zero members), the
   two packs disagreeing about `sync_io_in_hotpath`, and 41 intrinsics
   still living as literals in their own detectors.
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

   **Reproduced in `0.22.0`, two candidate signals tried, both
   rejected on measurement. Re-closed.** The scale is real:

   | repo | `sync_io_in_hotpath` | in a file with a `__main__` guard |
   |---|---|---|
   | airflow | 811 | **227 (28%)** |
   | mlflow | 402 | **88 (22%)** |
   | pydantic | 19 | **7 (37%)** |

   Nearly all of it sits where you would expect — `scripts/`, `dev/`,
   `devel-common/`, `release/`, `.github/` — and the charge genuinely
   does not apply there: a one-shot developer script has no worker to
   hold and no event loop to stall.

   **Candidate 1: the file has a `__main__` guard.** Wrong, and one
   file says why.
   `task-sdk/src/airflow/sdk/execution_time/task_runner.py` carries a
   guard at line 2441 of 2443 and is production code;
   `_send_error_email_notification` and `_handle_trigger_dag_run` are
   correctly reported. An entry point at the bottom of a module does
   not make the module a script.

   **Candidate 2: guard *and* nothing in the repo imports the
   module.** This is the refinement that looks like it fixes candidate
   1, and it **fails on the same file**: `task_runner.py` reports **0
   direct importers**, because airflow launches it as a subprocess
   (`python -m …`) rather than importing it. It would have been
   exempted. Separately, 364 of airflow's 811 `sync_io_in_hotpath`
   findings already sit at 0 importers, so the unimported half of the
   test is far too broad to carry the rule.

   **The signal that would work is the one this entry named**:
   reachability from the guard block — a function every one of whose
   same-file call paths starts inside `if __name__ == "__main__":`, in
   a module nothing imports, cannot run per request. The machinery
   exists (`weak_test_signal.py` already does bounded same-file call
   following). It is not built here because it would move 22–28% of a
   detector's output on a judgement that cannot be checked against
   anything but itself, and because `task_runner.py` is a case where
   two readings are both defensible — a task-runner process is
   one-shot, but a blocking email send inside it is still worth saying.
   **Deliberately left, with the counter-example named**, rather than
   shipped on a rule that its own test case defeats.
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

    **Re-measured in `0.22.0`; still not fixed, and now with the design
    written down.** `pydantic/v1/` carries **85 findings across 20
    files — 17.5% of pydantic's entire 487-finding report** (55
    `large_function`, 16 `large_file`, 9 `boolean_naming_drift`, 2
    `direct_date`, 2 `sync_io_in_hotpath`, 1 `circular_dependency`).
    It costs nothing elsewhere: airflow and mlflow have **zero**
    findings under any `*/v1/` path, so a path rule would be free — and
    a path rule is still the wrong rule, for the reason this entry
    already gives.

    **The general signal exists and it is the repo's own tooling.**
    `pydantic/v1` appears in *four* separate exclusions in pydantic's
    `pyproject.toml` — ruff `extend-exclude`, coverage `omit`, mypy
    `exclude`, codespell `skip` — and is regenerated by
    `make update-v1`. A directory a repo excludes from its own linter
    and type-checker is a directory the repo does not maintain. That is
    evidence, not a guess about the word "v1".

    **Not built, and the reason is the shape of the failure.** Reading
    lint excludes turns a config file into a silent-suppression
    mechanism, and airflow demonstrates the trap in its own
    `pyproject.toml`: line 589 is `exclude = ["*"]` under a
    `[tool.hatch.build]` table. A reader that took `exclude` from any
    table would report airflow as **completely clean**. For a tool whose
    value is being trustworthy about what it looked at, that is the
    worst available failure, and §30 is the standing example. Doing it
    properly means naming the specific tables, plus a
    `coverage.warnings[]` entry for every path skipped this way — a
    feature, not a patch, and out of scope for `0.22.0`.

    **One adjacent gap was closed**, because it needed no judgement:
    `VENDORED_RE` did not match `_vendor/`, which is the *Python*
    spelling of the convention — pip ships `pip/_vendor/`, setuptools
    `setuptools/_vendor/`, and airflow excludes its own `_vendor` glob
    from ruff. airflow: 1 finding, in
    `providers/google/.../_vendor/json_merge_patch.py`. Small, but it
    was a hole in a policy that claims to cover vendored trees.
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
18. ~~Default-view suppression is a *file* cap.~~ **Done** in `0.18.1` —
    `86d1ba3`. Nothing capped what was printed *inside* a file, so n8n's
    `instance-ai.service.ts` listed 41 numbered findings under one
    heading. Now 8, with the true tally still on the heading line and
    the remainder counted off against `--all`.
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
21. ~~`diff` human output is three integers with no locations, and runs
    two full scans.~~ **Done** in `0.18.1` — locations in `158a42f`, the
    second scan removed in `6be5681` (reuses the base scan when both
    refs resolve to the same tree; hono 12.3s → 7.0s).
22. ~~No `fingerprint` field in the JSON.~~ **Done** in `0.18.1` —
    `286c24e`. `schema_version` 0.5.0 → **0.6.0**; migration note in
    `docs/json-schema.md`. Both load-bearing properties re-checked after
    the change: byte-identical re-scans (`cmp` clean on messy-ts-app and
    hono) and fingerprint uniqueness (hono 376/376 unique).
23. ~~`lines` absent on 12–16% of findings.~~ **Mostly a wrong number.**
    `9df7628`. Measured 2.6% on airflow, not 12–16%, and most of the
    remainder is correct — an `oversized_raster` is an image,
    `high_fan_in_fan_out` and `circular_dependency` are claims about a
    file's position in a graph. One real gap inside it: the
    duplicate-block family had the range in its evidence
    (`Item.tsx:23-33`) and never set the field. 46 of 46 now do; overall
    2.6% → 2.1%. **The `symbol` half is not a defect** — the 21 types
    that never set one are file-level findings where naming one symbol
    would be arbitrary.
24. ~~`.json`/`.yaml`/`.txt`/`.rst`/`.adoc` absent from
    `DEFAULT_SOURCE_INCLUDES`.~~ **Done** in `0.18.1` — `920f222`. Two
    lists had drifted, and the symptom was a whole class of rule that
    could not fire. airflow 9,874 → 9,981 findings across .rst 54,
    .yaml 32, .json 32, .yml 21, .toml 6, .txt 1; the `docs` budget now
    reaches 28 files including `RELEASE_NOTES.rst`. Lockfiles and
    manifests excluded alongside. A test now pins the two lists in step,
    since the drift was the actual defect.
25. ~~Score derivation is mixed into `evidence`.~~ **Done** in `0.18.1`
    — `5719874`. `Finding.score_rationale` carries it; `evidence` goes
    back to being receipts a reader can check. 17 call sites across 10
    detectors, verified against the built binary (45 findings carry the
    field, zero traces left in `evidence`).

### Tooling, opened and closed after 0.18.1

26. ~~**`pnpm verify`'s lint step has not run since `6edfe2d`.**~~
    **Done** — `c277e29`. **The entry framed this as an environment
    failure; the durable half is a silent-success bug.** Biome 2.5.6
    aborts its worker pool under memory pressure, prints
    `[warn] Linter process terminated abnormally` as its *only* output —
    no diagnostics, no `Checked N files` summary — and **still exits
    0**, so `verify` reports green with lint having done nothing. That
    is why ~16 commits landed without anyone noticing: the failure is
    silent by construction.

    Measured: the abort reproduced **four times in one session** across
    `lint`, `format`, `check` and even `--version`, with `vm_stat`
    showing ~55MB of genuinely free pages — matching the last pass's
    report. It is intermittent; **100 consecutive invocations under the
    same conditions did not reproduce it**, so no `NODE_OPTIONS` or
    version-bump fix could be tested against it. No pnpm `ELIFECYCLE`
    banner accompanied the abort, which is the evidence for exit 0.

    The environmental cause is not ours and had cleared by the end of
    the session. `scripts/biome.mjs` handles the part that had not:
    biome's output is streamed unchanged, and a zero exit without a
    `Checked N files` summary becomes a hard failure. Verified three
    ways — real biome passes, a stub emitting the abnormal output
    fails, a stub exiting non-zero propagates its own code.

    With lint actually running, the ~16 commits from `6edfe2d` to
    `053cd14` carry **exactly one** warning: `useOptionalChain` in
    `packages/language-py/src/parse/calls.ts:59`. The guard then earned
    its place within the hour by catching a `noShadowRestrictedNames`
    error in new code.

27. ~~**`pnpm run build` does not reliably order `packages/cli` after
    `packages/reporter`.**~~ **NO CHANGE MADE — the entry does not
    reproduce.** Measured 8 runs: 3 from a cleared `dist` and 5
    incremental, each inserting a marker string into
    `packages/reporter/src/human/scan.ts` and grepping
    `packages/cli/dist/index.js`. **8 of 8 carried the change.**

    The declared order is correct and enforced, not incidental:
    `pnpm -r run` sorts topologically including `devDependencies`, and
    `packages/cli` declares `@crimes/core` and `@crimes/reporter` there.
    Observed order is `language-js, language-py → core → reporter →
    cli` on every run.

    One trap for whoever re-tests this: an *unused* exported constant
    is the wrong marker. esbuild tree-shakes it out of the CLI bundle,
    which looks exactly like a build-ordering failure. The first three
    runs here reported a false positive for that reason before the
    marker was moved into a string the CLI actually reaches.

    The workaround in circulation — "always
    `pnpm --filter crimes run build` afterwards" — is what you need
    after a *package-scoped* reporter build, which is the likeliest
    origin of the report. After a root `pnpm run build` it is
    unnecessary. **Left open as a possibility, not a fact**: nothing
    here proves the original observation was misattributed, only that
    the mechanism named in the entry is not the one.

28. **A ranking-quality metric.** **Done** — `d7f43f8`, and it answers
    §5's parked question 4. `structural_pass_rate` matches a detector's
    literal id in the response text, so it cannot see ranking at all.
    `pnpm run evals:ranking` scores the **scan alone** — nDCG over the
    order the scan emitted, against the scenario's expected findings as
    graded relevance labels. No agent, so no noise band: any delta is
    real, and `--cli` holds the fixture constant while swapping the
    build.

    On 0.17.1 → 0.18.1, **36 of 45 scenarios moved by up to ±0.47**
    where `structural_pass_rate` moved by noise. Splitting the 28
    deep-fixture scenarios by what they expect:

    | deep scenarios | n | mean nDCG | up | down |
    |---|---|---|---|---|
    | expect `large_function` / `large_file` | 6 | 0.459 → 0.406 | 0 | 5 |
    | expect anything else | 22 | 0.325 → 0.347 | 19 | 2 |

    That is exactly what `ce0ccab` set out to do, and it is the first
    evidence the change improved *ranking* rather than only changing
    which detector dominates. **The headline mean is +0.006** because
    it nets the two buckets against each other — the per-scenario table
    is the deliverable, not the aggregate.

    It also says something about the scenarios: the six that got worse
    are the ones whose labelled right answer is a length finding, and
    the product has now decided length findings should not lead. **Those
    labels encode the old ranking.** Re-labelling them would improve the
    metric without improving the product, so it was not done.

29. ~~**Codex scores zero while answering correctly.**~~ **Done** in
    `0.18.2` — `1faa759`. The scorer knew a finding by its slug, its
    charge, or its `crime_NNNNN` id, but not by its own evidence — so
    `CLAUDE.md`'s "evidence before judgement" was not applied to the
    measurement apparatus. Measured by replay, so the 96 responses are
    byte-identical and the whole delta is the scorer: **4 of 96 moved,
    all codex, all from a hard 0 to a full pass**; codex 0.544 → 0.589,
    claude unchanged at 0.854. Claude being flat is the evidence that
    nothing was over-credited.

    A string earns a place in the index only if it identifies **exactly
    one** detector type in that scan — the `has()` rule from `2e9b2da`
    applied to measurement. Bare line references, strings under 12
    characters, and pure prose (`arrow declaration` is a real
    `large_function` evidence line *and* a phrase an agent can write
    about unrelated code) are dropped. **The prose filter changed no
    score**, which is the point of adding it.

30. **`pnpm run evals:verify-scenarios` has been failing since
    `20e4e52`** — found while running the gate for §4d, unrelated to it.
    `review-05-permission-and-parallel` lists `parallel_destination` in
    `referenced_findings`, and 0.18.1 made that detector the first to
    ship `defaultOff: true`. It no longer fires on the fixture, so the
    scan the agent is handed does not contain it — while the scenario
    prompt still says *"There's also a parallel destination … Use
    `crimes scan --format json` to find these three IA drifts."*

    The agent is being asked to find something that is not in its
    context and scored 0 for not finding it. Codex scored **0/7** on
    this scenario in the 0.18.1 run, and it is one of the six checks
    behind that.

    **This entry was framed as an eval bug. It is a product bug**, and
    the scenario is only what surfaced it.

    `crimes scan` prints, when a gated detector sits out:

    ```
    crimes: parallel_destination did not run (off by default).
            Enable with "detectors": { "enable": ["parallel_destination"] }.
    ```

    `enable` was a pure allowlist, so **following that advice verbatim
    turned off all 68 other detectors and the entire asset pass, with
    no warning.** Measured on `05-stress-ia-drift`: 13 findings become
    **1**. The tool's own remediation advice silently gutted the scan.
    For a product whose entire value is being trustworthy about what it
    did and did not look at, that is the worst shape a defect can take.

    Fixed in `0.18.4` — naming a gated detector in `enable` is now
    **additive**; only default-on ids form the allowlist. The original
    ordering comment in `applyEnableDisable` was right about the case
    it considered (an unrelated `enable` list must not resurrect a
    gated detector, and still does not). What it did not consider was a
    list naming *nothing but* a gated detector — which is exactly what
    the hint tells users to write.

    **The semantics fix moves no finding anywhere in this repo**: no
    `crimes.config.json` under `evals/fixtures/`, `examples/`, or the
    repo root uses `enable` at all, so every existing scan is
    byte-identical across the change. Only the fixture opt-in below
    moves anything.

    With the mechanism fixed, the fixture gets a one-line
    `crimes.config.json` rather than the 69-id enumeration the old
    semantics would have demanded. That restores what the registry
    already claims fixture 05 exercises, and keeps a scenario whose
    prompt names the exact file (`src/routes/admin/billing-plans.ts`)
    and whose second judge question is specifically about this
    detector. Dropping the expectation instead would have gutted a
    purpose-built scenario to make a number go green — the thing §28
    warns against.

    Impact on the fixture is **+1 finding, `parallel_destination` 0 → 1**,
    with every other per-type count identical. It still needs its own
    baseline, because it changes what the agent is shown.

    Also found: nothing documented that any detector ships gated —
    `docs/packs.md`, `docs/configuration.md`, `docs/json-schema.md` and
    `docs/finding-types/ia.md` all described `parallel_destination` as
    though it ran. Documented in the first and last of those.

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
