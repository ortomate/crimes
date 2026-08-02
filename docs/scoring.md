# Scoring

Every `crimes` finding carries six numeric scores in [0, 1]:

| Score          | Source                                          | "Higher means" |
| -------------- | ----------------------------------------------- | -------------- |
| `severity`     | Detector — how bad the smell is in isolation    | More severe    |
| `confidence`   | Detector — how certain the detector is          | More certain   |
| `churn`        | Git log over a 90-day window                    | Edits more     |
| `test_gap`     | Filesystem + import-graph test discovery        | Less tested    |
| `blast_radius` | Import-graph transitive closure                 | Touches more   |
| `agent_risk`   | Unified composite — see the formula below       | Riskier to AI edits |

Rank by `agent_risk` when the question is "which areas are dangerous to
edit"; rank by `severity` when the question is "which findings are
worst in isolation".

## Status by version

| Version  | `severity` / `confidence` | `churn` / `test_gap` / `blast_radius` | `agent_risk` |
| -------- | ------------------------- | ------------------------------------- | ------------ |
| 0.1–0.5  | Populated                 | Reserved (always absent)              | Populated by detector |
| 0.6+     | Populated                 | **Populated** from the scoring context | Populated from the unified formula |

All fields are rounded to two decimal places.

## The unified `agent_risk` formula

`agent_risk` is recomputed for every finding after detectors emit. The
current formula, unchanged since 0.12.2:

```
agent_risk = clamp01(
    0.40 * intrinsic       // the detector's own scores.agent_risk
  + 0.20 * churn
  + 0.20 * test_gap
  + 0.20 * blast_radius
)
```

`intrinsic` is the value the detector itself set on `scores.agent_risk`.
It is the only genuinely agent-specific input in the system — it is
where "multiple sources of truth", "misleading name", and "hidden side
effect" (PRD §10) are actually encoded, and it scales with the evidence
found: `concept_alias_drift` rises with the number of competing aliases,
`mixed_utc_local_methods` with the number of offenders.

Detectors that don't set one (18 of 57 today) fall back to a
severity-derived default, deliberately compressed so a fallback finding
doesn't outrank a detector that made a real judgement:

| `severity` | fallback `intrinsic` |
| ---------- | -------------------- |
| `high`     | 0.75                 |
| `medium`   | 0.55                 |
| `low`      | 0.40                 |

New detectors should set their own. All eight `language-py` detectors
(0.14.0) do, which means Python's `circular_dependency.py` and
`deep_import.py` currently carry a real judgement where their JS
counterparts still fall back to the severity default — those two are
the obvious candidates when the JS side is next revisited.

### Why severity and confidence are not terms

From 0.6.0 to 0.12.1 the formula was
`0.4*severity + 0.2*confidence + 0.15*churn + 0.15*test_gap + 0.10*blast_radius`,
and the detector's own `agent_risk` was **discarded** at finalisation.

Severity takes one of three values and observed confidence spans a
0.25-wide band, so 60% of the weight sat on the two least-varying
inputs. Measured across a 210-finding scan of this repo, that produced:

| | old formula | 0.12.2 |
| --- | --- | --- |
| correlation with `severity` | **0.79** | 0.18 |
| correlation with `blast_radius` | 0.06 | 0.48 |
| correlation with `churn` | 0.45 | 0.35 |
| correlation with `test_gap` | 0.38 | 0.49 |
| p10–p90 spread | 0.23 | 0.33 |

`agent_risk` had effectively collapsed into `severity`, which PRD §10
says must not happen — and `blast_radius` contributed nothing at all.
Severity remains a separate ranking axis and is still reported per
finding; it simply no longer determines this score.

The 0.12.2 figures include the companion `test_gap` fix below. Together
they changed which findings surface: the top of a self-scan was four
markdown files, and is now `context.ts`, `finding.ts`, `scan.ts`,
`config.ts`, and `detector.ts` — the schema, the detector contract, and
the scan orchestrator. A `low`-severity `sync_io_in_hotpath` finding now
ranks third, above several `high`-severity ones, which is the behaviour
PRD §10 describes.

## How each signal is computed

### `churn`

```
churn[file] = min(commits_touching_file_in_last_90_days / 20, 1)
```

The same saturation curve `crimes hotspots` uses for the change-frequency
component of `risk`. The window can shift in future releases — the
contract is "higher is worse, range [0, 1]", not "this exact number".

When the repo isn't a git working tree, or the `git` binary isn't
available, `churn` is `0` for every file and the scoring context's
internal `limited` flag is set. The hotspots command already documents
this case under `history_limited`.

### `test_gap`

A three-tier signal derived from filesystem layout and the import graph:

| `test_gap` | Condition                                                                       |
| ---------- | ------------------------------------------------------------------------------- |
| `0.0`      | The file is *itself* a test file (e.g. `foo.test.ts`), **or** at least one test file imports it. |
| `0.5`      | A sibling test file exists (`foo.test.ts` next to `foo.ts`) **or** a test file under `__tests__/` or `tests/` shares the basename, but no test file actually imports the target. |
| `1.0`      | None of the above.                                                              |

Test files are recognised by the standard pattern: anything under
`__tests__/` or `tests/`, any file matching
`.test.{ts,tsx,js,jsx,mjs,cjs}` or `.spec.{…}`, and the Python / Go
forms `test_*.py`, `*_test.py`, `*_test.go`.

