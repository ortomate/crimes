# Calibration follow-ups

## 0.28 product-review decisions

The September review retains `swallowed_error` observations, including
intentional fallbacks, while weighting evidenced sensitive consequences
above generic/documented tolerance. This does not reverse prior decisions
to keep evidence visible. JS sync-I/O now requires request/render evidence;
Python also accepts an async function. Generic domain shape is insufficient.
Naming, raw-style and accessibility checks move to optional defaults.
File priority uses the strongest score plus bounded distinct-claim support,
not a count sum. See [scoring](./scoring.md), [evaluation](./evals.md), and
[release evidence](./releases/v0.28.0.md). Existing rationale is preserved
when [migrating pins](./pin-migration.md); absence does not establish a fix.


Open calibration questions, the decision taken, and the evidence behind
it. This file exists so a decision to *not* change a detector is as
recorded as a decision to change one.

Each entry states the disposition. `Decided: no change` means the
behaviour was examined and judged correct — not that it was
unexamined.

## Status at a glance

| Item | Status |
|---|---|
| [`swallowed_error` volume](#swallowed_error-volume-on-the-self-scan) | Decided — no change, handled by triage |
| [Self-scan triage policy](#self-scan-triage-policy-016x) | Applied; markdown suppressions since retired |
| [`dependency_provenance_gap` negation globs](#dependency_provenance_gap-ignores-pnpm-workspace-negation-globs) | **Fixed** in `a5ab6e5` |
| [`fingerprintFinding` collisions](#fingerprintfinding-collisions) | **Fixed** in `ee799ea` — `schema_version` 0.4.0 |
| [`exact_duplicate_block` non-determinism](#adjacent-found-while-measuring) | **Fixed** in `9ab8bdc` |
| [`unbounded_async_fanout` in the index builders](#what-is-deliberately-still-visible-and-why) | **Fixed** in `9ab8bdc` |
| [`large_file` has no `docs` shape](#self-scan-triage-policy-016x) | **Fixed** in `26c8c4b` |
| [`blast_radius` scale](#blast_radius-three-shapes-and-the-numbers-behind-each) | **Fixed** in `0ac0a5e` — log-scaled |
| [`agent_risk` shape](#agent_risk-what-we-know-and-what-we-believe) | **Inputs fixed** in `0.23.0`; the *mechanism* is still parked — see below |
| [The intrinsics were never calibrated](#0230--the-intrinsics-were-never-calibrated) | **Fixed** in `0.23.0` — 28 detectors had no judgement, only a fallback |
| [`STRUCTURAL_CEILING`'s stated band](#the-band-the-ceiling-was-fitted-to-does-not-exist) | **Refuted** in `0.23.0`; the *level* is still unvalidated |
| [Ceiling vs monotonic squash](#0240--the-ceiling-becomes-a-scale) | **Decided** in `0.24.0` — squash, on measurement |

---

## `swallowed_error` volume on the self-scan

**Status:** Decided — no detector change. Handled by triage.
**Raised:** 0.16.x cleanup, after `swallowed_error` returned 59 findings
on a self-scan of 406.

### What the numbers actually are

The initial read was "58 hits, mostly the `safelyBuildX` helpers in
`packages/core/src/indexes.ts`". Measured, it is more diffuse and more
interesting:

| | count |
|---|---|
| total | 59 |
| `severity: low` | 54 |
| `severity: medium` | 5 |
| in `indexes.ts` | 8 |
| distinct files | 32 |

Of the 5 `medium`, **4 are in `examples/risky-service/`** — the fixture
built to trigger this detector. Those firing at `medium` is the
detector working. Exactly one non-fixture `medium` exists:
`probeShallow` in `packages/core/src/git/churn.ts`.

Grouped by enclosing function, the 54 `low` findings are five families:

- `safelyBuild*` (8) — `indexes.ts`
- `read*` (~14) — `readManifest`, `readLockfile`, `readCreatedAt`, …
- `parse*` (~10) — `parse`, `parseFile`, `parsePyFile`, `parseTriage`
- probe predicates (~7) — `exists`, `isFile`, `isGitRepo`, `refExists`
- `load*` (~6) — `loadConfig`, `loadScenarios`, `loadBinSurface`

### Why the `safelyBuild*` family is already handled

`BEST_EFFORT_FUNCTION_RE` matches `^safely[A-Z]`, so `looksDeliberate`
already returns true for all 8 and the confidence ladder applies its
`-0.2` "suppression appears deliberate" delta. That is *why* they are
`low` rather than `medium`. The mechanism the follow-up proposed
widening is already doing its job.

### The three options, and why the first two are wrong

**Widen `BEST_EFFORT_FUNCTION_RE` — rejected.** To silence the
remaining families the regex would have to absorb `read*`, `parse*`,
`load*`, `exists*`. Those prefixes do not announce failure tolerance.
`readUser()` that swallows its error is a genuine bug in most
codebases, and this regex ships to every user of the tool. Trading
product-wide precision to quiet one repo's self-scan is the exact move
the "never weaken a check" rule exists to stop.

**`allowedFunctions` — rejected.** Repo-local, so it does not damage
other users, which makes it strictly better than the regex. But it
would need roughly 30 entries, and the names it would have to carry
(`readFile`, `parse`, `loadConfig`) are generic enough that adding them
would also blind this repo to *future* real swallows in functions that
happen to share a name. It hides findings rather than dispositioning
them.

**Triage — taken.** Because the detector is not wrong. A reader cannot
tell from the name `readManifest` that a failure is tolerated and
returns `undefined`; the finding is a fair observation that the
tolerance is undocumented. The problem is volume, not correctness, and
volume is what `.crimes/triage.json` is for. Triage keeps each finding
visible, attributed, and re-surfaceable rather than deleted.

The one non-fixture `medium` — `probeShallow` returning `false` when
`git rev-parse --is-shallow-repository` fails, so a failed probe is
indistinguishable from "history is complete" and `historyLimited` is
never set — was triaged separately and then dispositioned `wont-fix` on
its own merits, not folded into the bulk decision above.

The reason is in the triage entry and worth repeating here, because the
first read of this finding was that it was real: `probeShallow` runs
inside the same `Promise.all` as `git log`, so if git were missing or
the repo unreadable the log call throws first and the enclosing catch
already returns `gitAvailable: false`. The only way that handler runs is
git older than 2.15, which predates
`rev-parse --is-shallow-repository` — and those versions cannot produce
a shallow clone this code would need to warn about. Returning `false` is
correct; returning "unknown" would emit a false `historyLimited` warning
on every scan with old git.

---

## Self-scan triage policy (0.16.x)

**Status:** Applied. `.crimes/suppressions.json` and `.crimes/triage.json`
are committed and meant to be argued with.

The self-scan went 410 findings / 30 high to **250 / 0 high** in the
default view. Nothing was deleted — with `--show-triaged
--show-suppressed` the scan still reports 388 / 26 high. The reduction
is four levers, in descending order of how much they should be trusted:

**1. Config excludes (410 → 388).** Two of these are plain bugs rather
than judgement calls:

- `examples/risky-service/**` was never added to `crimes.config.json`
  when the fixture landed in 0.16.0, even though `examples/messy-ts-app/**`
  has always been there. Its 9 findings are the crimes the fixture was
  *built* to contain. Scanning your own fixture and reporting its
  deliberate crimes as your own is a measurement error.
- `docs/superpowers/**` — archived plan and spec documents from a
  one-time workflow, never edited after their milestone. Same class as
  `.planning/`.

**2. `scopeTiers.nonDomain` (partition, not removal).** Adds `docs/**`,
root `*.md`, and `.planning/**` to the non-domain tier, which moves 36
findings out of the primary walk without hiding them. Note this key
*replaces* `DEFAULT_NON_DOMAIN_PATTERNS` rather than extending it, so
the defaults are re-listed in the config.

**3. Suppressions (21, now 2).** Only categorical false positives, each
with a mechanism a reviewer can check:

- `hardcoded_local_path` on `docs/**` (2) — the docs that *document*
  the detector contain example bad paths to show the reader what it
  catches. Self-referential. **Still in force.**
- `large_file` on `**/*.md` (19) — `large_file` had two policy shapes,
  `domain` and `test_file`, so prose was scored against the domain-code
  line budget. Reference documentation is supposed to be long. The real
  fix is a `docs` shape in the detector; until then this is a
  suppression, not an acceptance.
  **Retired in `26c8c4b`** — the `docs` shape shipped, so all 19 entries
  were dropped. See [the `docs` shape](#large_file-had-no-shape-for-prose)
  below for what happened when they came off.

**4. Triage (117).** Recorded decisions on findings that are *correct*:

| disposition | n | what it covers |
|---|---|---|
| `wont-fix` | 98 | 55 `swallowed_error` (see above), 43 `high_fan_in_fan_out` |
| `needs-design` | 19 | every remaining `high` |

`high_fan_in_fan_out` is `wont-fix` because `packages/core` is a hub by
design — the finding schema and scoring are meant to be depended on
widely. `layer_violation` is the detector that would catch a genuinely
wrong edge, and it reports nothing.

The 19 `needs-design` highs are real size debt: detector `run` bodies
and parser surfaces that grew with the 0.16.0 slate. They are not
fixed here because splitting a detector changes its output, which needs
its own change and an eval re-run rather than a drive-by extraction
during a tooling pass.

### What is deliberately still visible, and why

250 findings remain untriaged and unsuppressed. They are **accepted as
backlog, not dismissed** — every type below was looked at and given a
decision. What they deliberately did *not* get is a per-finding triage
entry, because an entry that says nothing more than "acknowledged"
converts a visible number into a silent one while claiming credit for
having dealt with it.

No `high` remains in this set; the split is 165 `medium` / 85 `low`.

> **Counts below are the 0.16.x snapshot and are deliberately not
> restated.** After the fixes recorded further down, the same view reads
> **254 / 0 high** (164 `medium`, 90 `low`): `unbounded_async_fanout`
> and `dependency_provenance_gap` are gone, and five prose `large_file`
> findings moved out of a suppression and into this set. The per-row
> decisions are what this table is for, and those still hold — rewriting
> the numbers on every fix would turn a record of what was decided into
> a dashboard that has to be maintained.

| type | n | decision |
|---|---|---|
| `large_function` | 101 | Accept. Real size debt, same class as the 19 triaged highs. Detector `run` bodies dominate. Splitting one changes its output, so it belongs in a scoped change with an eval re-run. |
| `large_file` | 33 | Accept, as above. What remains is code — the prose cases moved from a suppression to the `docs` shape in `26c8c4b`, which leaves five of them visible at `low`. |
| `boolean_naming_drift` | 30 | Accept. 29 of 30 are `low`. Renaming a boolean is cheap individually and churns broadly; worth a dedicated sweep, not a drive-by. |
| `sync_io_in_hotpath` | 25 | Accept. All `low`. Concentrated in CLI startup and config loading, which run once per process — "hotpath" overstates it for a short-lived CLI. |
| `exact_duplicate_block` | 15 | Accept. The determinism caveat this row carried is **resolved** in `9ab8bdc` — its evidence strings are now reproducible and safe to act on. |
| `todo_density` | 9 | Accept. TODOs that are tracked prose, mostly in non-domain tier. |
| `direct_date` | 6 | Accept. `clock.ts` exists and domain code uses it; these are the eval runner and renderers stamping display timestamps, where a clock seam adds no testability. |
| `weak_test_signal` | 6 | Accept. All in the non-domain tier. |
| `magic_domain_literal_scatter` | 5 | Accept. Formatting-sensitive by construction and already `low`/`medium`. The fingerprint collision this type suffered is fixed separately in `ee799ea`. |
| `contract_drift` | 4 | Accept — **representational, not real**. Each pairs a TS interface with its Zod schema *in the same file* with 100% field overlap; the "disagreements" are `(typeof X)[number]` vs `enum` and `SuppressionEntry[]` vs `array[]`, i.e. the detector cannot see that a Zod enum and a TS union denote the same set. Already down-ranked by a −0.12 same-file delta. |
| `option_bag_junk_drawer` | 3 | Accept. Detector option bags are genuinely heterogeneous by design. |
| `near_duplicate_block` | 3 | Accept. Same determinism caveat as `exact_duplicate_block`, and resolved by the same change. |
| `unbounded_async_fanout` | 2 | **Fixed in `9ab8bdc`.** `buildFunctionHashIndex` and `buildJsxShapeIndex` both `Promise.all`-ed a `readFile` per candidate file with no bound — on a large enough repo that opens every source file at once and fails with `EMFILE`. Both now read through a shared `mapWithConcurrency` pool. Self-scan 2 → 0. |
| `name_behavior_mismatch` | 2 | Accept. `parseFile` and `readStdinIfAvailable` do exactly what they say; the detector reads caching/IO as an unadvertised side effect. |
| `logic_in_comments` | 2 | Accept. Non-domain tier. |
| `duplicated_role_status_plan_check` | 1 | Accept — **self-referential**. It fires on `duplicated-role-status-plan-check.ts`, because the detector's own source contains the literal `"admin"` three times as its detection patterns. Same shape as the suppressed `hardcoded_local_path` docs cases. |
| `dependency_provenance_gap` | 1 | **Fixed in `a5ab6e5`** — see below. Reports nothing now; its triage entry was retired in `26c8c4b` as dead. |
| `commented_out_code` | 1 | Accept. |
| `singular_plural_type_mismatch` | 1 | Accept. |

---

## `dependency_provenance_gap` ignores pnpm workspace negation globs

**Status:** **Fixed** in `a5ab6e5`, before 0.16.0 shipped.

First, the good half: this detector **independently found a real
CI-breaking bug in this repo**, and described it exactly right —

```
2 declared dependenc(ies) with no lockfile entry:
  `anything-goes`@* — declared in examples/risky-service/package.json:17
  `legacy-utils`@git+https://... — declared in examples/risky-service/package.json:16
the manifest and the lock disagree, so `install --frozen-lockfile` in CI
will resolve differently from a local install
```

That is precisely why `pnpm install --frozen-lockfile` was failing on
`main` after 0.16.0 (fixed in `ef7c3ab`).

The bug is that it **still reports it after the fix.** The repair was to
exclude the fixture from the workspace:

```yaml
packages:
  - "examples/*"
  - "!examples/risky-service"
```

`parseWorkspaceGlobs` in `manifest/build.ts` is a line-based reader that
collects every `- "glob"` entry verbatim and has no concept of a leading
`!`. So the negation is read as an ordinary glob, `examples/*` still
matches, and the fixture is counted as one of the "10 workspace
manifests compared" — when pnpm itself no longer installs it.

Net effect: the detector reports a manifest/lockfile disagreement for a
package the package manager deliberately excludes, on any repo that uses
pnpm's negation syntax.

### What shipped

`parseWorkspaceGlobs` now partitions the globs, and a directory is a
member when an include matches and no exclude does. A file containing
only exclusions declares no workspace. Both pnpm's `packages:` and
npm/yarn's `workspaces` support negation, so both get the same
treatment. Two regression tests, one per direction: the negated package
is ignored, and a sibling under the same include glob that the negation
does not cover still reports its missing dependency.

No version bump was needed. The policy in `CLAUDE.md` bumps on changes
that move the eval baseline; this one provably did not — no fixture uses
negation syntax, and `evals:replay` re-scored all 96 pinned results with
96 identical, 0 changed.

Self-scan `dependency_provenance_gap` went 1 → 0. The triage entry that
had covered the remaining finding was retired in `26c8c4b` as dead: it
pinned "unpinned specifiers" on the root manifest, and those specifiers
belonged to `examples/risky-service` — the package the negation fix
removed from the workspace in the first place.

---

## `fingerprintFinding` collisions

**Status:** **Fixed** in `ee799ea`, as `schema_version` 0.4.0. The
original decision — defer to a minor that bumps `schema_version` — is
kept below verbatim, because what shipped is that recommendation and the
reasoning is what makes the shape of the fix legible.
**Raised:** documented in `fingerprint.ts` as a known limitation,
pre-dating 0.16.0.

### It is not one detector

The follow-up named `magic_domain_literal_scatter`. Measured against a
self-scan, the collision is a property of `fingerprintFinding` itself
and hits every detector that emits more than one file-level finding
without a `symbol`:

```
x2  magic_domain_literal_scatter :: detectors/unbounded-async-fanout.ts
      "subprocess" appears in 5 production files
      "property"   appears in 4 production files
x2  exact_duplicate_block :: cli/src/commands/feedback.test.ts
x3  exact_duplicate_block :: cli/src/commands/audit-suppressions.test.ts

3 colliding fingerprints covering 7 findings, of 402 distinct.
```

`exact_duplicate_block` collides worse than the detector that was
reported. A fix that gives only `magic_domain_literal_scatter` a
disambiguator would repair one case of three.

### Why this matters more than "diff shows them as one"

The documented consequence is that `crimes diff` conflates them. The
sharper one is suppression targeting: `crimes ignore <fingerprint>` on
the `"property"` finding **also silently suppresses `"subprocess"`**,
because they are the same fingerprint. A user suppressing one thing
gets a second thing suppressed without being told. That is a safety
property, not a cosmetic one.

### Decision at the time

Do not patch it in a cleanup pass, for three reasons.

1. **The obvious fix abuses a field.** Setting `symbol` to the literal
   value would work mechanically, but `fingerprint.ts` documents
   `symbol` as naming *a specific declaration*. A string literal is not
   a declaration. That silently changes what the field means for every
   consumer reading it.
2. **A per-detector fix is the wrong shape.** The bug is in the
   fingerprint function's inputs, so it wants one general answer — an
   explicit optional `discriminator` on `Finding` that a detector
   populates when `(type, file, symbol)` is not unique, folded into the
   fingerprint when present. Each colliding detector already has a
   natural value: the literal for scatter, the body hash for the
   duplicate-block family (already in its evidence string).
3. **The cost should be paid once.** Any change to fingerprint
   composition invalidates `.crimes/baseline.json` and
   `.crimes/suppressions.json` in the wild — pinned entries stop
   matching, old findings read as "fixed", new ones as "new". The repo
   already has a designed channel for this (suppressions resurface on a
   minor for re-confirmation, per `docs/feedback.md`), so the right
   moment is a minor that is already bumping `schema_version` and
   migrating those files, not a standalone break.

**Recommendation:** add `discriminator?: string` to `Finding` and
include it in `fingerprintFinding` in the next `schema_version` bump.
Populate it in `magic_domain_literal_scatter` (the literal) and the
duplicate-block detectors (the hash) in the same change, and note the
baseline/suppression migration in the release notes.

### What shipped

Exactly that. `schema_version` went 0.3.0 → 0.4.0; `Finding` gained an
optional `discriminator`; `fingerprintFinding` appends `::<value>` when
one is present and emits the unchanged three-part string when it is not,
so no other detector's fingerprints moved. The three colliding detectors
populate it from the thing that makes their findings different — the
literal for scatter, the 12-character body hash for the duplicate-block
pair, which is the same string already printed in their evidence, so a
fingerprint and the finding it names can be matched up by eye.

The rule a detector has to follow is documented on the field: the value
must be stable across scans of the same code. A counter or a per-scan
index would satisfy the type and break every pinned baseline entry the
moment an unrelated finding appeared.

Self-scan collisions: **3 → 0**, over 254 findings.

**Migration.** Pinned `baseline.json` / `suppressions.json` entries for
those three types stop matching — the old fingerprint reads as fixed,
the new one as new. That churn is the repair rather than a cost of it:
re-recording an entry is what makes a suppression mean the one finding
its author actually looked at, which is precisely what a colliding
fingerprint took away. Loaders accept the whole `0.1.0`–`0.4.0` window,
so an un-migrated file still reads; it just matches fewer findings for
three types. This repo's own `.crimes/` files pinned none of the three,
so nothing here needed rewriting.

### Adjacent, found while measuring

`exact_duplicate_block` is **not deterministic** across runs on an
unchanged tree. Three consecutive scans of the same commit produced
identical finding *identity* and severity counts, but 3 findings
differed in content — the same anchor file reported
`hash 3dbfcb76d2cc… across 6 file(s)` on one run and
`hash 3d33dfe315b3… across 9 file(s)` on another. A function belonging
to more than one duplicate group appears to pick its group by map
iteration order.

Identity is stable, so baselines and `diff` are not affected, but the
evidence string a user reads is not reproducible.

**Status:** **Fixed** in `9ab8bdc`, together with the fan-out bound
above — they turned out to be the same bug wearing two hats.

The guess was right. `buildFunctionHashIndex` inserted into its maps
from *inside* the `Promise.all` callbacks, so map insertion order
tracked which `readFile` resolved first, and a function in more than one
duplicate group picked its group by that order. Each file's hits are now
collected and inserted afterwards in sorted file order, and both
duplicate detectors sort the hash keys before iterating so their output
does not depend on index internals either. Five consecutive runs over a
tree with deliberately overlapping groups now produce byte-identical
evidence, and there is a regression test that says so.

This did change findings, so it took the version bump and the eval
re-run the original note called for.

---

## `large_file` had no shape for prose

**Status:** **Fixed** in `26c8c4b`. Raised as a placeholder inside the
0.16.x triage pass rather than as an entry of its own.

The 19 `**/*.md` suppressions recorded above were explicitly *not* an
acceptance — the note said the real fix was a `docs` shape in the
detector. This is that shape.

`docs` covers the extensions whose whole purpose is prose (`.md`,
`.mdx`, `.markdown`, `.rst`, `.adoc`, `.asciidoc`, `.txt`) with a
1000-line budget and severity capped at `low` / `medium`, the same
posture `test_file` already had. 1000 is the point where one document
stops being something a reader or an agent holds at once and wants to
become a directory of pages — which is the split the detector asks for.
Configurable as `thresholds.largeFile.docs`.

Two boundaries worth stating, because both were judgement calls:

- **Data formats are not docs.** `.json`, `.yaml`, `.csv` stay on the
  domain budget. A 3000-line config file is a finding worth having, and
  extending "it isn't code" to cover it would have been the same
  precision trade the `swallowed_error` section rejects.
- **`agent_risk` sits above `test_file`, below `domain`.** An oversized
  document is a real context cost — an agent told to follow it has to
  load the whole thing to find the paragraph that applies — so it does
  not get the test-file discount.

### What happened when the suppressions came off

All 19 were dropped. **Fourteen had already stopped matching anything**;
they were carrying the appearance of a decision over files that no
longer fired. The remaining five surface as `low` findings:

| file | lines |
|---|---|
| `docs/json-schema.md` | 1929 |
| `PRD.md` | 1516 |
| `docs/roadmap.md` | 1515 |
| `README.md` | 1503 |
| `docs/agent-usage.md` | 1164 |

They are left visible on purpose. Replacing a blanket suppression with a
policy is supposed to leave some findings standing — if the new shape
silenced everything the old suppression silenced, it would be the
suppression with extra steps. These five are ones a reader can now
agree or disagree with, which the suppression never allowed.

Self-scan default view: 254 findings, 0 `high` — five of them these
prose entries, which were previously hidden.


---

## `blast_radius`: three shapes, and the numbers behind each

**Disposition: fixed in `0ac0a5e` (0.18.1).** Recorded here because two
shapes were tried and discarded in one session, and the discarded ones
are the argument for the third.

Measured on hono, whole repo, `--all`, 376 findings:

| shape | distinct values | modal value | share at 1.0 |
|---|---|---|---|
| linear `min(t/50, 1)` | 22 | `0` = 54% | 8.5% |
| quartile rank | 4 | `0.25` = 53% | 31.6% |
| log `log1p(t)/log1p(2000)` | **40** | `0` = 54% | **0.0%** |

The linear score saturated (47% of zulip findings at exactly 1.0 was the
original complaint). Quartile ranking was the standing recommendation
and removed the top-end pinning, but cost resolution — 22 distinct
values down to 4 — and could not separate a tied block bigger than a
quartile, so hono's 54%-at-0 simply became 53%-at-0.25. It also gave up
cross-repo comparability.

Log scaling bounds the top by construction, keeps every distinct closure
a distinct score, and restores comparability via a fixed reference.

The 54% modal value at `0` survives all three shapes and **should**:
54% of hono's finding-bearing files have no importers. That is a fact
about hono, not a scoring artefact, and quartile ranking only relabelled
it.

Direct fan-in was planned as a strict tiebreaker on the closure. It ships
as a bounded 15% contributor instead, because a strict tiebreak is
invisible at the two decimals `scores` are reported to — at a closure of
197 the gap to 198 is 0.0006, so hono's plateau would have kept reading
the same value six times.

---

## `agent_risk`: what we know and what we believe

**Disposition: still parked, but no longer blocked.** The 0.18.1 change
(`ce0ccab`) removed a defect; it did not settle what this score should
be, and the difference matters. What has changed since this was written
is that the blocking question — whether the evals can see a ranking
change at all — is answered, and `ce0ccab` is measured to have improved
ranking rather than merely believed to have. See
"Question 4 is answered" below.

**That is a reason to start measuring, not a licence to retune.** The
class table, the 0.3 ceiling and every per-detector intrinsic are
exactly as unvalidated as before.

### What we know — measured, reproducible

- **It was a length ranking.** Top 20 by rank before the change: 15 of
  20 on `ebg` and 18 of 20 on zulip were `large_function` /
  `large_file`. On zulip — a repo that is **71% Python** — the top 20
  contained **zero Python findings**.
- **Two mechanisms caused it**, not one. Length detectors fire on almost
  every large file *and* scale their own intrinsic with line count, so
  they won on volume and on score simultaneously. Separately, the
  fallback intrinsic for the ~18 detectors that express none of their
  own was derived from severity, which re-coupled the two axes
  `CLAUDE.md` and PRD §10 both say must stay separate.
- **Decoupling worked, on both languages.** After `ce0ccab`:
  zulip/zerver structural 18→0 of the top 20 and Python 0→20 of 20;
  hono structural 14→0, distinct detector types in the top 20 8→10, with
  `boolean_naming_drift`, `option_bag_junk_drawer`,
  `name_behavior_mismatch` and `hardcoded_localhost` at the top.
- **The ceiling had to be measured.** At 0.4 — the first value tried —
  212 zulip findings pinned to the cap and `large_file` still outranked
  `contract_drift`, because 0.4 sits *inside* the agent-signal band
  (0.31–0.53). 0.3 is that band's floor.
- **One monoculture replaced another.** zulip's top 20 is now 16 of 20
  `sync_io_in_hotpath`.

### What we believe — not yet established

- **That the class table is the right abstraction.** Sorting types into
  `structural` / `agent_signal` / `standard` is a hand-maintained
  judgement about ~60 detectors. It is legible and it works, but nothing
  validates it beyond the author's reading of each charge. A detector
  added without a class silently lands in `standard`.
- **That a hard ceiling is the right mechanism.** It is blunt: every
  structural finding above the cap collapses to exactly 0.3, which is
  the same plateau problem `blast_radius` was just fixed for. A
  monotonic squash would preserve order within the class.
- **That the `sync_io_in_hotpath` concentration is acceptable.** It is
  at least a differentiated detector firing on a repo that genuinely has
  a lot of blocking I/O in Python, rather than a length proxy. But 16 of
  20 is not obviously better than 18 of 20; it may just be a more
  interesting monoculture. We do not know whether the fix improved
  *ranking* or only improved *which detector dominates*.
- **That per-detector intrinsics are calibrated against each other.**
  They were each chosen locally, by whoever wrote the detector. Nothing
  has ever compared `sync_io_in_hotpath`'s 0.5–0.7 band against
  `contract_drift`'s. The band structure the ceiling was fitted to is
  therefore itself unvalidated.
- **That the evals can see any of this.** `agent_risk` drives rank
  order, and the eval fixtures are small and mostly-clean, so a ranking
  change may not move the aggregate at all. Confirming this change
  helped an agent probably needs a scenario built for it.

### What the 0.18.1 eval run added

Nothing, and that is itself the finding. `structural_pass_rate` moved
+3pp for claude and −2pp for codex, both inside the noise band, on a
release that rebuilt the ranking twice over.

The metric matches detector **ids** in response text, so it cannot see a
ranking change at all — an agent that quotes the right id still quotes
it whether that finding ranked 1st or 30th. The belief listed above
("that the evals can even see a ranking change") is now measured rather
than assumed: **they cannot.**

That moves question 4 below from nice-to-have to blocking. There is
currently no way to tell whether the `agent_risk` change improved
ranking, and no amount of re-running the existing suite will produce
one.

### Question 4 is answered — `ce0ccab` did improve ranking

`pnpm run evals:ranking` (`d7f43f8`) measures the **scan alone**: nDCG
over the order the scan emitted, against each scenario's expected
findings as graded relevance labels. No agent is invoked, so there is
no noise band — any delta is real — and `--cli` scans this tree's
fixtures with another build's binary, holding the fixture constant so
the delta belongs to the scanner. Fixtures and scenarios are
byte-identical between the 0.17.1 and 0.18.1 commits, so nothing else
could have moved.

**36 of 45 scenarios moved, by up to ±0.47**, on the change where
`structural_pass_rate` moved by noise. Splitting the 28 deep-fixture
scenarios (fixtures 01/02/03/04, 42–99 findings; shallow ones cannot
demonstrate a ranking change and are excluded):

| deep scenarios | n | mean nDCG 0.17.1 → 0.18.1 | up | down |
|---|---|---|---|---|
| expect `large_function` / `large_file` | 6 | 0.459 → 0.406 (**−0.053**) | 0 | 5 |
| expect anything else | 22 | 0.325 → 0.347 (**+0.022**) | 19 | 2 |

Both "down" rows in the second bucket moved −0.004 and −0.003 — flat.

So this moves from *believed* to *measured*: **`ce0ccab` demoted length
findings and promoted differentiated ones, in the ranking and not only
in which detector dominates.** The belief listed above — "that the
evals can see any of this" — was true of `structural_pass_rate` and is
now false of the suite as a whole.

Three things this does **not** settle, and none of them should be read
past:

- **The headline aggregate is +0.006.** It nets the two buckets
  against each other. Anyone quoting one number from this instrument is
  quoting the wrong thing; the per-scenario table is the result.
- **It says nothing about the ceiling or the intrinsics.** It compares
  two orderings. Questions 1–3 below are still open and still need
  their own measurements — what it provides is an instrument to
  measure them *with*.
- **Six scenario labels now encode the old ranking.** The six that got
  worse are the ones whose labelled right answer is a length finding,
  and the product has deliberately decided length findings should not
  lead. Re-labelling them would raise the metric without improving the
  product, so it has not been done — but nobody should read those six
  rows as a regression without first saying which of the two they think
  is wrong.

### What the next release needs to answer

1. Is a hard ceiling right, or should the structural class be squashed
   monotonically so it keeps internal order?
2. Are per-detector intrinsics calibrated against each other, and what
   would calibrating them look like?
3. Is one detector at 16 of 20 a problem in itself — should the ranking
   diversify across detector types deliberately, the way the default
   view already diversifies across files?
4. ~~Can any of this be measured other than by reading top-20 lists? A
   ranking-quality metric would turn all of the above from taste into
   evidence.~~ **Answered** — `pnpm run evals:ranking`, see above. It
   is the instrument questions 1–3 were waiting on.

Questions 1–3 remain open, and the instrument now exists to settle them
rather than argue them. Concretely, each is a measurable experiment:

1. **Ceiling vs monotonic squash.** Implement the squash, run
   `evals:ranking --compare` against the current build. A squash that
   preserves order within the structural class should not move the
   differentiated bucket and should move the six length-labelled
   scenarios — if it moves neither, the ceiling was not the binding
   constraint and the plateau is not costing anything.
2. **Are the intrinsics calibrated against each other?** The metric
   cannot answer this on its own: the fixtures label detector *types*,
   not relative importance between two correct findings. This one still
   needs a scenario built for it — two findings of different types on
   the same file, with a defensible answer about which should lead.
3. **Is 16-of-20 a problem in itself?** `top20_dominant_share`,
   `top20_dominant_type` and `top20_distinct_types` ship on every row
   of `ranking.json` and are unlabelled, so they work on zulip and hono
   as well as on the fixtures. That measures the concentration; it does
   not decide whether concentration is wrong, and a repo can
   legitimately have one dominant problem.

`ce0ccab` now stands as more than a defect fix — the ranking
improvement is measured, not assumed. **The shape of the score is still
unsettled**, and the specific constants are still fitted to an
unvalidated band: nothing here validates the class table, the 0.3
ceiling, or any per-detector intrinsic. Do not retune constants on the
strength of question 4 being answered.

---

## `0.23.0` — the intrinsics were never calibrated

**Status: fixed.** All three questions above were run. Question 2 turned
out to be the root cause of the other two, so it is the only one this
release changed.

### The defect: 28 detectors had no judgement, only a fallback

`agent_risk = 0.40*intrinsic + 0.20*churn + 0.20*test_gap +
0.20*blast_radius`, and the intrinsic is the only genuinely
agent-specific term in it. **28 of 70 registered detectors set no
`scores.agent_risk`** and fell through to `NEUTRAL_INTRINSIC` (0.30),
described in the source as saying "what is actually known: nothing".

Measured across the corpus, that is not what it said. The 29 *expressed*
agent-signal bases run **0.35 to 0.80**, so 0.30 sat **below every one
of them**. A detector that declined to score itself was ranked beneath
the most lenient deliberate judgement anyone had made — and the group
that declined includes `contract_drift`, `swallowed_error`,
`duplicated_policy`, `permission_ia_drift`, `unsafe_retry` and
`mock_saturation`.

The list was not curated. It is every detector whose source never
assigns the field, which is why it accumulated silently: nothing
enforced it, and `standard` — the class such a detector lands in — has
**zero members across all 70 detectors**, so the fallback path was
invisible in the class table too.

### The band the ceiling was fitted to does not exist

`STRUCTURAL_CEILING`'s comment justified 0.3 like this:

> the agent-signal band runs 0.31–0.53 (`sync_io_in_hotpath` 0.43–0.53,
> `direct_date` 0.51, `commented_out_code` 0.41, `contract_drift`
> ~0.36) … 0.3 puts the whole structural class at or below the bottom
> of the agent-signal band.

Checked by building `ce0ccab` itself — the commit that chose the
constant — and scanning the exact tree the comment cites:

| type | claimed | measured at `ce0ccab` |
|---|---|---|
| `sync_io_in_hotpath` | 0.43–0.53 | **0.20**–0.53 |
| `direct_date` | 0.51 | **0.18**–0.51 |
| `commented_out_code` | 0.41 | **0.14**–0.41 |
| `contract_drift` | ~0.36 | **0 findings — does not fire on that tree** |
| the band itself | "0.31–0.53" | min **0.12**, p50 0.35, max 0.53 |

Every quoted figure is that type's **maximum**. The band was read off
the head of each type's distribution rather than off the distribution,
and **45% of the agent-signal population sat at or below 0.30** on the
day the constant was chosen. It is 47–75% across the corpus today. The
ceiling never put structural "below the band"; it put it level with the
band's median.

The anchor was also circular: `contract_drift` expresses no intrinsic,
so its position in "a `large_file` still outranked a genuine contract
drift" was the fallback, not a judgement about contract drift.

**This is a documentation correction, not a licence to move the
constant.** 0.3 is unchanged and still unvalidated.

### What shipped

`INTRINSIC_DEFAULTS` in `detector-defaults.ts` — one table, every value
anchored to a *named expressed peer*, with the anchor written next to
it. A single table is the point: intrinsics can only be calibrated
against each other where they can be seen next to each other.

A gate in `detector-defaults.test.ts` reads the detector sources and
fails when a registered detector expresses neither its own intrinsic nor
a declared one. It reads source rather than carrying a hand-written list
because a list cannot see a detector added tomorrow — which is the hole
that let 28 accumulate.

`NEUTRAL_INTRINSIC` is deliberately **left at 0.30** rather than raised
to the expressed median. Built-ins can no longer reach it, so reaching
it now means a detector is missing from the table. Raising it would make
that omission harder to notice.

### Measured effect — a product delta

Deterministic (`evals:ranking`), split by whether a scenario's labelled
answer is one of the previously-suppressed types:

| bucket | n | mean nDCG | up | down |
|---|---|---|---|---|
| labels a previously-suppressed type | 12 | 0.5441 → **0.6213** (+0.0772) | 7 | 1 |
| labels only always-expressed types | 33 | 0.4510 → 0.4458 (−0.0053) | **0** | 22 |

Read the second row carefully. Nothing went *up* and the drops are
uniform and tiny — this is displacement, not regression: 28 detectors
that could not previously surface now do, and everything else shifts
down a rank. **Those labels were chosen while those 28 were
suppressed**, which is the same caveat §28 records about the six
length-labelled scenarios, arriving from a different direction.

The headline aggregate moves +0.0167 (all) and −0.0044 (deep). Only
three deep-fixture scenarios label any of the 28 at all — itself
evidence that the deep fixtures were labelled against a ranking these
detectors could not reach.

On the corpus, no finding was added or removed anywhere, and the change
is conservative: it moves a head only where the suppressed detectors
actually fire.

| repo | top-20 dominant, before → after | concentration lift |
|---|---|---|
| hono | `option_bag_junk_drawer` 5/20 → `swallowed_error` 6/20 | **6.00 → 2.80** |
| mlflow | `sync_io_in_hotpath` 11/20 → 10/20 | 2.85 → 2.59 |
| pydantic, drf, zulip/zerver | unchanged | unchanged |

### Question 1 — ceiling vs monotonic squash: measured, not taken

A monotonic squash (`min(scored, 0.3)` → `scored * 0.3`) was
implemented and measured before being reverted.

| deep bucket | n | mean nDCG | up | down |
|---|---|---|---|---|
| no structural expectation | 19 | 0.3700 → 0.3799 (+0.0098) | **13** | **0** |
| priority IS structural | 7 | 0.3658 → 0.3399 (−0.0259) | 0 | 7 |

Both columns are unanimous. It also took structural findings out of the
top 20 entirely on four of five corpus repos — including pydantic, whose
top 20 still led with `large_function` 5/20 under the ceiling, and drf's
15/20. **So the ceiling was not doing the job its comment claims.**

The prediction recorded above was that a squash "should not move the
differentiated bucket". It moved both, because at 2-decimal rounding a
monotonic map cannot re-spread the clamped tail without also lowering
the whole class — the two effects are not separable at the current
precision. That is a fact about the mechanism worth keeping.

**Not taken**, on grounds of attribution rather than merit: stacking a
second compensation on top of the missing intrinsics would put two
findings-moving changes in one baseline and make neither attributable.
The evidence stands for whoever picks the mechanism up.

### Question 3 — concentration is mostly the repo, not the ranking

The "16 of 20 `sync_io_in_hotpath`" figure is **stale**: measured at
`0.22.0` it is 12 of 20.

More usefully, comparing the dominant type's share of the top 20 against
its share of the population the head is drawn from (the agent-signal
class — structural is capped out of the head by design):

| repo | dominant | head share | population share | lift |
|---|---|---|---|---|
| zulip/zerver | `sync_io_in_hotpath` | 0.60 | 0.50 | **1.20** |
| mlflow | `sync_io_in_hotpath` | 0.55 | 0.19 | 2.85 |
| hono | `option_bag_junk_drawer` | 0.25 | 0.04 | 6.00 |

**zulip's monoculture is zulip's, not the ranking's.** At lift 1.20 the
head is very nearly a faithful sample of a repo that genuinely has a lot
of blocking I/O in Python — which is what the original entry suspected
but could not show. Where the lift *is* high (hono, mlflow), the cause
is a per-detector intrinsic sitting high relative to its peers, so
question 3 reduces to question 2 rather than standing beside it.

### What is still open

- ~~**The mechanism.** Ceiling vs squash, with the evidence above.~~
  **Decided in `0.24.0`** — see the next section.
- **The class table.** Still hand-maintained, and `standard` still has
  zero members — it is an unlabelled-default bucket, not a considered
  third category, and its behaviour (no adjustment) is the permissive
  one.
- **Cross-pack disagreement.** The same charge carries different
  intrinsics in different packs: `sync_io_in_hotpath` is 0.55 in the JS
  detector and 0.50 / 0.70 in the Python one. Nothing reconciles them.
- **The 41 expressed intrinsics.** Still literals inside their
  detectors, so they are calibrated only by reading 41 files. Moving
  their bases into `INTRINSIC_DEFAULTS` would put the whole calibration
  in one place; it was out of scope here.

---

## `0.24.0` — the ceiling becomes a scale

**Status: decided, on measurement.** `0.23.0` refuted the ceiling's
stated rationale but deliberately left the mechanism alone so the input
fix stayed attributable. This is the other half.

```
before   Math.min(scored, STRUCTURAL_CEILING)
after    round(scored * STRUCTURAL_CEILING)
```

### Why a clamp was the wrong shape

A clamp destroys order. Measured at `0.22.0`, it collapsed **760 of
zulip/zerver's 1505 findings onto exactly 0.30**, from 31 distinct
pre-clamp levels spanning 0.31–0.63. The plateau covered 22.8%–61.4% of
a report across the corpus.

That is worse than a tie, because `rank_score = agent_risk * (1 +
recency * 0.5)`. With half the report on one `agent_risk`, the ordering
of that half was decided by **`recency`** — a file-age signal with
nothing to say about agent risk — and then by severity, confidence and
file path. Half of pydantic's report was sorted by when its files were
last touched.

### Re-measured from `0.23.0`, not reused from R5

R5's numbers (13 up / 0 down) were taken against `0.22.0`, with 28
detectors still suppressed. They are not evidence about the squash on
top of the intrinsics fix, so the whole measurement was re-run.

Deterministic, deep fixtures:

| deep bucket | n | mean nDCG | up | down |
|---|---|---|---|---|
| no structural expectation | 19 | 0.3668 → 0.3757 (**+0.0089**) | **11** | **0** |
| priority IS structural | 7 | 0.3586 → 0.3382 (−0.0205) | 0 | 5 |

Both columns unanimous, the same shape as against `0.22.0` and slightly
attenuated. The headline deep mean is 0.3538 → 0.3530 — essentially
flat, because the two buckets net out; `all` is 0.4926 → 0.4799. The
second bucket is the length-labelled scenarios §28 has already
disowned, plus their neighbours.

### The plateau, which is the point

| repo | findings at exactly 0.30 | distinct `agent_risk` values |
|---|---|---|
| mlflow | 2778 → **46** | 57 → 63 |
| zulip/zerver | 777 → **4** | 42 → 48 |
| pydantic | 296 → **4** | 43 → 46 |
| hono | 99 → **4** | 43 → 49 |
| drf | 57 → **0** | 17 → 21 |

Resolution *rises* on every repo: the ranking says more, not less.

### What it does to the head

Length findings stop leading the two repos where the ceiling never
managed it:

| repo | top-20 structural | top-50 structural |
|---|---|---|
| pydantic | 6 → **0** | 23 → **0** |
| drf | 15 → **10** | 45 → 34 |
| zulip/zerver | 0 → 0 | 14 → **0** |
| hono | 0 → 0 | 1 → 0 |

drf stays structural-heavy because it *is* — 72 of its 88 findings are
structural, so the head cannot be anything else.

No finding is added or removed on any corpus repo and severity
distributions are unchanged. Concentration does not worsen: mlflow's
dominant-type lift falls 2.59 → 2.34, zulip holds at 1.20, hono at
2.80, and pydantic's head becomes measurable at 1.66 where it
previously had no agent-signal dominant type at all.

On pydantic the top-5 file *set* is unchanged; the order moves.
`core_schema.py` — 19 findings, 16 of them low, all length — goes from
2nd to 5th, and `mypy.py` and `fields.py`, which carry high-severity
differentiated findings, move up. The clearer effect is *within* a
file: `_generate_schema.py`'s God Functions now rank by their own size
and nesting (121 lines / depth 7 first) instead of by the tiebreak they
fell through to when 296 pydantic findings shared one score.

### The part that is a trade, not a free win

**The two effects are inseparable at 2-decimal precision.** The
structural band has 31 slots (`0.00`–`0.30`) and the input has 101
levels, so a monotonic map cannot re-spread the clamped tail without
also lowering the rest of the class. This is not only "preserve order";
it also pushes the whole structural class down, and a typical
`large_function` lands around 0.05–0.09 rather than 0.16–0.30.

That was measured and accepted rather than overlooked. It is the reason
the structural-labelled bucket drops, and anyone who thinks length
findings should sit higher should reopen this rather than the class
table.

### Still unsettled

The **level** 0.3 remains unvalidated — nothing here chooses it, and
correcting a mechanism does not validate a constant. The class table is
still hand-maintained with `standard` holding zero members, the two
packs still disagree about `sync_io_in_hotpath`, and 41 intrinsics are
still literals in their own detectors.


## 0.29: literal-scatter guidance and edit scope

The development edit trial exposed a guidance problem rather than a missing
finding. In `claude-plan-limit-briefing-2`, the agent explicitly cited the
“find or create the source of truth” guidance when extracting a shared policy
module for a small limit change. The finding identified `"pro"` in current
and intentionally frozen legacy flows; repetition alone did not require
consolidation.

Named-plan acceptance passed. Independent patch review found that the new
plain-object lookup changed the fallback for prototype-key plan names such
as `constructor`: 50 rows were previously accepted and now rejected. These
names were not specified by the task, so this is a supplementary behavior
observation, not a retroactive change to the frozen acceptance score. It
shows why acceptance and scope review must remain separate.

The context guidance and finding remediation now ask agents to inspect related consumers, preserve
intentional variants and reuse existing authority, keeping consolidation
separate unless the requested change requires it. Detection criteria,
thresholds, fingerprints and ranking are unchanged; the advice text changes. The original 216-run comparison uses
its frozen package; the revised guidance is checked separately. One observed
failure does not justify a new detector or establish a general benefit from
this wording change. See [0.29 evidence](./releases/v0.29.0.md).
