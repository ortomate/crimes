# Product roadmap

Reviewed: 2026-09-06. This file records desired outcomes; the
[implementation status](./docs/roadmap.md) records what exists.

- **0.28: trustworthy briefings and quieter defaults.** Share scan/context
  analysis, use the import graph for neighbors/tests, bound repetitive file
  ranking, make style suggestions optional, provide reviewed pin migration,
  and consolidate human/agent docs. Evidence and remaining limits belong in
  [release notes](./docs/releases/v0.28.0.md).
- **Demonstrate better edits.** Expand the acceptance-tested paired benchmark
  to representative changes, repeat each pair and report failures as well
  as successes. The initial 3/3 versus 3/3 result is inconclusive.
- **Close the feedback loop.** Turn real false-positive reports from
  dogfooding into reproductions and calibration decisions; preserve the
  original feedback reasons and expiry dates.
- **Measure outside use.** Seek an independently reported editing outcome,
  issue or feedback export. Establish retention/adoption goals once the
  intended audience is clearer; npm downloads are insufficient evidence.
- **Revisit distribution after correctness.** Homebrew and standalone
  binaries remain deferred. Validate Python WASM parity before shipping
  another installation path. The historical
  [0.27 sprint](./.planning/archive/SPRINT-0.27.md) records its unmet scope.

`crimes ask`, a hosted service, a paid tier and Windows binaries remain
outside this release. Recency stays enabled and reversible with
`--no-recency`; its formula and evidence limits are explicit in
[scoring](./docs/scoring.md).
