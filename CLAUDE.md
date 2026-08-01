# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Shipped on npm as `crimes` through 0.8.1. Latest published version
lives in `packages/cli/package.json`. The crimes.sh website auto-deploys
from `main` via Vercel. See `docs/roadmap.md` for the per-milestone
status mirror, and `docs/releases/` for in-repo draft release notes.

Workspace layout, test runners, and the per-release procedure are
canonical in `docs/releasing.md`. `pnpm verify` runs build + typecheck + test
across every workspace package; `pnpm --filter crimes smoke` packs the
tarball and exercises every CLI command from a clean install.

`PRD.md` is the authoritative product spec. When something here
conflicts with `PRD.md`, the PRD wins — update this file rather than
diverging.

## What this product is (and isn't)

`crimes` is a CLI that scans a repo for **change risk** and **agent risk**, not style or security. The wedge — and the reason not to drift into "better linter" territory — is:

> Local, open-source, agent-native codebase risk and context.

That positioning drives several non-obvious constraints:

- **JSON output is the product contract**, not an afterthought. Human terminal output is a renderer over the same finding schema (see `PRD.md` §9). Treat the schema as a public API from day one; `schema_version` is bumped on breaking changes.
- **Deterministic before magical.** Core detectors must work without an LLM. LLM-assisted features are optional and additive, never load-bearing.
- **Evidence before judgement.** Every finding must include concrete evidence (line ranges, churn counts, import patterns, duplicate locations). No verdicts without receipts.
- **Signal over exhaustiveness.** Default `crimes scan` shows top findings only, not everything. `--all` is opt-in.
- **Playful, not unserious.** Charge names ("God Function", "Temporal Recklessness") are fine. Jokes inside findings are not.

`crimes` is explicitly **not** trying to replace ESLint/Biome (linters), Semgrep/CodeQL (security), or SonarQube (platform). Don't add detectors that just re-implement those tools.

## Architecture (planned)

Public TypeScript monorepo, pnpm workspaces. The package boundaries matter because they encode the layering — keep them clean:

```
apps/website/              # crimes.sh — Astro+Starlight preferred, in same repo
packages/cli/              # published npm package, exposes `crimes` binary
packages/core/             # detectors, scoring, finding schema — language-agnostic
packages/language-js/      # TS/JS parsing, symbols, imports (first language pack)
packages/reporter/         # human/json/markdown reporters over core's schema
examples/messy-ts-app/     # intentional-mess fixture for detector tuning
examples/risky-service/    # 0.16.0 correctness + authority fixture
```

Shared analysis infrastructure inside `core` (added 0.16.0) — reach for
these before writing a new one:

- `risk/` — one-pass cross-file index: policy clones, object contracts,
  environment reads, pass-through chains. Bucketed matching, never
  global pairwise.
- `domain/vocabulary.ts` — two-tier domain vocabulary. The broad tier
  raises confidence; the narrow `strongDomainTokensIn` tier decides
  whether a finding is emitted at all. Never gate on the broad tier.
- `scoring/confidence.ts` — `ConfidenceLadder` / `SeverityLadder`. Every
  score is a base plus named deltas, rendered into evidence.
- `util/scope-class.ts` — one answer to generated / vendored /
  migration / fixture / test / config / production.
- `manifest/`, `agents/` — package-manifest and agent-config
  inventories for the repo-level detectors.

Key boundaries:

- **`core` owns the schema and scoring.** Detectors live here and depend only on a `DetectorContext` abstraction. They must not import language-specific parsers directly — language packs feed `core` via the context.
- **`language-js` is the first of many language packs.** Don't bake TS/JS assumptions into `core`. When in doubt, push parser-specific code down into the language pack.
- **`reporter` is presentation only.** It must not compute scores or filter findings beyond what core exposes. If a reporter needs new data, add it to the finding schema.
- **`cli` is orchestration only.** Argument parsing (Commander.js), config loading, calling core, handing results to a reporter. No detection logic.

## Scoring model

