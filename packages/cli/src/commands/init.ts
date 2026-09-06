import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import {
  mergeClaudeHook,
  serializeClaudeSettings,
  type ClaudeSettings,
  type MergeResult,
} from "../hook-templates.js";
import { generateConfig } from "../init-detect.js";

interface InitCommandOptions {
  agents: boolean;
  agentSkill: boolean;
  codexSkill: boolean;
  force: boolean;
  detect: boolean;
  hooks: boolean;
}

const CONFIG_FILENAME = "crimes.config.json";
const CLAUDE_SKILL_PATH = ".claude/skills/crimes/SKILL.md";
const CODEX_SKILL_PATH = ".agents/skills/crimes/SKILL.md";

const AGENT_SKILL = `---
name: crimes-codebase-risk
description: Use crimes to inspect change risk before and after edits in a repository that uses the CLI. Covers TypeScript, JavaScript and Python; interpret its evidence and analysis limits before acting.
---

# crimes workflow

Use JSON for decisions. Before editing, run \`crimes context <file> --root .
--format json\` from the intended repository root. Without \`--root\`, context
uses the nearest package/project root, which may omit monorepo consumers.
For several files use \`scan --files a.ts,b.ts --format json\`; for import
neighbors use \`scan --related-to src/api.ts --format json\`.

Read \`analysis_status\`, \`coverage.warnings\`, evidence, related files and
likely tests. \`partial\` or \`not_analyzed\` requires inspecting what was
missed. No findings does not establish safety, and \`test_gap\` describes
test discovery, not behavioral coverage. Context shares scan's analysis;
scoping narrows output, not the repository analysis cost.

After editing, compare \`scan --changed --format json\` with the pre-edit
findings. This selects changed files, including their old findings.
Use \`verdict --base main --format json\` for committed branch differences.
Run behavior tests independently. Treat a new high-severity finding as a
blocker unless the user accepts it. Do not fix unrelated findings.

A false positive can be recorded with \`crimes feedback <fingerprint>
--verdict fp --note "<reason>"\` within the user's scope. Reconfirm resurfaced
feedback with the user. For stale identities, preview \`crimes migrate-pins
--format json\`, review candidates, then apply the reviewed file. Never infer
that an absent finding is resolved or silently renew its expiry.

Summarize the evidence that affects the task. Use human output when a full
terminal report helps; rerunning a scan solely to repeat its presentation
is unnecessary. More detail: https://crimes.sh/docs/agent-usage/
`;

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Write a starter crimes.config.json to the current directory.")
    .option(
      "--agent-skill",
      `also write ${CLAUDE_SKILL_PATH} so Claude Code discovers crimes in this repo`,
      false,
    )
    .option(
      "--codex-skill",
      `also write ${CODEX_SKILL_PATH} so Codex discovers crimes in this repo`,
      false,
    )
    .option(
      "--agents",
      "also write Claude Code and Codex skill files for future agents",
      false,
    )
    .option("--force", "overwrite existing generated files instead of failing", false)
    .option("--no-detect", "skip repo detection and write the static template")
    .option("--no-hooks", "skip writing PreToolUse hook config with --agents")
    .action(async (options: InitCommandOptions) => {
      const path = resolve(process.cwd(), CONFIG_FILENAME);
      const writeClaudeSkill = options.agents || options.agentSkill;
      const writeCodexSkill = options.agents || options.codexSkill;
      const writeAgentSkills = writeClaudeSkill || writeCodexSkill;
      const claudeSkillPath = resolve(process.cwd(), CLAUDE_SKILL_PATH);
      const codexSkillPath = resolve(process.cwd(), CODEX_SKILL_PATH);
      const configExists = existsSync(path);

      if (configExists && !options.force && !writeAgentSkills) {
        process.stderr.write(
          `crimes: ${CONFIG_FILENAME} already exists. ` + `Pass --force to overwrite.\n`,
        );
        process.exit(2);
        return;
      }
      if (writeClaudeSkill && existsSync(claudeSkillPath) && !options.force) {
        process.stderr.write(
          `crimes: ${CLAUDE_SKILL_PATH} already exists. ` +
            `Pass --force to overwrite.\n`,
        );
        process.exit(2);
        return;
      }
      if (writeCodexSkill && existsSync(codexSkillPath) && !options.force) {
        process.stderr.write(
          `crimes: ${CODEX_SKILL_PATH} already exists. ` + `Pass --force to overwrite.\n`,
        );
        process.exit(2);
        return;
      }

      const written: string[] = [];
      if (!configExists || options.force) {
        const configText = await generateConfig({
          root: process.cwd(),
          detect: options.detect,
        });
        writeFileSync(path, configText, "utf8");
        written.push(CONFIG_FILENAME);
      }
      if (writeClaudeSkill) {
        mkdirSync(dirname(claudeSkillPath), { recursive: true });
        writeFileSync(claudeSkillPath, AGENT_SKILL, "utf8");
        written.push(CLAUDE_SKILL_PATH);
      }
      if (writeCodexSkill) {
        mkdirSync(dirname(codexSkillPath), { recursive: true });
        writeFileSync(codexSkillPath, AGENT_SKILL, "utf8");
        written.push(CODEX_SKILL_PATH);
      }

      if (writeAgentSkills && options.hooks !== false) {
        // Claude hook
        if (writeClaudeSkill) {
          const settingsPath = resolve(process.cwd(), ".claude/settings.local.json");
          let existing: ClaudeSettings | undefined;
          if (existsSync(settingsPath)) {
            try {
              existing = JSON.parse(readFileSync(settingsPath, "utf8"));
            } catch {
              if (!options.force) {
                process.stderr.write(
                  "crimes: .claude/settings.local.json is malformed — refusing to modify. Pass --force to overwrite.\n",
                );
                process.exit(2);
                return;
              }
              existing = undefined;
            }
          }
          let merge: MergeResult;
          try {
            merge = mergeClaudeHook(existing);
          } catch (err) {
            if (!options.force) {
              process.stderr.write(
                `crimes: .claude/settings.local.json has an unexpected shape — refusing to modify. Pass --force to overwrite. (${err instanceof Error ? err.message : String(err)})\n`,
              );
              process.exit(2);
              return;
            }
            merge = mergeClaudeHook(undefined);
          }
          if (merge.action !== "skipped") {
            mkdirSync(dirname(settingsPath), { recursive: true });
            writeFileSync(settingsPath, serializeClaudeSettings(merge.document), "utf8");
            written.push(".claude/settings.local.json");
          }
        }
      }

      if (written.includes(CONFIG_FILENAME)) {
        process.stdout.write(
          `Wrote ${CONFIG_FILENAME}. ` + `Tweak include/exclude/thresholds and commit.\n`,
        );
      } else if (configExists) {
        process.stdout.write(`Kept existing ${CONFIG_FILENAME}.\n`);
      }
      const agentFiles = written.filter((file) => file !== CONFIG_FILENAME);
      if (agentFiles.length > 0) {
        const list = agentFiles.join(", ");
        // SKILL.md files live in shared paths (`.claude/skills/...`,
        // `.agents/skills/...`) and are meant to be committed so
        // teammates / future agents pick them up. `settings.local.json`
        // is per-user by Claude Code convention (typically gitignored);
        // call that out so users don't naively commit it expecting
        // teammates to inherit the hook.
        const partitioned = partitionAgentFiles(agentFiles);
        process.stdout.write(`Wrote ${list}.\n`);
        if (partitioned.shared.length > 0) {
          process.stdout.write(
            `  Commit ${partitioned.shared.join(", ")} so teammates and future agents discover crimes.\n`,
          );
        }
        if (partitioned.local.length > 0) {
          const verb = partitioned.local.length === 1 ? "is" : "are";
          process.stdout.write(
            `  ${partitioned.local.join(", ")} ${verb} per-user local agent settings — keep ${partitioned.local.length === 1 ? "it" : "them"} gitignored or commit ${partitioned.local.length === 1 ? "it" : "them"} under your shared settings if your team wants the hook everywhere.\n`,
          );
        }
      }
    });
}

function partitionAgentFiles(files: string[]): {
  shared: string[];
  local: string[];
} {
  const shared: string[] = [];
  const local: string[] = [];
  for (const file of files) {
    if (file.endsWith("settings.local.json")) local.push(file);
    else shared.push(file);
  }
  return { shared, local };
}

/**
 * Exposed for the init command's tests — keeps the file fixture in sync
 * with the writer. Returns the static (detect=false) template.
 */
export function getStarterConfigText(): Promise<string> {
  return generateConfig({ root: ".", detect: false });
}
export const AGENT_SKILL_TEXT = AGENT_SKILL;
