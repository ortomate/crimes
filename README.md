# crimes

> Know what could go wrong before you change the code.

[![npm](https://img.shields.io/npm/v/crimes.svg)](https://www.npmjs.com/package/crimes)
[![CI](https://github.com/ortomate/crimes/actions/workflows/ci.yml/badge.svg)](https://github.com/ortomate/crimes/actions)
[MIT](./LICENSE) · [Website](https://crimes.sh) · [Documentation](https://crimes.sh/docs/)

`crimes` is a local, deterministic CLI for **change risk and agent risk**.
It finds duplicated policies, drifting contracts, hidden side effects,
weak test signals and dependencies an unfamiliar contributor could miss.
It supports TypeScript, JavaScript and Python, with universal checks for
other files and cross-language checks for polyglot repositories.
No account, cloud service or LLM is required to run the scanner.

## Install and try it

Requires **Node.js 18 or newer**.

```bash
npx crimes scan .
# Or install once:
npm install -g crimes
```

The default human report groups findings into the top five files. Each
finding includes evidence you can check. These are review leads, not
instructions to refactor everything or proof that code is unsafe.

## The change workflow

```bash
# Before editing: findings, dependencies, likely tests and editing guidance.
crimes context src/billing/tax.ts --root . --format json

# Plan a change to known files, or explore an import neighbourhood.
crimes scan --files src/billing/tax.ts,src/billing/invoice.ts --format json
crimes scan --related-to src/billing/tax.ts --format json

# After editing: inspect findings in the changed files.
crimes scan --changed --format json

# Compare committed branch findings with the base.
crimes verdict --base origin/main --fail-on new-high
```

`--root .` keeps context paths and configuration anchored to the current
repository. Without it, `context` selects the nearest enclosing package
root; use an explicit root for a workspace-wide briefing.

Read `analysis_status` and `coverage.warnings` before interpreting an empty
result. `likely_tests` and `test_gap` describe discoverable tests, not
measured coverage or test quality. See the [short agent guide](./docs/agent-usage.md).

## Adopt it without clearing a backlog

```bash
crimes triage                         # interactive dispositions with reasons
crimes triage --apply decisions.json   # non-interactive alternative
crimes baseline save                  # snapshot existing debt for CI
crimes baseline check --fail-on medium
```

Commit `.crimes/triage.json`, `.crimes/suppressions.json` and any baseline
with your project. To report a false positive, copy its fingerprint from
JSON and run `crimes feedback '<fingerprint>' --verdict fp --note 'why'`.
For stale fingerprints, `crimes migrate-pins --format json` previews a
migration; review it before applying. [Migration guide](./docs/pin-migration.md).

**Changed files and new findings are different.** `scan --changed --fail-on high`
blocks on any high finding in those files, including old findings.
`verdict`, `diff` and baseline checks compare finding identities.
[CI recipes and exit codes](./docs/ci.md).

## What it prioritises

Findings rank by a composite of detector evidence, churn, test discovery
and dependency reach, with a recency boost by default. File priority starts
with the strongest finding and adds diminishing contributions from distinct
claims. Repetition alone does not make a file the first thing to fix.
[Scoring and limitations](./docs/scoring.md).

Naming conventions, local accessibility checks and raw style concentration
are optional. Existing linters remain useful for those jobs. Enable specific
optional checks in `crimes.config.json` when they fit your project.
The [generated command and detector reference](./docs/reference.md) names
what is available and what runs by default.

## Agent setup and updates

```bash
crimes init --agents                  # install project skills and Claude hook
```

After CLI upgrades, normal terminal use refreshes unchanged generated skills
and reports what changed. Agent/JSON calls receive a safe update command on
stderr. CI stays read-only. Custom instructions and hook settings are preserved;
`--no-skill-update` skips maintenance. [Setup and upgrade guide](./docs/skills.md).

## Status — crimes@0.28.2

0.28 improves pre-edit briefing completeness, test/dependency guidance,
default signal, fingerprint migration and documentation consistency.
The JSON schema remains **0.8.0**; new reporting fields are optional.
0.28.2 makes skill updates discoverable, repairs Claude hook delivery and
aligns feedback/triage JSON with a generated API reference.
Read [release notes](./docs/releases/v0.28.2.md) before upgrading.
The npm badge reports the published version; the package file reports the
version being prepared. [Earlier releases](./docs/releases/).

## Develop and contribute

```bash
# Use the Node version in .nvmrc and pnpm 10.
pnpm install --frozen-lockfile
pnpm verify
pnpm --filter crimes smoke
```

`packages/core` owns analysis and scoring; language packages parse;
`packages/cli` orchestrates; `packages/reporter` renders; `apps/website`
hosts the site and documentation. Read [CONTRIBUTING.md](./CONTRIBUTING.md)
and [AGENTS.md](./AGENTS.md) before changing detectors.

[Product principles](./PRD.md) · [Roadmap](./ROADMAP.md) ·
[Configuration](./docs/configuration.md) · [JSON contract](./docs/json-schema.md) ·
[Release procedure](./docs/releasing.md)
