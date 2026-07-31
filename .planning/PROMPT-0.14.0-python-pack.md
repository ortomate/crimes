# Implement `crimes@0.14.0` — the Python language pack

Paste this into a fresh Claude Code session at the repo root. It is
self-contained: it assumes no memory of the 0.13.0 session.

---

## What you are building

`packages/language-py/` — the second language pack, proving the
language-pack seam introduced in 0.12.0 is real and reusable rather
than a JS-shaped abstraction with one implementation.

**Read these first, in this order:**

1. `CLAUDE.md` — product constraints. The wedge, what crimes is
   explicitly not, the eval-baseline versioning policy.
2. `docs/superpowers/specs/2026-05-22-wider-codebase-support-design.md`
   §"`crimes@0.14.0` — Python language pack" — the canonical spec.
   **Note:** the spec still calls this release `0.13.0`. It was
   renumbered when the ranking work took that number. Python is
   `0.14.0`, polyglot IA is `0.15.0`. `docs/roadmap.md` is correct.
3. `docs/scoring.md` — how the six scores work. Changed materially in
   0.13.0; do not rely on any older description.
4. `CONTRIBUTING.md` §"Adding a new language" — the pack registry.
5. `evals/README.md` §"What the structural rubric does and does not
   measure" and §"Measuring run-to-run noise".

**Scope per the spec:** eight detectors that prove the seam, not
catalogue parity — `large_function.py`, `direct_date.py`,
`sync_io_in_hotpath.py`, `circular_dependency.py`, `deep_import.py`,
`weak_test_signal.py`, `mixed_utc_local_methods.py`,
`boolean_naming_drift.py`. Plus 6 eval scenarios and 2 fixtures.
`tree-sitter` + `tree-sitter-python`, no Python runtime at install or
scan time. Schema unchanged — `pack` and `coverage` already ship.

---

## Three blockers found while shipping 0.13.0

These are not in the design spec. They are consequences of 0.13.0's
scoring changes meeting this pack, and two of them will silently
produce wrong output if you don't handle them. Resolve each explicitly.

### 1. `test_gap` will be wrong for every Python file

`packages/core/src/scoring/build.ts` — `stripTestSuffix()` strips
`.test` / `.spec` **suffixes**. Python convention is a **prefix**:
`test_billing.py` covers `billing.py`. `test_billing !== billing`, so
sibling detection never matches. The other zero-scoring path,
`importedByTest()`, needs an import graph Python doesn't have (blocker
2). `TEST_FILE_RE` in `packages/core/src/util/test-files.ts` already
*classifies* `test_*.py` and `*_test.py` correctly — only the pairing
logic is missing.

