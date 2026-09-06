# crimes

Local, deterministic change-risk and agent-risk analysis for TypeScript,
JavaScript and Python. Built for agents, readable by humans.

```bash
npx crimes scan .
npx crimes context src/file.ts --root . --format json
npx crimes scan --changed --format json
```

The human report prioritizes five files. JSON contains all visible findings
with evidence, scores, stable fingerprints and suggested next steps.
Review coverage warnings and context analysis status; a clean report does
not prove safety. Run behavior tests separately.

Analysis reuses source and parsed data within each command; no persistent
cache is required. Context and scoped scans still analyze the repository.
`crimes migrate-pins --format json` previews legacy decisions before reviewed
`--apply`; `--recover` restores originals after an interrupted replacement.
Schema remains `0.8.0`. [Migration guide](https://crimes.sh/docs/pin-migration/).

Install agent integration once per repository:

```bash
crimes init --agents
```

Normal terminal use refreshes unchanged generated skills after CLI upgrades.
Agent/JSON calls show the safe update action on stderr and never auto-write
skills. Customized instructions and executable hook settings are preserved;
CI skips maintenance. The optional Claude hook uses your installed CLI and
supplies advisory context without downloading tools.
[Skill setup and updates](https://crimes.sh/docs/skills/).

- [Getting started](https://crimes.sh/docs/)
- [Agent workflow](https://crimes.sh/docs/agent-usage/)
- [Command and detector reference](https://crimes.sh/docs/reference/)
- [Configuration](https://crimes.sh/docs/configuration/)
- [0.29.0 release evidence](https://crimes.sh/docs/releases/v0.29.0/)
- [Performance methods](https://crimes.sh/docs/performance/)
- [Source and contributions](https://github.com/ortomate/crimes)

MIT. Node.js >=18. No cloud or model required.
