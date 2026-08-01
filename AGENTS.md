# AGENTS.md

Instructions for AI coding agents (Codex CLI, Claude Code, Cursor, Aider, etc.)
working inside this repository. Humans should read [`README.md`](./README.md)
and [`CONTRIBUTING.md`](./CONTRIBUTING.md) first; this file is the
agent-facing summary.

> Project: `crimes` — a CLI that scans a repo for **change risk** and
> **agent risk**, not style or security. JSON output is the product contract.
> See [`PRD.md`](./PRD.md) for the spec, [`README.md`](./README.md) for the
> user-facing tour, and [`docs/roadmap.md`](./docs/roadmap.md) for what
> currently works.

---

## Install

`crimes` is published on npm:

```bash
npm install -g crimes      # global install — provides the `crimes` binary
npx crimes scan .          # or one-shot via npx
```

For working **on** this monorepo, requires **Node.js ≥ 18** and **pnpm 10**:

```bash
pnpm install        # install workspace dependencies
pnpm build          # build all packages (tsup)
```

You can then invoke the locally-built CLI from the repo root:

```bash
node packages/cli/dist/index.js --help
node packages/cli/dist/index.js scan examples/messy-ts-app
```

Convenience scripts:

```bash
pnpm scan:example         # build CLI + scan the bundled fixture (human format)
pnpm scan:example:json    # same, JSON output
```

## Build, typecheck, test

Run from the repo root. These three commands are the canonical "is the
workspace healthy" check — run them after any non-trivial change.

```bash
pnpm format:check # biome format .   (read-only)
pnpm lint         # biome lint .
pnpm build        # tsup across every package
pnpm typecheck    # tsc --noEmit across every package
pnpm test         # vitest run across every package
pnpm verify       # all five, sequentially (matches CI)
```

`pnpm format` and `pnpm lint:fix` write fixes. `pnpm verify` runs the
read-only forms first, so a formatting slip fails in seconds rather
than after a full build and test pass.

Note: it is `pnpm verify`, not `pnpm ci`. pnpm reserves `ci` as a
built-in command, so `pnpm ci` fails with
`ERR_PNPM_CI_NOT_IMPLEMENTED` and never reaches the workspace script.
`pnpm run ci` still works as an alias.

Per-package work:

```bash
pnpm --filter @crimes/core build
pnpm --filter @crimes/core test
pnpm --filter crimes smoke   # pack + install + run the published tarball in a temp dir
```

`pnpm --filter crimes smoke` is the gold-standard "did I break the release
path" check. It runs every shipped command against the bundled fixture.

## Scan commands (the product itself)

All commands print to stdout. `--format json` is the **stable contract** —
prefer it when planning or making decisions programmatically.

```bash
# Directory scan
crimes scan [path]
crimes scan . --format json
crimes scan . --all                       # show every finding (not just top 10)

# Changed-files-only scan (requires a git repo)
crimes scan --changed --format json                     # working tree vs HEAD
crimes scan --changed --base main --format json         # + commits on this branch
crimes scan --changed --base origin/main --format json  # + commits not yet pushed
crimes scan --changed --fail-on high                    # CI gate — exit 1 on a new high
crimes scan --changed --fail-on medium --format json    # JSON gains `fail_on` + `failed`

# Single-file context (findings + likely tests + safe-editing notes)
crimes context <file> --format json
crimes context <file> --root ./packages/api --format json

# Git churn × findings, ranked by aggregate risk
crimes hotspots --format json
crimes hotspots --since 30d --format json

# New / fixed / unchanged crimes between two committed refs.
# Working-tree-safe — exports each ref via `git archive` into a temp dir.
crimes diff main...HEAD --format json
crimes diff origin/main...HEAD --format json

# Pin pre-existing findings, then fail CI only on new ones.
# `.crimes/baseline.json` is intended to be committed.
crimes baseline save                                   # snapshot, write the file
crimes baseline check --format json                    # gate on default `--fail-on medium`
crimes baseline check --fail-on high --format json     # stricter — only new high findings fail

# One-line "did this branch make the repo cleaner, worse, unchanged, or mixed?".
# Default base: origin/main, then main.
crimes verdict --format json                           # advisory by default (always exit 0)
crimes verdict --base main --format json               # explicit base
crimes verdict --fail-on new-high                      # CI gate — exit 1 on any new high
crimes verdict --fail-on worse                         # CI gate — exit 1 when verdict is `worse`
```

If you are running against a checkout that has not been published to npm
yet (e.g. an unreleased version on `main`), prefix everything above with
`node packages/cli/dist/index.js` after running `pnpm build`.

**Shipped in `0.5.0`** — `crimes init`, `crimes ignore
<id-or-fingerprint> --reason "…"`, `crimes unignore <fingerprint>`,
`crimes audit-suppressions`, `crimes explain <id-or-fingerprint>
[--from <scan.json>]`, `crimes diff --fail-on new-high | new-medium`,
and `--show-suppressed` on every report-listing command. The
suppressions file at `.crimes/suppressions.json` is intended to be
committed; see [`docs/suppressions.md`](./docs/suppressions.md).