Left alone: every Python file scores `test_gap: 1.0` ("no test at
all") even in a well-tested repo. Since 0.13.0 that is 0.20 of
`agent_risk`, so Python findings would be systematically over-ranked
against JS ones.

Also note 0.13.0 scoped `test_gap` to files a language pack claims, so
registering `.py` is what pulls Python into the quartile population in
the first place.

**Deliverable:** convention-aware pairing, plus fixtures with a tested
and an untested Python module asserting the resulting quartiles.

### 2. Python has no import graph

`packages/core/src/imports/build.ts` resolves through `tsconfig.json`
and uses `ts.ScriptKind`. There is no Python equivalent. Two
consequences:

- `blast_radius` is derived purely from the import graph
  (`scoring/build.ts`, `buildBlastRadiusIndex`), so it is `0` for every
  Python file. In 0.13.0 `blast_radius` carries 0.20 of `agent_risk`
  and its correlation with the final score went from 0.06 to 0.48 — it
  is now a real signal, not decoration.
- `circular_dependency.py` and `deep_import.py` are 2 of the 8
  detectors on the slate and are meaningless without import edges.

**These two are not ports.** They need Python import resolution:
`__init__.py` packages, relative imports (`from . import x`),
`sys.path` semantics.

**Decide explicitly and say which you chose:** build a Python import
graph in this release (larger than the spec implies), or ship 6
detectors and declare `blast_radius` a known Python gap that
`--explain-coverage` reports. Silently shipping `blast_radius: 0` for
Python is the one option that is not acceptable.

### 3. Detectors must set their own `scores.agent_risk`

0.13.0 made the detector-supplied `scores.agent_risk` the heaviest
input to the unified formula:

```
agent_risk = 0.40*intrinsic + 0.20*churn + 0.20*test_gap + 0.20*blast_radius
```

`intrinsic` is the detector's own value. Detectors that omit it fall
back to a compressed severity-derived default (high 0.75 / medium 0.55
/ low 0.40), deliberately lower than a real judgement so fallbacks
cannot outrank considered ones.

All eight Python detectors must set an intrinsic value, scaled to
evidence the way the existing 30 do — `concept_alias_drift` rises with
the number of competing aliases, `mixed_utc_local_methods` with the
number of offenders. Omit it and the Python pack ranks below its JS
equivalents for no reason other than not having an opinion.

---

## What changed in 0.13.0 that you must not undo

- **`agent_risk` no longer includes severity or confidence.** It had
  collapsed into severity (correlation 0.79) while ignoring
  `blast_radius` (0.06). `PRD.md` §10 says this must not happen. If a
  change pushes the severity correlation back up, it is wrong.
- **Coverage derives from `LanguagePackRouter`**, not literals. Call
  `registerPackExtensions("language-py", [".py", ".pyi"])` at module
  load and `coverage.packs_loaded`, `files_by_language` and
  `universal_only_by_extension` all update themselves. Do not add a
  parallel extension list — there were three before 0.13.0 and
  removing them was deliberate.
- **The eval scorer reads only the agent's own message.** `codex exec
  --json` streams JSONL; scoring raw stdout meant 82–84% of the scored
  text was tool output. See
  `evals/runner/src/agents/codex-transcript.ts`.
- **`referenced_files` skips paths the prompt supplies.** When writing
  the 6 Python scenarios, an `expected_artifacts.referenced_files`
  entry that the prompt already names is recorded and **not scored**.
  Prefer files the agent must discover, or the scenario rests entirely
  on its other checks.

---

## Working conventions

- **`pnpm verify`**, never `pnpm ci` — pnpm reserves `ci` and it fails
  before reaching the workspace script.
- **Commit when a logical unit passes its checks.** Don't batch.
- **Calibration bumps:** any change that moves the eval baseline gets a
  patch bump in the same commit, no release and no tag, with a re-run
  baseline committed alongside. Full rule in `evals/README.md`
  §"Versioning policy". Say in the commit message whether a delta is a
  measurement correction or a quality change.
- **Don't add detectors that re-implement ESLint, Ruff, mypy, Semgrep
  or Bandit.** The wedge is change risk and agent risk. A Python
  detector that flags style or type errors is out of scope regardless
  of how easy it is.

---

## Judging the result

**The aggregate eval number is the only one worth reading.** Three
runs of identical code in 0.13.0 gave:

- per-agent aggregate: claude σ 0.029, codex σ 0.012 — treat moves
  under ~6pp as noise
- `per_scenario_kind`: **not interpretable** at 7–8 scenarios per
  kind. `plan`/claude ranged 0.64–0.88 across identical runs.

Six Python scenarios spread across five kinds will be individually
meaningless. Judge on the aggregate, or add enough Python scenarios to
make a grouping readable — and say which.

Before claiming any eval movement is real, run `pnpm run evals --
--label r2` and `pnpm run evals:variance`. A single sample cannot
distinguish a 5-point move from noise; that mistake is what the whole
0.13.0 investigation was about.

---

## Definition of done

1. `packages/language-py/` exists, registers `.py` / `.pyi`, and
   `crimes scan` on a Python repo reports `packs_loaded:
   ["universal", "language-py"]` with a populated
   `files_by_language.py`.
2. Detectors implemented, each with unit tests and an explicit
   intrinsic `agent_risk`. If you shipped 6 rather than 8, the reason
   is written down and `--explain-coverage` tells the user.
3. `test_gap` is correct for Python conventions, with fixtures proving
   it.
4. `blast_radius` for Python is either real or an explicitly reported
   gap.
5. Eval scenarios + fixtures added; `pnpm run evals:verify-scenarios`
   passes.
6. `pnpm verify` green, `pnpm --filter crimes smoke` green.
7. Baseline re-run and committed; aggregate compared against the
   0.13.0 band, not eyeballed.
8. Docs updated: `docs/packs.md`, `docs/roadmap.md`,
   `docs/releases/v0.14.0.md`, `README.md` status block,
   `packages/cli/README.md`, `apps/website/landing/llms.txt`. Release
   procedure is `docs/releasing.md` — publishing happens via a GitHub
   Release, never `npm publish` locally.

---

## Start here

Read the files listed at the top, then come back with a plan covering
the three blockers before writing code. In particular, state your
decision on blocker 2 — Python import graph or 6 detectors — because
it changes the size of the release.
