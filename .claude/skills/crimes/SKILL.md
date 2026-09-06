---
name: crimes-codebase-risk
description: Inspect change risk with crimes when planning, editing or reviewing code in a repository that uses the CLI. Covers TypeScript, JavaScript and Python; interpret evidence and analysis limits before acting.
---

# crimes workflow

Work from the intended repository root and follow its AGENTS.md and test
policy. Select the executable once: use `./node_modules/.bin/crimes` when it
exists, or the project's script that resolves that local installation.
In the crimes source checkout, use `node packages/cli/dist/index.js` after
building. For a global-only installation, resolve `command -v crimes` and
retain its absolute path. Check `--version` through the selected executable.
Keep that exact path before and after edits; shell PATH can change between
commands and a global CLI can be older than the project's package.
If none is installed, report that limitation; do not silently download or
upgrade tools. Examples below use the local path. Substitute the selected
source-checkout or absolute global command only when no local install exists.

Before editing, run `./node_modules/.bin/crimes context <file> --root . --format json`.
Without `--root`, context uses the nearest package/project root and may
omit monorepo consumers. Read `analysis_status`, `coverage.warnings`,
`agent_guidance`, evidence, related files and likely tests. Investigate
`partial` or `not_analyzed` before interpreting an empty list. No findings
does not establish safety; `test_gap` describes discovery, not test coverage.

Retain a pre-edit JSON scan for the intended files, for example
`./node_modules/.bin/crimes scan --files src/a.ts,src/b.ts --format json`. Store snapshots outside
the scanned sources (a temporary directory is suitable). For import neighbors,
use `scan --related-to src/api.ts --format json`. Context and scoped scans
still analyze the repository; smaller output does not promise a cheaper scan.

After editing, repeat the same scan with the same root, file scope and
configuration. Compare opaque `fingerprint` values from JSON to identify
new, retained and absent observations; do not construct fingerprints or
compare positional finding IDs. If the scope expanded, distinguish files
without a pre-edit snapshot from demonstrated new findings.
`scan --changed --format json` is useful to discover the working set,
but includes old findings in those files. Its failure threshold is not a
new-findings-only gate. For committed branch changes use `verdict --base
<project-base> --format json`; verify the actual base instead of assuming main.

Run the repository's behavior tests independently. Handle new high findings
according to its policy, explaining evidence and uncertainty. Do not turn
unrelated findings into extra work or silently change thresholds/suppressions.
Preserve useful regression coverage. Do not delete test checks or move them
to a one-off command solely to make the risk report clean.
Exit 2 means a usage/environment error; exit 1 can mean a configured gate
failed. A successful exit does not establish complete analysis or safety.

Within the user's scope, record a false positive with `./node_modules/.bin/crimes feedback
<fingerprint> --verdict fp --note "<reason>"`. This writes feedback and a
suppression. Reconfirm resurfaced feedback with the user. For stale identities,
preview `./node_modules/.bin/crimes migrate-pins --format json`, review candidates, then apply
the reviewed file. An absent observation is not proof of a resolved problem;
never silently renew an expiry or prior decision.

Summarize the evidence and tests that affect the task. Human output is useful
for terminal reports; do not rerun analysis solely to repeat its formatting.
Normal CLI use reports outdated skills on stderr. If that notice appears,
run `./node_modules/.bin/crimes init --refresh-skills` from the named project root to update
unchanged generated copies; `--check` previews without writing. Review
customized-file diffs before replacing. CI skips maintenance; use
`--no-skill-update` when a task requires no maintenance notices or updates.
More detail: https://crimes.sh/docs/agent-usage/

<!-- crimes-skill {"format":1,"version":"0.29.0","sha256":"37c69f9f31c46c0cb1c163a63f7065894ba9928ccd27ace0eaadcbc11a7438cc"} -->
