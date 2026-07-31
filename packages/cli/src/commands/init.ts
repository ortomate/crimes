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

\`crimes\` is a deterministic CLI (no LLM) that reports change risk and agent risk. JSON output is the stable contract for agent decisions; prefer it when planning. For user-facing readbacks, use the default human output instead of rebuilding the report in your own prose.

## Pack coverage

\`crimes\` ships findings under three packs:

- **Universal pack** runs on every file. Detectors: large files, raster
  asset weight, duplicate filenames, hardcoded localhost / local paths,
  docs link checking, missing agent context, TODO/FIXME density,
  commented-out code (non-JS only).
- **Language-js pack** runs on \`.ts/.tsx/.js/.jsx/.mjs/.cjs/.cts/.mts\`
  files only. Most detectors live here.
- **Language-py pack** runs on \`.py/.pyi\` files only. Eight detectors:
  \`large_function.py\`, \`direct_date.py\`,
  \`mixed_utc_local_methods.py\`, \`sync_io_in_hotpath.py\`,
  \`boolean_naming_drift.py\`, \`weak_test_signal.py\`,
  \`circular_dependency.py\`, \`deep_import.py\`. Python-specific
  hazards are called out as such: a naive \`datetime\` (no \`tz=\`) can
  raise \`TypeError\` when compared against an aware one, an import
  cycle can raise \`ImportError\` at startup depending on import order,
  and blocking I/O inside \`async def\` stalls the whole event loop.

Run \`crimes scan --explain-coverage\` to see which packs claimed which
files in this repo.

Findings on files no language pack claims have **full confidence** on
the things universal detectors can see, and are **silent** on things
they can't (function shape, imports, JSX, types). When a file's
\`Finding.pack\` is \`"universal"\`, treat its absence of other findings
as "we couldn't parse this; no opinion" rather than "this file is
clean".

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

## Reporting findings back to humans

Use \`--format json\` when you need to plan, gate, compare, or make decisions. When the user wants to see the results, or when you are summarising findings back in chat, prefer running the same command without \`--format json\` and quote or paste the relevant human-readable readout. The human report is intentionally designed for people: severity glyphs, grouped findings, evidence, feedback commands, suppressions, and gate status are already rendered there.

Do not paraphrase the whole JSON payload in your own voice unless you need a short executive summary. Use the human readout as the canonical user-facing presentation, and add your own interpretation only around the parts that matter for the task.
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
