# AGENTS.md

`crimes` scans for change risk and agent risk. JSON is the public product
contract. Read [README](./README.md) for the workflow and
[CONTRIBUTING](./CONTRIBUTING.md) before implementing a detector.

## Current capabilities

TypeScript, JavaScript, Python, cross-language and universal analysis ship.
The package version is in `packages/cli/package.json`; the JSON schema is
`0.8.0`. [Generated reference](./docs/reference.md) lists shipped commands,
detectors and optional defaults. [Roadmap status](./docs/roadmap.md) separates
implementation from plans. `crimes ask` is not implemented.

## Develop and verify

Use the Node version in `.nvmrc` for release work, pnpm 10.14.0 and Python
3.10+ for the evaluation oracle/method tests included in `pnpm verify`.
The published CLI supports Node >=18.

```bash
pnpm install
pnpm build
node packages/cli/dist/index.js context packages/core/src/scan.ts --root . --format json
node packages/cli/dist/index.js scan packages/core --format json
pnpm docs:generate
pnpm verify
pnpm --filter crimes smoke
```

`pnpm verify` runs format, lint, build, generated-reference check, typecheck,
and tests. `pnpm ci` is reserved; use `pnpm verify`.
Before risky core/language edits, retain the pre-edit JSON and compare the
post-edit findings. A changed-files scan selects files, not new findings.
Use fingerprints or `diff`/`verdict`/baseline for a finding delta.

## Interpretation

Use [agent usage](./docs/agent-usage.md) for pre/post-edit decisions. Pass
`--root .` for a monorepo-wide briefing. Read `analysis_status` and coverage
warnings before interpreting an empty list. Resolved imports lead the test
and related-file lists; these are discovery hints, not executed coverage.

Read evidence before acting. Review false positives with
`crimes feedback <fingerprint> --verdict fp --note "<reason>"`.
When JSON says `previously_suppressed: true`, surface the supplied
“Previously marked fp” hint and ask whether to reconfirm `fp` or mark `tp`;
do not silently re-suppress. See [feedback](./docs/feedback.md).
For stale pins use the reviewed [migration plan](./docs/pin-migration.md),
which preserves prior reasons and expiry. Read
[calibration followups](./docs/calibration-followups.md) before changing a
noisy detector: its behavior may already be an intentional decision.

## Architecture and style

- `packages/core`: schema, scoring and detectors. Consume language-pack
  contexts; keep parser-specific logic in `language-js` or `language-py`.
- `packages/reporter`: presentation. Core supplies ranking and scores.
- `packages/cli`: argument/config orchestration, no detection logic.
- `apps/website`: static landing page and Astro/Starlight docs, mirrored
  from `docs/`; update the source docs rather than generated pages.
- TypeScript, ESM, `.js` import extensions, strict mode and
  `noUncheckedIndexedAccess`. Guarded non-null assertions are normal here.
- Biome only; 90 columns, two spaces, double quotes. Do not add ESLint or
  Prettier. Never reformat `examples/`, `evals/fixtures/`, `docs/fixtures/`
  or `evals/results/`: their bytes are scanner/evaluation input.
- Tests sit beside source. New detectors need fixture-based tests and
  concrete evidence. Conservative heuristics and a concise default report
  matter more than finding counts.

## Safety rules for agents

These are non-negotiable inside this repo:

1. **Never publish.** Do not run `npm publish`, `pnpm publish`, `pnpm
   changeset publish`, `git tag`, or `git push --tags`, and never publish
   a GitHub Release: publishing one fires `release.yml`, which publishes
   `crimes` to npm, and a published version cannot be reused. Preparing a
   release and drafting the GitHub Release are yours to do; the Publish
   click is a human's. The exact split is in
   [`docs/releasing.md`](./docs/releasing.md), section "If you are an
   agent".
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


## Further references

- [PRD](./PRD.md): product requirements; historical milestone dates are
  reconciled in [roadmap status](./docs/roadmap.md).
- [Scoring](./docs/scoring.md), [JSON](./docs/json-schema.md),
  [configuration](./docs/configuration.md), [CI](./docs/ci.md).
- [Evaluation](./docs/evals.md): detection/ranking measurements and actual
  paired edits answer different questions.
- [Releasing](./docs/releasing.md): preparation, checks, draft and publishing boundary.
