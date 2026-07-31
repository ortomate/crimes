# Scoring

Every `crimes` finding carries five numeric scores in [0, 1]:

| Score          | Source                                          | "Higher means" |
| -------------- | ----------------------------------------------- | -------------- |
| `severity`     | Detector — how bad the smell is in isolation    | More severe    |
| `confidence`   | Detector — how certain the detector is          | More certain   |
| `churn`        | Git log over a 90-day window                    | Edits more     |
| `test_gap`     | Filesystem + import-graph test discovery        | Less tested    |
| `blast_radius` | Import-graph transitive closure                 | Touches more   |
| `agent_risk`   | Unified composite of all five                   | Riskier to AI edits |

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
0.12.2 formula:

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

Detectors that don't set one (18 of 48 today) fall back to a
severity-derived default, deliberately compressed so a fallback finding
doesn't outrank a detector that made a real judgement:

| `severity` | fallback `intrinsic` |
| ---------- | -------------------- |
| `high`     | 0.75                 |
| `medium`   | 0.55                 |
| `low`      | 0.40                 |

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
| `0.5`      | A sibling test file exists (`foo.test.ts` next to `foo.ts`) **or** a `__tests__/` test file shares the basename, but no test file actually imports the target. |
| `1.0`      | None of the above.                                                              |

Test files are recognised by the standard pattern: anything under
`__tests__/`, or any file matching `.test.{ts,tsx,js,jsx,mjs,cjs}` or
`.spec.{…}`.

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

Where `transitive_importers` is the count of distinct repo files that
reach the target via one or more import edges. The traversal is memoised
per file so the per-scan cost stays O(F).

When the import graph isn't available, `blast_radius` is `0` for every
file. The graph is built once per scan and shared across every detector
via `DetectorContext.imports`.

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
