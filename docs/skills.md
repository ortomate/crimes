# Bundled agent assets

`crimes` ships on-disk artefacts that AI coding agents pick up
automatically. Together they teach an agent **when** to invoke `crimes`,
**which** command to run, and **how** to interpret the JSON output. There
is nothing to install — they live in the repo.

This page is a short catalogue. The deep workflow doc is
[`agent-usage.md`](./agent-usage.md).

---

## `AGENTS.md` (repo root)

The convention used by Codex CLI, Aider, Cursor, OpenAI agents, and a
growing number of other coding assistants: a single file at the repo root
that describes how to work in the project.

Path: [`AGENTS.md`](../AGENTS.md)

Covers:

- Install commands (`npm install -g crimes`, plus the contributor
  `pnpm install` / `pnpm build` flow for working on the monorepo itself)
- Build / typecheck / test (`pnpm ci`, per-package filters)
- The shipped `crimes` commands (`scan` with `--changed [--base <ref>]
  [--fail-on …]`, `context`, `hotspots`, `diff`, `baseline save` /
  `baseline check`, `verdict`) and their JSON flags
- Project architecture and package boundaries
- Coding style notes
- Safety rules for agents — no auto-publish, no shared-branch rewrites,
  no silent auto-fix of findings

Picked up automatically by: Codex CLI, Claude Code (alongside `CLAUDE.md`),
Cursor, Aider, Continue, Copilot Workspace, and most other agents that
follow the `AGENTS.md` convention.

## `.claude/skills/crimes/SKILL.md`

A Claude Code skill that activates when the user invokes it (e.g.
`/crimes` or when Claude judges the skill relevant to a coding task in
this repo).

Path: [`../.claude/skills/crimes/SKILL.md`](../.claude/skills/crimes/SKILL.md)

Covers:

- When to invoke `crimes` (and when to skip it)
- The pre-edit / post-edit loop with exact commands
- Decision rules — what counts as a blocker, how to read `evidence` and
  `scores.agent_risk`
- Auto-fix policy — when **not** to "fix" findings without user approval
- The five finding fields that matter most
- Schema stability notes

Picked up automatically by: Claude Code (any `SKILL.md` under
`.claude/skills/<name>/` is discoverable).

If you are using a different agent that supports the
`description:`-frontmatter skill format (some tools do), this file is a
reasonable drop-in.

## `.agents/skills/crimes/SKILL.md`

A Codex skill that activates when Codex judges the workflow relevant to a
coding task in this repo.

Generated path: `.agents/skills/crimes/SKILL.md`

Run:

```bash
crimes init --codex-skill
```

or:

```bash
crimes init --agents
```

The content mirrors the Claude Code skill: pre-edit context checks,
post-edit changed-file scans, branch verdicts, blocker policy, and
false-positive feedback capture.

Picked up automatically by: Codex CLI (`SKILL.md` under
`.agents/skills/<name>/`).

---

## How the two pieces fit together

| Question                                                | Source           |
| ------------------------------------------------------- | ---------------- |
| "How do I build and test this repo?"                    | `AGENTS.md`      |
| "What's the architecture, what should I not touch?"     | `AGENTS.md`      |
| "What's the safety policy for an agent editing here?"   | `AGENTS.md`      |
| "Before I edit, what command should I run?"             | agent `SKILL.md` |
| "After I edit, what's the post-edit gate?"              | agent `SKILL.md` |
| "Is this finding a blocker?"                            | agent `SKILL.md` |
| "What does field X in the JSON mean?"                   | `json-schema.md` |
| "How should I present results back to the user?"        | `agent-usage.md` |
| "Show me a worked pre/post-edit example."               | `agent-usage.md` |

`AGENTS.md` is the **repo handbook**. `SKILL.md` is the **workflow recipe**.
`agent-usage.md` is the **long-form manual**. `json-schema.md` is the
**wire format reference**.

---

## What is **not** bundled (yet)

- A Cursor-specific rules file (`.cursorrules`).
- A Continue config preset.
- A Copilot Workspace `.github/copilot-instructions.md`.

These are not blockers — `AGENTS.md` is read by most of those tools — but
PRs adding agent-specific presets are welcome.

A copy-paste **GitHub Actions workflow** already ships at
[`examples/github-actions/crimes.yml`](../examples/github-actions/crimes.yml)
(see [`docs/ci.md`](./ci.md) for the three gating modes).

---

## Keeping these files honest

Two non-negotiable rules:

1. **Never document a command that does not exist yet.** Cross-check
   against [`docs/roadmap.md`](./roadmap.md) and the actual
   commands registered in [`packages/cli/src/index.ts`](../packages/cli/src/index.ts).
2. **The JSON in examples must match the current schema.** If you change
   `schema_version`, update every example in these docs in the same
   change.
