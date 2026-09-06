import { createHash } from "node:crypto";

// Bump when the workflow changes, independently of scanner-only releases.
export const SKILL_VERSION = "0.28.1";
export const SKILL_PATHS = {
  claude: ".claude/skills/crimes/SKILL.md",
  codex: ".agents/skills/crimes/SKILL.md",
} as const;

export const SKILL_BODY = `---
name: crimes-codebase-risk
description: Inspect change risk with crimes when planning, editing or reviewing code in a repository that uses the CLI. Covers TypeScript, JavaScript and Python; interpret evidence and analysis limits before acting.
---

# crimes workflow

Work from the intended repository root and follow its AGENTS.md and test
policy. Use the project's installed CLI: \`crimes\` if available, otherwise
\`./node_modules/.bin/crimes\` (or the project's package-manager script).
In the crimes source checkout, use \`node packages/cli/dist/index.js\` after
building. Check \`--version\`; keep the same executable before and after edits.
If none is installed, report that limitation; do not silently download or
upgrade tools. The commands below use \`crimes\` as shorthand for that executable.

Before editing, run \`crimes context <file> --root . --format json\`.
Without \`--root\`, context uses the nearest package/project root and may
omit monorepo consumers. Read \`analysis_status\`, \`coverage.warnings\`,
\`agent_guidance\`, evidence, related files and likely tests. Investigate
\`partial\` or \`not_analyzed\` before interpreting an empty list. No findings
does not establish safety; \`test_gap\` describes discovery, not test coverage.

Retain a pre-edit JSON scan for the intended files, for example
\`crimes scan --files src/a.ts,src/b.ts --format json\`. Store snapshots outside
the scanned sources (a temporary directory is suitable). For import neighbors,
use \`scan --related-to src/api.ts --format json\`. Context and scoped scans
still analyze the repository; smaller output does not promise a cheaper scan.

After editing, repeat the same scan with the same root, file scope and
configuration. Compare opaque \`fingerprint\` values from JSON to identify
new, retained and absent observations; do not construct fingerprints or
compare positional finding IDs. If the scope expanded, distinguish files
without a pre-edit snapshot from demonstrated new findings.
\`scan --changed --format json\` is useful to discover the working set,
but includes old findings in those files. Its failure threshold is not a
new-findings-only gate. For committed branch changes use \`verdict --base
<project-base> --format json\`; verify the actual base instead of assuming main.

Run the repository's behavior tests independently. Handle new high findings
according to its policy, explaining evidence and uncertainty. Do not turn
unrelated findings into extra work or silently change thresholds/suppressions.
Exit 2 means a usage/environment error; exit 1 can mean a configured gate
failed. A successful exit does not establish complete analysis or safety.

Within the user's scope, record a false positive with \`crimes feedback
<fingerprint> --verdict fp --note "<reason>"\`. This writes feedback and a
suppression. Reconfirm resurfaced feedback with the user. For stale identities,
preview \`crimes migrate-pins --format json\`, review candidates, then apply
the reviewed file. An absent observation is not proof of a resolved problem;
never silently renew an expiry or prior decision.

Summarize the evidence and tests that affect the task. Human output is useful
for terminal reports; do not rerun analysis solely to repeat its formatting.
After a CLI upgrade, \`crimes init --refresh-skills --check\` checks installed
workflows without writing; \`crimes init --refresh-skills\` safely refreshes
unchanged generated copies. Review customized-file diffs before replacing.
More detail: https://crimes.sh/docs/agent-usage/
`;

export function skillHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function managedSkill(body: string, version: string): string {
  const metadata = { format: 1, version, sha256: skillHash(body) };
  return `${body}\n<!-- crimes-skill ${JSON.stringify(metadata)} -->\n`;
}

export const AGENT_SKILL_TEXT = managedSkill(SKILL_BODY, SKILL_VERSION);
