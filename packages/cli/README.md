# crimes

> A crime scene investigator for your codebase. **Built for agents, readable by humans.**

[![npm version](https://img.shields.io/npm/v/crimes.svg)](https://www.npmjs.com/package/crimes)
[![license](https://img.shields.io/npm/l/crimes.svg)](https://github.com/ortomate/crimes/blob/main/LICENSE)

`crimes` is an open-source CLI that scans a repository for maintainability
risks, code smells, duplicated business rules, weak test boundaries,
information-architecture drift, and patterns that confuse AI coding
agents.

It is **not** another linter. It answers a higher-value question:

> _Where in this repo is future change most likely to go wrong, and what
> should a human or coding agent know before editing it?_

**`0.11.1` headline:** first calibration patch on `0.11.0`: compact
hook output for pre-edit briefings, capped `hotspots --format json`
with hidden counts, scan headers that show severity buckets up front,
and clearer agent-discovery help. **`0.11.0` headline:** `crimes triage` is the new recommended
front door for handling existing findings — interactive per-finding
walk over the current scan, persisting dispositions (`fix-now`,
`fix-this-PR`, `needs-design`, `wont-fix`, `scaffolding`) to
`.crimes/triage.json`. Silenced triage entries and baseline entries
now **resurface automatically** in `crimes scan` when their file is
in the branch diff against `main`, so a one-time decision doesn't
become permanent amnesia. `crimes init --agents` ships a Claude
Code `PreToolUse` Edit hook so the pre-edit briefing happens
without the agent having to remember to call `crimes context`. Two
new required `Finding` fields — `effort` and `fix_shape` — bump
`schema_version` to `"0.2.0"`; the loader still accepts `"0.1.0"`
on committed `.crimes/` state files. Secondary scores read as prose
(`blast top-quartile (11 importers)` instead of `0.72`); JSON
numerics are unchanged. Still deterministic, still no LLM / API
key / network required. `crimes@0.10.0` shipped the front-door
redesign (auto-init, lead-with-`context`); `crimes@0.9.2` shipped
emoji severity glyphs and the move to `ortomate/crimes`. See the
[root README](https://github.com/ortomate/crimes#status--crimes0111)
for the full version history.

- Website: **[crimes.sh](https://crimes.sh)**
- Repo: **[github.com/ortomate/crimes](https://github.com/ortomate/crimes)**

---

## Install

Requires Node.js ≥ 18.

```bash
npm install -g crimes
crimes scan .

# Or one-shot via npx
npx crimes scan .
```

`pnpm dlx crimes scan` and `bunx crimes scan` also work.

---

## What it does

Run `crimes` against any TypeScript / JavaScript repository:

```bash
# Per-file / per-directory
crimes scan .                                   # default top-10 findings
crimes scan . --format json                     # stable JSON contract
crimes scan . --all                             # every finding

crimes scan --changed --format json             # working-tree changes only
crimes scan --changed --base main --format json # + commits on this branch
crimes scan --changed --fail-on high            # CI gate — exit 1 on a new high

crimes context src/billing.ts --format json     # per-file pre-edit briefing
crimes hotspots --since 90d --format json       # git churn × findings ranking

# Branch / PR safety
crimes diff main...HEAD --format json           # new / fixed / unchanged crimes
crimes baseline save                            # snapshot pre-existing findings
crimes baseline check --fail-on medium          # fail CI only on new debt
crimes verdict --base origin/main --fail-on new-high  # branch-level gate
```

The JSON output is the **stable product API** (`schema_version: "0.2.0"`).
Every report carries a `report_type` discriminator (`"scan"`, `"context"`,
`"hotspots"`, `"diff"`, `"baseline"`, `"baseline_check"`, `"verdict"`).
Agents should consume it directly.

Uniform exit-code contract across all gating commands: `0` success,
`1` configured `--fail-on` threshold met, `2` usage / environment
error. See [`docs/ci.md`](https://github.com/ortomate/crimes/blob/main/docs/ci.md)
for the three recommended CI modes and a copy-paste GitHub Actions
workflow.

---

## Detectors in this release

### Structural detectors (since `0.1.0`)

| Detector            | Charge                | What it flags                                                              |
| ------------------- | --------------------- | -------------------------------------------------------------------------- |
| `large_function`    | God Function          | Functions / methods / arrows over a body-line threshold (default 60)        |
| `large_file`        | God File              | Files over a line threshold (default 300)                                  |
| `todo_density`      | Unfinished Business   | High density of `TODO` / `FIXME` / `XXX` / `HACK` markers                   |
| `direct_date`       | Temporal Recklessness | Direct uses of `Date.now()` and `new Date()` in source files                |

### Information architecture detectors (new in `0.3.0`)

| Detector                        | Charge                       | What it flags                                                                                                                       |
| ------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `missing_agent_context`         | Missing Agent Context        | Repo declares a `bin` but ships no `AGENTS.md` / `CLAUDE.md` / `.claude/skills/*/SKILL.md`                                            |
| `route_metadata_drift`          | Route Metadata Drift         | Route path, file, default-export component, `<title>`, `metadata.title`, and nav labels describe the same destination differently   |
| `duplicated_navigation_source`  | Duplicated Navigation Source | One internal destination appears in ≥2 nav-like sources with different non-empty labels                                              |
| `concept_alias_drift`           | Concept Alias Drift          | Multiple aliases from a seeded concept group (`team`/`workspace`/`org`, `plan`/`subscription`/`tier`, …) share the product surface  |
| `docs_code_drift`               | Docs-Code Drift              | A markdown doc under `docs/` (or root-level `*.md`) contains a local link that does not resolve on disk                              |

IA findings populate `related_files` with the other paths that
contributed evidence, and the human reporter renders them as an "Also
touches:" block (capped at 5). Long-form reference (quorum rules,
false-positive notes, suggested fixes):
[`docs/finding-types/ia.md`](https://github.com/ortomate/crimes/blob/main/docs/finding-types/ia.md).

IA findings phrase summaries as "appears to" / "may" — they are
**ambiguity signals**, not claims of semantic truth.

Every finding includes **evidence** (raw facts the detector observed) and
**scores** (`severity`, `confidence`, `agent_risk`).

---

## For coding agents

`crimes` is built for AI coding agents (Claude Code, Codex CLI, Cursor,
Aider, Continue, Copilot Workspace, …). Recommended loop:

```bash
# 1. Before editing a file
crimes context <file> --format json

# 2. Make the change

# 3. After editing — re-scan only what you touched
crimes scan --changed --format json
```

Repos that bundle [`AGENTS.md`](https://github.com/ortomate/crimes/blob/main/AGENTS.md)
or [`.claude/skills/crimes/SKILL.md`](https://github.com/ortomate/crimes/blob/main/.claude/skills/crimes/SKILL.md)
will surface this workflow to their agents automatically.

Decision rule: any **new `severity: "high"` finding** introduced by your
edit is a blocker — fix it, or surface it citing the finding `id` and
`charge`.

Full agent guide:
[`docs/agent-usage.md`](https://github.com/ortomate/crimes/blob/main/docs/agent-usage.md).

---

## Configuration

Zero-config by default. Drop a `crimes.config.json` at the repo root to
override:

```json
{
  "include": ["src/**/*.{ts,tsx,js,jsx}"],
  "exclude": ["**/node_modules/**", "**/dist/**", "**/*.generated.*"],
  "thresholds": {
    "largeFileLines": 300,
    "largeFunctionLines": 60,
    "todoDensityPerKLoc": 10
  }
}
```

---

## Docs

- [README](https://github.com/ortomate/crimes/blob/main/README.md) — full tour
- [Agent guide](https://github.com/ortomate/crimes/blob/main/docs/agent-usage.md) — pre/post-edit workflow
- [JSON schema](https://github.com/ortomate/crimes/blob/main/docs/json-schema.md) — wire format
- [Roadmap](https://github.com/ortomate/crimes/blob/main/docs/roadmap.md) — what's next

---

## License

[MIT](https://github.com/ortomate/crimes/blob/main/LICENSE).
