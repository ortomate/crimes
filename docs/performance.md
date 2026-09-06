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