**Shipped in `0.6.0`** — no new commands; every new capability
surfaces through the existing command set. Per-finding
`scores.churn` / `scores.test_gap` / `scores.blast_radius` populated
by every scan plus a unified `agent_risk` formula
([`docs/scoring.md`](./docs/scoring.md)). 18 new detector types
across dependency-graph
([`finding-types/dependency.md`](./docs/finding-types/dependency.md)),
IA completion (added to
[`finding-types/ia.md`](./docs/finding-types/ia.md)), frontend / UI
agent-risk
([`finding-types/frontend.md`](./docs/finding-types/frontend.md)),
and duplication
([`finding-types/duplication.md`](./docs/finding-types/duplication.md)).
A new `cli_command_registrar` shape for `large_function` recognises
Commander-style registrar wrappers and `.action(...)` callbacks.
`crimes hotspots <subdir>` walks upward to the enclosing git repo.
Full docs site at [`crimes.sh/docs/`](https://crimes.sh/docs/).

**Shipped in `0.16.0`** — no new commands. Ten detectors across three
new finding families: correctness risk (`swallowed_error`,
`unsafe_retry`, `unbounded_async_fanout`, `mock_saturation` —
[`finding-types/correctness.md`](./docs/finding-types/correctness.md)),
cross-file authority (`duplicated_policy`, `contract_drift`,
`config_drift`, `pass_through_abstraction` —
[`finding-types/authority.md`](./docs/finding-types/authority.md)), and
agent hygiene (`dependency_provenance_gap`, `agent_permission_sprawl` —
[`finding-types/agent-hygiene.md`](./docs/finding-types/agent-hygiene.md)).
Schema stays `0.3.0`. New shared infrastructure lives in
`packages/core/src/risk/` (one-pass cross-file index),
`packages/core/src/domain/vocabulary.ts` (two-tier domain vocabulary),
`packages/core/src/scoring/confidence.ts` (explainable score ladders),
and `packages/core/src/util/scope-class.ts` (one generated/vendored/
fixture/test classifier). New fixture:
`examples/risky-service/`.

**Not yet implemented** — do not invoke or reference these in generated docs:
`crimes ask`. See [`docs/agent-usage.md`](./docs/agent-usage.md) for the
full shipped/deferred matrix and
[`docs/roadmap.md`](./docs/roadmap.md) for milestone status.

## Project architecture

Public TypeScript monorepo, pnpm workspaces. Boundaries encode the layering —
keep them clean.

```
apps/website/              # crimes.sh — static landing page
packages/cli/              # `crimes` binary (Commander) — orchestration only
packages/core/             # detector engine, finding schema, scoring
packages/language-js/      # TS/JS file discovery + AST parsing
packages/reporter/         # human + JSON formatters
examples/messy-ts-app/     # intentional-mess fixture for tuning
```

Rules of thumb:

- **`core` owns the finding schema and scoring.** Detectors live here. They
  must not import language-specific parsers directly — they consume a
  `DetectorContext` populated by a language pack.
- **`language-js` is one of many future language packs.** Don't push TS/JS
  assumptions into `core`.
- **`reporter` is presentation only.** No score computation, no filtering
  beyond what `core` exposes. New display data → extend the finding schema.
- **`cli` is orchestration only.** Argument parsing, config loading, calling
  `core`, handing results to a `reporter`. No detection logic.

## Coding style

- **TypeScript, ESM, Node ≥ 18.** Strict mode is on, plus
  `noUncheckedIndexedAccess` — which is why `arr[0]!` and
  `map.get(k)!`-after-`has()` are everywhere. That is the idiom here, not
  a smell.
- **Format/lint: Biome, and only Biome.** Config in
  [`biome.jsonc`](./biome.jsonc). Never add ESLint or Prettier alongside
  it. Run `pnpm format` before committing, or let `pnpm verify` catch you.
  2-space indent, double quotes, semicolons, trailing commas, 90 columns
  — all enforced, so match the formatter rather than hand-wrapping.
- **Never reformat `examples/`, `evals/fixtures/`, `docs/fixtures/`, or
  `evals/results/`.** Biome already excludes them. They are scanner
  *input*: line counts feed `large_function` / `large_file` thresholds,
  and `docs/fixtures/` is byte-compared against live scans. Reformatting
  them changes what the product reports.
- To silence a lint rule, prefer a one-line
  `// biome-ignore lint/<rule>: <reason>` immediately above the line over
  widening a config disable. The reason must fit on that single line; a
  wrapped `//` block stops suppressing.
- Imports use `.js` extensions even from `.ts` source (ESM/NodeNext
  resolution).
- Tests sit next to source files (`detector.ts` + `detector.test.ts`),
  Vitest, no global setup file. New detectors **must** have a fixture-based
  unit test before they ship.
- Findings must include concrete **evidence** strings — facts a reader can
  verify against the AST or file contents. No verdicts without receipts.
- Keep heuristics conservative: a noisy detector is a disabled detector.
- Default `crimes scan` shows top findings only; `--all` is opt-in. Mirror
  that "signal over exhaustiveness" rule when adding new surfaces.
- See [`CLAUDE.md`](./CLAUDE.md) and [`CONTRIBUTING.md`](./CONTRIBUTING.md)
  for full design constraints, especially the package boundaries.

## Using `crimes` while editing this repo

`crimes` scans itself. Before risky edits in `packages/core` or
`packages/language-js`, run:

```bash
crimes context packages/core/src/scan.ts --format json
crimes scan packages/core --format json
```

After a change, diff the findings against the pre-edit run. New
`severity: "high"` findings introduced by your edit are blockers unless the
user explicitly accepts the risk. See
[`docs/agent-usage.md`](./docs/agent-usage.md) for the full pre/post-edit
workflow.

### The 0.7.0 feedback loop

Every finding in `crimes scan` / `context` / `diff` human output
now carries a trailing one-line hint:

```
     Give feedback: crimes feedback <fingerprint> --verdict {tp|fp}
```

When you (or a user you're collaborating with) disagrees with a
finding, recommend the exact command above with `--verdict fp` and
a one-sentence `--note` explaining why. That note becomes the
suppression reason and the suppression auto-resurfaces on the
next crimes minor for re-confirmation.

When you see `previously_suppressed: true` on a finding in JSON
output, do NOT silently re-suppress. Surface the alternate
"⚠ Previously marked fp in 0.7" hint verbatim and ask the user
whether the finding is still a false positive (re-confirm `fp`) or
has been resolved (mark `tp`). The transition is the calibration
signal we collect.

Full guide: [`docs/feedback.md`](./docs/feedback.md).

## Safety rules for agents

These are non-negotiable inside this repo:

1. **Never publish.** Do not run `npm publish`, `pnpm publish`, `pnpm
   changeset publish`, `git tag`, or `git push --tags` without explicit user
   instruction. The package name `crimes` on npm is unclaimed; publishing
   prematurely is unrecoverable.
2. **Never force-push, reset, or rewrite shared branches** (`main`, any
   branch present on `origin/`). Local feature branches are fine.
3. **Don't auto-fix detector findings** without (a) a clear user request,
   (b) tests that cover the touched behaviour, and (c) a scoped change. The
   product's whole point is to surface risk — silently "fixing" findings
   erodes the contract.
4. **Don't add backwards-compatibility hacks** to the finding schema. If
   you need to break it, bump `schema_version` and update
   [`docs/json-schema.md`](./docs/json-schema.md).
5. **Don't introduce LLM SDKs, Rust, or oclif** in v0 — explicitly deferred
   per [`PRD.md`](./PRD.md) and [`CLAUDE.md`](./CLAUDE.md).
6. **Don't re-implement ESLint, Biome, Semgrep, or SonarQube detectors.**
   `crimes` is positioned as change-risk and agent-risk, not style or
   security. If a detector is "could be a linter rule", push back before
   building it.
6b. **Three boundaries the 0.16.0 slate holds, and you must too.**
   (a) **No network.** `dependency_provenance_gap` reports what this
   repo's own records say; it never contacts a registry and never
   claims a package is malicious, hallucinated, or unknown.
   (b) **Never execute discovered configuration.** `agent_permission_sprawl`
   reads hooks, MCP launch commands, and settings as text. Running one
   to analyse it would make this tool an RCE vector.
   (c) **Never put a configuration value in a finding.** `config_drift`
   reports names, locations, and literal defaults from committed
   source. A real `.env` is never opened — enforced at discovery in
   `risk/env-inventory.ts`, with a second independent filter.
7. **Treat the JSON schema as a public API.** New optional fields are OK;
   removing or repurposing existing ones is a breaking change requiring a
   `schema_version` bump.
8. **Run `pnpm verify` before declaring work complete.** Build +
   typecheck + test must all pass. (Not `pnpm ci` — pnpm reserves that
   name.)
9. **Commit when work is ready** (per the user's global preference in
   `CLAUDE.md`). Don't wait for explicit permission on every logical unit.
   Hold off if changes are mid-refactor, contain secrets, or the user has
   said "don't commit yet" for this branch.

## Where to read next

- [`PRD.md`](./PRD.md) — authoritative product spec.
- [`README.md`](./README.md) — user-facing tour.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to add detectors, languages,
  and run the dev loop.
- [`CLAUDE.md`](./CLAUDE.md) — design constraints and stack decisions.
- [`docs/agent-usage.md`](./docs/agent-usage.md) — pre/post-edit workflow
  for agents (this file's deep cousin).
- [`docs/json-schema.md`](./docs/json-schema.md) — wire format reference.
- [`docs/ci.md`](./docs/ci.md) — three recommended CI modes
  (changed-files / baseline / branch verdict), exit-code contract, and
  the GitHub Actions recipe.
- [`docs/skills.md`](./docs/skills.md) — what's bundled for Claude Code and
  Codex.
- [`docs/roadmap.md`](./docs/roadmap.md) — what currently ships vs what
  is planned.