Each finding carries six scores (see `PRD.md` §10): `severity`, `confidence`, `blast_radius`, `churn`, `test_gap`, `agent_risk`. Default ranking is by **aggregate risk**, not severity alone — `agent_risk` is the differentiator and must not be collapsed into severity. Multiple sources of truth, misleading names, weak tests, and hidden side effects raise `agent_risk` even when local severity is low.

## Stack decisions (locked unless PRD changes)

- Language: TypeScript on Node.js
- Package manager: pnpm (workspaces)
- Build: tsup
- Tests: Vitest
- CLI framework: Commander.js (not oclif — keep it light)
- Lint/format: Biome (or ESLint/Prettier — pick one, don't run both)
- Versioning: Changesets
- AST: ts-morph or `@typescript-eslint/typescript-estree` for TS/JS
- File walking: fast-glob + `ignore` (respect `.gitignore`)
- Git history: simple-git or shelling out
- Validation: zod for config and schema validation
- CI: GitHub Actions
- Website: Astro + Starlight preferred over Next.js (docs-led site)

Don't reach for Rust, oclif, or LLM SDKs in v0 — explicitly deferred in the PRD.

## MVP scope (Milestone 1)

The first working CLI is `crimes scan` with these detectors only — resist scope creep:

- Structural: large function, large file, deep nesting, too many params, large React component, barrel/kitchen-sink files
- Dependency: circular deps, deep imports, layer violations (config-driven), high fan-in/fan-out
- Duplication: exact duplicate blocks, near-duplicate functions, repeated string literals, duplicated role/status/plan checks
- Testability: direct `Date.now()`/`new Date()`/`Math.random()`/`process.env` in domain code, mixed pure+side-effect functions
- Git/history: churn hotspots, frequently-changed + weakly-tested files, bug-fix churn

Required commands for v0: `scan`, `scan --changed`, `explain <id>`, `context <file>`, `hotspots`, `diff main...HEAD`, `verdict`, `init`.

Deferred to v0.2: `tests`, `baseline save`, `ignore`. Deferred to v1+: `ask`, `plan`, `pr-comment`.

## Configuration

- Zero-config must work. Defaults exclude `node_modules`, `dist`, `build`, `.next`, `coverage`, lockfiles, minified files.
- User config lives at `crimes.config.json` (simple) with `.crimes/` for baseline/suppressions/cache. Don't invent a third location.
- Config shape is in `PRD.md` §18. `architecture.layers` + `architecture.rules` drive layer-violation detection — this is config-driven, not hardcoded.

## npm package + binary naming

- Published package name: `crimes` (resolved — uses the unscoped name).
- Internal workspace packages remain scoped: `@crimes/core`, `@crimes/language-js`, `@crimes/reporter`.
- Binary is `crimes` (`bin.crimes` in `packages/cli/package.json`).
- `npx crimes scan` is the canonical first-run command in all docs.

## Eval baseline version bumps

The `packages/cli/package.json` `version` field doubles as the eval
**baseline version** — the runner writes results to
`evals/results/<version>/`. Between releases we're in continuous
improvement: any change that would move the eval baseline — whether
it's a **calibration change** (scoring logic, judge prompts, scenario
rubrics, fixture finding sets) or a **product change** that affects
findings (detector fixes, new detectors, scoring formula tweaks) —
gets a **patch bump in the same commit**, with **no release / no
Changeset / no tag**. Re-run `pnpm run evals` so the new baseline
lands in the new directory and commit it alongside.

We cut a real semver release (minor for new features, major for
breaking changes) when we're ready to ship — at which point the
accumulated patch bumps roll into the release version. Full rule and
rationale in [`evals/README.md` § Versioning policy](evals/README.md).

When a delta is a measurement correction rather than a quality
improvement (or vice versa), say so in the commit message.

## Open questions (resolved as of 0.8.0)

PRD §26's open questions have mostly settled into shipped reality:
npm name `crimes` is taken (the published package), the GitHub org
is `ortomate`, the license stays MIT, the site is Astro +
Starlight under `apps/website/`. Python in v0 is still deferred per
PRD §26. `crimes ask` is still deferred to v1+ — explicitly out of
scope through the 0.8.0 milestone.
