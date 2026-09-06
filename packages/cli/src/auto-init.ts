import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { AGENT_SKILL_TEXT } from "./commands/init.js";
import { generateConfig } from "./init-detect.js";
import { applySetupFiles, readSetupFile, type SetupFile } from "./setup-files.js";

export type Agent = "claude" | "codex" | "none";

export function autoInitFlags(program: Command): { init: boolean; noInit: boolean } {
  const value = program.opts<{ init?: boolean }>().init;
  return {
    init: value === true && program.getOptionValueSource("init") === "cli",
    noInit: value === false,
  };
}

export interface DetectAgentInput {
  env: NodeJS.ProcessEnv;
  cwd: string;
  exists: (path: string) => boolean;
}

export function detectAgent(input: DetectAgentInput): Agent {
  if (input.env.CLAUDECODE || input.env.CLAUDE_CODE) return "claude";
  if (input.env.OPENAI_CODEX || input.env.CODEX_AGENT) return "codex";
  if (input.exists(join(input.cwd, ".claude"))) return "claude";
  if (input.exists(join(input.cwd, ".agents"))) return "codex";
  return "none";
}

export interface ShouldPromptInput {
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  configExists: boolean;
  markerExists: boolean;
  flags: { noInit: boolean; init: boolean };
}

export function shouldPromptAutoInit(input: ShouldPromptInput): boolean {
  if (input.flags.noInit) return false;
  if (input.env.CI) return false;
  if (!input.isTTY) return false;
  if (input.markerExists) return false;
  if (input.configExists && !input.flags.init) return false;
  return true;
}

const MARKER_PATH = ".crimes/.skip-init";
const CONFIG_FILENAME = "crimes.config.json";

const COMMANDS_THAT_SKIP_PROMPT = new Set([
  "init",
  "feedback",
  "ignore",
  "unignore",
  "baseline",
  "triage",
]);

interface AutoInitOptions {
  cwd: string;
  flags: { noInit: boolean; init: boolean };
}

export async function maybeRunAutoInit(
  command: string,
  options: AutoInitOptions,
): Promise<void> {
  if (COMMANDS_THAT_SKIP_PROMPT.has(command)) return;

  const cwd = options.cwd;
  const configPath = join(cwd, CONFIG_FILENAME);
  const markerPath = join(cwd, MARKER_PATH);

  const should = shouldPromptAutoInit({
    env: process.env,
    isTTY: process.stdout.isTTY === true && process.stdin.isTTY === true,
    configExists: existsSync(configPath),
    markerExists: existsSync(markerPath),
    flags: options.flags,
  });
  if (!should) return;

  const agent = detectAgent({ env: process.env, cwd, exists: existsSync });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const onSigInt = () => {
    rl.close();
    process.stdout.write("\n");
    process.exit(130);
  };
  process.on("SIGINT", onSigInt);

  try {
    let wroteAny = false;
    let declinedAny = false;
    const planned: SetupFile[] = [];

    if (!existsSync(configPath)) {
      const ans = (
        await rl.question(
          `No crimes.config.json found. Generate one for this repo? [Y/n] `,
        )
      )
        .trim()
        .toLowerCase();
      if (ans === "" || ans === "y" || ans === "yes") {
        const body = await generateConfig({ root: cwd, detect: true });
        planned.push({ path: CONFIG_FILENAME, before: undefined, after: body });
        wroteAny = true;
      } else {
        declinedAny = true;
      }
    }

    if (agent !== "none") {
      const rel =
        agent === "claude"
          ? ".claude/skills/crimes/SKILL.md"
          : ".agents/skills/crimes/SKILL.md";
      const skillPath = join(cwd, rel);
      if (!existsSync(skillPath)) {
        const label = agent === "claude" ? "Claude Code" : "Codex";
        const ans = (
          await rl.question(
            `Write ${rel} so ${label} discovers crimes for future sessions? [Y/n] `,
          )
        )
          .trim()
          .toLowerCase();
        if (ans === "" || ans === "y" || ans === "yes") {
          planned.push({
            path: rel,
            before: readSetupFile(cwd, rel),
            after: AGENT_SKILL_TEXT,
          });
          wroteAny = true;
        } else {
          declinedAny = true;
        }
      }
    }

    applySetupFiles(cwd, planned);
    for (const file of planned) process.stdout.write(`  Wrote ${file.path}.\n`);
    if (declinedAny && !wroteAny) {
      mkdirSync(dirname(markerPath), { recursive: true });
      writeFileSync(markerPath, "", "utf8");
    }
    if (wroteAny || declinedAny) {
      process.stdout.write(`Continuing with \`${command}\` …\n\n`);
    }
  } finally {
    process.removeListener("SIGINT", onSigInt);
    rl.close();
  }
}
