# Agent integration

The npm package contains the current skill template. Installing or updating
npm packages does not write into your projects or agent home directories.
Install the workflow once per repository. Normal use then refreshes unchanged
generated skills or tells you when an update needs attention. There are no
npm install lifecycle scripts.

## Install

Run from the repository root using its chosen crimes executable:

```bash
npm install -g crimes
crimes init --agents
# With a project-local dependency:
./node_modules/.bin/crimes init --agents
```

This creates config if missing, installs skills at
`.claude/skills/crimes/SKILL.md` and `.agents/skills/crimes/SKILL.md`, and
installs/merges the Claude PreToolUse hook. Existing config is preserved.
Use `--agent-skill` or `--codex-skill` for one host, or `--no-hooks` to skip
hook setup. Repeating setup keeps current files and safely updates known
unchanged generated skills. Adding the other host requires no `--force`.

For skills without config or hook setup, including a first installation:

```bash
crimes init --refresh-skills --agents
```

Commit the SKILL.md files, including their management footer, to share the
workflow. The footer records the template version and SHA-256 of its body.
It travels with the skill; no separate tracking file is needed. Template
versions advance when the instructions change, independently of scanner-only
releases. These hashes detect edits; they are not signatures or proof of trust.

## Upgrade

Upgrade your chosen CLI (`npm install -g crimes@latest` or the project's
dependency update). On the next successful ordinary command:

- **Interactive terminal, human output:** unchanged generated skills refresh
  after analysis. Stderr names the files; review and commit them for the team.
- **JSON or non-interactive/agent invocation:** stdout remains the report;
  stderr names the project root and safe refresh command. No skill files change.
- **Customized skills:** preserved, with a review notice when based on an older
  template or missing recognizable metadata. A customized current template
  does not trigger a routine notice. Newer templates are never downgraded.
- **CI:** no prompts, automatic refreshes or maintenance notices.

`--no-skill-update` skips refreshes and their notices. `--no-init` also skips
maintenance. No missing skills are installed automatically. Maintenance follows
the command's project, including enclosing repository skills when run inside a
Git workspace package; it does not update unrelated repositories or home skills.
Setup, hooks, feedback, triage and pin migration do not trigger maintenance.
Failures to refresh are advisory and do not change the report's exit status.

You can still inspect or refresh explicitly from the named project root:

```bash
crimes init --refresh-skills --check  # optional read-only status and diff
crimes init --refresh-skills         # safe explicit update, including in CI
```

Refresh inspects existing skills in this repository only. It never writes
`crimes.config.json` or hook settings, even with `--force`. Select a host to
install a missing copy or limit the update:

```bash
crimes init --refresh-skills --codex-skill
```

Exact original templates from npm 0.27.0 and 0.28.0 are recognized without
metadata. Subsequent managed templates are recognized by their recorded hash.
CRLF checkouts are supported. Unknown older files, locally edited bodies,
invalid metadata and newer template versions are preserved for review.

If any selected skill needs review, the command prints a diff and writes
nothing, including other selected skills. Merge desired instructions manually
(the file remains customized), or explicitly replace only the reviewed host:

```bash
crimes init --refresh-skills --codex-skill --force
```

Keep project policies in AGENTS.md where possible so routine template updates
need no merge. `--force` is replacement, not a merge. Since 0.28.1,
`init --agents --force` also preserves existing config; **only `init --force`
without agent/refresh flags resets config**. Older CLI versions overwrite
config when forcing skill installation: upgrade the CLI before refreshing.

| Result | Exit code |
| --- | --- |
| Setup/refresh completed, or check found all skills current | 0 |
| Read-only `--check` found missing/outdated selected skills | 1 |
| Customized/newer skills need review, invalid options, or setup error | 2 |

`--check` requires `--refresh-skills` and cannot be combined with `--force`.
Without installed skills, select `--agents` or one host explicitly.
No background service or registry lookup is involved. Template changes, not
every package-version change, determine whether a refresh is needed.

## Discovery and hooks

Codex discovers repository skills in `.agents/skills`; it may select this
workflow from its description or you can invoke `$crimes-codebase-risk`.
See [OpenAI's skill documentation](https://learn.chatgpt.com/docs/build-skills).
Claude Code discovers `.claude/skills` and supports invoking the project
workflow as `/crimes`; see [Claude's skill documentation](https://code.claude.com/docs/en/skills).
If a newly installed skill is absent, restart the host and check its skill
settings. Discovery makes instructions available; it does not guarantee
that every model invokes or follows them on every task.

Claude setup installs a local PreToolUse hook for `Edit` and `Write` on existing
files. It uses the project-local executable first, then `crimes` on PATH;
it does not download through npx. A missing executable produces a hook warning.
The generated timeout is **30 seconds** (the host unit is seconds). Each call
still runs repository analysis; use `--no-hooks` at setup to rely on the skill's
explicit checks when that per-edit latency is undesirable. To remove an existing
hook, remove its crimes command from `.claude/settings.local.json`; `--no-hooks`
only skips setup and does not delete existing settings.

The hook uses the host project root, reads tool input from stdin and returns
`hookSpecificOutput.additionalContext` so Claude receives the briefing. It
includes analysis status, relevant coverage limits, evidence and fingerprints.
It sets no permission decision, applies no edits, and never blocks an edit.
These input/output and timeout rules follow the
[Claude hook contract](https://code.claude.com/docs/en/hooks).

Existing generated `--format compact` hooks also deliver structured context
when the input identifies a PreToolUse event. Normal CLI use notices exact
legacy hooks and recommends `crimes init --agent-skill` to update their command
and timeout. This explicit setup migrates the known old command, preserving
custom timeout values and other settings. Skill refresh never changes executable
hook settings. Review customized hook commands separately.

Keep `.claude/settings.local.json` local and review it as executable settings.
No Codex hook integration is claimed. Since 0.28, init no longer creates the
old inert `.agents/settings.local.json` placeholder. Existing copies are
untouched; delete one manually if it contains only that obsolete placeholder.

Setup validates all selected inputs before writing. Malformed hook settings
are never overwritten by `--force`: repair them or use `--no-hooks`.
Writes are staged and earlier replacements are restored on a write error;
if restoration itself fails, the original backup is retained and named.
Symlinked destinations are refused; update a shared symlink target deliberately.

## Workflow and maintenance

The skill covers locating the installed CLI, retaining comparable snapshots,
opaque fingerprints, coverage limits, project policy and independent tests.
[Agent usage](./agent-usage.md) explains decisions;
[JSON schema](./json-schema.md) defines reports.

The maintained template is `packages/cli/src/skills/template.ts`, embedded
in the CLI bundle. `pnpm docs:generate` regenerates both checked-in host
copies; `pnpm verify` rejects drift. `pnpm --filter crimes smoke` tests fresh
setup and real npm 0.28.0/0.28.1-to-tarball upgrades, including actual TTY
refresh, piped JSON, CI and customized files.
The optional `scripts/eval-skills.py` runs fresh Codex/Claude sessions against
an installed package; see [0.28.1 release evidence](./releases/v0.28.1.md)
for the measured results and limits.
