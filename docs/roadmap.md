# Implementation status

Repository version: **crimes 0.30.0** (prepared), JSON schema **0.8.0**.
The [npm package](https://www.npmjs.com/package/crimes) and
`npm view crimes version` identify the published version; a checkout can be ahead.
[0.30.0 release notes](./releases/v0.30.0.md) record the
change and verification. Prior versions are documented in
[release history](https://github.com/ortomate/crimes/tree/main/docs/releases).

This is the implementation-status reference. [Product roadmap](../ROADMAP.md)
records next outcomes; [strategy](../STRATEGY.md) records the objective;
[PRD](../PRD.md) retains the original requirements and historical targets.

## What exists

| Capability | Status and reference |
| --- | --- |
| Local scan, JSON and human output | Shipped. Default human view prioritizes five files; JSON retains all visible findings. |
| TypeScript / JavaScript | Shipped language pack, AST and resolved import graph. |
| Python | Shipped language pack and packaged parser WASM, including import/test discovery. |
| Java | Language pack on the shared tree-sitter runtime (0.29.6): import and same-package graph, JUnit test discovery, four detectors. No cross-language or symbol index yet. |
| Swift | Language pack (0.29.8): referenced-type and extension graph, XCTest and Swift Testing, the same four detectors. |
| Kotlin | Language pack (0.29.8) sharing the JVM type index with Java; top-level and extension functions; JUnit, kotlin.test, MockK and Kotest assertions; the same four detectors. |
| Universal and cross-language checks | Shipped; read coverage to distinguish universal checks from parsed language analysis. |
| Pre-edit context | Shared scan analysis, related-file findings, graph-first neighbors/tests, status and coverage diagnostics in 0.28. |
| Working sets | `--changed`, `--files`, `--related-to`; full repository analysis supplies cross-file evidence before output selection. |
| Branch comparison and gates | `diff`, `verdict`, baseline checks, explicit `--fail-on`; see [CI](./ci.md). |
| Suppression, feedback and triage | Shipped with reasoned decisions, expiry/resurfacing and claim-aware identity. |
| Pin migration | Preview and reviewed apply preserve metadata and leave ambiguous/absent subjects unselected; 0.29 stages replacements and adds interruption recovery. |
| Explainability | Evidence, finding scores, `explain`, coverage diagnostics and [scoring](./scoring.md). |
| Agent setup | Versioned skills, normal-use refresh/notices, protected customizations and verified Claude hook context delivery. |
| Evaluation | Detector tests, ranking, historical response replay, and twelve synthetic edit tasks with two hosts, three conditions and three repeats; see [methods and evidence](./evals.md). |
| npm distribution and docs site | Shipped release pipeline; source docs mirrored to Astro/Starlight. |

The [generated command and detector reference](./reference.md) is the
complete shipped inventory. Optional defaults in 0.28: parallel destinations,
boolean naming (JS/Python), raw style concentration and accessible interaction.
These remain available for explicitly scoped reviews.

## What remains open

- Demonstrating a general improvement in completed agent edits. The expanded
  trial remains synthetic; more representative work and independently
  reported outcomes are needed. Ranking alone does not answer this question.
- More calibration from actual feedback, including weak-test claims and
  the precision/recall tradeoff of conservative hotpath detection.
- Context performance across larger repositories. Bounded per-analysis reuse
  and batched coverage matching reduce repeated work in 0.29, but each command
  still analyzes the repository. See [performance](./performance.md) for
  reproducible timing, memory and unchanged-report checks. No disk cache ships.
- Homebrew and standalone binaries, with Python WASM parity verification.
- JSP and LESS/CSS packs (the 0.31 milestone in the [product roadmap](../ROADMAP.md));
  today they are reported under `files_not_discovered`.
- A live agent round on the Java, Kotlin and Swift fixtures (`17`–`19`, added in
  0.30.1); only the scan-only ranking metric covers them so far.
- Package-level cycles for Java/Kotlin, a cross-file symbol index for the
  structured packs, and Java 21 type patterns (a tree-sitter-java gap).
- Further language packs (Go, Rust, C# and others report as `files_universal_only`)
  and cross-language import resolution.
- `crimes ask`, other LLM-assisted modes, hosted services and paid tiers.

The [archived 0.27 sprint](../.planning/archive/SPRINT-0.27.md) records planned
work that did not land. A dated plan is not a shipped-command specification.
