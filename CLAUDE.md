# CLAUDE.md

Read [AGENTS.md](./AGENTS.md) for the repository workflow and safety rules.
It is the shared instruction source for all coding agents.

`crimes` is a local, deterministic change-risk and agent-risk CLI. JSON is
its public API; evidence and conservative heuristics are the product.
The current architecture has TypeScript/JavaScript and Python language
packs, a shared analysis pipeline for scan/context, and human/JSON
reporters. The website uses Astro and Starlight. TypeScript's compiler API
backs JS parsing; Python uses the packaged parser WASM. See each package's
manifest for dependencies rather than treating earlier PRD options as the
implemented stack.

Use Biome, pnpm, tsup, Vitest and Commander. Do not introduce Rust, oclif,
LLM SDKs, a second formatter, or style/security detector imitations in v0.
Configuration lives in `crimes.config.json`; project decisions live in
`.crimes/`. No discovered configuration is executed.

Current command/default/schema facts are generated in
[docs/reference.md](./docs/reference.md). Scoring is documented in
[docs/scoring.md](./docs/scoring.md). Historical requirements in PRD are
not a claim that a deferred feature ships. Consult
[docs/roadmap.md](./docs/roadmap.md) for implementation status.

The CLI package version is also the evaluation result key. A detector,
scoring or rubric change must land with results under a new version;
between releases use a patch increment without publishing. A planned
release can use its target minor version for the complete change.
Distinguish measurement corrections from product improvements in the
commit and release notes. Details: [evals/README.md](./evals/README.md).

Commit completed logical work after verification; do not commit an
unfinished refactor, secrets or changes the user asked to leave uncommitted.
Release authority remains as specified in [AGENTS.md](./AGENTS.md) and
[docs/releasing.md](./docs/releasing.md).
