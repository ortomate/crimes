# Product roadmap

Reviewed: 2026-09-07. This file records desired outcomes; the
[implementation status](./docs/roadmap.md) records what exists.

- **0.28: trustworthy briefings and quieter defaults.** Share scan/context
  analysis, use the import graph for neighbors/tests, bound repetitive file
  ranking, make style suggestions optional, provide reviewed pin migration,
  and consolidate human/agent docs. Evidence and remaining limits belong in
  [release notes](./docs/releases/v0.28.0.md).
- **0.29: measure cost and completed edits.** Reduce measured redundant
  analysis, preserve complete reports, expand behavioral trials and make pin
  replacement recoverable. [Release evidence](./docs/releases/v0.29.0.md)
  records performance, edit outcomes and the limits of those measurements.
- **Demonstrate better edits.** Move beyond the fixed synthetic suite to
  representative changes and independently reported use. Retain failures,
  scope expansion and integration cost alongside acceptance results.
- **Close the feedback loop.** Turn real false-positive reports from
  dogfooding into reproductions and calibration decisions; preserve the
  original feedback reasons and expiry dates.
- **Measure outside use.** Seek an independently reported editing outcome,
  issue or feedback export. Establish retention/adoption goals once the
  intended audience is clearer; npm downloads are insufficient evidence.
  The [self-serve trial](./docs/external-trial.md) is prepared; no outside
  trial outcome has been collected by this follow-up.
- **Revisit distribution after correctness.** Homebrew and standalone
  binaries remain deferred. Validate Python WASM parity before shipping
  another installation path. The historical
  [0.27 sprint](./.planning/archive/SPRINT-0.27.md) records its unmet scope.

`crimes ask`, a hosted service, a paid tier and Windows binaries remain
outside this release. Recency stays enabled and reversible with
`--no-recency`; its formula and evidence limits are explicit in
[scoring](./docs/scoring.md).
