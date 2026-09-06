# Implementation status

Prepared version: **crimes 0.29.0**, JSON schema **0.8.0**.
Preparation is separate from publication; `npm view crimes version` gives
the published version. [0.29.0 release notes](./releases/v0.29.0.md) record the
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
- Further language packs and cross-language import resolution.
- `crimes ask`, other LLM-assisted modes, hosted services and paid tiers.

The [archived 0.27 sprint](../.planning/archive/SPRINT-0.27.md) records planned
work that did not land. A dated plan is not a shipped-command specification.
