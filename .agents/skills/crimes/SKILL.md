---
name: crimes-codebase-risk
description: Use when editing, reviewing, or investigating a TypeScript / JavaScript codebase that ships with the crimes CLI. Helps agents run pre-edit context checks, post-edit scans, and interpret findings before risky changes.
---

# crimes — codebase risk workflow

`crimes` is a deterministic CLI (no LLM) that reports change risk and
agent risk. JSON output is the stable contract for agent decisions;
prefer it when planning. For user-facing readbacks, use the default
human output instead of rebuilding the report in your own prose.

## When to run it

- Before editing an unfamiliar file: `crimes context <file> --format json`
- Before a broad refactor: `crimes scan <path> --format json`
- After edits: `crimes scan --changed --format json`
- Before merging a branch: `crimes verdict --format json`

## Decision rules

- Treat any new `severity: "high"` finding introduced by your edit as a blocker unless the user explicitly accepts it.
- Read `evidence[]` before acting; it contains deterministic facts, not LLM opinion.
- Use `scores.agent_risk` to decide which findings need human attention first.
- If a finding is a false positive, record feedback with `crimes feedback <fingerprint> --verdict fp --note "<why>"` rather than silently ignoring it.

## Reporting findings back to humans

Use `--format json` when you need to plan, gate, compare, or make
decisions. When the user wants to see the results, or when you are
summarising findings back in chat, prefer running the same command
without `--format json` and quote or paste the relevant human-readable
readout. The human report is intentionally designed for people:
severity glyphs, grouped findings, evidence, feedback commands,
suppressions, and gate status are already rendered there.

Do not paraphrase the whole JSON payload in your own voice unless you
need a short executive summary. Use the human readout as the canonical
user-facing presentation, and add your own interpretation only around
the parts that matter for the task.
