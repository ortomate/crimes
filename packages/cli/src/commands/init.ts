import type { Command } from "commander";
import { generateConfig } from "../init-detect.js";
import { applySetupFiles } from "../setup-files.js";
import { skillDiff } from "../skills/inspect.js";
import { planSetup, type InitOptions, type SetupPlan } from "../skills/setup.js";
import { SKILL_PATHS, SKILL_VERSION } from "../skills/template.js";

export { AGENT_SKILL_TEXT } from "../skills/template.js";

function showSkillPlan(plan: SetupPlan, options: InitOptions): void {
  for (const skill of plan.skills) {
    const version = skill.version ? ` (template ${skill.version})` : "";
    process.stdout.write(`${skill.file.path}: ${skill.status}${version}\n`);
    if (
      skill.status !== "current" &&
      (options.check || skill.status === "customized" || skill.status === "newer")
    ) {
      process.stdout.write(
        skillDiff(skill.file.path, skill.file.before ?? "", skill.file.after),
      );
    }
  }
}

function showWritten(plan: SetupPlan): void {
  if (plan.keptConfig) process.stdout.write("Kept existing crimes.config.json.\n");
  for (const file of plan.files) process.stdout.write(`Wrote ${file.path}.\n`);
  if (plan.skills.length > 0) {
    process.stdout.write(
      `Skills use template ${SKILL_VERSION}. Commit SKILL.md files, including their management footer, for the team.\n`,
    );
  }
  if (plan.files.some((file) => file.path.endsWith("settings.local.json"))) {
    process.stdout.write(
      ".claude/settings.local.json is per-user local agent settings; keep it gitignored.\n",
    );
  }
}

async function runInit(options: InitOptions): Promise<void> {
  try {
    const plan = await planSetup(process.cwd(), options);
    showSkillPlan(plan, options);
    if (plan.skills.some((skill) => skill.conflict)) {
      process.stderr.write(
        "crimes: customized or newer skills were preserved; no files were written. Review the diff, merge it manually, or use --refresh-skills --force to replace selected skills.\n",
      );
      process.exitCode = 2;
      return;
    }
    if (options.check) {
      process.stdout.write(
        plan.files.length > 0
          ? "Skill updates available; run init --refresh-skills with the same host selection.\n"
          : "Installed skills are current.\n",
      );
      process.exitCode = plan.files.length > 0 ? 1 : 0;
      return;
    }
    applySetupFiles(process.cwd(), plan.files);
    showWritten(plan);
  } catch (error) {
    process.stderr.write(
      `crimes: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description(
      "Set up config and optional agent skills, or safely refresh installed skills.",
    )
    .option("--agent-skill", `install/refresh ${SKILL_PATHS.claude}`, false)
    .option("--codex-skill", `install/refresh ${SKILL_PATHS.codex}`, false)
    .option("--agents", "install/refresh both Claude Code and Codex skills", false)
    .option(
      "--refresh-skills",
      "refresh existing skills only; never write config or hooks",
      false,
    )
    .option(
      "--check",
      "with --refresh-skills: read-only check/diff; exit 1 if updates exist",
      false,
    )
    .option(
      "--force",
      "replace customized skills; without agent flags, reset config",
      false,
    )
    .option("--no-detect", "skip repo detection when creating config")
    .option("--no-hooks", "skip Claude hook setup with agent flags")
    .action(runInit);
}

/** Static starter used by fixture and config round-trip tests. */
export function getStarterConfigText(): Promise<string> {
  return generateConfig({ root: ".", detect: false });
}
