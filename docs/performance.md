# Measuring analysis performance

`scan`, `context` and the Claude hook use the complete repository analysis.
Working-set flags narrow output after cross-file evidence is collected. A
brief report is not necessarily a cheap report.

The 0.29 implementation reuses source reads and extracted JS/Python parse
data within a single analysis. It retains no compiler ASTs and no persistent
disk cache. The reuse budget is bounded; eviction costs another read/parse
without reducing coverage. A fresh command creates a fresh session, so edits,
renames, deletions, configuration, Git state and upgrades are re-evaluated.

Coverage attribution uses the same glob matcher in bounded batches, avoiding
the cost of compiling thousands of literal patterns into large tasks. Report
equivalence, including coverage diagnostics, is checked separately from time.

## Reproduce a comparison

Use the repository's Node toolchain, Python 3.10+ and built CLI bundles. Keep
source roots unchanged between binaries. For crimes itself, use a detached
worktree at the baseline commit; benchmark source edits must not change the
corpus being measured. Materialize the pinned OSS fixtures with `pnpm
evals:setup` before including them.

The bundled corpus preparer creates paths for the existing fixtures and
labelled synthetic Python/mixed scaling inputs in a new temporary directory:

```bash
python3 scripts/benchmark-corpus.py --source-root /tmp/crimes-baseline-worktree \
  --output-dir /tmp/crimes-performance-corpus
```

Use `/tmp/crimes-performance-corpus/cases.json` below. For your own repository,
a cases file contains an array such as:

```json
[{"id":"service","root":"/absolute/project","target":"src/api.ts"}]
```

```bash
python3 scripts/benchmark.py --cli /path/to/baseline/dist/index.js \
  --cases /tmp/performance-cases.json --output /tmp/before.json --repeats 10
python3 scripts/benchmark.py --cli packages/cli/dist/index.js \
  --cases /tmp/performance-cases.json --output /tmp/after.json --repeats 10
python3 scripts/compare-analysis.py --before /path/to/baseline/dist/index.js \
  --after packages/cli/dist/index.js --cases /tmp/performance-cases.json \
  --output /tmp/parity.json
```

All three commands accept `--node` to select the exact runtime. The benchmark pins
the scoring clock, records source and executable hashes, platform, sample
count, first measured time, repeated median/p95, and each child process's
peak RSS. Run it without competing builds or host trials. First measured
does **not** mean the operating system's disk cache was flushed; every sample
starts a fresh Node process. Ten repeats give a coarse p95, not a production
latency distribution. Timing/RSS collection currently targets macOS/Linux.

If an initial comparison shows an unexplained regression, retain it and run
an adjacent-process confirmation after competing work finishes. This alternates
which binary goes first in each pair, reducing confounding from running an
entire baseline batch before the candidate batch:

```bash
python3 scripts/benchmark-paired.py --before /path/to/baseline/dist/index.js \
  --after packages/cli/dist/index.js --cases /tmp/performance-cases.json \
  --commands scan,context,hook --repeats 10 --output /tmp/paired-performance.json
```

The optional Node preload subscribes to private diagnostics channels for
discovery, index, parsing and detection timings. Nested or concurrent spans
overlap and must not be added together or described as CPU time. Ordinary
CLI output and the JSON schema are unchanged. CPU profiles are complementary:

```bash
node --cpu-prof --cpu-prof-dir=/tmp packages/cli/dist/index.js \
  context src/api.ts --root /absolute/project --format json > /tmp/context.json
```

Generated scaling fixtures measure throughput, not real-world detector
precision or agent usefulness. Keep those conclusions separate. Measured
results and remaining limits belong in the release notes alongside the
unchanged-report checks.


The performance comparison isolates analysis changes. Later advisory-copy
corrections can be checked separately with `compare-analysis.py
--expected-text-changes <old-to-new-prose.json>`. The report records exact
equality and equality after those declared replacements separately. This
option does not drop findings, scores or coverage fields; keep the explicit
map with the evidence and never describe an approved wording change as an
identical report.


## 0.29 measurements

On 7 September 2026, the alternating-process confirmation compared the
0.28.2 bundle with the 0.29 analysis changes using Node 26.7.0 on one Mac.
Each cell has a separate first observation and ten repeated fresh processes.
The table shows repeated **context** latency; scan/hook results, stage times,
source/executable hashes and complete sample archives are in the
[measurement record](../evals/results/0.29.0/performance.json).

| Corpus | Analyzed files | Median ms, before → after | p95 ms, before → after | Peak MiB, before → after |
| --- | ---: | ---: | ---: | ---: |
| Bundled JS/TS fixture | 21 | 402 → 408 | 471 → 466 | 178 → 175 |
| Commander OSS fixture | 172 | 1311 → 754 | 1644 → 938 | 205 → 202 |
| Next.js learning fixture | 183 | 820 → 606 | 875 → 647 | 208 → 205 |
| Python service fixture | 11 | 322 → 315 | 358 → 338 | 171 → 167 |
| Mixed-language fixture | 3 | 348 → 332 | 414 → 345 | 172 → 165 |
| crimes source at 0.28.2 | 639 | 6270 → 2969 | 6519 → 3319 | 283 → 298 |
| Generated Python scaling case | 322 | 542 → 431 | 611 → 455 | 204 → 198 |
| Generated mixed scaling case | 482 | 764 → 534 | 803 → 567 | 213 → 207 |

The largest case roughly halves latency at a cost of 15 MiB additional peak
memory in context. The medium OSS cases improve less than 2×, and small-case
differences are modest; the small JS/TS context median is slightly slower.
A universal 2× speedup is not demonstrated.

The initial sequential batch recorded a TSX context regression from 825ms to
1248ms, with a 3724ms candidate p95. It did not reproduce in the alternating
run. Both batches remain in the record; the cause of that earlier slowdown
was not established. All 24 scan/context/hook pairs retain identical complete
reports across the performance comparison. Later literal-scatter and connectivity advice
corrections are verified separately with an explicit prose-replacement map;
findings, scores, identities and coverage must still agree in full.

These gains justify the bounded reuse and batching changes. They do not make
per-edit hooks free, establish a general agent benefit, or prove performance
on repositories larger than this corpus. Persistent caching remains unbuilt.
