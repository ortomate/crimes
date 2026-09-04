# crimes

> A crime scene investigator for your codebase. **Built for agents, readable by humans.**

[![npm version](https://img.shields.io/npm/v/crimes.svg)](https://www.npmjs.com/package/crimes)
[![license](https://img.shields.io/npm/l/crimes.svg)](./LICENSE)
[![CI](https://github.com/ortomate/crimes/actions/workflows/ci.yml/badge.svg)](https://github.com/ortomate/crimes/actions/workflows/ci.yml)

`crimes` is an open-source CLI that scans a repository for maintainability
risks, code smells, duplicated business rules, weak test boundaries, and
patterns that confuse AI coding agents.

It is **not** another linter. Linters catch local syntax and style issues.
`crimes` answers a higher-value question:

> _Where in this repo is future change most likely to go wrong, and what
> should a human or coding agent know before editing it?_

- Website: **[crimes.sh](https://crimes.sh)**
- npm: **[`crimes`](https://www.npmjs.com/package/crimes)**
- Repo: **[`ortomate/crimes`](https://github.com/ortomate/crimes)**

This README has a first-time-CLI-user path near the top and a “for agents”
section near the bottom. Pick whichever you are.

---

## Install

`crimes` is published on npm and requires **Node.js ≥ 18**.

```bash
# Global install
npm install -g crimes
crimes scan .

# Or one-shot via npx
npx crimes scan .
```

`pnpm dlx crimes scan` and `bunx crimes scan` also work.

---

## Quick start

```bash
# Pre-edit briefing for one file (findings + likely tests + agent notes)
crimes context src/billing/tax.ts --format json

# Triage findings — set a disposition + reason + owner per finding
crimes triage

# Scan the current directory (file-grouped, top 5 files)
crimes scan .

# Stable JSON output — the product contract
crimes scan . --format json

# Show every finding, not just the top files
crimes scan . --all

# Scope a scan to the files you're about to change (pre-edit)
crimes scan --files src/billing/tax.ts,src/billing/invoice.ts --format json

# …or to one file and its import-graph neighbourhood
crimes scan --related-to src/billing/tax.ts --format json

# Scan only files changed in the working tree (post-edit gate)
crimes scan --changed --format json
crimes scan --changed --base main --format json

# Rank files by Git churn × current findings
crimes hotspots --since 90d --format json
```

You should see a colourful **CRIME SCENE REPORT** printed to your terminal.

---

## Triage workflow

`crimes triage` is the front door for handling existing findings — the
escape hatch is still `crimes baseline save`, but triage is the
recommended path because it captures *why* each finding was set aside
and resurfaces silenced dispositions the moment you touch the same file
again.

`crimes triage` walks findings top-of-rank first and prompts for a
**disposition**, **reason**, **owner**, and stamps the **date**. The
five dispositions and how they affect later `crimes scan` runs:

| Disposition    | Shown in scan? | Resurfaces on touched files? |
| -------------- | -------------- | ---------------------------- |
| `fix-now`      | yes (▶ prefix) | n/a                          |
| `fix-this-PR`  | yes (▶ prefix) | n/a                          |
| `needs-design` | hidden         | yes — "still intentional?"   |
| `wont-fix`     | hidden         | yes — "still intentional?"   |
| `scaffolding`  | hidden         | yes — "still intentional?"   |

Entries persist to `.crimes/triage.json` — a sibling of
`.crimes/baseline.json` and `.crimes/suppressions.json` — and the file
is **intended to be committed**. Every entry carries `disposition`,
`reason`, `owner`, and `date` (`reason`, `owner`, and `date` are
required at the schema level so the receipts are always there). The
fingerprint scheme is the same `<type>::<file>::<symbol-or-empty>` used
by baseline and suppressions, so an entry survives line shifts and
unrelated edits to the same file.

`needs-design`, `wont-fix`, and `scaffolding` are silenced by default
and **resurface automatically** when the file appears in the branch
diff against `config.triage.resurfaceBase` (default `"main"`). The
resurfaced finding renders with a `▼ was previously triaged` annotation
asking whether the disposition is still intentional. Set
`triage.resurfaceBase` to `""` in `crimes.config.json` to disable
resurfacing entirely. Baseline entries get the same treatment on
touched files (`▼ was previously baselined`).

`crimes triage` flags:

| Flag                     | What it does                                                                |
| ------------------------ | --------------------------------------------------------------------------- |
| `--apply <file>`         | Non-interactive — read dispositions from a JSON file. Shape below. |
| `--list`                 | Show the current triage entries and exit; no scan, no prompts.              |
| `--clear <fingerprint>`  | Remove a single entry by fingerprint.                                       |
| `--retriage <target>`    | Re-open the disposition prompt for matching entries (fingerprint, file path, or glob). |
| `--owner <handle>`       | Default owner for new dispositions written this run.                        |
| `--all`                  | Include non-domain tier findings in the interactive walk.                   |

### `--apply`, and the shape it takes

`crimes triage` refuses to start the interactive walk in CI or a
non-TTY, so `--apply` is **the** route for an agent, a script, or a CI
job. Entries merge by fingerprint: an applied entry overwrites an
existing one with the same fingerprint, and fingerprints you do not
mention are left untouched.

**Three fields are required.** Everything else is optional and is filled
in for you:

```json
[
  {
    "fingerprint": "large_function::src/billing/tax.ts::applyVat",
    "disposition": "wont-fix",
    "reason": "generated file — rewritten by the codegen step"
  }
]
```

- `fingerprint` — copy it verbatim from `crimes scan --format json`. Do
  not build it by hand.
- `disposition` — one of `fix-now`, `fix-this-PR`, `needs-design`,
  `wont-fix`, `scaffolding`.
- `reason` — required, and non-empty. It is the whole point: a silenced
  finding without a reason is indistinguishable from one nobody looked at.
- `owner` — optional, defaults to empty. `--owner <handle>` sets it for
  the run.
- `date` — optional `YYYY-MM-DD`, defaults to today.
- `type`, `file`, `symbol` — optional. They are already inside the
  fingerprint and are derived from it; supply them only to override.

A bare array works, as above. So does `{"entries": [...]}`, and so does
a whole `.crimes/triage.json` envelope and all — which means an existing
triage file is a valid payload you can edit and re-apply. Every problem
in the payload is reported at once, not one per run.

`crimes triage --list --format json` emits `{"entries": [...]}` — the same
shape `--apply` accepts, so the two round-trip: list, edit a disposition,
apply it back.

---

## Status — `crimes@0.27.0`

`crimes@0.27.0` is the latest version. Three things in this release were
saying less than they knew: a finding knew which of several statements
it was making and reported only the detector's name, a triage entry knew
it had stopped matching and reported nothing, and a CI gate knew it had
scanned an empty directory and reported success.

**`schema_version` moves to `0.8.0` and fingerprints change for eleven
detector types.** Existing suppressions, baseline pins and triage
dispositions against those types will not match — read the
[upgrade note](./docs/releases/v0.27.0.md#upgrading) first. This is the
release that tells you when a pin has gone stale, which is why the two
changes ship together.

- **One type, one claim.** `type` was naming the detector *and* standing
  in for what it alleged, and those coincide only while a detector says
  one thing. Eleven say more. On a 761-file repository three findings of
  one `weak_test_signal` shape were checked, all three were false, the
  type was silenced, and **67 correct findings went with the 38 false
  ones** — they named 449 `expect(screen.getBy*(…)).toBeTruthy()` calls
  where the query already throws. crimes is built for agents and an
  agent triages by `type`; this is the main path. Scores do not move: 0
  score changes and 0 severity changes across 388 fixture findings.
- **A pin that matches nothing says so.** An entry nobody looks up is
  never visited, so a stale pin was a silent no-op. This repository is
  its own reproduction — of 115 triage entries, **63 match nothing**, 56
  of them `large_function::…` against a live `large_function/too_long::…`
  that was never fixed. Reported through `coverage.warnings[]`, with
  stale and fixed told apart.
- **`triage --apply` takes the shape a caller writes.** It validated
  input against the on-disk schema, so authoring a first payload took
  seven attempts. Three fields now, and every problem reported at once.
- **A gate that scanned nothing reported success.** `evals-pr.yml` never
  cloned its gitignored OSS fixtures, so every scan ran against an empty
  directory — and the failure read like a detector regression. It had
  never run: the first pull request ever opened here is what executed it.
- **One Node, from `.nvmrc`.** Four places named a version and three
  disagreed. Node 20 went end-of-life in April 2026.

Release notes: [`docs/releases/v0.27.0.md`](./docs/releases/v0.27.0.md).

### Earlier `0.26.0` work (_one charge, one answer_)

A correctness release: the cross-language scoring gaps are closed, and
two defects were found in the instruments that measure them.

- **Churn was silently lost through a symlinked scan root.** `git log`
  only matches paths git has committed, so a symlinked root produced a
  pathspec that exists on disk and not in history — every file dropped,
  and the caller told `git_available: true` with churn 0 everywhere.
  Anyone scanning through a symlinked checkout, a workspace link or a
  mounted path lost the signal with no warning.
- **`circular_dependency` and `deep_import` can now escalate.** Both
  expressed no intrinsic on the universal side, so a 4-file import cycle
  and a 2-file one scored identically, and 478 cal.com `deep_import`
  findings scored the same whether the file reached into one deep
  package path or twenty-eight. 204 corpus findings move.
- **Four cross-pack constant gaps reconciled**, toward the values
  `detector-defaults.ts` publishes as anchors — the numbers every other
  detector was calibrated against. 1,457 findings move, none added or
  removed.
- **`commented_out_code`'s two variants share one ladder.** Its
  published base of 0.48 was *unreachable*: the detector gated at a
  threshold that put its own floor at 0.68, so every peer calibrated
  against 0.48 was calibrated against a number no report contained.
- **`sync_io_in_hotpath` no longer charges dev and CI scripts.** The
  test-only bucket, inspected rather than reasoned about, is 63 findings
  in 36 modules across four repositories and every one is tooling.
- **crimes honours `.gitattributes linguist-generated`** — a repository's
  claim about who wrote its own file, trusted from a single source. 69
  findings on four posthog files the path heuristics could not
  recognise.
- **The agent noise band was wrong, and backwards.** Re-derived from
  per-scenario variance across two repeat pairs: ±5pp claude, ±7pp
  codex, against a documented ±6pp/±3pp that had codex as the steadier
  agent. A scorer defect was inside it — charge names were matched
  case-sensitively, so an agent writing "Permission IA drift" scored
  zero on a finding it had named.

`schema_version` stays at `0.7.0`. No field is added, renamed or
retyped.

Ranking quality: `mean_ndcg_deep` 0.3449 → 0.3615. The deep set grew
from 30 to 34 scenarios across the release, so that is not a
before/after — the movement attributable to the scanner is +0.0019, from
the churn fix, and every other change reports `delta_on_stable_set`
+0.0000. Two new fixtures, fourteen new scenarios, and **zero agent
invocations across the entire release**.

Release notes: [`docs/releases/v0.26.0.md`](./docs/releases/v0.26.0.md).

### Earlier `0.25.0` work (_what the scanner reads and skips_)

Six changes to what the scanner
reads, what it skips, and how it reports the difference.

- **A user `exclude` no longer replaces the defaults.** Setting one
  pattern used to inherit nothing from `DEFAULT_CONFIG`, so it silently
  un-excluded `node_modules` and every lockfile. `crimes init` had a
  second instance of the same defect, hand-copying 9 of the 20 default
  patterns. `exclude` is now additive; `excludeDefaults: false` restores
  the old behaviour.
- **`sync_io_in_hotpath` no longer charges one-shot scripts.** airflow
  811 → 680 findings (−16% of the detector), mlflow 402 → 347, pydantic
  17 → 11. A module counts as a script only if it has a `__main__` guard
  and zero textual references anywhere in the repo — three earlier
  candidate signals, including the one previously recorded as correct,
  all exempted a known production file.
- **crimes honours a repository's own tooling exclusions.** pydantic's
  `pydantic/v1` is excluded by its ruff, coverage, pyright and codespell
  config: 487 → 402 findings, −17.5%, with one `coverage.warnings[]`
  entry naming the directory, its file count and the opt-out. A path is
  skipped only when two or more independent tools name it; across the
  corpus that is exactly one directory. Build-backend tables such as
  `[tool.hatch.build]` are never read.
- **`commented_out_code`'s two variants now identify a block the same
  way.** The conditional form was unstable: an unrelated second block in
  the same file changed the first one's fingerprint.
- **One shared intrinsic ladder across both language packs**, plus a
  test that fails on undocumented cross-pack disagreement. An audit
  found 7 of 8 twice-implemented charges disagree; they are reported and
  not yet changed.
- **`DEPTH_FLOOR` re-centred 40 → 28.** Fixture `01` sat at 42 findings
  while carrying 75% of the deep aggregate, so removing three findings
  would have moved the headline +0.1333 with no scoring change. The
  population, the mean and all nine stored baselines are unchanged by
  the move.

`schema_version` stays at `0.7.0`; all schema changes are additive.
Fingerprints move for one population: `commented_out_code` in
single-block non-JS files.

Eval baseline: claude 0.82 → 0.84, codex 0.61 → 0.58 over 102
combinations. The scenario set grew by three, so those are not a
before/after; on the 48 scenarios present in both runs claude is +0.0pp
and codex −5.1pp. All 96 stable pairs received a byte-identical scan
context, so the run is a repeat sample measuring agent variance — 16 of
48 scenarios moved for each agent on identical input. `structural_pass_rate`
cannot observe the first three changes above, which move findings on
real repositories but not on the fixtures.

### Earlier `0.24.0` work (_the ceiling becomes a scale_)

`0.24.0` was the other half of `0.23.0`: the ceiling applied to length
findings became a scale rather than a clamp. **A clamp does not rank —
it hands ranking to something else.** It collapsed 760 of zulip/zerver's
1505 findings onto exactly 0.30 from 31 distinct levels, and since
`rank_score = agent_risk * (1 + recency * 0.5)`, the order of that half
was then decided by file age. Findings at exactly 0.30: mlflow
2778 → 46, zulip/zerver 777 → 4, pydantic 296 → 4, drf 57 → 0.
Release notes: [`docs/releases/v0.24.0.md`](./docs/releases/v0.24.0.md).

### Earlier `0.23.0` work (_the score's missing inputs_)

`agent_risk` is the score that makes `crimes` something other than a
linter, and its heaviest term is the detector's own judgement about how
badly a finding will mislead an agent. **28 of 70 detectors were not
making one.**

- **Silence was not scored as unknown.** A detector that set no
  intrinsic fell back to `0.30` — *below all 29 of the expressed
  agent-signal bases*, which run 0.35–0.80. So the tool ranked
  `contract_drift`, `swallowed_error`, `duplicated_policy` and
  `permission_ia_drift` beneath its own most lenient charge.
- **The constant that was supposed to prevent that was fitted to a band
  that does not exist.** Rebuilding `ce0ccab` and scanning the tree its
  comment cites: the agent-signal population starts at **0.12**, not
  0.31; every figure in the quoted band is a per-type *maximum*; and
  `contract_drift`, the type the comment says a `large_file` must not
  outrank, **produces no findings on that tree at all**.
- **One table, each value anchored to a named peer.** Intrinsics can
  only be calibrated against each other where they can be seen next to
  each other. A gate reads the detector sources and fails when a new
  detector expresses neither, so this cannot re-accumulate.
- **Conservative in practice.** No finding is added or removed anywhere
  on the corpus, and heads move only where the suppressed detectors
  actually fire — where they do, over-concentration *falls* (hono's
  top-20 lift 6.00 → 2.80).
- **The mechanism was measured and deliberately deferred**, so two
  findings-moving changes would not land in one baseline. It was then
  re-measured from this baseline and shipped in `0.24.0` above.

`schema_version` stays at `0.7.0` — no field is added, renamed or
retyped. Scores and ordering move.

Eval baseline: claude 0.81 → **0.81**, codex 0.58 → **0.63**. The codex
move clears its ±3pp band, but `structural_pass_rate` matches literal
detector ids in the response text and that release changed which
findings rank highly — so read its deterministic split, not this
number. `0.22.0`'s repeat sample moved 13 of codex's 48 scenarios on
provably identical input.

Release notes: [`docs/releases/v0.23.0.md`](./docs/releases/v0.23.0.md).

### Earlier `0.22.0` work (_the queue, closed_)

`crimes@0.22.0` **closes the remediation
queue** carried since `0.18.0` — seven entries, every one reproduced
before it was touched, and **four of the seven turned out to be wrong
about themselves**.

- **Fingerprint collisions are gone.** Four detectors could emit more
  than one finding per `(type, file, symbol)` with no way to tell them
  apart, so `crimes ignore` on one silenced its neighbours. Zero
  collisions now on n8n `packages/cli`, zulip and airflow, down from
  4, 39 and 184. **Only ambiguous fingerprints move** — across four
  repos and 7,888 findings, 16 retired and 51 introduced, and hono
  (which had none) is byte-identical.
- **The queue said those collisions were `weak_test_signal`.** Zero of
  zulip's and zero of airflow's are. The real class is `large_function`
  on a method name repeated across classes in one Python module, and
  `commented_out_code` on non-JS files.
- **A JavaScript syntax error is no longer indistinguishable from a
  clean file.** `coverage.warnings[]` gains `files_partial_parse` for
  `language-js`. The entry said no public API existed; there is one,
  and it costs 1262 ms → 1330 ms over n8n's 2,977 files.
- **`large_file` still counts blank lines**, implemented and reverted
  on measurement: it is 3–9% for code (the 15–25% in the queue was
  prose), and dropping them silences the bundled fixture's own
  `large_file` finding. What changed is `countNonEmptyLines`, which
  counted every line — now `countSourceLines`.
- **`verdict`'s short circuit was fine**; the 1762-vs-929 ms reading
  that indicted it was a measurement-order artifact.

`schema_version` stays at `0.7.0` — no field is added, renamed or
retyped. If you hold pinned suppressions, read the fingerprint note in
[`docs/json-schema.md`](./docs/json-schema.md).

Because all 14 eval fixtures scan **byte-identically** between `0.21.0`
and this build, the `0.22.0` eval run is a free repeat sample: claude
0.77 → **0.81**, codex 0.58 → **0.58**. That settles `0.21.0`'s 0.82 →
0.77 as noise, and it measures per-scenario variance directly — **16 of
claude's 48 scenarios and 13 of codex's moved with nothing changed**,
two of them by a full 1.00.

Earlier release notes:
[`docs/releases/v0.22.0.md`](./docs/releases/v0.22.0.md).

### Earlier `0.21.0` work (_precision, where the false positives were_)

`crimes@0.21.0` is **a precision release**:
four detectors named in an outside field report as producing false
positives, all four re-verified against `main` first and measured on
real repositories before and after.

**Three of the four fixes are not the fix the report asked for**,
because the suggested rules did not survive contact with the files that
prompted them. That is the most useful thing in the release.

- **`logic_in_comments`** matched its domain vocabulary with
  `String.includes`, so `auth` matched "**Auth**ored by the Curator" and
  `utc` matched "captured that o**utc**ome". Now whole-word with a closed
  set of inflections. choreograph 10 → 7.
- **`direct_date`** — the report's own example turned out to contain two
  poll timeouts (`if (Date.now() - startedAt >= VIDEO_POLL_TIMEOUT_MS)`),
  which is exactly the risky shape it was said to lack. Nothing is
  hidden; the evidence now names which readings decide a branch, and a
  file whose readings are all values caps at `medium`. choreograph 91 →
  91 findings, `high` 4 → 1.
- **`high_fan_in_fan_out`** — the suggested "exempt type-only exports"
  rule would not have exempted `types.ts`, which exports 24 interfaces
  and one `const`. The importer side was already in the graph: 32 of 33
  write `import type`. The count and the finding stay; only the p99
  promotion is withheld.
- **`name_behavior_mismatch`** — `const supabase = await createClient()`
  followed by `supabase.from(…)` builds the thing the function reads
  *through*. A shape rule, not a `createClient` allowlist. choreograph
  19 → 7.

**Nothing became a filter.** Every change is evidence or severity: a
finding that is noise mid-task can be exactly what an audit run wants,
and the way to serve both is to rank honestly rather than to hide.

`schema_version` stays at `0.7.0` and **no fingerprints move**, so
pinned baselines, suppressions and triage entries carry over untouched.

Release notes: [`docs/releases/v0.21.0.md`](./docs/releases/v0.21.0.md).

### Earlier `0.20.0` work (_scope it to the work_)

`0.20.0` makes **the agent workflow the
documented default**, and everything in it traces to one outside field
report on a real Next.js project — checked complaint-by-complaint
against `main` before any of it was acted on.

**`crimes scan` gains a working set.** Bare `scan` audits the whole
repository; on a 200-file project that is ~500 findings, which is not a
work list. Name what you are about to change instead:

```bash
crimes scan --files src/lib/api.ts,src/lib/types.ts
crimes scan --related-to src/lib/api.ts          # …and its import-graph neighbourhood
crimes scan --related-to src/lib/api.ts --related-depth 2
```

`--related-to` walks the graph **both ways** — what a file imports can
break it, what imports it is what it can break. On the field-report repo
that is **28 findings across 8 files** where the bare scan gives 491.
`--fail-on` now works with any selector rather than only `--changed`,
and the resolved set comes back as `working_set.files` so an agent can
confirm what was scanned. A path matching nothing says so on stderr,
because a typo used to produce "No crimes detected. Suspiciously clean."

**`--changed` is documented as the post-edit selector.** On a clean tree
it correctly returns nothing — which is exactly the moment most agent
tasks start, and why the other two selectors exist.

**The headline number now counts what the report shows.** It used to
announce *491 findings across 208 files* above a body listing *339
across 137*, because the other 152 were already classified non-domain
(`scripts/**` and friends) and collapsed into a footer. The remainder is
still stated as `+152 in non-domain paths`; `summary.total` in the JSON
is unchanged. The totals are also repeated just above the closing line,
so a long report no longer needs a second run at `--top 3` to read them.

`schema_version` `0.6.0` → **`0.7.0`**, purely additive
(`ScanReport.working_set`, plus a `working_set_path_unmatched` coverage
warning). **No fingerprints change**, so baselines, suppressions and
triage files carry over untouched.

Release notes: [`docs/releases/v0.20.0.md`](./docs/releases/v0.20.0.md).

#### Earlier `0.19.0` work (_the backlog release_)

`0.19.0` is **the backlog release** —
the largest span the project has published. 50 commits, ~30 defect
fixes, four features, and two `schema_version` bumps
(`0.4.0` → **`0.6.0`**).

`0.18.0` through `0.18.4` were internal eval-baseline markers and were
never published, so everything they carried lands here.

**If you consume the JSON, two migrations apply.** `0.5.0` renamed
`scores.blast_radius_importers` → `blast_radius_transitive_importers`
and added `blast_radius_direct_importers` — the old name promised "N
files import this" and delivered the transitive closure, and on `hono`
those differ by 5 vs 240 on the same file. `0.6.0` adds a required
`fingerprint` to every finding, which is the handle `crimes ignore`,
`unignore`, `feedback` and `triage` all accept and which the JSON did
not contain. See
[Migrating from `0.4.0` to `0.5.0`](./docs/json-schema.md#migrating-from-040-to-050).

**Pinned suppressions and baselines for twelve more detectors need
re-recording** (the fingerprint-collision work `0.17.0` started, run to
completion). `crimes feedback recheck` surfaces them with a
per-detector reason — and re-recording actually works now: before
`1499b5e`, `crimes ignore` on a discriminated finding was a silent
no-op by id and a hard reject by fingerprint.

**Installing is clean again.** npm ≥ 11.18 blocks install scripts by
default, so the only crimes-specific output on a fresh install was a
security warning asking the user to approve arbitrary code execution —
in exchange for a seven-line banner npm swallowed anyway. The
postinstall script is gone; bare `crimes` was always the reliable
onboarding surface.

The biggest measured wins are all on real repositories:
`commented_out_code` on airflow **8,019 → 45** (7,320 of them were the
Apache licence header), `parallel_destination` on n8n's editor-ui
**2,819 → 0** (now the first detector to ship gated off),
`pass_through_abstraction`'s fabricated 0.98-confidence chains **7 →
0**, and airflow's claimed-silent Python tests **−27.1%** via a
repo-wide symbol index.

And the worst-shaped defect in the release: `crimes scan` told users to
write `"detectors": { "enable": ["parallel_destination"] }`, and
`enable` was a pure allowlist — so following the tool's own advice
verbatim **turned off the other 68 detectors and the entire asset
pass, with no warning** (13 findings became 1). `enable` is now
additive for gated ids.

Release notes: [`docs/releases/v0.19.0.md`](./docs/releases/v0.19.0.md).

#### Earlier `0.17.0` work (_calibration, and the first wire-format change_)

`0.17.0` was **a calibration release**,
and the first one to change the wire format: `schema_version` goes
`0.3.0` → `0.4.0`.

`Finding` gains an optional `discriminator`, and `fingerprintFinding`
folds it in when present. That closes a real hole rather than a
cosmetic one. Three detectors can legitimately report several findings
about the same file — `magic_domain_literal_scatter` reports one per
scattered literal, `exact_duplicate_block` and `near_duplicate_block`
one per duplicate group — and those findings used to share a single
fingerprint. So `crimes ignore <fingerprint>` on one of them silently
suppressed the others, and the user was never told. A suppression
should mean the one finding its author actually looked at.

**If you have pinned entries for those three types**, they stop
matching and need re-recording; every other type is byte-identical.
`crimes feedback recheck` will surface them with the reason. See
[Migrating from `0.3.0` to `0.4.0`](./docs/json-schema.md).

`large_file` also gains a **`docs` shape**: prose (`.md`, `.mdx`,
`.rst`, `.adoc`, `.txt`) gets a 1000-line budget at `low`/`medium`
instead of being measured against the 300-line domain-code budget.
Reference documentation is supposed to be long. Data formats are
deliberately not docs — a 3000-line `.json` is still a finding worth
having.

Two scan-path fixes round it out: the index builders no longer
`Promise.all` a read per candidate file (unbounded on a large repo, and
`crimes`' own `unbounded_async_fanout` detector was right to flag it),
and `exact_duplicate_block` evidence is now reproducible run-to-run —
map insertion order used to track which read finished first.

Release notes: [`docs/releases/v0.17.0.md`](./docs/releases/v0.17.0.md).

#### Earlier `0.16.0` work (_correctness and authority_)

`0.16.0` is **the correctness and
authority slate** — ten detectors that ask a different question from
everything before them: *what does this code do when something goes
wrong, and where does it disagree with itself?*

Earlier families asked whether code is hard to change. These ask
whether it is safe on a bad day. A retry that replays a payment, a
catch that erases the only evidence a write failed, a `Promise.all`
that opens one socket per database row, a test that stays green through
any refactor because every collaborator was replaced with a double —
each is correct today, passes review, and passes CI.

The other half is **authority**: the same authorization rule
implemented in two files, one record described by two disagreeing
declarations, one environment variable parsed three ways. Nothing keeps
those copies in agreement, so the next edit to either one is
unobserved by the other. An agent asked to change a permission rule
edits the site it was shown and has no reason to suspect a second copy
exists three directories away.

Three boundaries this release holds deliberately: **no registry calls**
(`dependency_provenance_gap` reports what this repository's own records
say, never what npm says), **nothing is executed**
(`agent_permission_sprawl` reads hooks as text), and **no values are
reported** (`config_drift` reports names and locations; a real `.env`
is never opened).

Schema stayed `0.3.0` in that release — new `type` values are additive,
fingerprints and existing detector meanings were unchanged. Release
notes: [`docs/releases/v0.16.0.md`](./docs/releases/v0.16.0.md).

Earlier `0.15.0` work (_polyglot IA + monorepo coverage_) remains
shipped — the release where `crimes` starts reporting problems that no
single-language tool can see.

Three cross-language detectors report disagreements *between* Python
and TypeScript: `cross_language_route_drift` (the frontend calls a path
the backend doesn't serve, or the two disagree on the HTTP method),
`cross_language_type_drift` (a Python `Enum` and a TS string-literal
union that have diverged), and `cross_language_concept_alias_drift`
(the same concept called `team` in one language and `workspace` in the
other).

Every individual file in those cases is correct. Every type checker
passes. The system is still broken — and an agent asked to "add a field
to the workspace" greps for `workspace`, finds only the TypeScript
half, and ships one side of a two-sided change.

`ScanReport.coverage.by_package` answers the companion question on a
monorepo: the repo-wide language split says a repo is 75% TypeScript,
`by_package` says *which package* is the Python one.

It also fixes a bug 0.14.0 shipped: **`crimes context` reported no
findings for Python files.** The pre-edit briefing only ran the
universal and JS packs, and parsing a `.py` file with the TypeScript
parser returns an empty result rather than an error — so it reported
clean files. If you run `crimes` on Python, this is the reason to
upgrade.

Schema stays `0.3.0` — `Finding.pack: "cross-language"` and
`coverage.by_package` land additively, fingerprints are unchanged.
Release notes: [`docs/releases/v0.15.0.md`](./docs/releases/v0.15.0.md).

Earlier `0.14.0` work (_the Python language pack_) remains shipped:
`crimes scan` parses `.py` / `.pyi` and reports Python findings
alongside JavaScript ones in the same report.

```console
$ crimes scan . --explain-coverage

coverage breakdown:
  files discovered: 550
  packs loaded: universal, language-js, language-py
  files by language pack:
    language-js (.ts/.tsx/.js/.jsx/.mjs/.cjs/.cts/.mts): 412
    language-py (.py/.pyi): 138
  files with only universal coverage: 0
```

Eight Python detectors ship: `large_function.py`, `direct_date.py`,
`mixed_utc_local_methods.py`, `sync_io_in_hotpath.py`,
`boolean_naming_drift.py`, `weak_test_signal.py`,
`circular_dependency.py`, `deep_import.py`. They are not ports of the
JS ones — `direct_date.py` charges naive datetimes,
`circular_dependency.py` explains an `ImportError` at startup, and
`sync_io_in_hotpath.py` escalates inside `async def` because a blocking
call there stalls the whole event loop.

**No Python runtime is required**, at install or at scan time. The pack
parses via a vendored WebAssembly build of `tree-sitter-python`, ships
no native code and no install scripts, and loads nothing at all in a
repo with no `.py` files.

Two scoring fixes landed with it, both of which would otherwise have
mis-ranked Python against JavaScript:

- **`test_gap` understands Python's test convention.** `test_billing.py`
  covers `billing.py` — a *prefix*, where every other supported language
  uses a suffix. Without it every Python file scored `test_gap: 1.0`
  ("no test at all") no matter how well covered.
- **`blast_radius` is real for Python.** Python module resolution
  (`__init__.py` packages, relative-dot levels, `src/` layouts) feeds
  the same import graph the JS pack does. Without it every Python file
  scored `0` on a signal worth 0.20 of `agent_risk`.

Schema stays `0.3.0` — `pack` and `coverage` already shipped in 0.12.0,
and `Finding.pack: "language-py"` lands additively. Fingerprints are
unchanged. Release notes:
[`docs/releases/v0.14.0.md`](./docs/releases/v0.14.0.md). Pack
reference: [`docs/packs.md`](./docs/packs.md).

Earlier `0.13.0` work (_the ranking release_) remains shipped. It was
no new detectors, but a substantial change to which findings surface
first.

`agent_risk` — the score that separates "this file is long" from "an
agent will get this wrong" — had collapsed into `severity`
(correlation 0.79) while ignoring `blast_radius` (0.06), the exact
failure `PRD.md` §10 says must not happen. The formula now leads with
the detector's own judgement, which 30 of 48 detectors were computing
and having discarded on every scan. Severity correlation is now 0.18,
blast radius 0.48. Release notes:
[`docs/releases/v0.13.0.md`](./docs/releases/v0.13.0.md). Previous
release: [`docs/releases/v0.12.0.md`](./docs/releases/v0.12.0.md).

What's in `0.13.0`:

- **`agent_risk` reweighted.** `0.40*intrinsic + 0.20*churn +
  0.20*test_gap + 0.20*blast_radius`, where `intrinsic` is the
  detector's own agent-risk judgement. Severity and confidence are no
  longer terms. **Expect your rankings to move** — the findings are the
  same, the order is not. Fingerprints are unchanged, so baselines,
  suppressions, triage and feedback all carry over.
- **`test_gap` no longer fires on non-code files.** Markdown, JSON and
  YAML scored "no test at all" and were ranked against code, pushing
  documentation to the top of scans. Files no language pack claims now
  score 0 and leave the quartile population.
- **`coverage.universal_only_by_extension`.** A histogram of the
  universal-only bucket by extension, printed largest-first by
  `--explain-coverage`. Answers which language pack would buy the most
  coverage in your repo. Optional field, additive to schema `0.3.0`.
- **`crimes triage` records calibration feedback.** Dispositions imply
  a verdict, so the feedback loop fills up as a byproduct of triage
  instead of requiring a second command per finding. `wont-fix` is
  ambiguous, so it asks rather than guessing.
- **`pnpm ci` → `pnpm verify`.** pnpm reserves `ci`, so the documented
  verification gate never ran the workspace script.
- **Eval harness correctness.** Codex responses were being scored as
  raw JSONL transcripts (82–84% tool output, vs 0% for claude), and
  `referenced_files` credited agents for restating paths the prompt
  supplied. Both fixed; the apparent 0.10.5 → 0.12.0 regression was
  measurement error and disappears once corrected. A measured noise
  band is now published in `evals/README.md`.

Earlier `0.12.0` work (_universal pack_) remains shipped. Release
notes: [`docs/releases/v0.12.0.md`](./docs/releases/v0.12.0.md).

Earlier `0.10.0` work (_Release A front-door redesign_) remains
shipped. Release notes:
[`docs/releases/v0.10.0.md`](./docs/releases/v0.10.0.md).

What's in `0.10.0`:

- **File-grouped `scan` layout.** Default `crimes scan` groups
  findings by file, sorted by aggregate risk (churn × test gap ×
  blast radius × recency). Top 5 files shown by default; `--top N`
  overrides. `--flat` reverts to the old severity-grouped list.
  `--all` still shows every finding across every file.
- **Repo-relative `test_gap` quartile.** `Finding.scores.test_gap`
  is now a quartile-ranked value (0 / 0.25 / 0.5 / 0.75 / 1.0)
  computed against the distribution of test coverage across all
  files in the repo, not the prior fixed `{0, 0.5, 1.0}` mapping.
  Agents that compared exact values (`if test_gap === 1`) should
  switch to `>= 0.75`.
- **Recency-weighted ranking.** `Finding.scores.recency` carries a
  0–1 decay factor (1 = committed in the last 7 days, 0 = untouched
  for ≥ 180 days). The rank score multiplies recency in so recently-
  changed risky files surface first. `--no-recency` disables the
  recency multiplier.
- **`Finding.tier` and `scopeTiers.nonDomain` config.** Each finding
  is now tagged with `tier: "domain" | "nonDomain"`; non-domain
  findings appear in a separate "Also flagged elsewhere" footer in
  the human report and don't compete with domain findings for the
  default top-N. `scopeTiers.nonDomain` in `crimes.config.json` is a
  glob list (defaults to `scripts/**`, `examples/**`, `fixtures/**`,
  `public/**`, `**/__tests__/**`, `**/*.test.{ts,tsx,js,jsx}`,
  `**/*.spec.{ts,tsx,js,jsx}`); empty array opts out.
- **`clues` object on `crimes context --json`.** `ContextReport`
  gains an optional `clues` object with three sub-blocks: `churn`
  (`commits_90d`, `last_commit_at`, `unique_authors_90d`),
  `suppressions` (per-file inventory), and `test_gap` (`raw`,
  `percentile`, `label`). `clues.related_signals: []` is reserved
  for future use. Sub-blocks are omitted when empty.
- **Two-prompt auto-init.** On any subcommand other than
  `init` / `feedback` / `ignore` / `unignore` / `baseline`, if
  `crimes.config.json` is missing and stdout is a TTY (CI / piped
  invocations are skipped), `crimes` prompts to generate the config
  and (when an agent is detected via `CLAUDECODE`, `CLAUDE_CODE`,
  `OPENAI_CODEX`, or `CODEX_AGENT` env vars, or `.claude/`/`.agents/`
  directories) the agent skill. Decline once and `.crimes/.skip-init`
  is written so it never asks again. Global flags `--no-init` and
  `--init` suppress or force-re-enter the prompt. `crimes init
  --no-detect` skips repo-shape detection inside `init` itself.
- **New CLI flags.** `--top N` (scan: show top N files), `--flat`
  (scan: revert to flat severity-grouped output), `--no-recency`
  (scan: disable recency weighting), `crimes init --no-detect` (skip
  agent-environment detection).

Earlier `0.9.2` work (_emoji severity glyphs + org migration_)
remains shipped. Release notes:
[`docs/releases/v0.9.2.md`](./docs/releases/v0.9.2.md).

Earlier `0.9.1` work (_visible welcome banner on bare `crimes`_)
remains shipped: running `crimes` with no arguments now prints a
short banner with the version, three first-step commands, and a
docs link instead of Commander's long help dump; the post-install
message was expanded to match (though npm 7+ silently suppresses
post-install stdout by default — the bare-`crimes` banner is the
reliable surface). Release notes:
[`docs/releases/v0.9.1.md`](./docs/releases/v0.9.1.md).

Earlier `0.9.0` work (_Codex agent discovery + petty crime_) remains
shipped — one new detector, a Codex-aware update to
`missing_agent_context`, a `crimes explain` rewrite, and a
post-install nudge. Detector count: **47 → 48**. Release notes:
[`docs/releases/v0.9.0.md`](./docs/releases/v0.9.0.md).

What's in `0.9.0`:

- **Codex is a first-class agent.** `crimes init --agents` now writes
  both `.claude/skills/crimes/SKILL.md` and
  `.agents/skills/crimes/SKILL.md`; the new `--codex-skill` flag
  writes only the Codex skill. The `missing_agent_context` detector
  treats the Codex path as a satisfying signal, so repos that already
  ship a Codex skill no longer false-fire. See
  [`docs/skills.md`](./docs/skills.md).
- **`finder_duplicate_filename` (petty crime).** The seventh
  petty-crime detector. Flags macOS Finder / iCloud conflict-copy
  filenames like `Button 2.tsx` that slip into repos as accidental
  duplicates and force agents and humans to guess which file is
  canonical. Filename-only detection (Finder-style space + digit
  suffix), confidence 0.90. See
  [`docs/finding-types/petty.md`](./docs/finding-types/petty.md#finder-duplicate-filename).
- **`crimes explain` rewrite.** Output is split into named section
  helpers and gains a **Likely remedies** block synthesised from
  `suggested_actions` plus generic next-steps. `ExplainReport` JSON
  gains a new `likely_remedies: string[]` field (additive — the
  `Finding` wire format is byte-identical to 0.8.1).
- ~~**Post-install nudge.** `npm install -g crimes` now prints a
  one-line reminder to run `crimes init --agents`.~~ **Removed in
  0.19.0.** npm 7+ swallowed the output, so almost nobody saw it, and
  npm 11.18+ turned the script itself into an `allow-scripts` approval
  prompt — the only crimes-specific output on a fresh install was a
  security warning. The 0.9.1 bare-`crimes` banner was always the
  reliable surface and remains the whole onboarding story.
- **Landing-page broken link fix.** The "Live status" link on
  [crimes.sh](https://crimes.sh) and the `llms.txt` roadmap pointer
  now resolve to `docs/roadmap.md` instead of the moved
  `ROADMAP_STATUS.md` path.
- Schema: `schema_version` stays at `"0.1.0"`. Existing scan JSON
  files load unchanged.

Earlier `0.8.1` work (_calibration patch on 0.8.0_) remains shipped:
an eight-name expansion to `boolean_naming_drift`'s built-in
React-state allowlist (`loaded`, `found`, `settled`, `overflow`,
`typeonly`, `interpolated`, `limited`, `existed`); the crimes
monorepo's own `crimes.config.json` excludes `evals/fixtures/**` and
`examples/messy-ts-app/**` from the asset pass so the dogfood scan no
longer surfaces intentional-bad demo assets at the top; and a
behaviour-preserving refactor of `scan-assets.ts` into four named
helpers. No new detectors, no schema change. Release notes:
[`docs/releases/v0.8.1.md`](./docs/releases/v0.8.1.md).

Earlier `0.8.0` work (_extended lens: date, naming, hot-path, and
asset crimes_) remains shipped — one config feature plus **thirteen
new detectors** across four families that mainstream linters don't
catch. Detector count: **34 → 47**. Release notes:
[`docs/releases/v0.8.0.md`](./docs/releases/v0.8.0.md):

- **Per-detector exemption config.** `detectors.options.<id>` sits
  between `detectors.disable` (kills the detector everywhere) and
  `crimes ignore` (suppresses one specific finding) — name values
  that are fine for a detector across the whole codebase without
  disabling the rest of its surface. Each detector registers its own
  zod schema; typos surface at config-load time. See
  [`docs/configuration.md`](./docs/configuration.md).
- **Date / time family (5 detectors).** `timezone_unsafe_parse` flags
  `new Date("…")` literals with no zone marker; `mixed_utc_local_methods`
  catches `getUTCHours()` + `getMonth()` on the same receiver; the
  rest cover host-locale drift, DST-naive day math, and hand-rolled
  date string assembly. See [`docs/finding-types/structural.md`](./docs/finding-types/structural.md).
- **Naming-tier family (2 detectors).** `boolean_naming_drift` flags
  unprefixed booleans (with a built-in React-state allowlist);
  `singular_plural_type_mismatch` catches `users: User` and
  `invoice: Invoice[]` shapes where the name and type disagree.
- **Hot-path / portability family (3 detectors).** `sync_io_in_hotpath`
  flags `readFileSync` / `execSync` etc. inside route handlers, page
  exports, React components, or domain code; `hardcoded_local_path`
  flags `/Users/<name>/…` / `/home/<name>/…` / Windows
  `C:\Users\<name>\…`; `hardcoded_localhost` flags `localhost:NNNN`
  and IPv4/IPv6 loopback URLs in non-test, non-config source.
- **Asset family (3 detectors) — first non-source pass.** A new
  second-pass pipeline walks `**/*.{png,jpg,jpeg,gif,webp,avif,svg}`
  alongside the existing source detectors. `oversized_raster`
  thresholds at Core Web Vitals breakpoints (200 / 500 / 1000 KB by
  default); `raster_should_be_vector` flags ≤ 64 × 64 PNG / JPEG / GIF
  icons that should be SVGs; `svg_with_embedded_raster` flags SVGs
  containing `<image href="data:image/*;base64,…">`. See
  [`docs/finding-types/assets.md`](./docs/finding-types/assets.md).
- **Eight new eval scenarios** — one per new detector that warrants
  its own scenario, spread across all five kinds. Total per agent:
  30 → 38. Baseline at 0.7.15: claude 85% structural pass rate
  (essentially flat vs 0.7.8); codex 74% (codex weaker on the new
  bugfix / review scenarios — signal, not regression).
- Schema: `schema_version` stays at `"0.1.0"`. Existing scan JSON
  files load unchanged.

Earlier `0.7.5` work (_eval-harness graduation and detector trim_)
remains shipped:

- **Eval harness, production-grade.** Hardened scorer (matches by
  charge + finding id, not just slug), parallelised runs, variance
  sampling via `evals:variance` + `--label`, scenario↔fixture
  coverage verifier wired into CI so measurement bugs can't
  masquerade as agent misses, opt-in judge-model pass, per-scenario-
  kind baselines. See [`evals/README.md`](./evals/README.md).
- **`visual_regression_review_hint` removed.** Its trigger — file
  churn ≥ 0.7 on a UI `.tsx` file with weak test proximity — was a
  poor proxy for "needs visual review."

Earlier `0.7.0` work (_calibration and the evidence loop_) remains
shipped:

- **`crimes feedback <fingerprint> --verdict {tp|fp|known} --note '…'`** —
  capture per-finding verdicts. `fp` writes a feedback-sourced
  suppression that auto-resurfaces on the next crimes minor for
  re-confirmation. See [`docs/feedback.md`](./docs/feedback.md).
- **Inline `Give feedback: …` hints** under every finding in
  human-format output so the loop is one keystroke away.
- **`crimes feedback list / summary / export / recheck`** for the
  read paths plus the per-release review surface.
- **Cross-project rollup** at `~/.crimes/feedback-rollup.jsonl` via
  `crimes feedback export --append-global`.
- **`evals/` agentic harness** — 10 fixtures × 25 scenarios ×
  `claude` + `codex` (subscription-authenticated; no API keys).
  Structural rubric scores agent responses; opt-in `--judge` pass
  adds open-ended judgments. CI replays cached results against PRs
  via `.github/workflows/evals-pr.yml`. See [`docs/evals.md`](./docs/evals.md).
- **§20 dogfood housekeeping** — `direct_date` skips test files,
  `reporter/src/human.ts` and `language-js/src/parse.ts` split
  into per-responsibility files (byte-identical output).

Earlier `0.6.0` work (_detector + scoring completion_) remains shipped:

- **Per-finding scores.** Every `Finding.scores` carries real
  `blast_radius`, `churn`, and `test_gap` values. See
  [`docs/scoring.md`](./docs/scoring.md).
- **18 new detector types** across dependency-graph, IA, frontend,
  and duplication. See
  [`docs/finding-types/dependency.md`](./docs/finding-types/dependency.md),
  [`frontend.md`](./docs/finding-types/frontend.md),
  [`duplication.md`](./docs/finding-types/duplication.md), and the
  expanded [`ia.md`](./docs/finding-types/ia.md).
- **Shape-aware `cli_command_registrar`** — Commander-style
  `register*Command(program)` wrappers and their `.action(...)`
  callbacks no longer false-positive at the domain threshold. Fixes
  the dominant noise cluster from `0.5.0` self-scan.
- **`crimes hotspots <subdir>`** now walks upward to find the
  enclosing git repo, so a subdirectory inside a monorepo still gets
  churn signal.
- **`detectors.disable` stderr breadcrumb** — `crimes scan` /
  `context` / `diff` print a one-line notice when
  `crimes.config.json` has wholesale-disabled ≥ 3 detectors.
  Suppressed when stdout is piped or `--no-color` is set.
- **Full Starlight docs at [`crimes.sh/docs/`](https://crimes.sh/docs/)** —
  every existing markdown page routed under the new tree; landing
  page at `crimes.sh/` unchanged.

After upgrading, run `crimes baseline save` to re-pin
`.crimes/baseline.json` against the new detector slate, or use
`--fail-on high` until you've audited the new findings (only
`circular_dependency` at ≥ 3 files defaults to `high`).

Earlier `0.5.0` work (_suppressions, config, and explainability_)
remains shipped:

- `crimes init` — bootstrap a starter `crimes.config.json`. Use
  `crimes init --agents` to also add Claude Code and Codex skill files. See
  [`docs/configuration.md`](./docs/configuration.md).
- `crimes ignore <id-or-fingerprint> --reason "…"` — suppress one
  specific finding with a required justification, persisted to
  `.crimes/suppressions.json` (intended to be committed). See
  [`docs/suppressions.md`](./docs/suppressions.md).
- `crimes unignore <fingerprint>` — remove a suppression entry by
  fingerprint; symmetric to `crimes ignore`, supports `--dry-run`.
- `crimes audit-suppressions` — list every suppression with age and
  flags for stale, short, or vague reasons. Reviewable in JSON or
  human-readable form.
- One type carries one **claim**. Eleven detectors allege more than one
  thing — `weak_test_signal` says both "contains no expect/assert calls"
  and "only uses weak assertion matchers" — so every finding names which
  statement it makes, the claim is part of the fingerprint, and
  `detectors.disable` accepts `weak_test_signal/no_assertions`. Group
  findings by `(type, claim)`, never by `type` alone. See
  [`docs/claims.md`](./docs/claims.md).
- `crimes explain <id-or-fingerprint> [--from <scan.json>]` —
  deterministic long-form rationale for one finding plus the verbatim
  `crimes ignore` command line. See
  [`docs/explain.md`](./docs/explain.md).
- `crimes diff --fail-on new-high | new-medium` — completes the M4
  CI-gate trio.
- `--show-suppressed` on every command that lists findings.

Earlier `0.4.0` work (_agent context quality and signal-to-noise_)
remains shipped — `crimes context` tells agents what **else** to read
before editing a target file, and existing detectors are quieter and
more honest about what they searched. Release notes:
[`docs/releases/v0.4.0.md`](./docs/releases/v0.4.0.md). Everything
below is verified by the publish-tarball smoke test in CI on every
commit.

- `crimes --help` / `crimes --version`
- `crimes scan [path]` — directory scan, default top-10
- `crimes scan [path] --format json` — stable JSON contract (`schema_version: "0.1.0"`)
- `crimes scan --changed [--base <ref>]` — restrict to working-tree-changed files,
  optionally also `<ref>...HEAD`. Top-level `changed_files` (new in `0.4.0`)
  lists every changed file, even ones with zero findings.
- `crimes scan --changed --fail-on low|medium|high` — exit `1` when a changed-set
  finding meets the threshold (the canonical changed-files CI gate)
- `crimes context <file>` — single-file findings, likely tests, related files
  (new in `0.4.0`), and safe-editing notes. Auto-detects the nearest
  enclosing `package.json` so monorepo invocation from any working
  directory produces the same answer.
- `crimes context <file> --format json`
- `crimes hotspots [path]` — Git churn × scan findings, ranked by aggregate change-risk.
  Annotates shallow clones with `history_limited: true` (new in `0.4.0`).
- `crimes hotspots [path] --since <window>` — `90d`, `2w`, `6m`, `1y`, or any `git log --since` string
- `crimes hotspots [path] --format json`
- `crimes diff <base...head>` — new / fixed / unchanged crimes between two
  Git refs (e.g. `main...HEAD`, `origin/main...HEAD`). Working-tree-safe —
  scans each ref via `git archive` into a temp dir.
- `crimes diff <base...head> --format json`
- `crimes baseline save [path]` — snapshot the current findings to
  `.crimes/baseline.json`. **The baseline file is intended to be committed.**
- `crimes baseline check [path]` — re-scan and fail only on findings absent
  from the saved baseline. `--fail-on low|medium|high` (default `medium`)
  sets the severity threshold; exit `1` blocks CI, exit `2` is reserved for
  missing / malformed baseline files and bad flags.
- `crimes verdict` — one-line "did this branch make the repo cleaner,
  worse, unchanged, or mixed?" — built on top of `crimes diff`. Default
  base is `origin/main`, then `main`. Advisory by default; opt into a
  blocking gate with `--fail-on worse | new-high | new-medium`.
- Structural detectors (since `0.1.0`): **God Function**, **God File**,
  **Unfinished Business**, **Temporal Recklessness**
- Information architecture detectors (new in `0.3.0`): **Missing Agent
  Context**, **Route Metadata Drift**, **Duplicated Navigation Source**,
  **Concept Alias Drift**, **Docs-Code Drift** — see
  [`docs/finding-types/ia.md`](./docs/finding-types/ia.md). No LLM, no
  API key, no network access required.
- Bundled agent assets: [`AGENTS.md`](./AGENTS.md),
  [`.claude/skills/crimes/SKILL.md`](./.claude/skills/crimes/SKILL.md),
  and `.agents/skills/crimes/SKILL.md` when generated by `crimes init --agents`.
- CI integration: three gating modes documented in
  [`docs/ci.md`](./docs/ci.md) with a copy-paste GitHub Actions workflow
  at [`examples/github-actions/crimes.yml`](./examples/github-actions/crimes.yml).

See [`PRD.md`](./PRD.md) for the full spec.

---

## Shipped in `crimes@0.2.0`

**Theme: branch and PR safety for humans and coding agents.**

`0.1.0` answered "what does this repo / file look like right now?".
`0.2.0` extends the same workflow to **change sets** — what a branch or
PR introduces vs. what was already there — so the same `crimes` you run
locally can gate a PR in CI.

Shipped in `crimes@0.2.0`:

- **`crimes diff <base...head>`** — new, fixed, and unchanged findings
  between two Git refs. Working-tree-safe (`git archive` into a temp
  dir). See [Commands → `crimes diff`](#crimes-diff-basehead) below.
- **`crimes baseline save` / `crimes baseline check`** — snapshot
  current findings into `.crimes/baseline.json` so teams can adopt
  `crimes` on legacy code without fixing everything first, then fail CI
  only on findings introduced after the snapshot. See
  [Commands → `crimes baseline`](#crimes-baseline) below.
- **`crimes scan --changed --fail-on low|medium|high`** — exits non-zero
  when a finding in the changed-files set meets the threshold. The narrow,
  changed-files-only CI gate. JSON output gains `fail_on` / `failed` when
  the flag is set; `crimes scan` without `--changed` is unaffected.
- **`crimes verdict`** — one-line "did this branch help or hurt?"
  summary, built on `crimes diff`. Defaults base to `origin/main` then
  `main`; advisory by default, opt-in CI gate via `--fail-on worse |
  new-high | new-medium`. See [Commands → `crimes verdict`](#crimes-verdict)
  below.
- **CI integration docs + GitHub Actions example** —
  [`docs/ci.md`](./docs/ci.md) covers the three recommended gating modes
  (changed-files, baseline, branch verdict);
  [`examples/github-actions/crimes.yml`](./examples/github-actions/crimes.yml)
  is the copy-paste workflow.
- **Schema / report consistency pass** — every report now carries a
  `report_type` discriminator (`"scan"`, `"context"`, `"hotspots"`,
  `"diff"`, `"baseline"`, `"baseline_check"`, `"verdict"`) under the
  same `schema_version`. JSON schema docs (`DiffReport`, `Baseline`,
  `BaselineCheckReport`, `VerdictReport`) live in
  [`docs/json-schema.md`](./docs/json-schema.md).

Deferred from `0.2.0` and still deferred after `0.3.0` (see
[`docs/roadmap.md`](./docs/roadmap.md) for the full list):

- **`crimes diff --fail-on new-high`** — _shipped in `0.5.0`_.
- **`crimes ignore <id>`** + per-finding `.crimes/suppressions.json` — _shipped in `0.5.0`_.
- **`crimes explain <id>`** — _shipped in `0.5.0`_.
- **`crimes init`** + config plumbing — _shipped in `0.5.0`_.
- **`crimes ask`** / LLM-assisted modes — `v1+`.
- **Dependency-graph detectors** (circular deps, layer violations) —
  target: `0.4.0+`.
- **Duplication detectors** — target: `0.4.0+`.
- **Homebrew tap + standalone binaries** — deferred until the CLI
  surface stabilises.

## Shipped in `crimes@0.3.0`

**Theme: information architecture crimes.** `0.2.0` made `crimes`
useful for branches, PRs, CI, and agent loops. `0.3.0` makes it
better at detecting **source-of-truth and concept drift** — the places
where a repo gives humans and coding agents conflicting stories about
what things are called, where they live, which implementation owns
them, and how users move through the product. This is the
agent-confusion-risk wedge taken seriously: deterministic, evidence-backed
findings that linters and security scanners don't look for.

Shipped in `crimes@0.3.0`:

- **Missing Agent Context** — repos that declare a `bin` in
  `package.json` but ship no `AGENTS.md`, no `CLAUDE.md`, and no
  `.claude/skills/*/SKILL.md` or `.agents/skills/*/SKILL.md`.
- **Route Metadata Drift** — route path, file location, default-export
  component, page title, metadata title, and nav labels disagree
  (≥3-source quorum).
- **Duplicated Navigation Source** — the same internal destination
  appears in two or more nav-like sources with different non-empty
  labels.
- **Concept Alias Drift** — multiple aliases from a seeded concept group
  (`team`/`workspace`/`org`, `plan`/`tier`/`subscription`, etc.) appear
  across the product surface, each in ≥2 distinct directories.
- **Docs-Code Drift** — local links in `docs/**/*.md` (and root-level
  `*.md`) that do not resolve on disk.

Cross-file `related_files` is now populated by the IA detectors and
rendered as an "Also touches:" block in the human report. Long-form
reference (quorum rules, false-positive notes, suggested fixes):
[`docs/finding-types/ia.md`](./docs/finding-types/ia.md). IA detectors
phrase summaries as "appears to" / "may" — they are **ambiguity
signals**, not claims of semantic truth. No LLM, no API key, no network
access required to produce these findings.

Deferred from `0.3.0` (tracked for later versions — **do not document
them as shipped**):

- **Orphaned Destination** — pages / routes / screens unreachable from
  primary navigation.
- **Parallel Destination** — `/billing` vs `/settings/billing` vs
  `/account/subscription` for the same user intent.
- **Permission IA Drift** — nav, route guards, docs, and policy code
  describe access using different roles.
- **Action Label Drift** — "Delete" / "Remove" / "Archive" for the same
  operation across UI copy and code.
- **Command-drift variant of Docs-Code Drift** — docs that reference a
  CLI command the `bin` no longer implements.

Supporting work also deferred from `0.3.0`: per-finding scores
(`scores.churn` / `scores.test_gap` / `scores.blast_radius` —
**still deferred** as M2 work), `crimes explain`, `crimes ignore` +
`.crimes/suppressions.json`, `crimes init`, and `crimes diff --fail-on
new-high` (all four **shipped in `0.5.0`**).

## Shipped in `crimes@0.4.0`

**Theme: agent context quality and signal-to-noise.** `0.3.0` shipped
IA detectors that surface cross-file ambiguity. Live trials with Claude
Code and Codex CLI then surfaced a coupled pair of pain points: the
existing detectors fire too often on shapes they shouldn't (React
pages, route handlers, test callbacks), and even when they fire
correctly, `crimes context` doesn't tell agents what _else_ to read
before editing. `0.4.0` raises the trust ratio of every detector that
already shipped instead of adding more.

Shipped in `crimes@0.4.0`:

- **Neighbourhood `related_files` on `ContextReport`** — `crimes context`
  now lists up to ten files an agent should probably read before
  editing the target, ranked by a deterministic blend of IA-finding
  passthrough, shared path tokens, domain-prefix filename matches, and
  same-directory siblings. Each entry carries a `reason` and a `score`.
  Files already in `likely_tests` are excluded.
- **Monorepo / nested-package root detection for `crimes context`** —
  `crimes context examples/messy-ts-app/src/foo.ts` from the monorepo
  root now produces the same findings as `crimes context src/foo.ts`
  from inside `examples/messy-ts-app/`. Walks up to the nearest
  enclosing `package.json`; `--root` still wins when set explicitly.
- **Shape-aware `large_function`** — the detector now classifies each
  function as `domain` / `test_callback` / `react_component` /
  `page_export` / `route_handler` / `unknown` and applies per-shape
  thresholds (60 / 200@low / 200 / 200 / 100 / 80). 70-line `describe()`
  callbacks and 180-line React components no longer trip the detector.
  Evidence names the shape ("3.4× the domain function threshold (60
  lines)") so a reader can verify which budget applied.
- **`_test.ts` / `_spec.ts` likely-test discovery** — Go-style suffix
  conventions (`foo_test.ts`, `foo_spec.ts`) join the existing
  `.test.ts` / `.spec.ts` / `__tests__/` rules.
- **`docs_code_drift` GitHub-relative link allowlist** — `../../issues`,
  `../../pull/N`, `../../wiki/Home`, `../../blob/...`, and similar
  GitHub-rewritten paths are no longer flagged as broken local links.
  Real `../../docs/foo.md` paths still resolve normally.
- **`ScanReport.changed_files`** — `crimes scan --changed --format json`
  now includes a top-level array listing every file the resolver
  returned, sorted and deduplicated, _including_ files with zero
  findings (touched markdown, lockfiles, etc.). Absent on plain
  `crimes scan`.
- **`HotspotsReport.history_limited`** — `crimes hotspots` annotates
  shallow clones (`git rev-parse --is-shallow-repository`) so agents
  know not to over-weight rankings when commit history is truncated.
  Common in CI runners with `fetch-depth: 1`.
- **Top-level `agent_guidance` ordering in `ContextReport`** — JSON
  output places `agent_guidance` ahead of `findings` so agents read the
  actionable summary first. Same wording, new position in the canonical
  example.
- **Empty-field self-explanation** — `ContextReport.agent_guidance`,
  `related_files`, and `likely_tests` each gain an optional `*_reason`
  field set _only_ when the matching array is empty. Distinguishes "we
  searched and found nothing" from "we didn't search".

All additions are **additive and backwards-compatible** — no
`schema_version` bump, no required field changes, no CLI behaviour
regressions. The planning document
([`.planning/archive/0.4.0-agent-context-quality.md`](./.planning/archive/0.4.0-agent-context-quality.md))
covers the scope, risks, and rationale in full.

Deferred from `0.4.0` (tracked for later versions — **do not document
them as shipped**):

- **`crimes init` + `crimes.config.json`** — moved to `0.5.0` together
  with suppressions.
- **`crimes ignore <id>` + `.crimes/suppressions.json`** — moved to
  `0.5.0`. Fixing detector noise at source (this release) removes most
  of the demand for suppressions.
- **Per-finding `scores.churn` / `scores.test_gap` / `scores.blast_radius`** —
  M2 work; deferred.
- **More IA detectors** (`orphaned_destination`, `parallel_destination`,
  `permission_ia_drift`, `action_label_drift`, command-drift variant of
  `docs_code_drift`) — pre-empted by the "no more detectors before
  fixing noise" feedback; deferred.
- **`crimes diff --fail-on new-high`** — _shipped in `0.5.0`_.
- **`crimes ask` / LLM-assisted modes** — `v1+`.
- **Homebrew tap + standalone binaries** — deferred until the CLI
  surface stabilises further.

---

## Example output

Running `pnpm scan:example` against the bundled fixture produces something
like:

```
CRIME SCENE REPORT
repo: messy-ts-app  ·  5 findings

HIGH severity (1)
  1. src/billing.ts:37-240 (generateInvoice)
     Charge: God Function
     Summary: generateInvoice spans 204 lines — past the 60-line threshold...
     Evidence:
       · lines 37–240 (204 lines)
       · 3.4× the configured 60-line threshold
       · function declaration
     id=crime_00001  confidence=0.95
  ...

Total 20  ·  high 1  medium 13  low 6
```

JSON output is the **stable product API** — see
[`docs/json-schema.md`](./docs/json-schema.md) for the full schema and
[`docs/agent-usage.md`](./docs/agent-usage.md) for the pre-edit / post-edit
workflow.

---

## What it finds (today)

### Structural detectors (shipped in `0.1.0`)

| Detector            | Charge                | What it does                                                                    |
| ------------------- | --------------------- | ------------------------------------------------------------------------------- |
| `large_file`        | God File              | Flags files over a line threshold (default 300)                                 |
| `large_function`    | God Function          | Flags functions / methods / arrows over a body-line threshold (default 60)     |
| `todo_density`      | Unfinished Business   | Flags files with high density of `TODO` / `FIXME` / `XXX` / `HACK` markers      |
| `direct_date`       | Temporal Recklessness | Flags direct uses of `Date.now()` and `new Date()` in source files              |

### Petty crimes (shipped in `0.3.0`)

| Detector                        | Charge                   | What it does                                                                 |
| ------------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `commented_out_code`            | Commented-Out Corpse     | Flags disabled code left behind in comments                                  |
| `logic_in_comments`             | Logic in the Alibi       | Flags comments that appear to carry business rules not encoded nearby         |
| `name_behavior_mismatch`        | False Identity           | Flags safe-sounding function names whose bodies perform side effects          |
| `magic_domain_literal_scatter`  | String Sprinkles         | Flags repeated domain literals spread across production files                 |
| `weak_test_signal`              | Test That Proves Nothing | Flags tests with no assertions or only weak assertion signal                  |
| `option_bag_junk_drawer`        | Option Bag Junk Drawer   | Flags broad generic option bags with large implicit shapes                    |
| `return_shape_roulette`         | Return Shape Roulette    | Flags branchy functions returning divergent anonymous object shapes           |
| `negative_flag_maze`            | Negative Flag Maze       | Flags conditionals that combine multiple negative flags                       |

Petty crimes are small, evidence-backed maintainability irritants that make
future edits easier to misread. They are not style rules; anything best
handled by ESLint/Biome stays out of scope. See
[`docs/finding-types/petty.md`](./docs/finding-types/petty.md).

### Information architecture detectors (shipped in `0.3.0`)

| Detector                        | Charge                       | What it does                                                                                                                          |
| ------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `missing_agent_context`         | Missing Agent Context        | Repos with a `bin` in `package.json` but no `AGENTS.md`, no `CLAUDE.md`, no `.claude/skills/*/SKILL.md`, and no `.agents/skills/*/SKILL.md` |
| `route_metadata_drift`          | Route Metadata Drift         | Route path, file, default-export component, page title, metadata title, and nav-source labels disagree for the same destination       |
| `duplicated_navigation_source`  | Duplicated Navigation Source | The same internal destination appears in two or more nav-like sources with different non-empty labels                                 |
| `concept_alias_drift`           | Concept Alias Drift          | Multiple aliases from a seeded concept group (`team`/`workspace`/`org`, `plan`/`tier`/`subscription`, etc.) appear across the product surface |
| `docs_code_drift`               | Docs-Code Drift              | A markdown doc under `docs/` (or a root-level `*.md`) contains a local link that does not resolve to a file on disk                   |

IA crimes surface **deterministic evidence that the repo tells multiple
stories about the same product concept** — what something is called,
where it lives, which implementation owns it. No LLM, no API key, no
network access. See [`docs/finding-types/ia.md`](./docs/finding-types/ia.md)
for the long-form reference (quorum rules, false-positive notes, suggested
fixes) and the `related_files` field on every IA finding for the other
paths that contributed evidence.

### Correctness-risk detectors (shipped in `0.16.0`)

| Detector                 | Charge               | What it does                                                                                                  |
| ------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `swallowed_error`        | Catch and Release    | A failure caught and discarded, or turned into an ambiguous fallback — no rethrow, no record, no discrimination |
| `unsafe_retry`           | Double Jeopardy      | A retry around a potentially-mutating operation with no idempotency or deduplication key visible                |
| `unbounded_async_fanout` | Concurrency Stampede | `Promise.all` over a runtime-sized collection doing per-element I/O with no visible concurrency bound            |
| `mock_saturation`        | Mock Alibi           | A test that replaces every collaborator with a behaviourless double and asserts only on those doubles           |

These are file-local, so `crimes context <file>` reports them on a
single file. Long-form reference:
[`docs/finding-types/correctness.md`](./docs/finding-types/correctness.md).

### Cross-file authority detectors (shipped in `0.16.0`)

| Detector                   | Charge                 | What it does                                                                                             |
| -------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `duplicated_policy`        | Policy Doppelgänger    | The same business / authorization / pricing / state-transition rule implemented independently in ≥2 files  |
| `contract_drift`           | Contract Split-Brain   | Two declarations of one record that disagree — interfaces, type literals, Zod, and Valibot                 |
| `config_drift`             | Environment Roulette   | One environment variable parsed, defaulted, or required differently across call sites, or client-exposed   |
| `pass_through_abstraction` | Abstraction Laundering | A chain or cluster of wrapper functions that forward their arguments and add nothing                       |

All four read one cross-file index built in a single parse pass.
`duplicated_policy` gates on a narrow tier of business vocabulary, so
`items.length > 0` in fifty files is never a finding. Long-form
reference: [`docs/finding-types/authority.md`](./docs/finding-types/authority.md).

### Agent-hygiene detectors (shipped in `0.16.0`)

| Detector                    | Charge             | What it does                                                                                                    |
| --------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `dependency_provenance_gap` | Phantom Accomplice | An import with no declaring manifest, a manifest/lockfile disagreement, or a specifier that resolves differently between installs |
| `agent_permission_sprawl`   | Loaded Agent       | Repository-local agent settings, hooks, and MCP servers granting unrestricted execution or running fetched code   |

Both are strictly local. `dependency_provenance_gap` contacts no
registry and never claims a package is malicious, hallucinated, or
unknown — only that this repository cannot account for it.
`agent_permission_sprawl` never executes a hook it discovers, quotes
only the minimal fragment needed, and redacts anything token-shaped.
Prose directives in `AGENTS.md`-style files are reported as **advisory
only**, capped below the medium severity band. Long-form reference:
[`docs/finding-types/agent-hygiene.md`](./docs/finding-types/agent-hygiene.md).

Every finding includes **evidence** (raw facts the detector observed) and
**scores** (`severity`, `confidence`, `agent_risk`) so downstream tools can
rank or filter without re-running heuristics. From `0.16.0` the newer
detectors also render their **scoring arithmetic** into evidence —
`confidence 0.88 = 0.60 base + 0.12 (domain vocabulary: …) + 0.10
(spans 2 layers)` — so a number you disagree with is a number you can
argue with.

---

## Commands

### `crimes scan [path]`

Scan a directory. Defaults to the current directory.

```bash
crimes scan
crimes scan ./packages/api
crimes scan --format json
crimes scan --all          # show every finding, not just the top 10
crimes scan --no-color     # plain output for pipes/CI
```

#### Scoping a scan: `--files`, `--related-to`, `--changed`

Bare `crimes scan` audits the whole repository. Three flags narrow it to
a **working set** — the files you actually care about right now. They are
mutually exclusive, because a report whose scope you cannot infer from
the command that produced it is worse than no report.

```bash
# Name the files. Repo-relative or absolute, comma-separated or repeated.
crimes scan --files src/lib/api.ts,src/lib/types.ts
crimes scan --files src/lib/api.ts --files src/lib/types.ts

# Name one file and take its import-graph neighbourhood, both directions:
# what it imports (can break it) and what imports it (it can break).
crimes scan --related-to src/lib/api.ts
crimes scan --related-to src/lib/api.ts --related-depth 2
```

The resolved set comes back on the JSON report as `working_set.files`,
so you can confirm what was scanned rather than assuming. A path that
matched nothing is called out on **stderr** and in `coverage.warnings` —
a typo that silently narrows a scan to nothing would otherwise produce a
report reading "No crimes detected. Suspiciously clean."

Cross-file indexes are always built from the whole repository, so
`blast_radius` on a working-set scan is the blast radius of the file
within the repo, not within the set.

`--fail-on` works with any of the three.

#### `crimes scan --changed`

Scan only the files that have changed in the working tree (staged,
unstaged, and untracked). With `--base <ref>`, also include everything that
differs between `<ref>...HEAD`. This is the **post-edit** half of the
agent loop: make the change, then re-scan the files you touched.

Before you have written anything, on a clean tree, `--changed --base main`
correctly returns nothing — which is what `--files` and `--related-to`
are for.

```bash
crimes scan --changed                                   # working-tree changes vs HEAD
crimes scan --changed --base main                       # + commits on this branch
crimes scan --changed --base origin/main                # + commits not yet on origin
crimes scan --changed --format json
crimes scan --changed --fail-on high                    # CI gate — exit 1 on a new high
crimes scan --changed --fail-on medium --format json    # CI gate, with JSON output
```

Notes:

- Requires a Git repository. Run outside one and `crimes` exits with a clear
  "not a git repository" error on stderr (exit code 2).
- Deleted files are skipped — there is nothing on disk to scan.
- Only JS/TS source files are scanned; non-source files in the changed set
  (Markdown, JSON, lockfiles, etc.) are ignored via the configured
  `include` / `exclude` patterns.
- `--fail-on low|medium|high` is **only** valid in combination with
  `--changed`. Passing it on a plain `crimes scan` exits `2` (usage
  error). When set, the JSON output adds `fail_on` and `failed` at the
  top level; exit `1` means "at least one finding in the changed set
  meets the threshold", exit `0` means it doesn't. See
  [`docs/ci.md`](./docs/ci.md) for the full CI integration recipe.

### `crimes context <file>`

Inspect a single file. Returns the findings on that file, the test files
that look likely to cover it, and short safe-editing notes for an agent —
all deterministic, no LLM, no git history.

```bash
crimes context src/billing/tax.ts
crimes context src/billing/tax.ts --format json
crimes context src/billing/tax.ts --root ./packages/api  # explicit repo root
```

The JSON payload is the stable contract — agents should consume that:

```jsonc
{
  "schema_version": "0.1.0",
  "report_type": "context",
  "file": "src/billing.ts",
  "risk": { "level": "high", "high": 1, "medium": 1, "low": 1, "total": 3 },
  "findings": [ /* same Finding shape as `crimes scan` */ ],
  "likely_tests": ["src/billing.test.ts", "src/__tests__/billing.test.ts"],
  "agent_guidance": [
    "Prefer extracting pure helpers before adding more branches.",
    "Avoid adding more direct clock access; inject time where possible."
  ]
}
```

`likely_tests` is found by three deterministic conventions: same-basename
`.test.ts` / `.spec.ts` / `.test.tsx` / `.spec.tsx` siblings, files under
`__tests__/` matching the basename, and test files that import the target
via a relative path.

`agent_guidance` is a per-finding-type lookup — one line per detector that
fired, deduped. It is intentionally short and behavioural ("don't make this
worse"), not a fix recipe.

### `crimes hotspots [path]`

Rank files by **change risk** using Git history × current scan findings.
Default window is the last 90 days; pass `--since` to widen or narrow it.

```bash
crimes hotspots
crimes hotspots --since 30d
crimes hotspots --since 1y --format json
crimes hotspots --all                # show every file, not just the top 20
```

`--since` accepts the compact form `90d` / `2w` / `6m` / `1y`, or anything
`git log --since` understands (`"2 weeks ago"`, `"2026-01-01"`).

The risk score is a 0–1 blend of churn and findings:

```text
risk = 0.6 × min(change_count / 20, 1)
     + 0.4 × { high: 1.0, medium: 0.6, low: 0.3, none: 0 }[highest_severity]
```

Churn saturates at 20 commits in the window — beyond that, severity is the
only signal that moves the score.

In a **non-git directory**, `git_available` is `false`, `change_count` is `0`
for every row, and risk collapses to the severity component alone (max `0.4`).
The command still succeeds — it just produces a degraded ranking.

JSON output is the stable contract:

```jsonc
{
  "schema_version": "0.2.0",
  "report_type": "hotspots",
  "repo": { "name": "messy-ts-app", "root": "/path/to/repo" },
  "since": "90d",
  "git_available": true,
  "total_files": 42,
  "shown_count": 20,
  "hidden_count": 22,
  "hotspots": [
    {
      "file": "src/billing.ts",
      "change_count": 14,
      "latest_change": "2026-05-12T14:30:00+00:00",
      "finding_count": 3,
      "highest_severity": "high",
      "risk": 0.82
    }
  ]
}
```

`crimes hotspots --format json` is capped to the top 20 rows by
default, matching the human report. Pass `--all --format json` when
you need every file.

### `crimes diff <base...head>`

Report **new**, **fixed**, and **unchanged** crimes between two Git refs.
The range must be the triple-dot form (`<base>...<head>`); the typical
inputs are `main...HEAD` locally or `origin/main...HEAD` in CI.

```bash
crimes diff main...HEAD
crimes diff origin/main...HEAD --format json
crimes diff v0.1.0...HEAD --no-color
```

`crimes diff` is **working-tree-safe** — it exports each ref into a fresh
temporary directory via `git archive` and scans it there. The working
tree is never checked out, stashed, or otherwise mutated.

Concise human output:

```
CRIMES DIFF
base: main
head: HEAD

New crimes: 2
Fixed crimes: 1
Unchanged crimes: 8
```

The JSON output is the stable contract:

```jsonc
{
  "schema_version": "0.1.0",
  "report_type": "diff",
  "repo": { "name": "crimes", "root": "/path/to/repo" },
  "base": "main",
  "head": "HEAD",
  "summary": { "new": 2, "fixed": 1, "unchanged": 8 },
  "new_findings": [ /* same Finding shape as crimes scan */ ],
  "fixed_findings": [ /* ... */ ],
  "unchanged_findings": [ /* ... */ ]
}
```

Findings are matched across refs by a **stable fingerprint** —
`<type>::<file>::<symbol-or-empty>` — not by the per-scan `id`. Small line
shifts from unrelated edits do not register as fix + new; a function that
moves from lines 37–240 to 42–246 stays `unchanged`. See
[`docs/json-schema.md`](./docs/json-schema.md#diffreport-output-of-crimes-diff-basehead)
for the full schema, fingerprint design, and known limitations (e.g. file
renames register as a fix + new pair).

Advisory by default — pass `--fail-on new-high | new-medium` (shipped
in `0.5.0`) to opt into a hard gate, or gate on JSON, or use
`crimes verdict --fail-on new-high` / `crimes scan --changed --fail-on
high` / `crimes baseline check` for the equivalent CI gate:

```bash
crimes diff origin/main...HEAD --format json \
  | jq -e '.summary.new == 0' >/dev/null
```

### `crimes baseline`

Pin pre-existing findings so CI only fails on **new** crimes. The intended
adoption path for legacy repos: `crimes baseline save` once, commit
`.crimes/baseline.json`, then run `crimes baseline check` in CI on every
PR. New high-severity findings introduced by the branch fail the build;
the legacy debt stays out of the way.

```bash
# 1. Snapshot the current state. Run this once when adopting `crimes`.
crimes baseline save

# 2. Commit `.crimes/baseline.json` to the repo.
git add .crimes/baseline.json && git commit -m "Add crimes baseline"

# 3. Run on every PR. Exit 0 = no regression, exit 1 = blocking new findings.
crimes baseline check
crimes baseline check --fail-on high          # ignore new medium/low findings
crimes baseline check --format json           # the stable contract
```

Shape of `.crimes/baseline.json` (always carries `schema_version` and
`report_type: "baseline"`):

```jsonc
{
  "schema_version": "0.1.0",
  "report_type": "baseline",
  "created_at": "2026-05-16T12:00:00.000Z",
  "crimes_version": "0.3.0",
  "summary": { "total": 5, "high": 1, "medium": 3, "low": 1 },
  "findings": [
    {
      "fingerprint": "large_function::src/billing.ts::generateInvoice",
      "type": "large_function",
      "charge": "God Function",
      "severity": "high",
      "file": "src/billing.ts",
      "symbol": "generateInvoice"
    }
    // ...
  ],
  "repo": { "name": "messy-ts-app", "root": "/abs/path/to/repo" }
}
```

`crimes baseline check` re-scans the repo, matches findings against the
saved baseline by stable fingerprint (`<type>::<file>::<symbol-or-empty>`,
the same identity `crimes diff` uses), and emits a `BaselineCheckReport`:

```jsonc
{
  "schema_version": "0.1.0",
  "report_type": "baseline_check",
  "repo": { "name": "messy-ts-app", "root": "/abs/path/to/repo" },
  "baseline_path": "/abs/path/to/repo/.crimes/baseline.json",
  "fail_on": "medium",
  "failed": false,
  "summary": {
    "total_baseline": 5,
    "total_current": 5,
    "new": 0,
    "fixed": 0,
    "unchanged": 5,
    "new_by_severity": { "high": 0, "medium": 0, "low": 0 }
  },
  "new_findings": [],
  "fixed_findings": [],
  "unchanged_findings": [ /* same Finding shape as crimes scan */ ]
}
```

Exit codes:

| Exit | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| `0`  | No new findings at or above `--fail-on` — branch is clean against baseline.   |
| `1`  | At least one new finding at or above `--fail-on` — the CI gate.               |
| `2`  | Missing or malformed baseline, bad `--format` / `--fail-on` flag.             |

Full schema, fingerprint semantics, and known limitations:
[`docs/json-schema.md`](./docs/json-schema.md#baseline-on-disk-shape-of-crimesbaselinejson).

### `crimes verdict`

Branch-level "did this branch make the repo cleaner, worse, unchanged, or
mixed?" summary. Built on top of `crimes diff` — same archive-into-temp
machinery, same fingerprint-based matching, same working-tree-safe
guarantees — with a single headline verdict layered on top.

```bash
crimes verdict                                # default base: origin/main → main
crimes verdict --base main                    # override base
crimes verdict --format json                  # the stable contract
crimes verdict --fail-on worse                # exit 1 when verdict is worse
crimes verdict --fail-on new-high             # exit 1 on any new high finding
crimes verdict --fail-on new-medium           # exit 1 on any new medium or high
```

Concise human output:

```
CRIMES VERDICT
base: origin/main
head: HEAD

Verdict: WORSE
New: 2
Fixed: 1
Reason: introduced 1 high-severity crime
Recommended next action: fix new high-severity findings before merging.
```

JSON output is the stable contract:

```jsonc
{
  "schema_version": "0.1.0",
  "report_type": "verdict",
  "repo": { "name": "crimes", "root": "/path/to/repo" },
  "base": "origin/main",
  "head": "HEAD",
  "verdict": "worse",
  "summary": {
    "new": 2, "fixed": 1, "unchanged": 8,
    "new_by_severity":   { "high": 1, "medium": 1, "low": 0 },
    "fixed_by_severity": { "high": 0, "medium": 1, "low": 0 },
    "new_weighted": 5,
    "fixed_weighted": 2
  },
  "reasons": ["introduced 1 high-severity crime"],
  "recommended_actions": ["fix new high-severity findings before merging."],
  "new_findings":   [ /* same Finding shape as crimes scan */ ],
  "fixed_findings": [ /* ... */ ]
}
```

Judgement logic (deterministic, no LLM):

- **unchanged** — no new and no fixed findings.
- **worse** — any new high finding, OR new weighted severity > fixed
  weighted severity.
- **cleaner** — fixed weighted severity > new weighted severity AND no
  new high findings.
- **mixed** — both sides non-zero with equal weighted severity.

Severity weights are `high = 3`, `medium = 2`, `low = 1`. Treat the
verdict as an ordinal signal — the weights may change between minor
releases (same contract as the per-finding `scores.*` fields).

Exit codes:

| Exit | When                                                                                |
| ---- | ----------------------------------------------------------------------------------- |
| `0`  | Default — `crimes verdict` is advisory regardless of verdict.                       |
| `0`  | With `--fail-on`, threshold not hit.                                                |
| `1`  | With `--fail-on worse` and `verdict === "worse"`.                                   |
| `1`  | With `--fail-on new-high` and any new finding has `severity: "high"`.               |
| `1`  | With `--fail-on new-medium` and any new finding has `severity: "medium"` or `"high"`. |
| `2`  | Usage / environment error — not a git repo, no resolvable default base, bad flag.   |

Full schema: [`docs/json-schema.md`](./docs/json-schema.md#verdictreport-output-of-crimes-verdict).

More commands land in later milestones — see [`PRD.md` §22](./PRD.md) and
[`docs/roadmap.md`](./docs/roadmap.md).

---

## CI

`crimes` is designed to run in CI. Three gating modes are supported, all
deterministic and JSON-first:

| Mode                 | Command                                                       | When to use                                                                       |
| -------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Changed-files gate   | `crimes scan --changed --fail-on high`                        | Repo already clean, or you only want to gate the diff itself.                     |
| Baseline gate        | `crimes baseline check --fail-on medium`                      | Legacy repo — snapshot `.crimes/baseline.json`, then fail only on **new** debt.   |
| Branch verdict gate  | `crimes verdict --base origin/main --fail-on new-high`        | PR summary signal that flips to a hard gate on any new high finding.              |

A copy-paste GitHub Actions workflow lives at
[`examples/github-actions/crimes.yml`](./examples/github-actions/crimes.yml).
The full integration guide — gating semantics, exit codes, known limits —
is in [`docs/ci.md`](./docs/ci.md).

Exit codes for every gating command are uniform:

| Exit | Meaning                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| `0`  | Command succeeded; no blocking findings under the configured `--fail-on`.    |
| `1`  | The configured `--fail-on` threshold was met. Treat as a CI gate failure.    |
| `2`  | Usage / environment error — bad flag, missing baseline, not a git repo, etc. |

Without `--fail-on`, `crimes scan`, `crimes diff`, and `crimes verdict`
are **advisory** — always exit `0`, regardless of findings.

---

## Configuration

Zero-config is the default. Drop a `crimes.config.json` at the repo root to override:

```json
{
  "include": ["src/**/*.{ts,tsx,js,jsx}"],
  "exclude": ["**/node_modules/**", "**/dist/**", "**/*.generated.*"],
  "thresholds": {
    "largeFileLines": 300,
    "largeFunctionLines": 60,
    "todoDensityPerKLoc": 10
  }
}
```

---

## Using `crimes` with coding agents

> ### Run this once, in every repo you want an agent to use `crimes` in:
>
> ```bash
> npx crimes init --agents
> ```
>
> It writes `crimes.config.json` plus a skill for Claude Code and Codex,
> so the agent **finds `crimes` on its own** and knows which command to
> reach for. Without it, an agent told "run crimes" has to guess.
>
> That guessing is measured, not hypothetical. A field report from
> 2026-08-05 records **four steps to first run**: searching
> `~/.claude/skills`, then `~/.claude/commands`, then `~/.claude/plugins`,
> then a filesystem find that turned up an unrelated directory, then
> `which crimes` (nothing), before finally guessing `npx crimes@latest`.

`crimes` ships with on-disk artefacts that AI coding agents pick up
automatically. **There is nothing to install into a prompt** — point your
agent at the repo and it loads them itself.

| Agent                                            | What it reads                              |
| ------------------------------------------------ | ------------------------------------------ |
| Claude Code                                      | [`.claude/skills/crimes/SKILL.md`](./.claude/skills/crimes/SKILL.md) (+ `AGENTS.md`) |
| Codex CLI                                        | `.agents/skills/crimes/SKILL.md` (+ `AGENTS.md`) |
| Cursor, Aider, Continue, Copilot Workspace       | [`AGENTS.md`](./AGENTS.md)            |
| Anything else                                    | [`docs/agent-usage.md`](./docs/agent-usage.md) — drop the workflow into your own rules file |

### Scope the scan to the work — this is the whole trick

Bare `crimes scan` audits the whole repository. That is a real thing to
want and it is almost never what you want mid-task: on a 200-file
project it returns roughly 500 findings, which is not a work list. For
an agent it is an invitation to over-fix into unrelated files or to
dismiss the tool.

Name the working set instead:

```bash
# You know which files the change touches.
crimes scan --files src/lib/api.ts,src/lib/types.ts --format json

# You know one file and want its neighbourhood — the import graph,
# walked both ways, because both directions can break.
crimes scan --related-to src/lib/api.ts --format json

# You have already made the edits.
crimes scan --changed --base main --format json
```

`--changed` is the **post-edit** selector: on a clean tree it correctly
returns nothing, which is why the other two exist. `--fail-on` works
with all three, and the resolved set comes back as `working_set.files`
so you can check what was actually scanned.

The recommended loop is the same for every agent:

```bash
# 1. Planning — scope to the files the change will touch
crimes scan --files a.ts,b.ts --format json
crimes scan --related-to src/lib/thing.ts --format json

# 2. Before editing one file — a structured per-file briefing
crimes context <file> --format json

# 3. Make your change

# 4. After editing — re-scan only what you touched
crimes scan --changed --format json

# 5. For a wider triage — rank the whole repo by change-risk
crimes hotspots --format json
```

Decision rule: any **new `severity: "high"` finding** introduced by your
edit should be treated as a blocker — fix it, or call it out explicitly to
the user citing the finding `id` and `charge`.

The JSON output is a stable contract:

```jsonc
{
  "schema_version": "0.1.0",
  "report_type": "scan",
  "repo": { "name": "messy-ts-app", "root": "/path/to/crimes/examples/messy-ts-app" },
  "summary": { "total": 5, "high": 1, "medium": 3, "low": 1 },
  "findings": [
    {
      "id": "crime_00001",
      "type": "large_function",
      "charge": "God Function",
      "severity": "high",
      "confidence": 0.95,
      "file": "src/billing.ts",
      "symbol": "generateInvoice",
      "lines": [50, 253],
      "summary": "generateInvoice spans 204 lines — past the 60-line threshold...",
      "evidence": ["lines 50–253 (204 lines)", "3.4× the configured 60-line threshold", "function declaration"],
      "scores": { "severity": 0.9, "confidence": 0.95, "agent_risk": 0.95 },
      "suggested_actions": [{ "kind": "extract_function", "description": "...", "risk": "low" }]
    }
  ]
}
```

For the full schema and the complete pre/post-edit workflow:

- 📄 [`docs/json-schema.md`](./docs/json-schema.md) — every field, what it means, what's reserved
- 🤖 [`docs/agent-usage.md`](./docs/agent-usage.md) — pre-edit/post-edit workflow, how to read findings, what's shipped vs deferred
- 🧰 [`docs/skills.md`](./docs/skills.md) — what's bundled for Claude Code, Codex, and friends
- 🧪 [`docs/fixtures/messy-ts-app.json`](./docs/fixtures/messy-ts-app.json) — full example output

---

## Repository layout

```
crimes/
├── apps/
│   └── website/              # crimes.sh — static HTML/CSS, deployed via Vercel
├── packages/
│   ├── cli/                  # crimes — Commander entrypoint, `crimes` binary (the published package)
│   ├── core/                 # @crimes/core — detector engine, finding schema, built-in detectors
│   ├── language-js/          # @crimes/language-js — file discovery + TS/JS AST parsing
│   └── reporter/             # @crimes/reporter — human and JSON output formats
├── examples/
│   └── messy-ts-app/         # intentionally crime-ridden fixture
├── .claude/skills/crimes/    # Claude Code skill
├── .agents/skills/crimes/    # Codex skill (generated by crimes init --agents)
├── .github/workflows/        # ci.yml + release.yml (npm Trusted Publishing)
├── docs/                     # agent-usage, json-schema, skills, releasing
├── AGENTS.md                 # repo-level instructions for coding agents
├── PRD.md                    # product requirements document
├── docs/roadmap.md           # what currently ships vs what is planned
├── README.md
├── CONTRIBUTING.md
├── LICENSE                   # MIT
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

---

## Development

```bash
git clone https://github.com/ortomate/crimes.git
cd crimes
pnpm install                  # install everything
pnpm build                    # build all packages (tsup)
pnpm typecheck                # tsc --noEmit across the workspace
pnpm test                     # vitest run across the workspace
pnpm scan:example             # build CLI + run it on the fixture
pnpm scan:example:json        # same, as JSON
pnpm --filter crimes smoke    # publish-tarball smoke test (pack → install → run)
```

Build a single package:

```bash
pnpm --filter @crimes/core build
```

The `smoke` script is the canonical "does the published package actually
work" check. It does an `npm pack`, installs the resulting tarball into a
clean temp directory with `npm install`, and runs `--version`, `--help`,
`scan`, `scan --format json`, `context`, and `hotspots` against
`examples/messy-ts-app`. CI runs it on every commit as the
`publish-smoke` job.

---

## Releasing

Releases are automated. Publishing a GitHub Release is the trigger; a bare
git tag is not.

1. Land a `Prep crimes@X.Y.Z` commit on `main` (version bump plus every
   mirrored surface).
2. Create a GitHub Release with tag `vX.Y.Z` and publish it.
3. [`.github/workflows/release.yml`](./.github/workflows/release.yml)
   publishes to npm via [Trusted Publishing](https://docs.npmjs.com/trusted-publishers).
   No `NPM_TOKEN` required.
4. Vercel auto-deploys [crimes.sh](https://crimes.sh) from `main`.

The full procedure, the prep-commit checklist, what an agent may and may
not do, and rollback: [`docs/releasing.md`](./docs/releasing.md).

---

## Roadmap (short version)

- **M0 — Repo foundation** ✅ (`0.1.0`)
- **M1 — First working CLI** ✅ (`0.1.0`) — `crimes scan` with the structural-detector slice
- **M2 — Risk model** — `crimes hotspots` ✅ (`0.1.0`), `HotspotsReport.history_limited` shallow-clone awareness ✅ (`0.4.0`); per-finding `scores.churn` / `test_gap` / `blast_radius` still deferred (M2 work; tracked for a future minor)
- **M3 — Agent context** — `crimes context <file>` ✅, `AGENTS.md` ✅, Claude skill ✅ (`0.1.0`); cross-file `related_files` ✅ on IA findings (`0.3.0`); deterministic neighbourhood `related_files` + monorepo-root auto-detection + shape-aware `large_function` ✅ (`0.4.0`)
- **M4 — Diff and CI** — `crimes scan --changed` ✅ (`0.1.0`), `crimes scan --changed --fail-on` ✅ (`0.2.0`), `crimes diff <base...head>` ✅ (`0.2.0`), `crimes baseline save` / `crimes baseline check` ✅ (`0.2.0`), `crimes verdict` ✅ (`0.2.0`), [`docs/ci.md`](./docs/ci.md) + [GitHub Actions example](./examples/github-actions/crimes.yml) ✅ (`0.2.0`), `crimes diff --fail-on new-high | new-medium` ✅ (`0.5.0`), per-finding `crimes ignore` + `.crimes/suppressions.json` ✅ (`0.5.0`), `crimes unignore` + `crimes audit-suppressions` ✅ (`0.5.0`)
- **M5 — Public launch** — npm ✅, [crimes.sh](https://crimes.sh) ✅ (`0.1.0`); full docs site planned
- **M6 — Homebrew / standalone binaries** — deferred

Full detail: [`PRD.md`](./PRD.md). Live status: [`docs/roadmap.md`](./docs/roadmap.md).

---

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Issues and PRs welcome on
[github.com/ortomate/crimes](https://github.com/ortomate/crimes).

---

## License

[MIT](./LICENSE). Use it freely.
