# crimes

> A crime scene investigator for your codebase. **Built for agents, readable by humans.**

[![npm version](https://img.shields.io/npm/v/crimes.svg)](https://www.npmjs.com/package/crimes)
[![license](https://img.shields.io/npm/l/crimes.svg)](https://github.com/ortomate/crimes/blob/main/LICENSE)

`crimes` is an open-source CLI that scans a repository for maintainability
risks, code smells, duplicated business rules, weak test boundaries,
information-architecture drift, and patterns that confuse AI coding
agents.

It is **not** another linter. It answers a higher-value question:

> _Where in this repo is future change most likely to go wrong, and what
> should a human or coding agent know before editing it?_

**`0.23.0` headline:** `agent_risk` is what makes `crimes` more than a
linter, and its heaviest term is the detector's own judgement about how
badly a finding will mislead an agent — **28 of 70 detectors were not
making one**. They were not scored as unknown either: the fallback
`0.30` sits *below all 29 expressed agent-signal bases* (0.35–0.80), so
`contract_drift`, `swallowed_error`, `duplicated_policy` and
`permission_ia_drift` ranked beneath the tool's own most lenient charge.
The constant meant to prevent exactly that was fitted to a band that
does not exist: rebuilding `ce0ccab` and scanning the tree its comment
cites, the agent-signal population starts at **0.12**, not 0.31, every
quoted figure is a per-type *maximum*, and `contract_drift` — the type
the comment says a `large_file` must not outrank — fires **zero times**
on that tree. All 28 now carry a declared intrinsic in one table, each
anchored to a named expressed peer, with a gate that reads the detector
sources so it cannot re-accumulate. No finding is added or removed on
the corpus; where heads move, over-concentration falls (hono's top-20
lift 6.00 → 2.80). `schema_version` stays `0.7.0`.

**`0.22.0` headline:** the remediation queue carried since `0.18.0`,
closed — seven entries, every one reproduced before it was touched, and
**four of the seven turned out to be wrong about themselves**.
Fingerprint collisions are gone: four detectors could emit more than
one finding per `(type, file, symbol)` with no way to tell them apart,
so `crimes ignore` on one silenced its neighbours. Zero collisions now
on n8n `packages/cli`, zulip and airflow, down from 4, 39 and 184 — and
**only ambiguous fingerprints move**, so a pin on a finding whose
symbol is unique in its file is untouched. The queue said those
collisions were `weak_test_signal`; zero of zulip's and zero of
airflow's are. `coverage.warnings[]` now reports a JavaScript syntax
error, which the entry said had no public API to read (it has one,
costing 1262 ms → 1330 ms over n8n's 2,977 files). `large_file` still
counts blank lines — implemented, measured at 3–9% for code rather
than the queue's 15–25%, and reverted because dropping them silences
the bundled fixture's own finding. `schema_version` stays `0.7.0`.

**`0.21.0` headline:** a precision release — four detectors named in an
outside field report as producing false positives, all re-verified and
measured on real repositories before and after. **Three of the four
fixes are not the fix the report asked for**, because the suggested
rules did not survive contact with the files that prompted them.
`logic_in_comments` matched domain terms as substrings (`auth` from
"Authored", `utc` from "outcome") — now whole-word, 10 → 7 on the
reporting repo. `direct_date` now says which readings decide a branch
and which only record one, and caps a record-only file at `medium`;
nothing is hidden, because the report's own example turned out to
contain two real poll timeouts. `high_fan_in_fan_out` stops promoting a
module whose importers are ≥80% `import type` — the coupling is
compile-time. `name_behavior_mismatch` stops charging a `get*` function
for constructing the client it reads through, 19 → 7. **Nothing became
a filter**: every change is evidence or severity. `schema_version` stays
`0.7.0` and no fingerprints move.

**`0.20.0` headline:** the agent workflow becomes the documented
default. `crimes scan` gains a **working set**: `--files a.ts,b.ts`
names it directly, `--related-to <file>` takes a file plus its
import-graph neighbourhood (walked both ways — what it imports and what
imports it), and `--related-depth` widens the walk. `--fail-on` now
works with any of the three selectors rather than only with `--changed`.
The resolved set comes back as `working_set.files` so an agent can
confirm what was scanned, and a path that matched nothing says so on
stderr instead of producing a report that reads "Suspiciously clean".

`--changed` is now documented as the **post-edit** selector: on a clean
tree it correctly returns nothing, which is exactly the moment most
agent tasks start — and why the other two exist.

**The headline number now counts what the report shows.** It used to
announce 491 findings above a body listing 339, because the other 152
were already classified non-domain (`scripts/**` and friends) and
collapsed into a footer. The remainder is still stated as
`+152 in non-domain paths`, and `summary.total` in the JSON is
unchanged. The totals are also repeated just above the closing line, so
a long report no longer needs a second run at `--top 3` just to read
them.

`schema_version` `0.6.0` → `0.7.0` (additive: `ScanReport.working_set`,
plus a `working_set_path_unmatched` coverage-warning kind). No
fingerprints change, so baselines, suppressions and triage files carry
over untouched.

**`0.19.0` headline:** the backlog release — the largest span the
project has published. 50 commits, ~30 defect fixes, four features, and
two `schema_version` bumps (`0.4.0` → **`0.6.0`**). `0.18.0`–`0.18.4`
were internal eval-baseline markers and were never published, so
everything they carried lands here.

**Installing is clean again.** npm ≥ 11.18 blocks install scripts by
default, so the only crimes-specific output on a fresh install was a
security warning asking you to approve arbitrary code execution — for a
seven-line banner npm swallowed anyway. The postinstall script is gone.

**Two JSON migrations.** `0.5.0` renamed
`scores.blast_radius_importers` → `blast_radius_transitive_importers`
and added `blast_radius_direct_importers` (the old name promised "N
files import this" and delivered the transitive closure — on `hono`,
5 vs 240 on the same file). `0.6.0` adds a required `fingerprint` to
every finding, the handle `crimes ignore` / `unignore` / `feedback` /
`triage` all accept. **Pinned entries for twelve more detectors need
re-recording**; `crimes feedback recheck` surfaces them.

Measured on real repositories: `commented_out_code` on airflow **8,019
→ 45** (7,320 were the Apache licence header), `parallel_destination`
on n8n's editor-ui **2,819 → 0** (first detector to ship gated off),
`pass_through_abstraction`'s fabricated 0.98-confidence chains **7 →
0**, airflow's claimed-silent Python tests **−27.1%** via a repo-wide
symbol index. `agent_risk` stops being a length ranking; `blast_radius`
moves to a log scale; whole-repo findings get their own section in the
human view.

**`0.17.0` headline:** calibration, and the first wire-format change —
`schema_version` `0.3.0` → `0.4.0`. `Finding` gains an optional
`discriminator` that `fingerprintFinding` folds in, so the three
detectors that can report several findings per file
(`magic_domain_literal_scatter`, `exact_duplicate_block`,
`near_duplicate_block`) stop sharing one fingerprint — before this,
`crimes ignore` on one of them silently suppressed the others. **Pinned
baseline / suppression entries for those three types need
re-recording**; every other type is unchanged. `large_file` gains a
`docs` shape so prose gets a 1000-line budget at `low`/`medium` instead
of the 300-line domain budget. The scan's index builders no longer open
every candidate file at once, and `exact_duplicate_block` evidence is
now reproducible run-to-run.

**`0.16.0` headline:** correctness and authority — ten detectors for the
crimes that only show up *between* files. The same business rule
implemented twice and now divergent (`duplicated_policy`), two
declarations of one record that disagree (`contract_drift`), an
environment variable read past the config boundary or leaked to a client
bundle (`config_drift`), a retry wrapped around a mutating call with no
idempotency key (`unsafe_retry`), a `Promise.all` over a runtime-sized
collection doing per-element I/O (`unbounded_async_fanout`), a failure
caught and discarded with no record (`swallowed_error`), and a test
whose collaborators are all behaviourless doubles it then asserts on
(`mock_saturation`). Plus agent hygiene: imports with no declaring
manifest (`dependency_provenance_gap`, entirely local — it never
contacts a registry) and repo-local agent config granting unrestricted
execution (`agent_permission_sprawl`, read as text, never executed).
`schema_version` was unchanged at `0.3.0` in that release; existing
baselines, suppressions, and triage files were unaffected.

**`0.15.0` headline:** polyglot IA + monorepo coverage — findings no
single-language tool can produce. Three cross-language detectors report
disagreements *between* Python and TypeScript: a frontend calling a
path the backend doesn't serve (`cross_language_route_drift`), a Python
`Enum` and a TS string-literal union that have diverged
(`cross_language_type_drift`), and the same concept called `team` on
one side and `workspace` on the other
(`cross_language_concept_alias_drift`). Every file is individually
correct and every type checker passes; the system is still broken.
`coverage.by_package` says which package in a mixed monorepo is the
Python one. Single-language repos are unaffected — all three return
early unless two languages are present.
**`0.14.0` headline:** the Python language pack. `crimes scan` now
parses `.py` / `.pyi` and reports Python findings alongside JavaScript
ones in one report — `packs_loaded: ["universal", "language-js",
"language-py"]`. Eight Python detectors ship, written to the language
rather than ported: `direct_date.py` charges naive datetimes,
`circular_dependency.py` explains an `ImportError` at startup, and
`sync_io_in_hotpath.py` escalates inside `async def`, where a blocking
call stalls the whole event loop. **No Python runtime is needed at
install or scan time** — parsing goes through a vendored WebAssembly
grammar, with no native code and no install scripts, and nothing loads
at all in a repo with no Python. Two scoring fixes came with it:
`test_gap` now understands the `test_*.py` prefix convention (Python
files previously all scored "no test at all"), and `blast_radius` is
computed from a real Python import graph rather than being `0`.
**`0.13.0` headline:** the ranking release. `agent_risk` — the score
that separates "this file is long" from "an agent will get this wrong"
— had collapsed into `severity` (correlation 0.79) while ignoring
`blast_radius` (0.06). It now leads with the detector's own
agent-risk judgement, which 30 of 48 detectors were computing and
having discarded on every scan. `test_gap` no longer fires on markdown
and JSON, which had been pushing documentation to the top of scans.
Expect rankings to move; fingerprints are unchanged so baselines,
suppressions and triage carry over. `crimes triage` now records
calibration feedback automatically, and `--explain-coverage` breaks
universal-only files down by extension so you can see which language
pack would buy the most coverage. **`0.12.0` headline:** the universal
pack — `crimes scan` produces real findings on Python, Go, Rust or any
non-JS repo without an AST, plus a coverage banner explaining the gap.
**`0.11.1` headline:** first calibration patch on `0.11.0`: compact
hook output for pre-edit briefings, capped `hotspots --format json`
with hidden counts, scan headers that show severity buckets up front,
and clearer agent-discovery help. **`0.11.0` headline:** `crimes triage` is the new recommended
front door for handling existing findings — interactive per-finding
walk over the current scan, persisting dispositions (`fix-now`,
`fix-this-PR`, `needs-design`, `wont-fix`, `scaffolding`) to
`.crimes/triage.json`. Silenced triage entries and baseline entries
now **resurface automatically** in `crimes scan` when their file is
in the branch diff against `main`, so a one-time decision doesn't
become permanent amnesia. `crimes init --agents` ships a Claude
Code `PreToolUse` Edit hook so the pre-edit briefing happens
without the agent having to remember to call `crimes context`. Two
new required `Finding` fields — `effort` and `fix_shape` — bump
`schema_version` to `"0.2.0"`; the loader still accepts `"0.1.0"`
on committed `.crimes/` state files. Secondary scores read as prose
(`blast top-quartile (11 importers)` instead of `0.72`); JSON
numerics are unchanged. Still deterministic, still no LLM / API
key / network required. `crimes@0.10.0` shipped the front-door
redesign (auto-init, lead-with-`context`); `crimes@0.9.2` shipped
emoji severity glyphs and the move to `ortomate/crimes`. See the
[root README](https://github.com/ortomate/crimes#status--crimes0111)
for the full version history.

- Website: **[crimes.sh](https://crimes.sh)**
- Repo: **[github.com/ortomate/crimes](https://github.com/ortomate/crimes)**

---

## Install

Requires Node.js ≥ 18.

```bash
npm install -g crimes
crimes scan .

# Or one-shot via npx
npx crimes scan .
```

`pnpm dlx crimes scan` and `bunx crimes scan` also work.

---

## What it does

Run `crimes` against any TypeScript / JavaScript / Python repository:

```bash
# Per-file / per-directory
crimes scan .                                   # default top-10 findings
crimes scan . --format json                     # stable JSON contract
crimes scan . --all                             # every finding

# Scope to a working set — usually what you want mid-task
crimes scan --files a.ts,b.ts --format json     # the files your change touches
crimes scan --related-to src/lib/api.ts         # …and its import-graph neighbours

crimes scan --changed --format json             # working-tree changes only
crimes scan --changed --base main --format json # + commits on this branch
crimes scan --changed --fail-on high            # CI gate — exit 1 on a new high

crimes context src/billing.ts --format json     # per-file pre-edit briefing
crimes hotspots --since 90d --format json       # git churn × findings ranking

# Branch / PR safety
crimes diff main...HEAD --format json           # new / fixed / unchanged crimes
crimes baseline save                            # snapshot pre-existing findings
crimes baseline check --fail-on medium          # fail CI only on new debt
crimes verdict --base origin/main --fail-on new-high  # branch-level gate
```

The JSON output is the **stable product API** (`schema_version: "0.3.0"`).
Every report carries a `report_type` discriminator (`"scan"`, `"context"`,
`"hotspots"`, `"diff"`, `"baseline"`, `"baseline_check"`, `"verdict"`).
Agents should consume it directly.

Uniform exit-code contract across all gating commands: `0` success,
`1` configured `--fail-on` threshold met, `2` usage / environment
error. See [`docs/ci.md`](https://github.com/ortomate/crimes/blob/main/docs/ci.md)
for the three recommended CI modes and a copy-paste GitHub Actions
workflow.

---

## Detectors in this release

### Structural detectors (since `0.1.0`)

| Detector            | Charge                | What it flags                                                              |
| ------------------- | --------------------- | -------------------------------------------------------------------------- |
| `large_function`    | God Function          | Functions / methods / arrows over a body-line threshold (default 60)        |
| `large_file`        | God File              | Files over a line threshold (default 300)                                  |
| `todo_density`      | Unfinished Business   | High density of `TODO` / `FIXME` / `XXX` / `HACK` markers                   |
| `direct_date`       | Temporal Recklessness | Direct uses of `Date.now()` and `new Date()` in source files                |

### Information architecture detectors (new in `0.3.0`)

| Detector                        | Charge                       | What it flags                                                                                                                       |
| ------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `missing_agent_context`         | Missing Agent Context        | Repo declares a `bin` but ships no `AGENTS.md` / `CLAUDE.md` / `.claude/skills/*/SKILL.md`                                            |
| `route_metadata_drift`          | Route Metadata Drift         | Route path, file, default-export component, `<title>`, `metadata.title`, and nav labels describe the same destination differently   |
| `duplicated_navigation_source`  | Duplicated Navigation Source | One internal destination appears in ≥2 nav-like sources with different non-empty labels                                              |
| `concept_alias_drift`           | Concept Alias Drift          | Multiple aliases from a seeded concept group (`team`/`workspace`/`org`, `plan`/`subscription`/`tier`, …) share the product surface  |
| `docs_code_drift`               | Docs-Code Drift              | A markdown doc under `docs/` (or root-level `*.md`) contains a local link that does not resolve on disk                              |

IA findings populate `related_files` with the other paths that
contributed evidence, and the human reporter renders them as an "Also
touches:" block (capped at 5). Long-form reference (quorum rules,
false-positive notes, suggested fixes):
[`docs/finding-types/ia.md`](https://github.com/ortomate/crimes/blob/main/docs/finding-types/ia.md).

IA findings phrase summaries as "appears to" / "may" — they are
**ambiguity signals**, not claims of semantic truth.

Every finding includes **evidence** (raw facts the detector observed) and
**scores** (`severity`, `confidence`, `agent_risk`).

---

## For coding agents

`crimes` is built for AI coding agents (Claude Code, Codex CLI, Cursor,
Aider, Continue, Copilot Workspace, …). Recommended loop:

```bash
# 1. Planning — scope the scan to the files the change will touch.
#    Bare `crimes scan` audits the whole repo; on a 200-file project
#    that is ~500 findings, which is not a work list.
crimes scan --files a.ts,b.ts --format json
crimes scan --related-to src/lib/thing.ts --format json

# 2. Before editing one file
crimes context <file> --format json

# 3. Make the change

# 4. After editing — re-scan only what you touched
crimes scan --changed --format json
```

`--changed` is the post-edit selector: on a clean tree it correctly
returns nothing, which is why `--files` and `--related-to` exist.

Repos that bundle [`AGENTS.md`](https://github.com/ortomate/crimes/blob/main/AGENTS.md)
or [`.claude/skills/crimes/SKILL.md`](https://github.com/ortomate/crimes/blob/main/.claude/skills/crimes/SKILL.md)
will surface this workflow to their agents automatically.

Decision rule: any **new `severity: "high"` finding** introduced by your
edit is a blocker — fix it, or surface it citing the finding `id` and
`charge`.

Full agent guide:
[`docs/agent-usage.md`](https://github.com/ortomate/crimes/blob/main/docs/agent-usage.md).

---

## Configuration

Zero-config by default. Drop a `crimes.config.json` at the repo root to
override:

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

## Docs

- [README](https://github.com/ortomate/crimes/blob/main/README.md) — full tour
- [Agent guide](https://github.com/ortomate/crimes/blob/main/docs/agent-usage.md) — pre/post-edit workflow
- [JSON schema](https://github.com/ortomate/crimes/blob/main/docs/json-schema.md) — wire format
- [Roadmap](https://github.com/ortomate/crimes/blob/main/docs/roadmap.md) — what's next

---

## License

[MIT](https://github.com/ortomate/crimes/blob/main/LICENSE).
