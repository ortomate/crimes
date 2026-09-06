---
name: crimes-codebase-risk
description: Use crimes to inspect change risk before and after edits in a repository that uses the CLI. Covers TypeScript, JavaScript and Python; interpret its evidence and analysis limits before acting.
---

# crimes workflow

Use JSON for decisions. Before editing, run `crimes context <file> --root .
--format json` from the intended repository root. Without `--root`, context
uses the nearest package/project root, which may omit monorepo consumers.
For several files use `scan --files a.ts,b.ts --format json`; for import
neighbors use `scan --related-to src/api.ts --format json`.

Read `analysis_status`, `coverage.warnings`, evidence, related files and
likely tests. `partial` or `not_analyzed` requires inspecting what was
missed. No findings does not establish safety, and `test_gap` describes
test discovery, not behavioral coverage. Context shares scan's analysis;
scoping narrows output, not the repository analysis cost.

After editing, compare `scan --changed --format json` with the pre-edit
findings. This selects changed files, including their old findings.
Use `verdict --base main --format json` for committed branch differences.
Run behavior tests independently. Treat a new high-severity finding as a
blocker unless the user accepts it. Do not fix unrelated findings.

A false positive can be recorded with `crimes feedback <fingerprint>
--verdict fp --note "<reason>"` within the user's scope. Reconfirm resurfaced
feedback with the user. For stale identities, preview `crimes migrate-pins
--format json`, review candidates, then apply the reviewed file. Never infer
that an absent finding is resolved or silently renew its expiry.

Summarize the evidence that affects the task. Use human output when a full
terminal report helps; rerunning a scan solely to repeat its presentation
is unnecessary. More detail: https://crimes.sh/docs/agent-usage/
