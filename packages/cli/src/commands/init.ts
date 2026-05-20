import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import {
  CODEX_HOOK_DOCUMENT,
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
description: Use when editing, reviewing, or investigating a TypeScript / JavaScript codebase that ships with the crimes CLI. Helps agents run pre-edit context checks, post-edit scans, and interpret findings before risky changes.
---

# crimes — codebase risk workflow

\`crimes\` is a deterministic CLI (no LLM) that reports change risk and agent risk. JSON output is the stable contract; prefer it when planning.

## When to run it

- Before editing an unfamiliar file: \`crimes context <file> --format json\`
- Before a broad refactor: \`crimes scan <path> --format json\`
- After edits: \`crimes scan --changed --format json\`
- Before merging a branch: \`crimes verdict --format json\`

## Decision rules

- Treat any new \`severity: "high"\` finding introduced by your edit as a blocker unless the user explicitly accepts it.
- Read \`evidence[]\` before acting; it contains deterministic facts, not LLM opinion.
- Use \`scores.agent_risk\` to decide which findings need human attention first.
- If a finding is a false positive, record feedback with \`crimes feedback <fingerprint> --verdict fp --note "<why>"\` rather than silently ignoring it.
`;

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description(
      "Write a starter crimes.config.json to the current directory.",
    )
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
    .option(
      "--force",
      "overwrite existing generated files instead of failing",
      false,
    )
    .option(
      "--no-detect",
      "skip repo detection and write the static template",
    )
    .option(
      "--no-hooks",
      "skip writing PreToolUse hook config with --agents",
    )
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
          `crimes: ${CONFIG_FILENAME} already exists. ` +
            `Pass --force to overwrite.\n`,
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
          `crimes: ${CODEX_SKILL_PATH} already exists. ` +
            `Pass --force to overwrite.\n`,
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
          const settingsPath = resolve(
            process.cwd(),
            ".claude/settings.local.json",
          );
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
            writeFileSync(
              settingsPath,
              serializeClaudeSettings(merge.document),
              "utf8",
            );
            written.push(".claude/settings.local.json");
          }
        }

        // Codex placeholder
        if (writeCodexSkill) {
          const codexSettingsPath = resolve(
            process.cwd(),
            ".agents/settings.local.json",
          );
          if (!existsSync(codexSettingsPath) || options.force) {
            mkdirSync(dirname(codexSettingsPath), { recursive: true });
            writeFileSync(
              codexSettingsPath,
              CODEX_HOOK_DOCUMENT + "\n",
              "utf8",
            );
            written.push(".agents/settings.local.json");
          }
        }
      }

      if (written.includes(CONFIG_FILENAME)) {
        process.stdout.write(
          `Wrote ${CONFIG_FILENAME}. ` +
            `Tweak include/exclude/thresholds and commit.\n`,
        );
      } else if (configExists) {
        process.stdout.write(`Kept existing ${CONFIG_FILENAME}.\n`);
      }
      const agentFiles = written.filter((file) => file !== CONFIG_FILENAME);
      if (agentFiles.length > 0) {
        process.stdout.write(`Wrote ${agentFiles}. Commit them so future agents auto-discover crimes.\n`);
      }
    });
}

/**
 * Exposed for the init command's tests — keeps the file fixture in sync
 * with the writer. Returns the static (detect=false) template.
 */
export function getStarterConfigText(): Promise<string> {
  return generateConfig({ root: ".", detect: false });
}
export const AGENT_SKILL_TEXT = AGENT_SKILL;