#### Test-naming conventions

Pairing a test to the file it covers is per-language, and until 0.14.0
only the JS convention was understood:

| written as        | covers    | languages  |
| ----------------- | --------- | ---------- |
| `billing.test.ts` | `billing` | JS/TS      |
| `billing.spec.ts` | `billing` | JS/TS      |
| `billing_test.py` | `billing` | Python, Go |
| `test_billing.py` | `billing` | Python     |

Note the asymmetry: every convention except Python's dominant one is a
*suffix*. Because the old logic only stripped `.test` / `.spec`
suffixes, `test_billing` never matched `billing` and **every Python file
scored `test_gap: 1.0`** regardless of how well tested it was. Since
0.13.0 that is 0.20 of `agent_risk`, so Python findings would have been
systematically over-ranked against JS ones.

A test in a dedicated directory (`__tests__/` or `tests/`) pairs by
basename rather than by being a sibling. `tests/` was added alongside
the Python work in 0.14.0 and applies to **both** languages — a JS repo
keeping its tests outside `src/` was previously scored as having none.

**Only files a language pack claims carry a test_gap.** Markdown, JSON,
YAML, and assets score `0.0` and are excluded from the quartile
population entirely. A README having no unit test is a category error,
not a risk. Before 0.12.2 they scored `1.0` and were ranked against
code, which pushed every documentation file into the top quartile and —
because `test_gap` feeds `agent_risk` — put four markdown files at the
top of a self-scan of this repo. Excluding them also keeps the quartile
boundaries meaningful for the code files that remain.

This is derived from the language-pack router, so a file type becomes
testable automatically when a pack starts claiming it — no second list.

### `blast_radius`

```
blast_radius[file] = min(transitive_importers / 50, 1)
```

Where `transitive_importers` is the size of the file's transitive
importer closure: every distinct repo file that reaches the target via
one or more import edges. The traversal is memoised per file so the
per-scan cost stays O(F).

**This is reachability, not fan-in, and the two are not close.** The
walk follows import edges without breaking cycles, so a file on an
import cycle appears in its own closure, and every member of a
strongly-connected component reports the same number. Measured on the
`hono` corpus: `src/utils/mime.ts` has 5 direct importers and a closure
of 240; six files in the core component all report exactly 197 while
their direct fan-in ranges from 2 to 70. On `zulip`, 866 findings shared
one value (798) and 825 shared another (324) — a component census, not a
per-file measurement.

Both integers are reported on every finding, under names that say which
is which:

| Field | Meaning |
| --- | --- |
| `scores.blast_radius_transitive_importers` | Closure size. The integer `blast_radius` normalises. |
| `scores.blast_radius_direct_importers` | Distinct files with a direct import edge to this one. Deduplicated per source file, self-edges excluded. |

`blast_radius_direct_importers` deliberately does **not** feed the score.
Which of the two signals should drive `blast_radius`, and where the cap
should sit, is a calibration question with eval-baseline consequences;
splitting the reporting is a truthfulness fix and is kept separate from
it. Before `schema_version` 0.5.0 the closure size was the only integer
emitted, under the name `blast_radius_importers`, and every human
surface rendered it as "N importers".

When the import graph isn't available, `blast_radius` is `0` for every
file. The graph is built once per scan and shared across every detector
via `DetectorContext.imports`.

The graph is **language-agnostic** and carries every pack's edges. As of
0.14.0 Python module resolution (`__init__.py` packages, relative-dot
levels, `src/` layouts) feeds the same structure, so a Python module
imported by 30 others earns the same blast radius a TS one would.
Before that, Python files scored `0` here — which mattered more than it
looks, because `blast_radius` went from contributing nothing to the
final score (r=0.06) to being a real signal (r=0.48) in 0.13.0.

Specifiers a language cannot statically resolve are recorded as
external rather than guessed at: bare module names on the JS side, and
namespace packages / `importlib` / runtime `sys.path` edits on the
Python side. A missed edge understates blast radius; a guessed one
would invent a dependency.

## Stability guarantees

`severity` and `confidence` continue to be the "stable" knobs detectors
calibrate against. `churn`, `test_gap`, and `blast_radius` are
**ordinal** — treat the exact numbers as advisory; the formulae may
shift between minor releases as the underlying heuristics are refined.
The contracts that don't shift:

- Range is always [0, 1], rounded to two decimal places.
- Direction is always "higher is worse".
- `agent_risk` is monotonic in each of its five inputs.

The exact `agent_risk` weighting itself may also shift between minor
releases. Consumers that key off `agent_risk` should rank findings by
relative ordering rather than absolute thresholds.

## Where to read the scores

- `crimes scan --format json` — `findings[].scores` carries all five
  fields on every finding.
- `crimes scan` (human format) — a one-line "Risk profile" block prints
  alongside any finding where at least one of `churn` / `test_gap` /
  `blast_radius` is > 0.5. `--all` always shows it.
- `crimes explain <id>` — a "Risk profile" section explains each score
  alongside its raw evidence (commit count, importer count, test-file
  presence).
- `crimes context <file>` — every finding rendered in the deep-dive
  view includes the risk profile.
