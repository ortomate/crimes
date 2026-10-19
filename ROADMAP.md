# Product roadmap

Reviewed: 2026-10-19. This file records desired outcomes; the
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
- **0.30: say what was not seen; read the JVM and Swift.** Honest coverage
  for languages no pack parses, quieter defaults on real estates (tooling
  excludes, icon rasters, runtime env vars), and Java, Kotlin and Swift
  packs on one shared structured-surface detector slate. Before release,
  use it on the private estate it was built against and judge whether its
  briefings are useful, not just correct.
- **0.31 milestone: templates and stylesheets.** JSP (`.jsp`, `.jspf`,
  `.tag`) and LESS/CSS packs. Server-rendered views and stylesheets are a
  large share of older Java web estates (on the estate behind 0.30, about
  1,650 files) and are currently only reported as undiscovered. Needs a
  grammar decision for JSP (embedded Java, EL and tag libraries), links
  from templates to the Java they call, and detectors chosen for what those
  files hide from an agent rather than style rules.
- **Measure the new packs.** Eval fixtures and scenarios for Java, Kotlin
  and Swift, pinned from real public repositories rather than written for
  the purpose; today no fixture exercises them.
- **Large-repository cost.** A full n8n scan takes about 27 minutes, nearly
  all of it TypeScript parsing for the IA index. A persistent cache is the
  obvious lever and conflicts with the guarantee that every command
  re-evaluates from scratch; decide that trade explicitly.
- **JVM and Swift depth.** Package-level cycle detection for Java and
  Kotlin (file-level cycles are routine there); a cross-file symbol index
  so `weak_test_signal` can follow inherited helpers instead of giving them
  the benefit of the doubt; a newer tree-sitter-java for Java 21 type
  patterns.
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
