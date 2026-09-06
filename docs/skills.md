# Agent integration

`crimes init --agents` writes the workflow skill to both
`.claude/skills/crimes/SKILL.md` and `.agents/skills/crimes/SKILL.md`.
Use `--agent-skill` or `--codex-skill` for one host. Existing files require
`--force` to replace; review local customizations before doing so.

The skill covers pre-edit context, post-edit comparison, evidence and
analysis limits. Project-specific architecture, tests and safety policies
belong in the project's `AGENTS.md`; crimes does not replace those policies.
[Agent usage](./agent-usage.md) is the operational reference;
[JSON schema](./json-schema.md) is the wire contract.

For Claude Code, init also installs/merges a local PreToolUse hook invoking
`crimes hook`; use `--no-hooks` to install only the skill. The hook reads the
host's JSON input and produces advisory context; it does not apply fixes.
Review `.claude/settings.local.json` as local executable configuration.

0.28 stops creating `.agents/settings.local.json`: the prior file was an
inert future-hook placeholder, not a functioning Codex integration. Existing
copies are left alone; a copy containing only crimes' placeholder can be
deleted. No Codex hook compatibility is claimed by this release. The skill
remains the supported integration provided here.

Commit skills if the team wants the shared workflow. Keep host-local
settings local. Summarize task-relevant evidence from JSON; a second scan
just to produce human formatting is unnecessary. Use the human formatter
when a full terminal report helps.

The generated [reference](./reference.md) checks shipped capabilities against
the build. Skill templates are kept in `packages/cli/src/commands/init.ts`;
update the two bundled copies when the workflow changes.
