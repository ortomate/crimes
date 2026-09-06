# Agent integration

The npm package contains the current skill template. Installing or updating
npm packages does not write into your projects or agent home directories.
Install the workflow once per repository, then refresh it after upgrading
crimes. There are no npm install lifecycle scripts.

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

```bash
npm install -g crimes@latest          # or update your project dependency
crimes init --refresh-skills --check  # read-only status and proposed diff
crimes init --refresh-skills          # update unchanged generated skills
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
There is no background refresh or traversal of other repositories.

## Discovery and hooks

Codex discovers repository skills in `.agents/skills`; it may select this
workflow from its description or you can invoke `$crimes-codebase-risk`.
See [OpenAI's skill documentation](https://learn.chatgpt.com/docs/build-skills).
Claude Code discovers `.claude/skills` and supports invoking the project
workflow as `/crimes`; see [Claude's skill documentation](https://code.claude.com/docs/en/skills).
If a newly installed skill is absent, restart the host and check its skill
settings. Discovery makes instructions available; it does not guarantee
that every model invokes or follows them on every task.

Claude setup uses a local PreToolUse hook invoking `npx -y crimes hook`.
It resolves crimes through npm independently of the skill text. A project-local
installation keeps this on the project's dependency; without one, npx may
fetch a package. Use `--no-hooks` if that is unsuitable. The hook consumes
host JSON on stdin and supplies advisory context; it does not apply fixes.
Keep `.claude/settings.local.json` local and review it as executable settings.
Only the exact shipped broken legacy command is migrated; custom hooks and
unrelated settings are preserved. Refreshing skills does not change hooks.

Setup validates all selected inputs before writing. Malformed hook settings
are never overwritten by `--force`: repair them or use `--no-hooks`.
Writes are staged and earlier replacements are restored on a write error;
if restoration itself fails, the original backup is retained and named.
Symlinked destinations are refused; update a shared symlink target deliberately.

No Codex hook integration is claimed. Since 0.28, init no longer creates the
old inert `.agents/settings.local.json` placeholder. Existing copies are
untouched; delete one manually if it contains only that obsolete placeholder.

## Workflow and maintenance

The skill covers locating the installed CLI, retaining comparable snapshots,
opaque fingerprints, coverage limits, project policy and independent tests.
[Agent usage](./agent-usage.md) explains decisions;
[JSON schema](./json-schema.md) defines reports.

The maintained template is `packages/cli/src/skills/template.ts`, embedded
in the CLI bundle. `pnpm docs:generate` regenerates both checked-in host
copies; `pnpm verify` rejects drift. `pnpm --filter crimes smoke` tests fresh
setup and a real npm 0.28.0-to-tarball upgrade, including customized files.
The optional `scripts/eval-skills.py` runs fresh Codex/Claude sessions against
an installed package; see [0.28.1 release evidence](./releases/v0.28.1.md)
for the measured results and limits.
