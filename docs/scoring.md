# Scoring

Scores prioritise review. They are deterministic heuristics and ordinal
signals, not estimated probabilities of bugs or agent failure. A score of
0.7 does not mean a 70% chance of a bad change.

## Finding priority

```text
raw = clamp01(0.40 × intrinsic + 0.20 × churn
            + 0.20 × test_gap + 0.20 × blast_radius)
agent_risk = round(raw)                         for agent signals
agent_risk = round(round(raw) × 0.30)           for structural findings
rank_score = agent_risk × (1 + 0.50 × recency)
```

`rank_score` is a sort key, not a stored Finding field. `scan --no-recency`
disables its recency term. The default remains enabled: recent edits are
useful context, but do not establish defects. Ties break on severity,
confidence, file, line and fingerprint. Numeric scores are rounded to two
decimal places; higher means more of the named signal.

`intrinsic` comes from detector evidence or that detector's declared
anchor in `detector-defaults.ts`. The last-resort value for an unknown type
is 0.30; fallback is not derived from severity. Severity and confidence
remain independent reported fields and tie-breakers, not composite terms.

Structural scaling prevents length and count heuristics from overwhelming
agent-specific evidence. It applies to large files/functions, connectivity,
cycles/layers/deep imports and the structural UI/asset checks. The current
classification lives in `scoring/agent-risk-class.ts`. Its scale is a
product calibration choice, not a scientifically validated boundary.

## Signal sources and limitations

| Signal | Calculation | Interpretation |
| --- | --- | --- |
| `churn` | `min(commits in 90 days / 20, 1)` | Change frequency. Missing git history is not evidence of stability. |
| `test_gap` | Relative quartile of the raw discovery signal below | Test discoverability, not measured code coverage. |
| `blast_radius` | `0.85 × min(log1p(transitive importers)/log1p(2000), 1) + 0.15 × min(log1p(direct importers)/log1p(250), 1)` | Dependency reach plus direct use. |
| `recency` | 1 through seven days; linear decay to 0 at fourteen days | Age of the latest commit. Unavailable history contributes 0. |

Raw test-discovery values are 0 when the target is a test or is imported by
one; 0.5 when a matching sibling or dedicated-directory test exists without
a resolved import; 1 otherwise. JS suffixes, Python prefixes/suffixes and Go
suffixes are recognised. Scoring ranks these values among claimed source
files. Test files and files without a language pack do not contribute to
that population. `context.clues.test_gap.raw` reports the raw value.

A hollow or heavily mocked test can still import production code. Read
`weak_test_signal`, `mock_saturation`, and the actual assertions separately.
Unresolved aliases, dynamic imports, namespace packages or incomplete
parsing can hide graph edges. `coverage.warnings` reports known gaps.

The blast-radius integers are separately available as
`scores.blast_radius_direct_importers` and
`scores.blast_radius_transitive_importers`. Direct counts exclude self-edges
and deduplicate source files. Transitive reach includes a cycle's own file,
so files in the same component can share reach despite different fan-in.

## File priority in human reports

For each distinct `(type, claim)` in a file, keep its highest finding
`rank_score`. Sort those scores descending, then weight them by
`1, 1/4, 1/8, 1/16, …`. Repeated instances of the same claim add no count
bonus. The extra contribution stays below half the strongest score.

This replaces the unbounded sum in 0.28. A file with thirty mild fallback
observations should not beat a consequential contract finding solely
because it has thirty observations. Counts and all evidence remain visible;
use `--all` for the full human report. JSON retains all visible findings.

## Consequence and intent

`swallowed_error` still reports deliberate fallbacks. Its intrinsic now
separates payment/persistence/authorization/queue/state boundaries (0.80),
other evidenced boundaries (0.55, or 0.35 with documented tolerance),
undocumented empty/discarded failures (0.50), other generic fallbacks (0.30)
and documented fallbacks without an evidenced boundary (0.15).
No blanket `read*` or `parse*` exemption is introduced.

`sync_io_in_hotpath` requires request/render evidence in JavaScript. Python
also accepts an async function, where blocking the event loop is evidenced.
Generic synchronous domain functions are insufficient. Naming, accessibility
and raw-style checks are optional; see [the registry](./reference.md).

## Reproducible measurement

Product recency changes with time. `CRIMES_NOW` can pin the reference time
for a comparison; the ranking harness uses a committed reference date.
Hold the source tree, configuration, clock and labels constant when
comparing versions. Do not confuse removing default checks, changing labels
or changing the evaluation population with improving ranking.

[Evaluation methods and limits](./evals.md) · [JSON contract](./json-schema.md)
