# Calibration follow-ups

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
| [`agent_risk` shape](#agent_risk-what-we-know-and-what-we-believe) | **Parked** — decoupled in `0.18.1`; the shape is the next release's focus |

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

**Disposition: parked. The shape of this score is the focus of the next
release.** The 0.18.1 change (`ce0ccab`) removed a defect; it did not
settle what this score should be, and the difference matters.

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

### What the next release needs to answer

1. Is a hard ceiling right, or should the structural class be squashed
   monotonically so it keeps internal order?
2. Are per-detector intrinsics calibrated against each other, and what
   would calibrating them look like?
3. Is one detector at 16 of 20 a problem in itself — should the ranking
   diversify across detector types deliberately, the way the default
   view already diversifies across files?
4. Can any of this be measured other than by reading top-20 lists? A
   ranking-quality metric would turn all of the above from taste into
   evidence.

Until those are answered, `ce0ccab` stands as a defect fix — the score
is no longer a length ranking, and no longer correlated with severity by
construction — and nothing more should be read into the specific
numbers.
